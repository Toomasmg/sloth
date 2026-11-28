//! Chat (datos): la parte de red de las fotos de equipo, sobre Supabase Storage. Bucket PRIVADO `team-photos`. Lo que se
//! sube ya pasó por `decodificar_foto_del_equipo` (tamaño y bytes mágicos), y lo que se baja se revalida por bytes: la
//! base no es confiable. Nunca se loguean bytes.
use super::fotos::{data_url, detectar_foto, es_ruta_de_foto, ruta_nueva, Foto, PHOTO_BUCKET};
use super::http::Pedido;
use super::postgrest::Supabase;
use super::tipos::LIMITE_FOTO_BYTES;
use super::Res;
use serde_json::json;

const TIMEOUT_MS: u64 = 30_000;

/// La ruta ya validada va en la URL: solo hay `[0-9a-f-]`, `/` y la extensión, nada que escapar.
fn url_objeto(sb: &Supabase, ruta: &str) -> String {
    format!("{}/storage/v1/object/{PHOTO_BUCKET}/{ruta}", sb.url())
}

fn pedido(sb: &Supabase, metodo: &'static str, url: &str) -> Pedido {
    let mut p = Pedido::nuevo(metodo, url).con_timeout(TIMEOUT_MS);
    for (k, v) in sb.cabeceras() {
        p = p.con_cabecera(&k, &v);
    }
    p
}

/// Sube la foto a `<teamId>/<uuid>.<ext>` y devuelve la ruta. `uuid` lo da quien llama (así se prueba).
pub fn subir_foto(sb: &Supabase, team_id: &str, uuid: &str, foto: &Foto) -> Res<String> {
    let ruta = ruta_nueva(team_id, uuid, foto.tipo);
    if !es_ruta_de_foto(&ruta) {
        return Err("No se pudo subir la foto.".into());
    }
    let p = pedido(sb, "POST", &url_objeto(sb, &ruta)).con_cabecera("Content-Type", foto.tipo.mime()).con_cabecera("cache-control", "max-age=3600").con_cabecera("x-upsert", "false").con_cuerpo(foto.bytes.clone());
    match sb.http().pedir(&p) {
        Ok(r) if r.ok() => Ok(ruta),
        _ => Err("No se pudo subir la foto.".into()),
    }
}

/// Borra una foto (best effort: un fallo no es fatal).
pub fn borrar_foto(sb: &Supabase, ruta: &str) {
    if !es_ruta_de_foto(ruta) {
        return;
    }
    let p = pedido(sb, "DELETE", &format!("{}/storage/v1/object/{PHOTO_BUCKET}", sb.url())).con_cabecera("Content-Type", "application/json").con_cuerpo(json!({"prefixes": [ruta]}).to_string().into_bytes());
    let _ = sb.http().pedir(&p);
}

