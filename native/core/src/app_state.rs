//! El estado que ve la interfaz y las reglas de la ventana y del arranque de src/main/index.ts. Lo que es Electron
//! (BrowserWindow, bandeja, menús, `app.*`, protocolos, permisos de Chromium) queda detrás del trait `Plataforma`.
use crate::agent_machine::{siguiente_estado, EntradaAgente, EstadoAgente};
use crate::store::{CausaSoloLectura, SoloLecturaStore};
use crate::window_state_core::Rect;
use serde_json::{json, Map, Value};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EstadoDeAgente {
    pub estado: EstadoAgente,
    pub detalle: Option<String>,
    pub at: u64,
}

impl EstadoDeAgente {
    pub fn a_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("state".into(), Value::String(self.estado.como_texto().into()));
        if let Some(d) = &self.detalle {
            o.insert("detail".into(), Value::String(d.clone()));
        }
        o.insert("at".into(), Value::from(self.at));
        Value::Object(o)
    }
}

/// El estado de cada espacio, en el orden en que se fue sabiendo (como un `Map` de JS: actualizar no cambia el lugar).
#[derive(Debug, Default)]
pub struct Agentes {
    items: Vec<(String, EstadoDeAgente)>,
}

impl Agentes {
    pub fn get(&self, ws: &str) -> Option<&EstadoDeAgente> {
        self.items.iter().find(|(k, _)| k == ws).map(|(_, v)| v)
    }

    pub fn fijar(&mut self, ws: &str, e: EstadoDeAgente) {
        match self.items.iter_mut().find(|(k, _)| k == ws) {
            Some((_, v)) => *v = e,
            None => self.items.push((ws.to_owned(), e)),
        }
    }

    pub fn quitar(&mut self, ws: &str) {
        self.items.retain(|(k, _)| k != ws);
    }

    pub fn contiene(&self, ws: &str) -> bool {
        self.get(ws).is_some()
    }

    /// Aplica una entrada del ciclo de vida. Devuelve el estado nuevo, o `None` si no cambió nada.
    pub fn mover(&mut self, ws: &str, entrada: EntradaAgente, detalle: Option<String>, at: Option<u64>, ahora: u64) -> Option<EstadoDeAgente> {
        let estado = siguiente_estado(self.get(ws).map(|e| e.estado), entrada)?;
        let nuevo = EstadoDeAgente { estado, detalle, at: at.unwrap_or(ahora) };
        self.fijar(ws, nuevo.clone());
        Some(nuevo)
    }

    pub fn a_json(&self) -> Value {
        Value::Object(self.items.iter().map(|(k, v)| (k.clone(), v.a_json())).collect())
    }
}

pub fn solo_lectura_json(s: &SoloLecturaStore) -> Value {
    let causa = match s.causa {
        CausaSoloLectura::VersionFutura => "version-futura",
        CausaSoloLectura::Io => "io",
    };
    json!({ "motivo": s.motivo, "archivo": s.archivo.to_string_lossy(), "causa": causa })
}

/// La respuesta de `state:get`.
pub fn armar_estado(cuentas: &[Value], espacios: &[Value], paneles_abiertos: &[String], agentes: &Agentes, solo_lectura: Option<&SoloLecturaStore>) -> Value {
    let mut o = Map::new();
    o.insert("accounts".into(), Value::Array(cuentas.to_vec()));
    o.insert("workspaces".into(), Value::Array(espacios.to_vec()));
    o.insert("openPanes".into(), json!(paneles_abiertos));
    o.insert("agents".into(), agentes.a_json());
    if let Some(s) = solo_lectura {
        o.insert("soloLectura".into(), solo_lectura_json(s));
    }
    Value::Object(o)
}

pub fn detalle_de_shells_en_fondo(n: usize) -> String {
    if n == 1 { "Shell en segundo plano".into() } else { format!("{n} shells en segundo plano") }
}

/// Estado de un evento de hook: con shells de fondo corriendo, terminar el turno sigue siendo «trabajando».
pub fn estado_de_hook(en_fondo: usize, por_evento: Option<(EstadoAgente, Option<String>)>) -> Option<(EstadoAgente, Option<String>)> {
    if en_fondo > 0 {
        return Some((EstadoAgente::Working, Some(detalle_de_shells_en_fondo(en_fondo))));
    }
    por_evento
}

/// Si el aviso del shell nunca llega, no queda «trabajando» para siempre: cuándo se pasa a «terminó» (ms desde ahora).
pub fn espera_hasta_dar_por_terminado(vence: u64, ahora: u64) -> u64 {
    vence.saturating_sub(ahora) + 1000
}

pub const ANCHO_INICIAL: f64 = 1500.0;
pub const ALTO_INICIAL: f64 = 920.0;
pub const ANCHO_MINIMO: f64 = 900.0;
pub const ALTO_MINIMO: f64 = 560.0;
pub const ALTO_BARRA_TITULO: u32 = 40;

