//! Dormir espacios inactivos, como src/main/features/sleep.ts: cierra el agente de un espacio que lleva un rato sin uso
//! y, al despertarlo, lo abre con `claude --continue`. Es del núcleo porque vive de sus hooks, escrituras y terminales;
//! las decisiones están en `sloth_core::features::sleep`.
use serde_json::Value;
use sloth_core::avisos::Avisos;
use sloth_core::daemon_protocolo::HookEventPayload;
use sloth_core::features::sleep::{leer_dormidos, puede_dormir, tiene_texto, Dormidos, EntradaDormir, EventoHook};
use sloth_core::persistencia::{escribir_json_atomico, leer_json, OpcionesLectura};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

pub const NOMBRE: &str = "sleep";

#[derive(Default)]
struct Estado {
    dormidos: Dormidos,
    /// Último evento de Claude por espacio: para saber si está quieto en su prompt.
    ultimo_evento: HashMap<String, EventoHook>,
    /// Última actividad: un hook que no sea el aviso de inactividad, o algo escrito en la terminal.
    ultima_actividad: HashMap<String, f64>,
    /// Se escribió algo que Claude todavía no recibió (un borrador en el prompt): no se duerme.
    borradores: HashSet<String>,
}

/// Lo que el núcleo sabe de un espacio al decidir si se duerme.
pub struct Candidato<'a> {
    pub id: &'a str,
    pub corriendo: bool,
    pub permiso_pendiente: bool,
}

pub struct Dormir {
    archivo: PathBuf,
    estado: Mutex<Estado>,
}

fn evento(p: &HookEventPayload) -> EventoHook {
    EventoHook { evento: p.event.clone(), tipo_aviso: p.notification_type.clone() }
}

impl Dormir {
    /// `existe` y `confiable`: con el store incompleto, los dormidos que no aparecen se conservan en el archivo.
    pub fn cargar(archivo: &Path, existe: impl Fn(&str) -> bool, confiable: bool, avisos: &Avisos) -> Dormir {
        let validar = |v: &Value| leer_dormidos(v);
        let por_defecto = Vec::new;
        let leidos = leer_json(archivo, &OpcionesLectura::nuevas(&validar, &por_defecto), avisos).valor;
        let dormidos = Dormidos::desde_archivo(&leidos, existe, confiable);
        Dormir { archivo: archivo.to_path_buf(), estado: Mutex::new(Estado { dormidos, ..Default::default() }) }
    }

    fn estado(&self) -> MutexGuard<'_, Estado> {
        self.estado.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn guardar(&self, e: &Estado) {
        if let Err(err) = escribir_json_atomico(&self.archivo, &e.dormidos.a_json()) {
            sloth_core::logger_global::aviso(NOMBRE, &format!("no se pudo guardar sleep.json: {err}"));
        }
    }

    pub fn dormidos(&self) -> Vec<String> {
        self.estado().dormidos.ids().to_vec()
    }

    pub fn esta_dormido(&self, id: &str) -> bool {
        self.estado().dormidos.contiene(id)
    }

    pub fn al_hook(&self, p: &HookEventPayload, ahora: f64) {
        let mut e = self.estado();
        let ev = evento(p);
        let inactividad = sloth_core::features::sleep::es_aviso_de_inactividad(&ev);
        e.ultimo_evento.insert(p.ws.clone(), ev);
        if inactividad {
            return;
        }
        e.ultima_actividad.insert(p.ws.clone(), p.at.map(|t| t as f64).unwrap_or(ahora));
        e.borradores.remove(&p.ws);
    }

    pub fn al_escribir(&self, id: &str, data: &str, ahora: f64) {
        let mut e = self.estado();
        e.ultima_actividad.insert(id.to_string(), ahora);
        if tiene_texto(data) {
            e.borradores.insert(id.to_string());
        }
    }

    pub fn al_cerrar(&self, id: &str) {
        let mut e = self.estado();
        e.ultimo_evento.remove(id);
        e.borradores.remove(id);
    }

