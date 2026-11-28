//! Diagnóstico (`feat:diagnostico:*`), como src/main/features/diagnostico.ts. Lo atiende el núcleo porque vive de lo
//! que tiene él: el log en memoria, la marca de cierre inesperado, los ajustes y la lista de funciones del apoyo.
use super::arg;
use super::report::{arquitectura, producto_y_release};
use crate::nucleo::arranque::ahora_ms;
use crate::nucleo::Nucleo;
use crate::router::Router;
use serde_json::Value;
use sloth_core::features::diagnostico::{ajustes_booleanos, leer_error_renderer, texto_diagnostico, DatosDiagnostico, Limite, Nivel};
use sloth_core::features::redactar::{redactar, ContextoRedaccion};
use sloth_core::logger_global as log;
use std::sync::{Arc, Mutex};

pub const NOMBRE: &str = "diagnostico";

/// Errores de la interfaz que se anotan como mucho por minuto: un render que falla en bucle no llena el log.
const ERRORES_POR_MINUTO: usize = 20;

/// `process.platform` de Node, que es lo que mostraba el diagnóstico.
fn plataforma_de_node() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        otra => otra,
    }
}

fn texto(n: &Nucleo, webview: &str) -> String {
    let entradas = log::recientes(200);
    let mut funciones: Vec<String> = super::nombres_en_rust().map(str::to_owned).collect();
    funciones.extend(n.funciones_del_apoyo());
    let (cuentas, espacios) = {
        let s = n.store();
        (s.accounts().len(), s.workspaces().len())
    };
    let (_, release) = producto_y_release();
    let datos = DatosDiagnostico {
        sloth: n.plataforma.version(),
        webview: webview.to_string(),
        so: [plataforma_de_node(), &release, arquitectura()].iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join(" "),
        features: funciones,
        cuentas,
        espacios,
        ajustes: ajustes_booleanos(&Value::Object(n.ajustes())),
        errores: entradas.iter().filter(|e| e.nivel == Nivel::Error).cloned().collect(),
        avisos: entradas.iter().filter(|e| e.nivel == Nivel::Aviso).map(|e| format!("{}: {}", e.origen, e.msg)).collect(),
        crash_previo: n.crash.hubo(),
        fallos_log: log::fallo(),
        ..Default::default()
    };
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let user_data = n.arranque.raiz.to_string_lossy();
    redactar(&texto_diagnostico(&datos, ahora_ms() as f64), &ContextoRedaccion { home: &home, user_data: &user_data })
}

/// `webview`: la versión de WebView2 (la da Tauri al arrancar; vacía si no se pudo leer).
pub fn registrar(router: &mut Router, nucleo: &Arc<Nucleo>, webview: String) {
    let n = nucleo.clone();
    router.registrar("feat:diagnostico:texto", move |_| Ok(Value::String(texto(&n, &webview))));
    let n = nucleo.clone();
    router.registrar("feat:diagnostico:crashPrevio", move |_| Ok(Value::Bool(n.crash.tomar())));
    let limite = Mutex::new(Limite::nuevo(ERRORES_POR_MINUTO, 60_000.0));
    router.registrar("feat:diagnostico:errorRenderer", move |a| {
        let Some(t) = leer_error_renderer(arg(&a, 0)) else { return Ok(Value::Null) };
        if limite.lock().unwrap_or_else(|e| e.into_inner()).pasa(ahora_ms() as f64) {
            log::error("renderer", t);
        }
        Ok(Value::Null)
    });
}
