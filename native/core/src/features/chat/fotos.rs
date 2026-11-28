//! Chat (datos): fotos de equipo. Bucket PRIVADO `team-photos`, ruta `<team_id>/<uuid>.<ext>`. Validación ANTES de subir:
//! largo del base64, tamaño y bytes mágicos (webp, png, jpeg). Equivale a la parte pura de chat-photos.ts; subir, bajar y
//! borrar son del cliente de Supabase. Nunca se loguean bytes.
use super::mapa::es_uuid;
use super::tipos::LIMITE_FOTO_BYTES;
use super::Res;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::{alphabet, Engine};
use std::collections::VecDeque;

pub const PHOTO_BUCKET: &str = "team-photos";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TipoFoto {
    Webp,
    Png,
    Jpeg,
}

impl TipoFoto {
    pub fn mime(self) -> &'static str {
        match self {
            TipoFoto::Webp => "image/webp",
            TipoFoto::Png => "image/png",
            TipoFoto::Jpeg => "image/jpeg",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            TipoFoto::Webp => "webp",
            TipoFoto::Png => "png",
            TipoFoto::Jpeg => "jpg",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Foto {
    pub bytes: Vec<u8>,
    pub tipo: TipoFoto,
}

/// Tipo real de la imagen según sus primeros bytes. `None` si no es webp, png ni jpeg.
pub fn detectar_foto(b: &[u8]) -> Option<TipoFoto> {
    if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return Some(TipoFoto::Webp);
    }
    if b.len() >= 8 && b[..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
        return Some(TipoFoto::Png);
    }
    if b.len() >= 3 && b[..3] == [0xff, 0xd8, 0xff] {
        return Some(TipoFoto::Jpeg);
    }
    None
}

/// `^[A-Za-z0-9+/]+={0,2}$`
fn es_base64(s: &str) -> bool {
    let sin = s.trim_end_matches('=');
    s.len() - sin.len() <= 2 && !sin.is_empty() && sin.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// Decodifica y valida la foto que manda la UI (base64 SIN prefijo). `max_bytes` es el tope ya recortado.
pub fn decodificar_foto_base64(raw: &str, max_bytes: usize) -> Res<Foto> {
    if raw.is_empty() {
        return Err("La foto no es válida.".into());
    }
    let pesa_mas = || format!("La foto pesa más de {} KB.", (max_bytes as f64 / 1024.0).round() as usize);
    // Corte temprano: el base64 de más de max_bytes ni se decodifica.
    if raw.len() > max_bytes.div_ceil(3) * 4 {
        return Err(pesa_mas());
    }
    if raw.len() % 4 != 0 || !es_base64(raw) {
        return Err("La foto no es válida.".into());
    }
    let motor = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true),
    );
    let bytes = motor.decode(raw).map_err(|_| "La foto no es válida.".to_string())?;
    if bytes.is_empty() {
        return Err("La foto no es válida.".into());
    }
    if bytes.len() > max_bytes {
        return Err(pesa_mas());
    }
    let tipo = detectar_foto(&bytes).ok_or_else(|| "La foto tiene que ser webp, png o jpeg.".to_string())?;
    Ok(Foto { bytes, tipo })
}

pub fn decodificar_foto_del_equipo(raw: &str) -> Res<Foto> {
    decodificar_foto_base64(raw, LIMITE_FOTO_BYTES)
}

/// Ruta que se acepta de la base: `<uuid>/<uuid>.(webp|png|jpg)`.
pub fn es_ruta_de_foto(path: &str) -> bool {
    let Some((equipo, archivo)) = path.split_once('/') else { return false };
    let Some((id, ext)) = archivo.rsplit_once('.') else { return false };
    path.encode_utf16().count() <= 200 && es_uuid(equipo, false) && es_uuid(id, false) && matches!(ext, "webp" | "png" | "jpg")
}