#[derive(Debug, PartialEq)]
pub struct OpcionesDeVentana {
    pub ancho: f64,
    pub alto: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub ancho_minimo: f64,
    pub alto_minimo: f64,
    pub fondo: String,
    pub simbolo: String,
    pub alto_barra_titulo: u32,
    pub titulo: &'static str,
    pub ocultar_menu: bool,
    pub mostrar_al_crear: bool,
}

/// Tema guardado ANTES de crear la ventana (sin destello) y tamaño y posición de la última vez.
pub fn opciones_de_ventana(guardado: Option<&Rect>, fondo: &str, simbolo: &str) -> OpcionesDeVentana {
    OpcionesDeVentana {
        ancho: guardado.map_or(ANCHO_INICIAL, |b| b.width),
        alto: guardado.map_or(ALTO_INICIAL, |b| b.height),
        x: guardado.map(|b| b.x),
        y: guardado.map(|b| b.y),
        ancho_minimo: ANCHO_MINIMO,
        alto_minimo: ALTO_MINIMO,
        fondo: fondo.into(),
        simbolo: simbolo.into(),
        alto_barra_titulo: ALTO_BARRA_TITULO,
        titulo: "Sloth",
        ocultar_menu: true,
        mostrar_al_crear: false,
    }
}

/// Preferencias de la página: aislada, sin Node, con sandbox y sin corrector ortográfico.
pub const PREFERENCIAS_WEB: [(&str, bool); 6] = [
    ("contextIsolation", true),
    ("nodeIntegration", false),
    ("sandbox", true),
    ("webSecurity", true),
    ("spellcheck", false),
    // Con la ventana minimizada u oculta, Chromium baja timers y dibujo.
    ("backgroundThrottling", true),
];

/// Links externos al navegador; la ventana nunca navega fuera de la app.
pub fn es_enlace_externo(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// Bajo consumo: apagamos lo que Chromium trae y Sloth no usa.
pub const FEATURES_APAGADAS: &str = "SpareRendererForSitePerProcess,MediaRouter,HardwareMediaKeyHandling,GlobalMediaControls,Translate,AutofillServerCommunication";

/// Modo liviano: en PCs con ≤ 8 GB de RAM se apaga la GPU. `SLOTH_GPU=1/0` lo fuerza.
pub fn gpu_apagada(preferencia: Option<&str>, memoria_total_bytes: u64) -> bool {
    let baja = memoria_total_bytes as f64 <= 8.5 * 1024f64.powi(3);
    preferencia == Some("0") || (preferencia != Some("1") && baja)
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn normalizar(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            Component::CurDir => {}
            otro => out.push(otro.as_os_str()),
        }
    }
    out
}

/// El archivo de la UI que corresponde a `app://ui/<pathname>`, o `None` (403) si cae fuera de su carpeta.
pub fn archivo_del_renderer(raiz: &Path, pathname: &str) -> Option<PathBuf> {
    let raiz = normalizar(raiz);
    let decodificado = percent_decode(pathname)?;
    let relativo = decodificado.trim_start_matches(['/', '\\']);
    let archivo = normalizar(&raiz.join(relativo));
    (archivo != raiz && archivo.starts_with(&raiz)).then_some(archivo)
}

pub const PROHIBIDO: &str = "Prohibido";

pub const TITULO_ERROR_INESPERADO: &str = "Sloth tuvo un error inesperado";
pub const TEXTO_ERROR_INESPERADO: &str = "Quedó registrado en el log. Podés copiar el diagnóstico desde la paleta (Ctrl+K).";

pub fn texto_perfiles_bloqueados(motivo: &str) -> String {
    format!("{motivo}\n\nNo toqué ninguno de tus datos. Cerrá otras copias de Sloth, revisá que ningún antivirus tenga esos archivos y volvé a abrir Sloth.")
}

pub const TITULO_PERFILES_BLOQUEADOS: &str = "Sloth no puede abrir tus perfiles";

/// Los dos únicos motivos para registrar la caída de un proceso: una salida limpia no es un error.
pub fn texto_de_proceso_caido(tipo: Option<&str>, nombre: Option<&str>, motivo: &str, codigo: i64) -> Option<String> {
    if motivo == "clean-exit" {
        return None;
    }
    Some(match tipo {
        None => format!("se cayó el proceso de la ventana ({motivo}, código {codigo})"),
        Some(t) => format!("se cayó {t}{} ({motivo}, código {codigo})", nombre.filter(|n| !n.is_empty()).map_or(String::new(), |n| format!(" {n}"))),
    })
}