/// Baja la foto y la devuelve como `data:` URL. Revalida tipo y tamaño por bytes.
pub fn bajar_foto(sb: &Supabase, ruta: &str) -> Res<String> {
    if !es_ruta_de_foto(ruta) {
        return Err("Ruta de foto inválida.".into());
    }
    let r = sb.http().pedir(&pedido(sb, "GET", &url_objeto(sb, ruta))).ok().filter(|r| r.ok()).ok_or("No se pudo bajar la foto.")?;
    if r.cuerpo.len() > LIMITE_FOTO_BYTES {
        return Err("La foto pesa demasiado.".into());
    }
    let tipo = detectar_foto(&r.cuerpo).ok_or("La foto no es una imagen válida.")?;
    Ok(data_url(tipo, &r.cuerpo))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::chat::fotos::TipoFoto;
    use crate::features::chat::http::pruebas::HttpFalso;
    use crate::features::chat::http::{ErrorRed, Respuesta};
    use crate::features::chat::postgrest::pruebas::cliente_falso;

    const EQUIPO: &str = "11111111-1111-4111-8111-111111111111";
    const FOTO: &str = "22222222-2222-4222-8222-222222222222";
    const PNG: [u8; 12] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];

    fn foto() -> Foto {
        Foto { bytes: PNG.to_vec(), tipo: TipoFoto::Png }
    }

    #[test]
    fn subir_manda_los_bytes_al_bucket_privado_y_devuelve_la_ruta() {
        let http = HttpFalso::nuevo(|_| Ok(Respuesta { estado: 200, cuerpo: b"{}".to_vec() }));
        let ruta = subir_foto(&cliente_falso(http.clone()), EQUIPO, FOTO, &foto()).unwrap();
        assert_eq!(ruta, format!("{EQUIPO}/{FOTO}.png"));
        let p = http.pedidos.lock().unwrap()[0].clone();
        assert_eq!((p.metodo, p.url.as_str()), ("POST", format!("https://x.supabase.co/storage/v1/object/team-photos/{ruta}").as_str()));
        assert_eq!(p.cuerpo.as_deref(), Some(PNG.as_slice()));
        let cab = |k: &str| p.cabeceras.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(cab("Content-Type").as_deref(), Some("image/png"));
        assert_eq!(cab("x-upsert").as_deref(), Some("false"));
        assert_eq!(cab("Authorization").as_deref(), Some("Bearer jwt"));
    }

    #[test]
    fn subir_falla_con_el_mensaje_de_siempre_si_el_servidor_rechaza_o_no_hay_red() {
        for h in [HttpFalso::nuevo(|_| Ok(Respuesta { estado: 403, cuerpo: Vec::new() })), HttpFalso::nuevo(|_| Err(ErrorRed::Timeout))] {
            assert_eq!(subir_foto(&cliente_falso(h), EQUIPO, FOTO, &foto()), Err("No se pudo subir la foto.".to_string()));
        }
    }

    #[test]
    fn un_equipo_que_no_es_uuid_no_sube_nada() {
        let http = HttpFalso::nuevo(|_| unreachable!());
        assert!(subir_foto(&cliente_falso(http), "../x", FOTO, &foto()).is_err());
    }

    #[test]
    fn borrar_solo_toca_rutas_validas_y_no_tira() {
        let http = HttpFalso::nuevo(|_| Err(ErrorRed::Timeout));
        let sb = cliente_falso(http.clone());
        borrar_foto(&sb, "cualquier/cosa");
        assert!(http.pedidos.lock().unwrap().is_empty());
        let ruta = format!("{EQUIPO}/{FOTO}.webp");
        borrar_foto(&sb, &ruta);
        let p = http.pedidos.lock().unwrap()[0].clone();
        assert_eq!((p.metodo, p.url.as_str()), ("DELETE", "https://x.supabase.co/storage/v1/object/team-photos"));
        assert_eq!(serde_json::from_slice::<serde_json::Value>(p.cuerpo.as_ref().unwrap()).unwrap(), json!({"prefixes": [ruta]}));
    }

    #[test]
    fn bajar_devuelve_data_url_segun_los_bytes_no_segun_lo_que_diga_el_servidor() {
        let http = HttpFalso::nuevo(|_| Ok(Respuesta { estado: 200, cuerpo: PNG.to_vec() }));
        let u = bajar_foto(&cliente_falso(http), &format!("{EQUIPO}/{FOTO}.jpg")).unwrap();
        assert!(u.starts_with("data:image/png;base64,iVBORw0KGgo"), "{u}");
    }

    #[test]
    fn bajar_rechaza_ruta_invalida_no_imagen_y_demasiado_grande() {
        let sb = |cuerpo: Vec<u8>, estado: u16| cliente_falso(HttpFalso::nuevo(move |_| Ok(Respuesta { estado, cuerpo: cuerpo.clone() })));
        let ruta = format!("{EQUIPO}/{FOTO}.png");
        assert_eq!(bajar_foto(&sb(PNG.to_vec(), 200), "x/y.png"), Err("Ruta de foto inválida.".to_string()));
        assert_eq!(bajar_foto(&sb(b"<html>".to_vec(), 200), &ruta), Err("La foto no es una imagen válida.".to_string()));
        assert_eq!(bajar_foto(&sb(PNG.to_vec(), 404), &ruta), Err("No se pudo bajar la foto.".to_string()));
        let mut grande = PNG.to_vec();
        grande.resize(LIMITE_FOTO_BYTES + 1, 0);
        assert_eq!(bajar_foto(&sb(grande, 200), &ruta), Err("La foto pesa demasiado.".to_string()));
    }
}