    /// Terminales que siguieron vivas en el daemon: se parte de su último evento.
    pub fn partir_de(&self, ultimos: &BTreeMap<String, HookEventPayload>, ahora: f64) {
        let mut e = self.estado();
        for (id, p) in ultimos {
            if e.ultimo_evento.contains_key(id) {
                continue;
            }
            e.ultimo_evento.insert(id.clone(), evento(p));
            e.ultima_actividad.insert(id.clone(), p.at.map(|t| t as f64).unwrap_or(ahora));
        }
    }

    /// Al abrir la terminal de un espacio dormido se retoma la conversación: true si estaba dormido (se gasta).
    pub fn tomar_para_retomar(&self, id: &str) -> bool {
        let mut e = self.estado();
        let estaba = e.dormidos.quitar(id);
        if estaba {
            self.guardar(&e);
        }
        estaba
    }

    /// Los que se duermen ahora (quedan marcados y guardados): el núcleo cierra su terminal.
    pub fn elegir(&self, candidatos: &[Candidato], ahora: f64, despues_ms: f64) -> Vec<String> {
        let mut e = self.estado();
        let mut cambio = false;
        let mut elegidos = Vec::new();
        for c in candidatos {
            // Corriendo y marcado como dormido: lo abrió otro reemplazo de comando (Historial, mover de cuenta) antes
            // que el nuestro. Ya despertó: se limpia la marca para que pueda volver a dormir.
            if c.corriendo && e.dormidos.quitar(c.id) {
                cambio = true;
            }
            let entrada = EntradaDormir {
                corriendo: c.corriendo,
                borrador: e.borradores.contains(c.id),
                ultimo_evento: e.ultimo_evento.get(c.id),
                permiso_pendiente: c.permiso_pendiente,
                ahora,
                ultima_actividad: e.ultima_actividad.get(c.id).copied(),
                despues_ms,
            };
            if puede_dormir(&entrada) {
                e.dormidos.agregar(c.id);
                cambio = true;
                elegidos.push(c.id.to_string());
            }
        }
        if cambio {
            self.guardar(&e);
        }
        elegidos
    }

