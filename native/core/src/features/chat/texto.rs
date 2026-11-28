//! Texto de los mensajes (menciones y búsqueda), host de Supabase y borrado automático. Equivale a
//! src/shared/chat-text.ts y src/shared/chat-retention.ts. Los índices de las menciones son unidades UTF-16, como en la UI.
use super::tipos::{ChatNotice, ChatRole, TipoConv, CHAT_RETENTION_HOURS};
use super::Res;
use serde_json::Value;
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParteTexto {
    Texto(String),
    Mencion(String),
}

fn es_login(u: u16) -> bool {
    matches!(u, 0x30..=0x39 | 0x41..=0x5A | 0x61..=0x7A | 0x2D)
}

/// Lo que impide que un `@` cuente: es parte de un mail o de otra mención.
fn bloquea_arroba(u: u16) -> bool {
    matches!(u, 0x30..=0x39 | 0x41..=0x5A | 0x61..=0x7A | 0x5F | 0x40 | 0x2E)
}

fn s16(u: &[u16]) -> String {
    String::from_utf16_lossy(u)
}

pub fn dividir_menciones(text: &str) -> Vec<ParteTexto> {
    let u: Vec<u16> = text.encode_utf16().collect();
    let mut out = Vec::new();
    let mut ultimo = 0;
    let mut i = 0;
    while i < u.len() {
        if u[i] == 0x40 && (i == 0 || !bloquea_arroba(u[i - 1])) {
            let mut j = i + 1;
            while j < u.len() && es_login(u[j]) {
                j += 1;
            }
            let largo = j - (i + 1);
            if (1..=39).contains(&largo) && u[i + 1] != 0x2D {
                if i > ultimo {
                    out.push(ParteTexto::Texto(s16(&u[ultimo..i])));
                }
                out.push(ParteTexto::Mencion(s16(&u[i + 1..j])));
                ultimo = j;
                i = j;
                continue;
            }
        }
        i += 1;
    }
    if ultimo < u.len() {
        out.push(ParteTexto::Texto(s16(&u[ultimo..])));
    }
    out
}

pub fn menciona_a(body: &str, login: &str) -> bool {
    let want = login.to_lowercase();
    dividir_menciones(body).iter().any(|p| matches!(p, ParteTexto::Mencion(l) if l.to_lowercase() == want))
}

/// Si el cursor está terminando de escribir una mención: dónde empieza (el `@`) y lo escrito hasta ahí.
pub fn consulta_de_mencion(text: &str, caret: usize) -> Option<(usize, String)> {
    let u: Vec<u16> = text.encode_utf16().collect();
    if caret > u.len() || (caret < u.len() && es_login(u[caret])) {
        return None;
    }
    let previo = &u[..caret];
    let arroba = previo.iter().rposition(|&c| c == 0x40)?;
    let cola = &previo[arroba + 1..];
    if cola.len() > 39 || !cola.iter().all(|&c| es_login(c)) || (arroba > 0 && bloquea_arroba(previo[arroba - 1])) {
        return None;
    }
    Some((arroba, s16(cola)))
}

/// Reemplaza lo escrito entre `start` y `caret` por la mención completa, con un espacio después.
pub fn aplicar_mencion(text: &str, start: usize, caret: usize, login: &str) -> (String, usize) {
    let u: Vec<u16> = text.encode_utf16().collect();
    let resto = &u[caret.min(u.len())..];
    let con_espacio = resto.first() == Some(&0x20);
    let insertado = format!("@{login}{}", if con_espacio { "" } else { " " });
    let nuevo = format!("{}{insertado}{}", s16(&u[..start.min(u.len())]), s16(resto));
    (nuevo, start + insertado.encode_utf16().count() + usize::from(con_espacio))
}

/// Escapa los comodines de LIKE/ILIKE. PostgREST convierte todo `*` en `%` aunque vaya escapado, así que pasa a `_` y el
/// resultado hay que filtrarlo después con `contiene_texto`.
pub fn escapar_like(q: &str) -> String {
    let mut out = String::with_capacity(q.len());
    for c in q.chars() {
        match c {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(c);
            }
            '*' => out.push('_'),
            otro => out.push(otro),
        }
    }
    out
}

pub fn contiene_texto(body: &str, q: &str) -> bool {
    body.to_lowercase().contains(&q.to_lowercase())
}

