//! Lo justo de `new URL(...)` que necesitan el export (URL de Supabase) y la bajada del modelo (hosts permitidos y
//! redirecciones): URLs absolutas http/https, sin IDNA ni percent-decoding. Lo que no entiende lo rechaza (None).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Url {
    pub scheme: String,
    pub usuario: String,
    pub clave: String,
    pub host: String,
    /// None si no vino o si es el puerto por defecto del esquema (como `URL.port === ''`).
    pub puerto: Option<u16>,
    pub ruta: String,
    pub query: String,
    pub hash: String,
}

fn puerto_por_defecto(scheme: &str) -> Option<u16> {
    match scheme {
        "http" => Some(80),
        "https" => Some(443),
        _ => None,
    }
}

fn host_valido(h: &str) -> bool {
    if h.is_empty() {
        return false;
    }
    if h.starts_with('[') {
        return h.ends_with(']') && h.len() > 2 && h[1..h.len() - 1].bytes().all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.');
    }
    h.is_ascii() && h.bytes().all(|b| b.is_ascii_graphic() && !b"#%/:<>?@[\\]^|".contains(&b))
}

/// Parte una URL absoluta de http o https. Los tabs y saltos de línea se sacan como hace WHATWG.
pub fn parsear(texto: &str) -> Option<Url> {
    let t: String = texto.trim_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let (scheme, resto) = t.split_once(':')?;
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https") || !scheme.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let resto = resto.replace('\\', "/");
    let resto = resto.trim_start_matches('/');
    let (resto, hash) = match resto.split_once('#') {
        Some((a, h)) => (a, h.to_string()),
        None => (resto, String::new()),
    };
    let (resto, query) = match resto.split_once('?') {
        Some((a, q)) => (a, q.to_string()),
        None => (resto, String::new()),
    };
    let (autoridad, ruta) = match resto.find('/') {
        Some(i) => (&resto[..i], resto[i..].to_string()),
        None => (resto, "/".to_string()),
    };
    let (credenciales, hostport) = match autoridad.rfind('@') {
        Some(i) => (Some(&autoridad[..i]), &autoridad[i + 1..]),
        None => (None, autoridad),
    };
    let (usuario, clave) = match credenciales {
        Some(c) => match c.split_once(':') {
            Some((u, p)) => (u.to_string(), p.to_string()),
            None => (c.to_string(), String::new()),
        },
        None => (String::new(), String::new()),
    };
    let (host, puerto_txt) = if hostport.starts_with('[') {
        let fin = hostport.find(']')?;
        let rest = &hostport[fin + 1..];
        (&hostport[..=fin], rest.strip_prefix(':'))
    } else {
        match hostport.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (hostport, None),
        }
    };
    let host = host.to_ascii_lowercase();
    if !host_valido(&host) {
        return None;
    }
    let puerto = match puerto_txt {
        None | Some("") => None,
        Some(p) if p.bytes().all(|b| b.is_ascii_digit()) => {
            let n: u32 = p.parse().ok()?;
            let n = u16::try_from(n).ok()?;
            (Some(n) != puerto_por_defecto(&scheme)).then_some(n)
        }
        Some(_) => return None,
    };
    Some(Url { scheme, usuario, clave, host, puerto, ruta, query, hash })
}

impl Url {
    /// `URL.origin`: esquema, host y puerto que no sea el por defecto.
    pub fn origen(&self) -> String {
        match self.puerto {
            Some(p) => format!("{}://{}:{p}", self.scheme, self.host),
            None => format!("{}://{}", self.scheme, self.host),
        }
    }

    pub fn href(&self) -> String {
        let cred = match (self.usuario.is_empty(), self.clave.is_empty()) {
            (true, true) => String::new(),
            (_, true) => format!("{}@", self.usuario),
            _ => format!("{}:{}@", self.usuario, self.clave),
        };
        let puerto = self.puerto.map(|p| format!(":{p}")).unwrap_or_default();
        let query = if self.query.is_empty() { String::new() } else { format!("?{}", self.query) };
        let hash = if self.hash.is_empty() { String::new() } else { format!("#{}", self.hash) };
        format!("{}://{cred}{}{puerto}{}{query}{hash}", self.scheme, self.host, self.ruta)
    }
}