/// `data:` URL con la que vuelve la foto a la UI (el bucket no es público).
pub fn data_url(tipo: TipoFoto, bytes: &[u8]) -> String {
    format!("data:{};base64,{}", tipo.mime(), base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Ruta nueva dentro del bucket.
pub fn ruta_nueva(team_id: &str, uuid: &str, tipo: TipoFoto) -> String {
    format!("{team_id}/{uuid}.{}", tipo.extension())
}

/// Caché en memoria ruta → data URL con tope (LRU simple).
pub struct CacheDeFotos {
    orden: VecDeque<(String, String)>,
    max: usize,
}

impl CacheDeFotos {
    pub fn nueva(max: usize) -> Self {
        CacheDeFotos { orden: VecDeque::new(), max }
    }

    pub fn obtener(&mut self, ruta: &str) -> Option<String> {
        let pos = self.orden.iter().position(|(r, _)| r == ruta)?;
        let par = self.orden.remove(pos)?;
        let v = par.1.clone();
        self.orden.push_back(par);
        Some(v)
    }

    pub fn poner(&mut self, ruta: &str, data_url: &str) {
        self.orden.retain(|(r, _)| r != ruta);
        self.orden.push_back((ruta.into(), data_url.into()));
        while self.orden.len() > self.max {
            self.orden.pop_front();
        }
    }

    pub fn vaciar(&mut self) {
        self.orden.clear();
    }

    pub fn tamano(&self) -> usize {
        self.orden.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const U1: &str = "11111111-1111-4111-8111-111111111111";
    const U2: &str = "22222222-2222-4222-8222-222222222222";

    fn b64(b: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(b)
    }

    #[test]
    fn detecta_el_tipo_por_los_bytes_magicos() {
        assert_eq!(detectar_foto(&PNG), Some(TipoFoto::Png));
        assert_eq!(detectar_foto(b"RIFF\0\0\0\0WEBPxx"), Some(TipoFoto::Webp));
        assert_eq!(detectar_foto(&[0xff, 0xd8, 0xff, 0xe0]), Some(TipoFoto::Jpeg));
        assert_eq!(detectar_foto(b"RIFF\0\0\0\0WAVExx"), None);
        assert_eq!(detectar_foto(b"GIF89a"), None);
        assert_eq!(detectar_foto(&[]), None);
    }

    #[test]
    fn decodifica_una_foto_valida() {
        let f = decodificar_foto_del_equipo(&b64(&PNG)).unwrap();
        assert_eq!((f.tipo, f.bytes), (TipoFoto::Png, PNG.to_vec()));
    }

    #[test]
    fn rechaza_lo_que_no_es_una_foto() {
        assert_eq!(decodificar_foto_del_equipo(""), Err("La foto no es válida.".into()));
        assert_eq!(decodificar_foto_del_equipo("abc"), Err("La foto no es válida.".into()));
        assert_eq!(decodificar_foto_del_equipo("ab=c"), Err("La foto no es válida.".into()));
        assert_eq!(decodificar_foto_del_equipo("data:image/png;base64,AAAA"), Err("La foto no es válida.".into()));
        assert_eq!(decodificar_foto_del_equipo(&b64(b"GIF89a....")), Err("La foto tiene que ser webp, png o jpeg.".into()));
    }

    #[test]
    fn rechaza_las_que_pesan_mas_del_tope() {
        let mut grande = PNG.to_vec();
        grande.resize(LIMITE_FOTO_BYTES + 1, 0);
        assert_eq!(decodificar_foto_del_equipo(&b64(&grande)), Err("La foto pesa más de 512 KB.".into()));
        let mut justo = PNG.to_vec();
        justo.resize(LIMITE_FOTO_BYTES, 0);
        assert!(decodificar_foto_del_equipo(&b64(&justo)).is_ok());
        assert_eq!(decodificar_foto_base64(&b64(&[0u8; 100]), 10), Err("La foto pesa más de 0 KB.".into()));
    }

    #[test]
    fn la_ruta_del_bucket_es_uuid_barra_uuid_y_extension_conocida() {
        assert!(es_ruta_de_foto(&format!("{U1}/{U2}.webp")));
        assert!(es_ruta_de_foto(&format!("{U1}/{}.jpg", U2.to_uppercase())));
        for mala in [format!("{U1}/{U2}.gif"), format!("{U1}/{U2}.jpeg"), format!("../{U2}.png"), format!("{U1}/x.png"), format!("{U1}/{U2}"), String::new()] {
            assert!(!es_ruta_de_foto(&mala), "{mala}");
        }
        assert_eq!(ruta_nueva(U1, U2, TipoFoto::Jpeg), format!("{U1}/{U2}.jpg"));
    }

    #[test]
    fn la_data_url_lleva_el_mime_real() {
        assert_eq!(data_url(TipoFoto::Png, &[1, 2, 3]), "data:image/png;base64,AQID");
    }

    #[test]
    fn la_cache_olvida_la_menos_usada() {
        let mut c = CacheDeFotos::nueva(2);
        c.poner("a", "1");
        c.poner("b", "2");
        assert_eq!(c.obtener("a"), Some("1".into()));
        c.poner("c", "3");
        assert_eq!(c.obtener("b"), None);
        assert_eq!(c.obtener("a"), Some("1".into()));
        assert_eq!(c.tamano(), 2);
        c.vaciar();
        assert_eq!(c.tamano(), 0);
    }
}