/// ¿El host es el de un proyecto de Supabase en la nube (`<ref>.supabase.co`)? Uno parecido (`acme.supabase.co.otro.com`)
/// vería todo lo que se escribe: los que no pasan se muestran con una advertencia, no se rechazan.
pub fn es_host_supabase(host: &str) -> bool {
    let h = host.to_lowercase();
    let Some(r) = h.strip_suffix(".supabase.co") else { return false };
    (8..=40).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Lo que la UI manda para confirmar una invitación: con un servidor fuera de supabase.co va atado al host completo.
pub fn confirmacion_de_invitacion(decision: &str, host: &str) -> String {
    if es_host_supabase(host) {
        decision.to_string()
    } else {
        format!("{decision}@{host}")
    }
}

/// `host` de la URL como lo da WHATWG (con puerto si no es el de default).
pub fn host_de_url(url: &Url) -> Option<String> {
    let h = url.host_str()?;
    Some(match url.port() {
        Some(p) => format!("{h}:{p}"),
        None => h.to_string(),
    })
}

/// El host de la URL si no es de Supabase (para avisarlo); `None` si es `<ref>.supabase.co` o no es una URL.
pub fn host_no_supabase(url: &str) -> Option<String> {
    let host = host_de_url(&Url::parse(url).ok()?)?;
    (!es_host_supabase(&host)).then_some(host)
}

// ---------- borrado automático ----------

const HORA_MS: i64 = 3_600_000;

pub fn es_plazo(v: &Value) -> bool {
    v.as_f64().is_some_and(|n| CHAT_RETENTION_HOURS.iter().any(|&h| f64::from(h) == n))
}

/// Plazo que llega por IPC: uno de los permitidos o null (apagado).
pub fn parsear_retencion(raw: &Value) -> Res<Option<u32>> {
    if raw.is_null() {
        return Ok(None);
    }
    if !es_plazo(raw) {
        return Err("Plazo inválido.".into());
    }
    Ok(raw.as_f64().map(|n| n as u32))
}

/// Columna `retention_hours` → plazo; lo que no es un plazo permitido cuenta como apagado.
pub fn retencion_de(v: &Value) -> Option<u32> {
    if es_plazo(v) {
        v.as_f64().map(|n| n as u32)
    } else {
        None
    }
}

pub fn vencido(creado: i64, horas: Option<u32>, ahora: i64) -> bool {
    horas.is_some_and(|h| creado <= ahora - i64::from(h) * HORA_MS)
}

pub fn sacar_vencidos<T>(lista: Vec<T>, horas: Option<u32>, ahora: i64, creado: impl Fn(&T) -> i64) -> Vec<T> {
    if horas.is_none() {
        return lista;
    }
    lista.into_iter().filter(|m| !vencido(creado(m), horas, ahora)).collect()
}

pub fn etiqueta_de_retencion(horas: Option<u32>) -> &'static str {
    match horas {
        Some(24) => "24 horas",
        Some(168) => "7 días",
        Some(720) => "30 días",
        Some(2160) => "90 días",
        _ => "Nunca",
    }
}

/// Quién puede cambiar el borrado automático o vaciar: owner o admin en un equipo; en un DM, cualquiera.
pub fn puede_gestionar(kind: TipoConv, rol: Option<ChatRole>) -> bool {
    kind == TipoConv::Dm || matches!(rol, Some(ChatRole::Owner | ChatRole::Admin))
}

/// Columnas `kind` y `body` de un aviso → aviso; `None` si es un mensaje común o no se reconoce.
pub fn aviso_de_fila(kind: &Value, body: &Value) -> Option<ChatNotice> {
    if kind.as_str() == Some("clear") {
        return Some(ChatNotice::Clear);
    }
    let b = body.as_str()?;
    if kind.as_str() != Some("retention") || b.is_empty() || b.len() > 4 || !b.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let horas: u32 = b.parse().ok()?;
    if horas == 0 {
        return Some(ChatNotice::Retention { hours: None });
    }
    CHAT_RETENTION_HOURS.contains(&horas).then_some(ChatNotice::Retention { hours: Some(horas) })
}