/// `new URL(destino, base).href` para las redirecciones: absoluta, desde la raíz del host o relativa a la ruta de la base.
pub fn resolver(destino: &str, base: &str) -> Option<String> {
    let d = destino.trim_matches(|c: char| c <= ' ');
    if let Some(u) = parsear(d) {
        if d.to_ascii_lowercase().starts_with(&format!("{}:", u.scheme)) {
            return Some(u.href());
        }
    }
    let b = parsear(base)?;
    let relativa = |ruta: &str, query: &str| Url { ruta: normalizar_ruta(ruta), query: query.to_string(), hash: String::new(), ..b.clone() }.href();
    if let Some(sin) = d.strip_prefix("//") {
        return parsear(&format!("{}://{sin}", b.scheme)).map(|u| u.href());
    }
    let (sin_hash, hash) = d.split_once('#').map_or((d, ""), |(a, h)| (a, h));
    let (ruta, query) = sin_hash.split_once('?').map_or((sin_hash, None), |(a, q)| (a, Some(q)));
    let url = if ruta.is_empty() {
        let q = query.unwrap_or(&b.query);
        relativa(&b.ruta, q)
    } else if ruta.starts_with('/') {
        relativa(ruta, query.unwrap_or(""))
    } else {
        let carpeta = &b.ruta[..=b.ruta.rfind('/').unwrap_or(0)];
        relativa(&format!("{carpeta}{ruta}"), query.unwrap_or(""))
    };
    Some(if hash.is_empty() { url } else { format!("{url}#{hash}") })
}

fn normalizar_ruta(ruta: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let segs: Vec<&str> = ruta.split('/').collect();
    for (i, s) in segs.iter().enumerate().skip(1) {
        let ultimo = i == segs.len() - 1;
        match *s {
            "." => {
                if ultimo {
                    out.push("");
                }
            }
            ".." => {
                out.pop();
                if ultimo {
                    out.push("");
                }
            }
            otro => out.push(otro),
        }
    }
    format!("/{}", out.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parsea_host_puerto_y_credenciales() {
        let u = parsear("HTTPS://Abc.Supabase.co:443/x/y?a=1#z").unwrap();
        assert_eq!((u.scheme.as_str(), u.host.as_str(), u.puerto, u.ruta.as_str(), u.query.as_str(), u.hash.as_str()), ("https", "abc.supabase.co", None, "/x/y", "a=1", "z"));
        assert_eq!(parsear("https://h.com:8443/").unwrap().puerto, Some(8443));
        let c = parsear("https://usuario:clave@h.com/").unwrap();
        assert_eq!((c.usuario.as_str(), c.clave.as_str()), ("usuario", "clave"));
        assert_eq!(parsear("https://h.com").unwrap().ruta, "/");
    }

    #[test]
    fn rechaza_lo_que_no_es_http_o_esta_roto() {
        for t in ["no es una url", "file:///C:/modelo.bin", "ftp://h.com/", "https://", "https://h .com/", "https://h.com:99999/", "https://h.com:ab/", "", "mailto:a@b.c"] {
            assert!(parsear(t).is_none(), "{t:?}");
        }
    }

    #[test]
    fn origen_y_href() {
        assert_eq!(parsear("https://abc.supabase.co/").unwrap().origen(), "https://abc.supabase.co");
        assert_eq!(parsear("https://h.com:8443/a?b=1#c").unwrap().href(), "https://h.com:8443/a?b=1#c");
    }

    #[test]
    fn resuelve_destinos_de_redireccion() {
        let base = "https://cdn.hf.co/blob?firma=abc";
        assert_eq!(resolver("https://cdn.hf.co/blob?firma=abc", "https://huggingface.co/x").unwrap(), "https://cdn.hf.co/blob?firma=abc");
        assert_eq!(resolver("/otro", base).unwrap(), "https://cdn.hf.co/otro");
        assert_eq!(resolver("otro/mas", "https://h.com/a/b").unwrap(), "https://h.com/a/otro/mas");
        assert_eq!(resolver("../c", "https://h.com/a/b/d").unwrap(), "https://h.com/a/c");
        assert_eq!(resolver("//otro.com/x", "https://h.com/a").unwrap(), "https://otro.com/x");
        assert_eq!(resolver("?q=2", "https://h.com/a?q=1").unwrap(), "https://h.com/a?q=2");
        assert_eq!(resolver("http://cdn.hf.co/modelo.bin", base).unwrap(), "http://cdn.hf.co/modelo.bin");
    }
}
