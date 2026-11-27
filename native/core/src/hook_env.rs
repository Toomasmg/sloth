//! Entorno de la terminal de un espacio. Equivale a src/main/hook-env-core.ts.
use std::collections::BTreeMap;

pub struct DatosHook {
    pub url: String,
    pub token: String,
}

pub struct Capacidades {
    pub hooks: bool,
    pub aviso_turno: bool,
}

/// URL y token del canal de hooks solo van si el agente los usa: con Claude hooks y statusline; con Codex solo el aviso
/// de turno y solo si la cuenta lo activó. El token es por espacio.
pub fn entorno_de_terminal(
    base: &BTreeMap<String, String>,
    cap: &Capacidades,
    aviso_activo: bool,
    ws: &str,
    hook: impl FnOnce() -> DatosHook,
) -> BTreeMap<String, String> {
    let mut e = base.clone();
    e.insert("SLOTH_WS".into(), ws.into());
    if !cap.hooks && !(cap.aviso_turno && aviso_activo) {
        return e;
    }
    let h = hook();
    e.insert("SLOTH_HOOK_URL".into(), h.url);
    e.insert("SLOTH_TOKEN".into(), h.token);
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> BTreeMap<String, String> {
        BTreeMap::from([("PATH".to_string(), "x".to_string())])
    }
    fn hook() -> DatosHook {
        DatosHook { url: "http://127.0.0.1:1/hook".into(), token: "t".into() }
    }

    #[test]
    fn claude_con_hooks_lleva_url_y_token() {
        let e = entorno_de_terminal(&base(), &Capacidades { hooks: true, aviso_turno: false }, false, "w1", hook);
        assert_eq!(e["SLOTH_WS"], "w1");
        assert_eq!(e["SLOTH_HOOK_URL"], "http://127.0.0.1:1/hook");
        assert_eq!(e["SLOTH_TOKEN"], "t");
        assert_eq!(e["PATH"], "x");
    }

    #[test]
    fn sin_hooks_ni_aviso_solo_va_el_espacio_y_no_se_pide_el_hook() {
        let e = entorno_de_terminal(&base(), &Capacidades { hooks: false, aviso_turno: false }, true, "w1", || panic!("no debía pedirse"));
        assert!(!e.contains_key("SLOTH_HOOK_URL") && !e.contains_key("SLOTH_TOKEN"));
        assert_eq!(e["SLOTH_WS"], "w1");
    }

    #[test]
    fn codex_solo_con_el_aviso_de_turno_activado() {
        let cap = Capacidades { hooks: false, aviso_turno: true };
        assert!(!entorno_de_terminal(&base(), &cap, false, "w", || panic!("no debía pedirse")).contains_key("SLOTH_TOKEN"));
        assert!(entorno_de_terminal(&base(), &cap, true, "w", hook).contains_key("SLOTH_TOKEN"));
    }
}