pub fn linea_de_arranque(version: &str, crash_previo: bool) -> String {
    format!("Sloth {version} arrancó{}", if crash_previo { " (la sesión anterior no cerró limpia)" } else { "" })
}

/// Espera máxima del cierre ordenado de terminales antes de salir igual.
pub const ESPERA_CIERRE_MS: u64 = 5000;

/// Lo que solo puede hacer el sistema o Electron. El núcleo decide; quien implemente esto ejecuta.
pub trait Plataforma {
    fn nombre_app(&self) -> String;
    fn version(&self) -> String;
    fn empaquetada(&self) -> bool;
    fn carpeta_de_datos(&self) -> PathBuf;
    fn pedir_instancia_unica(&self) -> bool;
    fn salir(&self, codigo: i32);
    fn reiniciar(&self);
    fn enviar_a_la_ventana(&self, canal: &str, args: &[Value]);
    fn ventana_existe(&self) -> bool;
    fn crear_ventana(&self, opciones: &OpcionesDeVentana);
    fn mostrar_ventana(&self, maximizada: bool, bounds: Option<&Rect>);
    fn enfocar_ventana(&self);
    fn zoom_actual(&self) -> f64;
    fn fijar_zoom(&self, nivel: f64);
    fn abrir_enlace_externo(&self, url: &str) -> Result<(), String>;
    fn abrir_ruta(&self, ruta: &str) -> Result<(), String>;
    fn elegir_carpeta(&self) -> Option<String>;
    fn mostrar_error(&self, titulo: &str, texto: &str);
    fn leer_portapapeles(&self) -> Value;
    fn escribir_portapapeles(&self, texto: &str);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn el_estado_de_la_ui_lleva_las_claves_en_orden_y_omite_solo_lectura_si_no_hay() {
        let mut ag = Agentes::default();
        ag.fijar("w1", EstadoDeAgente { estado: EstadoAgente::Working, detalle: Some("Bash".into()), at: 9 });
        let e = armar_estado(&[json!({ "id": "a" })], &[json!({ "id": "w1" })], &["w1".to_owned()], &ag, None);
        assert_eq!(e.as_object().unwrap().keys().collect::<Vec<_>>(), ["accounts", "workspaces", "openPanes", "agents"]);
        assert_eq!(e["agents"], json!({ "w1": { "state": "working", "detail": "Bash", "at": 9 } }));
        assert_eq!(e["openPanes"], json!(["w1"]));
    }

    #[test]
    fn el_estado_en_solo_lectura_informa_el_motivo_y_la_causa() {
        let s = SoloLecturaStore { motivo: "versión futura".into(), archivo: PathBuf::from("sloth-state.json"), causa: CausaSoloLectura::VersionFutura };
        let e = armar_estado(&[], &[], &[], &Agentes::default(), Some(&s));
        assert_eq!(e["soloLectura"], json!({ "motivo": "versión futura", "archivo": "sloth-state.json", "causa": "version-futura" }));
        let io = SoloLecturaStore { causa: CausaSoloLectura::Io, ..s };
        assert_eq!(armar_estado(&[], &[], &[], &Agentes::default(), Some(&io))["soloLectura"]["causa"], "io");
    }

    #[test]
    fn el_estado_sin_detalle_no_lleva_la_clave() {
        let e = EstadoDeAgente { estado: EstadoAgente::Idle, detalle: None, at: 3 };
        assert_eq!(e.a_json().as_object().unwrap().keys().collect::<Vec<_>>(), ["state", "at"]);
    }

    #[test]
    fn mover_aplica_la_maquina_y_no_cambia_el_orden_de_los_espacios() {
        let mut ag = Agentes::default();
        assert_eq!(ag.mover("a", EntradaAgente::Start, None, None, 10).unwrap().estado, EstadoAgente::Idle);
        ag.mover("b", EntradaAgente::Start, None, None, 11);
        let n = ag.mover("a", EntradaAgente::Hook(EstadoAgente::Working), Some("x".into()), Some(50), 60).unwrap();
        assert_eq!((n.at, n.detalle.as_deref()), (50, Some("x")));
        assert_eq!(ag.a_json().as_object().unwrap().keys().collect::<Vec<_>>(), ["a", "b"]);
        // Reconectarse a una terminal que seguía viva no pisa lo que estaba haciendo.
        assert_eq!(ag.mover("a", EntradaAgente::Start, None, None, 70), None);
        assert_eq!(ag.get("a").unwrap().estado, EstadoAgente::Working);
        ag.mover("a", EntradaAgente::Exit, None, None, 80);
        assert_eq!(ag.mover("a", EntradaAgente::Hook(EstadoAgente::Done), None, None, 90), None);
        ag.quitar("a");
        assert!(!ag.contiene("a") && ag.contiene("b"));
    }

