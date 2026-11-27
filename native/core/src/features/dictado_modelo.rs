//! Bajada verificada del modelo de Whisper (equivale a src/main/dictado-modelo.ts). Es un dato, nunca se ejecuta: se escribe
//! en un .part, se compara el SHA-256 y recién entonces se renombra, así el nombre final solo existe con el contenido
//! correcto. La red y el disco se inyectan (`ModeloDeps`) para poder probarlo; quien baja de verdad implementa la
//! inactividad (sin recibir un solo byte durante `inactividad_ms` el intento se da por caído) en `fetch` y en el cuerpo.
use super::url_lite;
use sha2::{Digest, Sha256};
use std::path::Path;

pub type Cuerpo = Box<dyn Iterator<Item = Result<Vec<u8>, String>>>;

pub struct RespuestaModelo {
    pub status: u16,
    pub location: Option<String>,
    pub content_length: Option<String>,
    pub cuerpo: Option<Cuerpo>,
}

impl RespuestaModelo {
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorIo {
    pub mensaje: String,
    /// ENOSPC: el disco está lleno.
    pub sin_espacio: bool,
}

pub trait Escritor {
    fn write(&mut self, chunk: &[u8]) -> Result<(), ErrorIo>;
    fn close(&mut self) -> Result<(), ErrorIo>;
}

pub trait ModeloDeps {
    /// Pide la URL sin seguir redirecciones (`redirect: 'manual'`).
    fn fetch(&mut self, url: &str, inactividad_ms: u64) -> Result<RespuestaModelo, String>;
    fn mkdir(&mut self, dir: &str) -> Result<(), ErrorIo>;
    fn abrir(&mut self, path: &str) -> Result<Box<dyn Escritor>, ErrorIo>;
    fn rename(&mut self, desde: &str, hasta: &str) -> Result<(), ErrorIo>;
    fn rm(&mut self, path: &str) -> Result<(), ErrorIo>;
    fn existe(&mut self, path: &str) -> bool;
    fn sleep(&mut self, ms: u64);
}

pub struct OpcionesModelo<'a> {
    pub url: &'a str,
    pub sha256: &'a str,
    pub destino: &'a str,
    pub hosts: &'a [&'a str],
    /// Tope de bytes: lo que pase de acá se corta aunque el servidor siga mandando.
    pub max_bytes: u64,
    /// Para el progreso cuando la respuesta no trae content-length.
    pub bytes_aprox: u64,
    pub intentos: Option<u32>,
    pub inactividad_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorModelo {
    SinRed,
    Hash,
    Disco,
    Escritura,
    Http,
    /// Los datos que le pasó el código (un SHA-256 mal formado): no es un problema de la red ni del disco.
    Invalido,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeloError {
    pub mensaje: String,
    pub tipo: ErrorModelo,
    pub reintentable: bool,
}

impl ModeloError {
    fn nuevo(mensaje: impl Into<String>, tipo: ErrorModelo, reintentable: bool) -> ModeloError {
        ModeloError { mensaje: mensaje.into(), tipo, reintentable }
    }
}

const MAX_SALTOS: usize = 5;
const ESPERAS_MS: [u64; 2] = [1000, 3000];

pub fn host_permitido(url: &str, hosts: &[&str]) -> bool {
    url_lite::parsear(url).is_some_and(|u| u.scheme == "https" && u.puerto.is_none() && u.usuario.is_empty() && u.clave.is_empty() && hosts.contains(&u.host.as_str()))
}

fn host_de(url: &str) -> String {
    url_lite::parsear(url).map_or_else(|| "URL inválida".to_string(), |u| u.host)
}

fn por_disco(e: &ErrorIo) -> ErrorModelo {
    if e.sin_espacio { ErrorModelo::Disco } else { ErrorModelo::Escritura }
}

fn pedir(url: &str, o: &OpcionesModelo, d: &mut dyn ModeloDeps, inactividad_ms: u64) -> Result<RespuestaModelo, ModeloError> {
    let mut actual = url.to_string();
    for _ in 0..=MAX_SALTOS {
        if !host_permitido(&actual, o.hosts) {
            return Err(ModeloError::nuevo(format!("Host no permitido para el modelo: {}", host_de(&actual)), ErrorModelo::Http, false));
        }
        let res = d.fetch(&actual, inactividad_ms).map_err(|e| ModeloError::nuevo(format!("Sin conexión con {}: {e}", host_de(&actual)), ErrorModelo::SinRed, true))?;
        if (300..400).contains(&res.status) {
            let Some(destino) = res.location.as_deref() else { return Err(ModeloError::nuevo(format!("Redirección sin destino desde {}", host_de(&actual)), ErrorModelo::Http, false)) };
            let Some(nueva) = url_lite::resolver(destino, &actual) else { return Err(ModeloError::nuevo(format!("Redirección inválida desde {}", host_de(&actual)), ErrorModelo::Http, false)) };
            actual = nueva;
            continue;
        }
        if !res.ok() {
            return Err(ModeloError::nuevo(format!("{} respondió {}", host_de(&actual), res.status), ErrorModelo::Http, res.status >= 500));
        }
        return Ok(res);
    }
    Err(ModeloError::nuevo("Demasiadas redirecciones", ErrorModelo::Http, false))
}

/// `Number(header)` de JavaScript: sin header es 0, vacío es 0 y lo que no es número es NaN.
fn declarado_de(header: Option<&str>) -> f64 {
    match header.map(str::trim) {
        None | Some("") => 0.0,
        Some(t) => t.parse::<f64>().unwrap_or(f64::NAN),
    }
}

fn descargar(o: &OpcionesModelo, d: &mut dyn ModeloDeps, part: &str, progreso: &mut Option<&mut dyn FnMut(u64, u64)>, archivo: &mut Option<Box<dyn Escritor>>) -> Result<(), ModeloError> {
    let inactividad_ms = o.inactividad_ms.unwrap_or(60_000);
    let mut res = pedir(o.url, o, d, inactividad_ms)?;
    let Some(cuerpo) = res.cuerpo.take() else { return Err(ModeloError::nuevo("La respuesta no trae contenido", ErrorModelo::SinRed, true)) };
    let declarado = declarado_de(res.content_length.as_deref());
    if declarado.is_finite() && declarado > o.max_bytes as f64 {
        return Err(ModeloError::nuevo("El archivo es más grande de lo esperado", ErrorModelo::Http, false));
    }
    let total = if declarado.is_finite() && declarado > 0.0 { declarado as u64 } else { o.bytes_aprox };

    let escritor = d.abrir(part).map_err(|e| ModeloError::nuevo(format!("No se pudo crear {part}"), por_disco(&e), false))?;
    let escritor = archivo.insert(escritor);

    let mut hash = Sha256::new();
    let mut recibidos: u64 = 0;
    for parte in cuerpo {
        let chunk = parte.map_err(|e| ModeloError::nuevo(format!("Se cortó la bajada: {e}"), ErrorModelo::SinRed, true))?;
        recibidos += chunk.len() as u64;
        if recibidos > o.max_bytes {
            return Err(ModeloError::nuevo("El archivo es más grande de lo esperado", ErrorModelo::Http, false));
        }
        hash.update(&chunk);
        escritor.write(&chunk).map_err(|e| ModeloError::nuevo(format!("No se pudo escribir {part}"), por_disco(&e), false))?;
        if let Some(p) = progreso.as_mut() {
            p(recibidos, total);
        }
    }
    if declarado.is_finite() && declarado > 0.0 && recibidos as f64 != declarado {
        return Err(ModeloError::nuevo(format!("Llegaron {recibidos} de {} bytes", declarado as u64), ErrorModelo::SinRed, true));
    }

    let mut cerrando = archivo.take().expect("el archivo sigue abierto hasta acá");
    cerrando.close().map_err(|e| ModeloError::nuevo(format!("No se pudo cerrar {part}"), por_disco(&e), false))?;
    if hex::encode(hash.finalize()) != o.sha256 {
        return Err(ModeloError::nuevo("El SHA-256 del modelo no coincide", ErrorModelo::Hash, true));
    }
    Ok(())
}

fn es_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn asegurar_modelo(o: &OpcionesModelo, d: &mut dyn ModeloDeps, mut progreso: Option<&mut dyn FnMut(u64, u64)>) -> Result<(), ModeloError> {
    if !es_sha256(o.sha256) {
        return Err(ModeloError::nuevo("El SHA-256 del modelo tiene que ser hexadecimal de 64 caracteres.", ErrorModelo::Invalido, false));
    }
    if !host_permitido(o.url, o.hosts) {
        return Err(ModeloError::nuevo(format!("Host no permitido para el modelo: {}", host_de(o.url)), ErrorModelo::Http, false));
    }
    if d.existe(o.destino) {
        return Ok(());
    }
    if let Some(dir) = Path::new(o.destino).parent() {
        d.mkdir(&dir.to_string_lossy()).map_err(|e| ModeloError::nuevo("No se pudo crear la carpeta del modelo", por_disco(&e), false))?;
    }

    let part = format!("{}.part", o.destino);
    let intentos = o.intentos.unwrap_or(3);
    let mut ultimo: Option<ModeloError> = None;
    let mut hash_fallos = 0;
    for i in 0..intentos as usize {
        if i > 0 {
            d.sleep(ESPERAS_MS.get(i - 1).copied().unwrap_or(ESPERAS_MS[ESPERAS_MS.len() - 1]));
        }
        let mut archivo: Option<Box<dyn Escritor>> = None;
        let resultado = descargar(o, d, &part, &mut progreso, &mut archivo).and_then(|()| d.rename(&part, o.destino).map_err(|e| ModeloError::nuevo(format!("No se pudo guardar el modelo: {}", e.mensaje), ErrorModelo::Escritura, false)));
        // Si ya falló otra cosa, el error que importa es ese y no el del cierre.
        if let Some(mut a) = archivo {
            let _ = a.close();
        }
        match resultado {
            Ok(()) => return Ok(()),
            Err(e) => {
                // Un antivirus puede tener el .part abierto: que el rm falle no tiene que tapar el error de la bajada.
                let _ = d.rm(&part);
                // Si el hash falla dos veces el servidor sirve otra cosa: repetir solo gasta otros 190 MB.
                if e.tipo == ErrorModelo::Hash {
                    hash_fallos += 1;
                    if hash_fallos >= 2 {
                        return Err(e);
                    }
                }
                if !e.reintentable {
                    return Err(e);
                }
                ultimo = Some(e);
            }
        }
    }
    Err(ultimo.unwrap_or_else(|| ModeloError::nuevo("No se pudo bajar el modelo", ErrorModelo::SinRed, false)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::rc::Rc;

    const HOSTS: [&str; 2] = ["huggingface.co", "cdn.hf.co"];
    const URL_MODELO: &str = "https://huggingface.co/x/modelo.bin";
    const DESTINO: &str = "/datos/modelo.bin";
    const PART: &str = "/datos/modelo.bin.part";

    fn contenido() -> Vec<u8> {
        b"contenido de prueba del modelo, lo bastante largo para partirlo en chunks".to_vec()
    }

    fn hash_de(b: &[u8]) -> String {
        hex::encode(Sha256::digest(b))
    }

    fn cuerpo(bytes: &[u8], partes: usize) -> Cuerpo {
        let tam = bytes.len().div_ceil(partes).max(1);
        Box::new(bytes.chunks(tam).map(|c| Ok(c.to_vec())).collect::<Vec<_>>().into_iter())
    }

    fn resp(status: u16, bytes: Option<&[u8]>, headers: &[(&str, &str)]) -> RespuestaModelo {
        let h = |n: &str| headers.iter().find(|(k, _)| *k == n).map(|(_, v)| v.to_string());
        RespuestaModelo { status, location: h("location"), content_length: h("content-length"), cuerpo: bytes.map(|b| cuerpo(b, 3)) }
    }

    #[derive(Default)]
    struct Estado {
        fs: HashMap<String, Vec<u8>>,
        pedidos: Vec<String>,
        esperas: Vec<u64>,
        inactividades: Vec<u64>,
        escribir_falla: Option<ErrorIo>,
        rm_falla: bool,
        n: usize,
    }

    type Respuesta = Box<dyn Fn(&str) -> Result<RespuestaModelo, String>>;

    struct Falso {
        e: Rc<RefCell<Estado>>,
        respuestas: Vec<Respuesta>,
    }

    struct EscritorFalso(Rc<RefCell<Estado>>, String);

    impl Escritor for EscritorFalso {
        fn write(&mut self, chunk: &[u8]) -> Result<(), ErrorIo> {
            let mut e = self.0.borrow_mut();
            if let Some(f) = e.escribir_falla.clone() {
                return Err(f);
            }
            e.fs.get_mut(&self.1).expect("el .part está abierto").extend_from_slice(chunk);
            Ok(())
        }
        fn close(&mut self) -> Result<(), ErrorIo> {
            Ok(())
        }
    }

    impl ModeloDeps for Falso {
        fn fetch(&mut self, url: &str, inactividad_ms: u64) -> Result<RespuestaModelo, String> {
            let mut e = self.e.borrow_mut();
            e.pedidos.push(url.to_string());
            e.inactividades.push(inactividad_ms);
            let i = e.n.min(self.respuestas.len() - 1);
            e.n += 1;
            (self.respuestas[i])(url)
        }
        fn mkdir(&mut self, _: &str) -> Result<(), ErrorIo> {
            Ok(())
        }
        fn abrir(&mut self, path: &str) -> Result<Box<dyn Escritor>, ErrorIo> {
            self.e.borrow_mut().fs.insert(path.to_string(), Vec::new());
            Ok(Box::new(EscritorFalso(self.e.clone(), path.to_string())))
        }
        fn rename(&mut self, desde: &str, hasta: &str) -> Result<(), ErrorIo> {
            let mut e = self.e.borrow_mut();
            let v = e.fs.remove(desde).expect("el .part tiene que existir al renombrar");
            e.fs.insert(hasta.to_string(), v);
            Ok(())
        }
        fn rm(&mut self, path: &str) -> Result<(), ErrorIo> {
            let mut e = self.e.borrow_mut();
            e.fs.remove(path);
            if e.rm_falla { Err(ErrorIo { mensaje: "EBUSY".into(), sin_espacio: false }) } else { Ok(()) }
        }
        fn existe(&mut self, path: &str) -> bool {
            self.e.borrow().fs.contains_key(path)
        }
        fn sleep(&mut self, ms: u64) {
            self.e.borrow_mut().esperas.push(ms);
        }
    }

    fn falso(respuestas: Vec<Respuesta>) -> Falso {
        Falso { e: Rc::new(RefCell::new(Estado::default())), respuestas }
    }

    fn sirve(status: u16, bytes: Option<Vec<u8>>, headers: Vec<(&'static str, String)>) -> Respuesta {
        Box::new(move |_| {
            let h: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
            Ok(resp(status, bytes.as_deref(), &h))
        })
    }

    fn cae() -> Respuesta {
        Box::new(|_| Err("fetch failed".into()))
    }

    fn opciones(sha: &str) -> OpcionesModelo<'static> {
        let sha: &'static str = Box::leak(sha.to_string().into_boxed_str());
        OpcionesModelo { url: URL_MODELO, sha256: sha, destino: DESTINO, hosts: &HOSTS, max_bytes: 1000, bytes_aprox: contenido().len() as u64, intentos: None, inactividad_ms: None }
    }

    fn tipo_de(r: Result<(), ModeloError>) -> Option<ErrorModelo> {
        r.err().map(|e| e.tipo)
    }

    #[test]
    fn descarga_bien_renombra_el_part_al_destino_y_avisa_el_progreso() {
        let c = contenido();
        let mut f = falso(vec![sirve(200, Some(c.clone()), vec![("content-length", c.len().to_string())])]);
        let mut avances: Vec<(u64, u64)> = Vec::new();
        let mut al_avanzar = |r, t| avances.push((r, t));
        asegurar_modelo(&opciones(&hash_de(&c)), &mut f, Some(&mut al_avanzar)).unwrap();
        let e = f.e.borrow();
        assert_eq!(e.fs.get(DESTINO), Some(&c));
        assert!(!e.fs.contains_key(PART));
        assert!(avances.len() >= 2);
        assert_eq!(avances.last(), Some(&(c.len() as u64, c.len() as u64)));
    }

    #[test]
    fn hash_incorrecto_borra_el_part_reintenta_una_sola_vez_y_al_agotar_falla_sin_dejar_el_destino() {
        let c = contenido();
        let mut f = falso(vec![sirve(200, Some(b"otro contenido distinto".to_vec()), vec![])]);
        assert_eq!(tipo_de(asegurar_modelo(&opciones(&hash_de(&c)), &mut f, None)), Some(ErrorModelo::Hash));
        let e = f.e.borrow();
        assert_eq!(e.pedidos.len(), 2);
        assert!(e.fs.is_empty());
        assert_eq!(e.esperas, vec![1000]);
    }

    #[test]
    fn hash_incorrecto_una_vez_y_bien_la_siguiente_queda_el_contenido_bueno() {
        let c = contenido();
        let mut f = falso(vec![sirve(200, Some(b"malo".to_vec()), vec![]), sirve(200, Some(c.clone()), vec![])]);
        asegurar_modelo(&opciones(&hash_de(&c)), &mut f, None).unwrap();
        assert_eq!(f.e.borrow().fs.get(DESTINO), Some(&c));
    }

    #[test]
    fn sin_red_reintenta_y_anda_a_la_tercera_si_no_sin_red() {
        let c = contenido();
        let mut f = falso(vec![cae(), cae(), sirve(200, Some(c.clone()), vec![])]);
        asegurar_modelo(&opciones(&hash_de(&c)), &mut f, None).unwrap();
        assert_eq!(f.e.borrow().pedidos.len(), 3);
        assert_eq!(f.e.borrow().esperas, vec![1000, 3000]);

        let mut g = falso(vec![cae()]);
        assert_eq!(tipo_de(asegurar_modelo(&opciones(&hash_de(&c)), &mut g, None)), Some(ErrorModelo::SinRed));
        assert_eq!(g.e.borrow().pedidos.len(), 3);
        assert!(g.e.borrow().fs.is_empty());
    }

    #[test]
    fn un_stream_que_se_corta_a_la_mitad_cuenta_como_sin_red_y_no_deja_nada() {
        let c = contenido();
        let cortado: Respuesta = Box::new(|_| {
            let partes: Vec<Result<Vec<u8>, String>> = vec![Ok(b"0123456789".to_vec()), Err("conexión reiniciada".into())];
            Ok(RespuestaModelo { status: 200, location: None, content_length: None, cuerpo: Some(Box::new(partes.into_iter())) })
        });
        let mut f = falso(vec![cortado]);
        assert_eq!(tipo_de(asegurar_modelo(&opciones(&hash_de(&c)), &mut f, None)), Some(ErrorModelo::SinRed));
        assert!(f.e.borrow().fs.is_empty());
    }

    #[test]
    fn si_llegan_menos_bytes_que_el_content_length_no_se_acepta_aunque_no_haya_error() {
        let c = contenido();
        let mut f = falso(vec![sirve(200, Some(c[..10].to_vec()), vec![("content-length", c.len().to_string())])]);
        assert_eq!(tipo_de(asegurar_modelo(&opciones(&hash_de(&c)), &mut f, None)), Some(ErrorModelo::SinRed));
        assert!(!f.e.borrow().fs.contains_key(DESTINO));
    }

    #[test]
    fn un_404_falla_como_http_sin_reintentar_un_503_si_reintenta() {
        let c = contenido();
        let mut a = falso(vec![sirve(404, None, vec![])]);
        assert_eq!(tipo_de(asegurar_modelo(&opciones(&hash_de(&c)), &mut a, None)), Some(ErrorModelo::Http));
        assert_eq!(a.e.borrow().pedidos.len(), 1);

        let mut b = falso(vec![sirve(503, None, vec![]), sirve(200, Some(c.clone()), vec![])]);
        asegurar_modelo(&opciones(&hash_de(&c)), &mut b, None).unwrap();
        assert_eq!(b.e.borrow().pedidos.len(), 2);
    }

    #[test]
    fn redirect_a_un_host_fuera_de_la_lista_http_y_no_se_pide() {
        let mut f = falso(vec![sirve(302, None, vec![("location", "https://malo.example.com/modelo.bin".into())])]);
        assert_eq!(tipo_de(asegurar_modelo(&opciones(&hash_de(&contenido())), &mut f, None)), Some(ErrorModelo::Http));
        assert_eq!(f.e.borrow().pedidos, vec![URL_MODELO]);
    }

    #[test]
    fn redirect_a_http_plano_http_y_no_se_pide() {
        let mut f = falso(vec![sirve(302, None, vec![("location", "http://cdn.hf.co/modelo.bin".into())])]);
        assert_eq!(tipo_de(asegurar_modelo(&opciones(&hash_de(&contenido())), &mut f, None)), Some(ErrorModelo::Http));
        assert_eq!(f.e.borrow().pedidos.len(), 1);
    }

    #[test]
    fn redirect_sin_destino_o_con_destino_invalido_es_http() {
        let c = hash_de(&contenido());
        let mut f = falso(vec![sirve(302, None, vec![])]);
        assert_eq!(asegurar_modelo(&opciones(&c), &mut f, None).unwrap_err().mensaje, "Redirección sin destino desde huggingface.co");
        let mut g = falso(vec![sirve(302, None, vec![("location", "https://".into())])]);
        assert_eq!(tipo_de(asegurar_modelo(&opciones(&c), &mut g, None)), Some(ErrorModelo::Http));
    }

    #[test]
    fn redirect_a_un_host_permitido_tambien_relativo_se_sigue_y_baja() {
        let c = contenido();
        let mut f = falso(vec![
            sirve(302, None, vec![("location", "https://cdn.hf.co/blob?firma=abc".into())]),
            sirve(307, None, vec![("location", "/otro".into())]),
            sirve(200, Some(c.clone()), vec![]),
        ]);
        asegurar_modelo(&opciones(&hash_de(&c)), &mut f, None).unwrap();
        assert_eq!(f.e.borrow().pedidos, vec![URL_MODELO, "https://cdn.hf.co/blob?firma=abc", "https://cdn.hf.co/otro"]);
        assert_eq!(f.e.borrow().fs.get(DESTINO), Some(&c));
    }

    #[test]
    fn redirecciones_en_bucle_corta() {
        let mut f = falso(vec![sirve(302, None, vec![("location", URL_MODELO.into())])]);
        assert_eq!(tipo_de(asegurar_modelo(&opciones(&hash_de(&contenido())), &mut f, None)), Some(ErrorModelo::Http));
        assert!(f.e.borrow().pedidos.len() <= 6);
    }

    #[test]
    fn disco_lleno_al_escribir_disco_sin_reintentos_y_sin_part() {
        let c = contenido();
        let mut f = falso(vec![sirve(200, Some(c.clone()), vec![])]);
        f.e.borrow_mut().escribir_falla = Some(ErrorIo { mensaje: "no space left".into(), sin_espacio: true });
        assert_eq!(tipo_de(asegurar_modelo(&opciones(&hash_de(&c)), &mut f, None)), Some(ErrorModelo::Disco));
        assert_eq!(f.e.borrow().pedidos.len(), 1);
        assert!(f.e.borrow().fs.is_empty());
    }

    #[test]
    fn otro_error_de_escritura_escritura_sin_reintentos() {
        let c = contenido();
        let mut f = falso(vec![sirve(200, Some(c.clone()), vec![])]);
        f.e.borrow_mut().escribir_falla = Some(ErrorIo { mensaje: "denegado".into(), sin_espacio: false });
        assert_eq!(tipo_de(asegurar_modelo(&opciones(&hash_de(&c)), &mut f, None)), Some(ErrorModelo::Escritura));
        assert_eq!(f.e.borrow().pedidos.len(), 1);
    }

    #[test]
    fn si_el_destino_ya_existe_no_pide_nada() {
        let c = contenido();
        let mut f = falso(vec![sirve(200, Some(c.clone()), vec![])]);
        f.e.borrow_mut().fs.insert(DESTINO.into(), c.clone());
        asegurar_modelo(&opciones(&hash_de(&c)), &mut f, None).unwrap();
        assert!(f.e.borrow().pedidos.is_empty());
    }

    #[test]
    fn tope_de_tamano_por_content_length_y_por_lo_que_llega_de_verdad() {
        let c = contenido();
        let mut a = falso(vec![sirve(200, Some(c.clone()), vec![("content-length", "999999".into())])]);
        assert_eq!(tipo_de(asegurar_modelo(&opciones(&hash_de(&c)), &mut a, None)), Some(ErrorModelo::Http));
        assert!(a.e.borrow().fs.is_empty());

        let mut b = falso(vec![sirve(200, Some(c.clone()), vec![])]);
        let o = OpcionesModelo { max_bytes: 20, ..opciones(&hash_de(&c)) };
        assert_eq!(tipo_de(asegurar_modelo(&o, &mut b, None)), Some(ErrorModelo::Http));
        assert!(b.e.borrow().fs.is_empty());
    }

    #[test]
    fn sin_recibir_nada_durante_el_tiempo_de_inactividad_sin_red() {
        let c = contenido();
        let mut f = falso(vec![cae()]);
        let o = OpcionesModelo { inactividad_ms: Some(20), intentos: Some(1), ..opciones(&hash_de(&c)) };
        assert_eq!(tipo_de(asegurar_modelo(&o, &mut f, None)), Some(ErrorModelo::SinRed));
        assert_eq!(f.e.borrow().inactividades, vec![20]);
    }

    #[test]
    fn la_inactividad_por_defecto_es_de_un_minuto() {
        let c = contenido();
        let mut f = falso(vec![sirve(200, Some(c.clone()), vec![])]);
        asegurar_modelo(&opciones(&hash_de(&c)), &mut f, None).unwrap();
        assert_eq!(f.e.borrow().inactividades, vec![60_000]);
    }

    #[test]
    fn host_permitido_solo_https_host_exacto_de_la_lista_sin_credenciales_ni_puerto() {
        assert!(host_permitido("https://huggingface.co/a/b", &HOSTS));
        assert!(!host_permitido("http://huggingface.co/a/b", &HOSTS));
        assert!(!host_permitido("https://huggingface.co.evil.com/a", &HOSTS));
        assert!(!host_permitido("https://evil.com/huggingface.co", &HOSTS));
        assert!(!host_permitido("https://usuario:clave@huggingface.co/a", &HOSTS));
        assert!(!host_permitido("https://huggingface.co:8443/a", &HOSTS));
        assert!(!host_permitido("file:///C:/modelo.bin", &HOSTS));
        assert!(!host_permitido("no es una url", &HOSTS));
        assert!(host_permitido("https://HuggingFace.co:443/a", &HOSTS));
    }

    #[test]
    fn un_sha256_mal_formado_tira_antes_de_pedir_nada() {
        let c = contenido();
        let bien = hash_de(&c);
        let mut f = falso(vec![sirve(200, Some(c), vec![])]);
        for mal in [String::new(), "abc".into(), bien.to_uppercase(), format!("{bien}0"), "z".repeat(64)] {
            let e = asegurar_modelo(&opciones(&mal), &mut f, None).unwrap_err();
            assert!(e.mensaje.contains("SHA-256"), "{mal}");
            assert_eq!(e.tipo, ErrorModelo::Invalido);
        }
        assert!(f.e.borrow().pedidos.is_empty());
    }

    #[test]
    fn una_url_inicial_fuera_de_la_lista_falla_sin_pedir_nada() {
        let c = contenido();
        let mut f = falso(vec![sirve(200, Some(c.clone()), vec![])]);
        let o = OpcionesModelo { url: "https://evil.com/m.bin", ..opciones(&hash_de(&c)) };
        assert_eq!(tipo_de(asegurar_modelo(&o, &mut f, None)), Some(ErrorModelo::Http));
        assert!(f.e.borrow().pedidos.is_empty());
    }

    #[test]
    fn si_el_rm_del_part_falla_se_propaga_el_error_de_la_bajada_y_no_el_del_rm() {
        let mut f = falso(vec![sirve(404, None, vec![])]);
        f.e.borrow_mut().rm_falla = true;
        assert_eq!(tipo_de(asegurar_modelo(&opciones(&hash_de(&contenido())), &mut f, None)), Some(ErrorModelo::Http));
    }

    #[test]
    fn una_respuesta_sin_cuerpo_es_sin_red_y_reintenta() {
        let c = contenido();
        let mut f = falso(vec![sirve(200, None, vec![]), sirve(200, Some(c.clone()), vec![])]);
        asegurar_modelo(&opciones(&hash_de(&c)), &mut f, None).unwrap();
        assert_eq!(f.e.borrow().pedidos.len(), 2);
    }

    #[test]
    fn el_content_length_que_no_es_un_numero_no_frena_la_bajada() {
        let c = contenido();
        let mut f = falso(vec![sirve(200, Some(c.clone()), vec![("content-length", "abc".into())])]);
        asegurar_modelo(&opciones(&hash_de(&c)), &mut f, None).unwrap();
        assert_eq!(f.e.borrow().fs.get(DESTINO), Some(&c));
    }
}