    /// Despertar a mano. Devuelve si estaba dormido; si la terminal seguía viva se quita la marca (no hay nada que
    /// retomar) y si no, queda para que la próxima terminal arranque con `--continue`.
    pub fn despertar(&self, id: &str, terminal_viva: bool, ahora: f64) -> bool {
        let mut e = self.estado();
        if !e.dormidos.contiene(id) {
            return false;
        }
        if terminal_viva {
            e.dormidos.quitar(id);
            self.guardar(&e);
        }
        e.ultima_actividad.insert(id.to_string(), ahora);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn carpeta(n: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sloth-dormir-{n}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn hook(ws: &str, event: &str, tipo: Option<&str>, at: u64) -> HookEventPayload {
        serde_json::from_value(serde_json::json!({ "ws": ws, "event": event, "notificationType": tipo, "at": at })).unwrap()
    }

    fn corriendo(id: &str) -> Candidato<'_> {
        Candidato { id, corriendo: true, permiso_pendiente: false }
    }

    #[test]
    fn duerme_al_que_termino_su_turno_y_paso_el_tiempo_y_lo_recuerda() {
        let d = carpeta("duerme");
        let archivo = d.join("sleep.json");
        let s = Dormir::cargar(&archivo, |_| true, true, &Avisos::nuevo());
        s.al_hook(&hook("w1", "Stop", None, 1_000), 0.0);
        assert!(s.elegir(&[corriendo("w1")], 60_000.0, 60_000.0).is_empty(), "todavía no pasó el minuto");
        assert_eq!(s.elegir(&[corriendo("w1")], 61_000.0, 60_000.0), ["w1"]);
        let otra = Dormir::cargar(&archivo, |_| true, true, &Avisos::nuevo());
        assert_eq!(otra.dormidos(), ["w1"]);
        assert!(otra.tomar_para_retomar("w1"));
        assert!(!otra.tomar_para_retomar("w1"), "se gasta");
        assert!(Dormir::cargar(&archivo, |_| true, true, &Avisos::nuevo()).dormidos().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn no_duerme_con_un_borrador_trabajando_ni_con_un_permiso_esperando() {
        let d = carpeta("no-duerme");
        let s = Dormir::cargar(&d.join("sleep.json"), |_| true, true, &Avisos::nuevo());
        s.al_hook(&hook("w1", "Stop", None, 0), 0.0);
        s.al_escribir("w1", "hola", 0.0);
        assert!(s.elegir(&[corriendo("w1")], 100_000.0, 1_000.0).is_empty(), "borrador sin mandar");
        s.al_hook(&hook("w1", "UserPromptSubmit", None, 0), 0.0);
        assert!(s.elegir(&[corriendo("w1")], 100_000.0, 1_000.0).is_empty(), "trabajando");
        s.al_hook(&hook("w1", "Notification", Some("idle_prompt"), 0), 0.0);
        let con_permiso = Candidato { id: "w1", corriendo: true, permiso_pendiente: true };
        assert!(s.elegir(&[con_permiso], 100_000.0, 1_000.0).is_empty(), "permiso esperando");
        assert!(s.elegir(&[Candidato { id: "w1", corriendo: false, permiso_pendiente: false }], 100_000.0, 1_000.0).is_empty(), "sin terminal");
        assert_eq!(s.elegir(&[corriendo("w1")], 100_000.0, 1_000.0), ["w1"], "quieto en el prompt");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn las_escapes_no_son_borrador_y_cerrar_la_terminal_olvida_el_evento() {
        let d = carpeta("escapes");
        let s = Dormir::cargar(&d.join("sleep.json"), |_| true, true, &Avisos::nuevo());
        s.al_hook(&hook("w1", "Stop", None, 0), 0.0);
        s.al_escribir("w1", "\x1b[I", 0.0);
        assert_eq!(s.elegir(&[corriendo("w1")], 5_000.0, 1_000.0), ["w1"]);
        s.al_hook(&hook("w2", "Stop", None, 0), 0.0);
        s.al_cerrar("w2");
        assert!(s.elegir(&[corriendo("w2")], 5_000.0, 1_000.0).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn despertar_con_la_terminal_viva_saca_la_marca_y_sin_ella_la_deja_para_retomar() {
        let d = carpeta("despertar");
        std::fs::write(d.join("sleep.json"), r#"{"asleep":["w1","w2","borrado"]}"#).unwrap();
        let s = Dormir::cargar(&d.join("sleep.json"), |id| id != "borrado", true, &Avisos::nuevo());
        assert_eq!(s.dormidos(), ["w1", "w2"], "el espacio borrado se poda");
        assert!(s.despertar("w1", true, 0.0));
        assert!(!s.esta_dormido("w1"));
        assert!(s.despertar("w2", false, 0.0));
        assert!(s.esta_dormido("w2"));
        assert!(!s.despertar("w3", false, 0.0));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn un_dormido_que_aparece_corriendo_ya_desperto() {
        let d = carpeta("ya-desperto");
        std::fs::write(d.join("sleep.json"), r#"{"asleep":["w1"]}"#).unwrap();
        let s = Dormir::cargar(&d.join("sleep.json"), |_| true, true, &Avisos::nuevo());
        assert!(s.elegir(&[corriendo("w1")], 0.0, 1_000.0).is_empty());
        assert!(!s.esta_dormido("w1"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn rehidratar_parte_del_ultimo_evento_de_las_terminales_vivas() {
        let d = carpeta("rehidratar");
        let s = Dormir::cargar(&d.join("sleep.json"), |_| true, true, &Avisos::nuevo());
        let mut ultimos = BTreeMap::new();
        ultimos.insert("w1".to_string(), hook("w1", "Stop", None, 1_000));
        s.partir_de(&ultimos, 50_000.0);
        assert_eq!(s.elegir(&[corriendo("w1")], 2_500.0, 1_000.0), ["w1"]);
        let _ = std::fs::remove_dir_all(&d);
    }
}