pub fn texto_de_aviso(notice: &ChatNotice, login: &str) -> String {
    match notice {
        ChatNotice::Clear => format!("{login} vació la conversación"),
        ChatNotice::Retention { hours: None } => format!("{login} desactivó el borrado automático"),
        ChatNotice::Retention { hours } => format!("{login} activó el borrado automático: {}", etiqueta_de_retencion(*hours)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use ParteTexto::{Mencion, Texto};

    fn t(s: &str) -> ParteTexto {
        Texto(s.into())
    }
    fn m(s: &str) -> ParteTexto {
        Mencion(s.into())
    }

    #[test]
    fn menciones_separa_texto_y_logins() {
        assert_eq!(dividir_menciones("hola @Tomy, ¿venís?"), vec![t("hola "), m("Tomy"), t(", ¿venís?")]);
        assert_eq!(dividir_menciones("@ana"), vec![m("ana")]);
        assert_eq!(dividir_menciones(""), Vec::<ParteTexto>::new());
    }

    #[test]
    fn un_mail_no_es_una_mencion() {
        assert_eq!(dividir_menciones("escribí a a@b.com"), vec![t("escribí a a@b.com")]);
        assert!(!menciona_a("mandalo a tomy@empresa.com", "tomy"));
        assert!(!menciona_a("@@tomy", "tomy"));
        assert!(!menciona_a("@-tomy", "tomy"));
    }

    #[test]
    fn mencion_sin_distinguir_mayusculas() {
        assert!(menciona_a("ey @TOMY mirá", "tomy"));
        assert!(!menciona_a("ey @tomyx mirá", "tomy"));
        assert!(menciona_a("(@tomy)", "Tomy"));
    }

    #[test]
    fn un_login_de_mas_de_39_caracteres_no_es_mencion() {
        assert_eq!(dividir_menciones(&format!("@{}", "a".repeat(39))).len(), 1);
        assert_eq!(dividir_menciones(&format!("@{}", "a".repeat(40))), vec![t(&format!("@{}", "a".repeat(40)))]);
    }

    #[test]
    fn consulta_de_mencion_en_el_cursor() {
        assert_eq!(consulta_de_mencion("hola @to", 8), Some((5, "to".into())));
        assert_eq!(consulta_de_mencion("@", 1), Some((0, String::new())));
        assert_eq!(consulta_de_mencion("hola @tomy", 8), None);
        assert_eq!(consulta_de_mencion("mail a@b", 8), None);
        assert_eq!(consulta_de_mencion("hola @to y", 10), None);
        assert_eq!(consulta_de_mencion("x", 5), None);
    }

    #[test]
    fn aplicar_mencion_deja_un_espacio_despues() {
        assert_eq!(aplicar_mencion("hola @to", 5, 8, "tomy"), ("hola @tomy ".to_string(), 11));
        assert_eq!(aplicar_mencion("@to mirá", 0, 3, "tomy"), ("@tomy mirá".to_string(), 6));
    }

    #[test]
    fn escapar_comodines_de_like() {
        assert_eq!(escapar_like("50%_\\"), "50\\%\\_\\\\");
        assert_eq!(escapar_like("hola"), "hola");
        assert_eq!(escapar_like("a*b"), "a_b");
        assert!(contiene_texto("Hola A*B chau", "a*b"));
        assert!(!contiene_texto("axb", "a*b"));
    }

    #[test]
    fn es_host_supabase_solo_ref_supabase_co() {
        assert!(es_host_supabase("abcdefghijklmnopqrst.supabase.co"));
        assert!(es_host_supabase("ABCDEFGHIJ.SUPABASE.CO"));
        for h in ["acme.supabase.co.evil.example", "supabase.co", "evil-supabase.co", "a.b.supabase.co", "abcdefghij.supabase.co:8443", "chat.miempresa.com", ""] {
            assert!(!es_host_supabase(h), "{h}");
        }
    }

    #[test]
    fn con_un_servidor_propio_confirmar_exige_el_host_completo() {
        assert_eq!(confirmacion_de_invitacion("confirmNew", "abcdefghijklmnopqrst.supabase.co"), "confirmNew");
        assert_eq!(confirmacion_de_invitacion("confirmNew", "chat.miempresa.com"), "confirmNew@chat.miempresa.com");
        assert_eq!(confirmacion_de_invitacion("confirmReplace", "acme.supabase.co.evil.example"), "confirmReplace@acme.supabase.co.evil.example");
    }

    #[test]
    fn host_no_supabase_da_el_host_completo_de_un_servidor_propio() {
        assert_eq!(host_no_supabase("https://abcdefghijklmnopqrst.supabase.co"), None);
        assert_eq!(host_no_supabase("https://chat.miempresa.com:8443"), Some("chat.miempresa.com:8443".into()));
        assert_eq!(host_no_supabase("no es url"), None);
    }

    #[test]
    fn retencion_solo_acepta_los_plazos_permitidos_o_null() {
        assert_eq!(parsear_retencion(&json!(null)), Ok(None));
        assert_eq!(parsear_retencion(&json!(24)), Ok(Some(24)));
        assert_eq!(parsear_retencion(&json!(2160)), Ok(Some(2160)));
        for malo in [json!(0), json!(1), json!(48), json!(-24), json!(24.5), json!("24"), json!({})] {
            assert_eq!(parsear_retencion(&malo), Err("Plazo inválido.".into()), "{malo}");
        }
        assert_eq!(retencion_de(&json!(168)), Some(168));
        assert_eq!(retencion_de(&json!(null)), None);
        assert_eq!(retencion_de(&json!(12)), None);
    }

    #[test]
    fn retencion_vence_justo_al_cumplirse_el_plazo() {
        let ahora = 1_000 * HORA_MS;
        assert!(vencido(ahora - 24 * HORA_MS, Some(24), ahora));
        assert!(!vencido(ahora - 24 * HORA_MS + 1, Some(24), ahora));
        assert!(!vencido(0, None, ahora));
    }

    #[test]
    fn sacar_vencidos_saca_los_viejos_y_deja_todo_si_no_hay() {
        let ahora = 1_000 * HORA_MS;
        let lista = vec![ahora - 200 * HORA_MS, ahora - 2 * HORA_MS];
        assert_eq!(sacar_vencidos(lista.clone(), Some(168), ahora, |x| *x), vec![ahora - 2 * HORA_MS]);
        assert_eq!(sacar_vencidos(lista.clone(), Some(720), ahora, |x| *x), lista);
        assert_eq!(sacar_vencidos(lista.clone(), None, ahora, |x| *x), lista);
    }

    #[test]
    fn retencion_etiquetas() {
        assert_eq!(etiqueta_de_retencion(None), "Nunca");
        assert_eq!(etiqueta_de_retencion(Some(24)), "24 horas");
        assert_eq!(etiqueta_de_retencion(Some(168)), "7 días");
        assert_eq!(etiqueta_de_retencion(Some(720)), "30 días");
        assert_eq!(etiqueta_de_retencion(Some(2160)), "90 días");
    }

    #[test]
    fn permisos_owner_y_admin_en_equipos_cualquiera_en_un_dm() {
        assert!(puede_gestionar(TipoConv::Team, Some(ChatRole::Owner)));
        assert!(puede_gestionar(TipoConv::Team, Some(ChatRole::Admin)));
        assert!(!puede_gestionar(TipoConv::Team, Some(ChatRole::Member)));
        assert!(!puede_gestionar(TipoConv::Team, None));
        assert!(puede_gestionar(TipoConv::Dm, None));
    }

    #[test]
    fn avisos_de_la_fila_al_texto() {
        assert_eq!(aviso_de_fila(&json!("clear"), &json!("clear")), Some(ChatNotice::Clear));
        assert_eq!(aviso_de_fila(&json!("retention"), &json!("168")), Some(ChatNotice::Retention { hours: Some(168) }));
        assert_eq!(aviso_de_fila(&json!("retention"), &json!("0")), Some(ChatNotice::Retention { hours: None }));
        assert_eq!(aviso_de_fila(&json!("retention"), &json!("5")), None);
        assert_eq!(aviso_de_fila(&json!("retention"), &json!("x")), None);
        assert_eq!(aviso_de_fila(&json!("text"), &json!("hola")), None);
        assert_eq!(aviso_de_fila(&Value::Null, &json!("hola")), None);
        assert_eq!(texto_de_aviso(&ChatNotice::Clear, "ana"), "ana vació la conversación");
        assert_eq!(texto_de_aviso(&ChatNotice::Retention { hours: Some(168) }, "ana"), "ana activó el borrado automático: 7 días");
        assert_eq!(texto_de_aviso(&ChatNotice::Retention { hours: None }, "ana"), "ana desactivó el borrado automático");
    }
}