    #[test]
    fn con_shells_de_fondo_el_estado_es_trabajando_con_su_detalle() {
        assert_eq!(estado_de_hook(1, Some((EstadoAgente::Done, None))), Some((EstadoAgente::Working, Some("Shell en segundo plano".into()))));
        assert_eq!(estado_de_hook(3, None), Some((EstadoAgente::Working, Some("3 shells en segundo plano".into()))));
        assert_eq!(estado_de_hook(0, Some((EstadoAgente::Done, None))), Some((EstadoAgente::Done, None)));
        assert_eq!(estado_de_hook(0, None), None);
    }

    #[test]
    fn el_temporizador_del_fondo_da_un_segundo_de_gracia() {
        assert_eq!(espera_hasta_dar_por_terminado(5000, 2000), 4000);
        assert_eq!(espera_hasta_dar_por_terminado(1000, 2000), 1000);
    }

    #[test]
    fn la_ventana_arranca_con_lo_guardado_o_con_el_tamano_de_siempre() {
        let o = opciones_de_ventana(None, "#111", "#eee");
        assert_eq!((o.ancho, o.alto, o.x, o.y), (1500.0, 920.0, None, None));
        assert_eq!((o.ancho_minimo, o.alto_minimo, o.alto_barra_titulo), (900.0, 560.0, 40));
        assert!(!o.mostrar_al_crear && o.ocultar_menu);
        let g = Rect { x: 10.0, y: 20.0, width: 1000.0, height: 700.0 };
        let o = opciones_de_ventana(Some(&g), "#fff", "#000");
        assert_eq!((o.ancho, o.alto, o.x, o.y), (1000.0, 700.0, Some(10.0), Some(20.0)));
        assert_eq!((o.fondo.as_str(), o.simbolo.as_str()), ("#fff", "#000"));
    }

    #[test]
    fn solo_los_links_http_salen_al_navegador() {
        assert!(es_enlace_externo("https://claude.ai"));
        assert!(es_enlace_externo("http://localhost:3000"));
        for no in ["file:///C:/x", "javascript:alert(1)", "app://ui/", "HTTP://x", " https://x", "ftp://x"] {
            assert!(!es_enlace_externo(no), "{no}");
        }
    }

    #[test]
    fn la_gpu_se_apaga_con_8_gb_o_menos_salvo_que_se_fuerce() {
        const GB: u64 = 1024 * 1024 * 1024;
        assert!(gpu_apagada(None, 8 * GB));
        assert!(!gpu_apagada(None, 16 * GB));
        assert!(gpu_apagada(Some("0"), 32 * GB));
        assert!(!gpu_apagada(Some("1"), 4 * GB));
        assert!(gpu_apagada(Some("otra"), 4 * GB));
        assert!(!gpu_apagada(None, 8 * GB + GB / 2 + 1));
    }

    #[test]
    fn el_protocolo_app_solo_sirve_archivos_de_la_carpeta_de_la_ui() {
        let raiz = Path::new("C:/app/out/renderer");
        assert_eq!(archivo_del_renderer(raiz, "/index.html"), Some(normalizar(&raiz.join("index.html"))));
        assert_eq!(archivo_del_renderer(raiz, "/assets/a%20b.js"), Some(normalizar(&raiz.join("assets/a b.js"))));
        assert_eq!(archivo_del_renderer(raiz, "/../secreto.txt"), None);
        assert_eq!(archivo_del_renderer(raiz, "/%2e%2e/secreto.txt"), None);
        assert_eq!(archivo_del_renderer(raiz, "/a/../../x"), None);
        assert_eq!(archivo_del_renderer(raiz, "/%zz"), None);
        assert_eq!(archivo_del_renderer(raiz, "/"), None);
        assert!(archivo_del_renderer(raiz, "/a/../b.html").is_some());
    }

    #[test]
    fn los_textos_del_arranque_y_de_los_errores() {
        assert_eq!(linea_de_arranque("0.8.0", false), "Sloth 0.8.0 arrancó");
        assert_eq!(linea_de_arranque("0.8.0", true), "Sloth 0.8.0 arrancó (la sesión anterior no cerró limpia)");
        assert!(texto_perfiles_bloqueados("falló").starts_with("falló\n\nNo toqué ninguno"));
        assert_eq!(texto_de_proceso_caido(None, None, "clean-exit", 0), None);
        assert_eq!(texto_de_proceso_caido(None, None, "crashed", 5).unwrap(), "se cayó el proceso de la ventana (crashed, código 5)");
        assert_eq!(texto_de_proceso_caido(Some("GPU"), None, "killed", 1).unwrap(), "se cayó GPU (killed, código 1)");
        assert_eq!(texto_de_proceso_caido(Some("Utility"), Some("audio"), "oom", 9).unwrap(), "se cayó Utility audio (oom, código 9)");
    }
}
