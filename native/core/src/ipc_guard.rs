//! Qué pedidos de IPC y qué permisos de Chromium se aceptan. Equivale a src/main/ipc-guard.ts.
//! La URL se interpreta lo justo para comparar origen: esquema, host y puerto.
use serde_json::Value;

#[derive(Debug, PartialEq)]
struct UrlMin {
    esquema: String,
    host: String,
    puerto: Option<u16>,
}

impl UrlMin {
    /// Como `URL.origin`: solo los esquemas de red tienen origen; el resto da «null».
    fn origen(&self) -> Option<String> {
        let especial = matches!(self.esquema.as_str(), "http" | "https" | "ws" | "wss" | "ftp");
        if !especial {
            return None;
        }
        let por_defecto = match self.esquema.as_str() {
            "http" | "ws" => Some(80),
            "https" | "wss" => Some(443),
            "ftp" => Some(21),
            _ => None,
        };
        let puerto = self.puerto.filter(|p| Some(*p) != por_defecto);
        Some(match puerto {
            Some(p) => format!("{}://{}:{p}", self.esquema, self.host),
            None => format!("{}://{}", self.esquema, self.host),
        })
    }
}

fn url_de(s: Option<&str>) -> Option<UrlMin> {
    let s = s?.trim();
    let (esquema, resto) = s.split_once(':')?;
    let mut cs = esquema.chars();
    if !cs.next().is_some_and(|c| c.is_ascii_alphabetic()) || !cs.all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
        return None;
    }
    let esquema = esquema.to_ascii_lowercase();
    let especial = matches!(esquema.as_str(), "http" | "https" | "ws" | "wss" | "ftp" | "file");
    let (host, puerto) = match resto.strip_prefix("//") {
        Some(r) => {
            let autoridad = r.split(['/', '?', '#']).next().unwrap_or("");
            let sin_usuario = autoridad.rsplit_once('@').map_or(autoridad, |(_, h)| h);
            match sin_usuario.rsplit_once(':') {
                Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => (h, Some(p.parse::<u16>().ok()?)),
                Some((h, "")) => (h, None),
                _ => (sin_usuario, None),
            }
        }
        None if especial && esquema != "file" => return None,
        None => ("", None),
    };
    if esquema != "file" && especial && host.is_empty() {
        return None;
    }
    Some(UrlMin { esquema, host: host.to_ascii_lowercase(), puerto })
}

pub fn origen_confiable(url: Option<&str>, dev_url: Option<&str>) -> bool {
    let Some(u) = url_de(url) else { return false };
    if u.esquema == "app" && u.host == "ui" {
        return true;
    }
    let Some(dev) = url_de(dev_url).and_then(|d| d.origen()) else { return false };
    u.origen().is_some_and(|o| o == dev)
}

/// Solo lo que la UI usa de verdad: el dictado pide el micrófono y los botones de copiar escriben el portapapeles.
pub fn permiso_chromium(permiso: &str, origen_ok: bool, medios: Option<&[&str]>) -> bool {
    if !origen_ok {
        return false;
    }
    if permiso == "media" {
        return medios.is_some_and(|m| !m.is_empty() && m.iter().all(|x| *x == "audio"));
    }
    permiso == "clipboard-sanitized-write"
}

/// Un id de IPC: texto de 1 a 200 unidades UTF-16 (como `length` en JS).
pub fn id_valido(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty() && s.encode_utf16().count() <= 200)
}

pub fn dim_valida(v: &Value) -> Option<u32> {
    let n = v.as_f64()?;
    (n.fract() == 0.0 && (1.0..=2000.0).contains(&n)).then_some(n as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn app_ui_con_cualquier_path() {
        assert!(origen_confiable(Some("app://ui/index.html"), None));
        assert!(origen_confiable(Some("app://ui/"), None));
        assert!(!origen_confiable(Some("app://otro/index.html"), None));
    }

    #[test]
    fn lo_de_afuera_vacio_o_roto_no() {
        assert!(!origen_confiable(Some("https://evil"), None));
        assert!(!origen_confiable(Some("https://app.ui/"), None));
        assert!(!origen_confiable(Some("file:///C:/x.html"), None));
        assert!(!origen_confiable(None, None));
        assert!(!origen_confiable(Some(""), None));
        assert!(!origen_confiable(Some("no es url"), Some("no es url")));
    }

    #[test]
    fn el_origin_de_dev_vale_solo_si_se_pasa_dev_url() {
        assert!(!origen_confiable(Some("http://localhost:5173/"), None));
        assert!(origen_confiable(Some("http://localhost:5173/x"), Some("http://localhost:5173/")));
        assert!(!origen_confiable(Some("http://localhost:5174/"), Some("http://localhost:5173/")));
        assert!(!origen_confiable(Some("https://evil/"), Some("http://localhost:5173/")));
    }

    #[test]
    fn el_puerto_por_defecto_y_las_mayusculas_no_cambian_el_origen() {
        assert!(origen_confiable(Some("HTTP://LocalHost:80/x"), Some("http://localhost/")));
        assert!(!origen_confiable(Some("http://localhost:81/"), Some("http://localhost/")));
    }

    #[test]
    fn un_dev_url_sin_origen_no_confia_en_nada() {
        assert!(!origen_confiable(Some("app://otro/"), Some("app://otro/")));
    }

    #[test]
    fn microfono_solo_de_audio_y_portapapeles_de_escritura() {
        assert!(permiso_chromium("media", true, Some(&["audio"])));
        assert!(!permiso_chromium("media", true, Some(&["audio", "video"])));
        assert!(!permiso_chromium("media", true, Some(&["video"])));
        assert!(!permiso_chromium("media", true, Some(&[])));
        assert!(!permiso_chromium("media", true, None));
        assert!(permiso_chromium("clipboard-sanitized-write", true, None));
        assert!(!permiso_chromium("geolocation", true, None));
        assert!(!permiso_chromium("notifications", true, None));
    }

    #[test]
    fn con_el_origen_mal_no_se_permite_nada() {
        assert!(!permiso_chromium("media", false, Some(&["audio"])));
        assert!(!permiso_chromium("clipboard-sanitized-write", false, None));
    }

    #[test]
    fn id_valido_y_dim_valida() {
        assert_eq!(id_valido(&json!("abc")), Some("abc"));
        assert_eq!(id_valido(&json!("")), None);
        assert_eq!(id_valido(&json!("a".repeat(201))), None);
        assert!(id_valido(&json!("a".repeat(200))).is_some());
        assert_eq!(id_valido(&json!(5)), None);
        assert_eq!(dim_valida(&json!(80)), Some(80));
        assert_eq!(dim_valida(&json!(1)), Some(1));
        assert_eq!(dim_valida(&json!(2000)), Some(2000));
        assert_eq!(dim_valida(&json!(0)), None);
        assert_eq!(dim_valida(&json!(2001)), None);
        assert_eq!(dim_valida(&json!(80.5)), None);
        assert_eq!(dim_valida(&json!("80")), None);
        assert_eq!(dim_valida(&json!(80.0)), Some(80));
    }
}
