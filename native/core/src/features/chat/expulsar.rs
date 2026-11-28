//! Qué se le cuenta a la UI después de expulsar a alguien del equipo. Equivale a chat-expulsar.ts.
use super::tipos::ChatRemoveResult;

/// PostgREST responde PGRST202 cuando la función no existe; Postgres directo, 42883.
pub fn falta_la_funcion(code: Option<&str>) -> bool {
    matches!(code, Some("PGRST202" | "42883"))
}

pub const AVISO_0007: &str = "Tu servidor del chat no tiene la migración 0007 (expulsar). Se sacó a la persona como antes y se intentó cambiar el código aparte. Pedile a quien administra el Supabase que aplique supabase/migrations/0007_expulsar.sql.";

pub const REENVIAR: &str = "El código de invitación cambió: reenviá la invitación a quienes todavía no entraron.";

/// Qué se le cuenta a la UI después de expulsar, según si la RPC nueva estaba y si el código cambió.
pub fn resultado_de_expulsar(con_rpc: bool, codigo_nuevo: bool) -> ChatRemoveResult {
    if con_rpc {
        return ChatRemoveResult { codigo_nuevo: true, aviso: REENVIAR.into() };
    }
    if codigo_nuevo {
        return ChatRemoveResult { codigo_nuevo: true, aviso: format!("{REENVIAR} {AVISO_0007}") };
    }
    ChatRemoveResult {
        codigo_nuevo: false,
        aviso: format!("El código de invitación NO cambió: con la invitación vieja puede volver a entrar. {AVISO_0007}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconoce_que_la_rpc_no_existe_sin_la_0007_y_no_confunde_otros_errores() {
        assert!(falta_la_funcion(Some("PGRST202")));
        assert!(falta_la_funcion(Some("42883")));
        assert!(!falta_la_funcion(Some("P0001")));
        assert!(!falta_la_funcion(None));
    }

    #[test]
    fn siempre_avisa_que_hay_que_reenviar_invitaciones_y_pide_la_0007_si_no_estaba() {
        let con = resultado_de_expulsar(true, true);
        assert!(con.aviso.contains("reenviá"));
        assert!(!con.aviso.contains("0007"));
        let viejo = resultado_de_expulsar(false, false);
        assert!(!viejo.codigo_nuevo);
        assert!(viejo.aviso.contains("NO cambió") && viejo.aviso.contains("0007_expulsar.sql"));
        let medio = resultado_de_expulsar(false, true);
        assert!(medio.aviso.find("reenviá").unwrap() < medio.aviso.find("0007").unwrap());
    }
}
