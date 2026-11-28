//! Qué hacer con un primer mensaje que no se pudo pasar como argumento. Equivale a src/main/primer-mensaje.ts.

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum DestinoPrimerMensaje {
    Pegar,
    AMano,
    Ninguno,
}

/// Se pega cuando arranca el agente solo si avisa de su arranque con un hook: sin hook nadie dispara el pegado
/// y el mensaje se perdería en silencio.
pub fn destino_primer_mensaje(hooks: bool, paste: Option<&str>) -> DestinoPrimerMensaje {
    match (paste, hooks) {
        (None, _) => DestinoPrimerMensaje::Ninguno,
        (Some(_), true) => DestinoPrimerMensaje::Pegar,
        (Some(_), false) => DestinoPrimerMensaje::AMano,
    }
}

pub fn aviso_primer_mensaje_a_mano(agente: &str, espacio: &str) -> String {
    format!("{agente} no recibe el primer mensaje solo en «{espacio}»: escribilo a mano.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sin_texto_para_pegar_no_hay_destino() {
        assert_eq!(destino_primer_mensaje(true, None), DestinoPrimerMensaje::Ninguno);
        assert_eq!(destino_primer_mensaje(false, None), DestinoPrimerMensaje::Ninguno);
    }

    #[test]
    fn con_hooks_se_pega_y_sin_hooks_se_avisa() {
        assert_eq!(destino_primer_mensaje(true, Some("hola")), DestinoPrimerMensaje::Pegar);
        assert_eq!(destino_primer_mensaje(false, Some("hola")), DestinoPrimerMensaje::AMano);
    }

    #[test]
    fn el_aviso_nombra_al_agente_y_al_espacio() {
        assert_eq!(aviso_primer_mensaje_a_mano("Codex", "api"), "Codex no recibe el primer mensaje solo en «api»: escribilo a mano.");
    }
}
