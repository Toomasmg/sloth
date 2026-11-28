//! Lo que comparten los handlers de Rust: la plataforma, la carpeta del perfil que eligió el proceso de apoyo
//! y la lectura (solo lectura) del estado de espacios que sigue guardando ese proceso.
use crate::router::{Futuro, Respuesta};
use serde_json::Value;
use sloth_core::app_state::Plataforma;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, RwLock};
use std::time::Duration;

pub const ACTIVIDAD_MAX_BYTES: u64 = 256 * 1024;
const ACTIVIDAD_ARCHIVOS: usize = 3;

pub trait PlataformaCompartida: Plataforma + Send + Sync {}
impl<T: Plataforma + Send + Sync> PlataformaCompartida for T {}

/// Invoca un canal por el router, como si lo pidiera la UI: lo atiende quien sea su dueño (Rust o el proceso de apoyo).
pub type Pedidos = Arc<dyn Fn(String, Vec<Value>) -> Futuro<Respuesta> + Send + Sync>;

/// Aviso del sistema (título, cuerpo).
pub type Notificador = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// Evento nativo hacia el proceso de apoyo (nombre, argumentos).
pub type EventosAlApoyo = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub struct Entorno {
    pub plataforma: Arc<dyn PlataformaCompartida>,
    perfil: RwLock<Option<PathBuf>>,
    pedidos: RwLock<Option<Pedidos>>,
    runtime: RwLock<Option<tokio::runtime::Handle>>,
    foco: AtomicBool,
    notificador: RwLock<Option<Notificador>>,
    al_apoyo: RwLock<Option<EventosAlApoyo>>,
}

impl Entorno {
    pub fn nuevo(plataforma: Arc<dyn PlataformaCompartida>) -> Arc<Entorno> {
        Arc::new(Entorno {
            plataforma,
            perfil: RwLock::new(None),
            pedidos: RwLock::new(None),
            runtime: RwLock::new(None),
            foco: AtomicBool::new(false),
            notificador: RwLock::new(None),
            al_apoyo: RwLock::new(None),
        })
    }

    /// Para pedir desde hilos propios de una función (fuera del runtime), como los del MCP del chat.
    pub fn fijar_runtime(&self, h: tokio::runtime::Handle) {
        *self.runtime.write().unwrap_or_else(|e| e.into_inner()) = Some(h);
    }

    pub fn fijar_foco(&self, enfocada: bool) {
        self.foco.store(enfocada, Ordering::SeqCst);
    }

    pub fn con_foco(&self) -> bool {
        self.foco.load(Ordering::SeqCst)
    }

    pub fn fijar_notificador(&self, n: Notificador) {
        *self.notificador.write().unwrap_or_else(|e| e.into_inner()) = Some(n);
    }

    pub fn notificar(&self, titulo: &str, cuerpo: &str) {
        let n = self.notificador.read().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(n) = n {
            n(titulo, cuerpo);
        }
    }

    pub fn fijar_eventos_al_apoyo(&self, f: EventosAlApoyo) {
        *self.al_apoyo.write().unwrap_or_else(|e| e.into_inner()) = Some(f);
    }

    /// Lo que el proceso de apoyo necesita saber de una función de Rust (la sesión del chat para «celular», un aviso).
    pub fn al_apoyo(&self, nombre: &str, args: Value) {
        let f = self.al_apoyo.read().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(f) = f {
            f(nombre, args);
        }
    }

    pub fn fijar_pedidos(&self, p: Pedidos) {
        *self.pedidos.write().unwrap_or_else(|e| e.into_inner()) = Some(p);
    }

    /// Pide un canal al router y espera la respuesta. Desde un handler (hilo bloqueante del runtime) o desde un hilo propio
    /// si se fijó el runtime; nunca desde una tarea async.
    /// Sirve para lo que todavía tiene otro dueño, como dar de alta un espacio: así el store sigue con uno solo.
    pub fn pedir(&self, canal: &str, args: Vec<Value>, espera: Duration) -> Respuesta {
        let p = self.pedidos.read().unwrap_or_else(|e| e.into_inner()).clone().ok_or_else(|| "Sloth todavía está arrancando.".to_string())?;
        let guardado = self.runtime.read().unwrap_or_else(|e| e.into_inner()).clone();
        let rt = tokio::runtime::Handle::try_current().ok().or(guardado).ok_or_else(|| format!("No se pudo pedir {canal}."))?;
        let (tx, rx) = mpsc::channel();
        let futuro = p(canal.to_string(), args);
        rt.spawn(async move {
            let _ = tx.send(futuro.await);
        });
        rx.recv_timeout(espera).unwrap_or_else(|_| Err(format!("{canal} no respondió a tiempo.")))
    }

    /// Carpeta raíz de datos (la de los logs del daemon y los reportes), no la del perfil.
    pub fn raiz(&self) -> PathBuf {
        self.plataforma.carpeta_de_datos()
    }

    /// `sloth-state.json` tal como lo dejó el proceso de apoyo, sin migrar ni reescribir; `{}` si no se puede leer.
    pub fn estado(&self) -> Value {
        self.perfil().ok().and_then(|p| leer_estado(&p.join("sloth-state.json"))).unwrap_or_else(|| Value::Object(Default::default()))
    }

    pub fn lista_del_estado(&self, clave: &str) -> Vec<Value> {
        self.estado().get(clave).and_then(Value::as_array).cloned().unwrap_or_default()
    }

    /// El proceso de apoyo decide el perfil activo (migraciones incluidas) y avisa su carpeta una vez que arrancó.
    pub fn fijar_perfil(&self, carpeta: PathBuf) {
        *self.perfil.write().unwrap_or_else(|e| e.into_inner()) = Some(carpeta);
    }

    pub fn perfil(&self) -> Result<PathBuf, String> {
        self.perfil.read().unwrap_or_else(|e| e.into_inner()).clone().ok_or_else(|| "Sloth todavía está arrancando.".to_string())
    }

    pub fn carpeta_features(&self) -> Result<PathBuf, String> {
        Ok(self.perfil()?.join("features"))
    }

    /// Evento `feat:<funcion>:<evento>` hacia la UI.
    pub fn emitir(&self, funcion: &str, evento: &str, args: &[Value]) {
        self.plataforma.enviar_a_la_ventana(&format!("feat:{funcion}:{evento}"), args);
    }

    pub fn cwd_de_espacio(&self, id: &str) -> Option<String> {
        cwd_en_estado(&self.perfil().ok()?.join("sloth-state.json"), id)
    }

    pub fn registrar_pr(&self, pr: &str, ahora_ms: u64) -> Result<(), String> {
        agregar_actividad_pr(&self.perfil()?.join("actividad"), pr, ahora_ms)
    }
}

/// Lee, sin migrar ni reescribir, la carpeta de un espacio del `sloth-state.json` que escribe el proceso de apoyo.
pub fn cwd_en_estado(archivo: &Path, id: &str) -> Option<String> {
    let v = leer_estado(archivo)?;
    v.get("workspaces")?.as_array()?.iter().find(|w| w.get("id").and_then(Value::as_str) == Some(id))?.get("cwd")?.as_str().map(str::to_string)
}

fn leer_estado(archivo: &Path) -> Option<Value> {
    let texto = fs::read_to_string(archivo).ok()?;
    serde_json::from_str(texto.strip_prefix('\u{feff}').unwrap_or(&texto)).ok()
}

fn nombre_actividad(i: usize) -> String {
    if i == 0 { "actividad.jsonl".into() } else { format!("actividad-{i}.jsonl") }
}

fn campo_limpio(s: &str) -> String {
    let sin_control: String = s.chars().map(|c| if c.is_control() || c == '\u{2028}' || c == '\u{2029}' { ' ' } else { c }).collect();
    sin_control.trim().chars().take(120).collect::<String>().trim().to_string()
}

/// Misma entrada y misma rotación que `agregarActividad` de src/main/perfiles-actividad.ts.
pub fn agregar_actividad_pr(dir: &Path, pr: &str, ahora_ms: u64) -> Result<(), String> {
    let pr = campo_limpio(pr);
    if pr.is_empty() || ahora_ms == 0 {
        return Err("actividad inválida".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let actual = dir.join(nombre_actividad(0));
    if fs::metadata(&actual).map(|m| m.len() > ACTIVIDAD_MAX_BYTES).unwrap_or(false) {
        let _ = fs::remove_file(dir.join(nombre_actividad(ACTIVIDAD_ARCHIVOS - 1)));
        for i in (0..ACTIVIDAD_ARCHIVOS - 1).rev() {
            let origen = dir.join(nombre_actividad(i));
            if origen.exists() {
                fs::rename(&origen, dir.join(nombre_actividad(i + 1))).map_err(|e| e.to_string())?;
            }
        }
    }
    let linea = serde_json::json!({ "t": ahora_ms, "tipo": "pr", "pr": pr });
    let mut f = OpenOptions::new().create(true).append(true).open(&actual).map_err(|e| e.to_string())?;
    writeln!(f, "{linea}").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn carpeta(nombre: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sloth-entorno-{nombre}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn la_carpeta_de_un_espacio_sale_del_estado_sin_tocarlo() {
        let d = carpeta("estado");
        let f = d.join("sloth-state.json");
        let texto = format!("\u{feff}{}", json!({ "version": 1, "workspaces": [{ "id": "a", "cwd": "C:\\repo" }, { "id": "b" }] }));
        fs::write(&f, &texto).unwrap();
        assert_eq!(cwd_en_estado(&f, "a").as_deref(), Some("C:\\repo"));
        assert_eq!(cwd_en_estado(&f, "b"), None);
        assert_eq!(cwd_en_estado(&f, "z"), None);
        assert_eq!(fs::read_to_string(&f).unwrap(), texto);
        assert_eq!(cwd_en_estado(&d.join("no-existe.json"), "a"), None);
    }

    #[test]
    fn un_estado_roto_no_da_carpeta() {
        let d = carpeta("roto");
        let f = d.join("sloth-state.json");
        fs::write(&f, "{no es json").unwrap();
        assert_eq!(cwd_en_estado(&f, "a"), None);
    }

    #[test]
    fn la_actividad_de_pr_queda_como_la_deja_el_main_de_node() {
        let d = carpeta("act");
        agregar_actividad_pr(&d, "#12", 1700).unwrap();
        agregar_actividad_pr(&d, "#13", 1800).unwrap();
        let t = fs::read_to_string(d.join("actividad.jsonl")).unwrap();
        assert_eq!(t, "{\"t\":1700,\"tipo\":\"pr\",\"pr\":\"#12\"}\n{\"t\":1800,\"tipo\":\"pr\",\"pr\":\"#13\"}\n");
    }

    #[test]
    fn la_actividad_rota_cuando_pasa_el_tope() {
        let d = carpeta("rota");
        fs::write(d.join("actividad.jsonl"), vec![b'x'; ACTIVIDAD_MAX_BYTES as usize + 1]).unwrap();
        agregar_actividad_pr(&d, "#1", 5).unwrap();
        assert_eq!(fs::metadata(d.join("actividad-1.jsonl")).unwrap().len(), ACTIVIDAD_MAX_BYTES + 1);
        assert_eq!(fs::read_to_string(d.join("actividad.jsonl")).unwrap(), "{\"t\":5,\"tipo\":\"pr\",\"pr\":\"#1\"}\n");
    }

    #[test]
    fn la_actividad_invalida_se_rechaza() {
        let d = carpeta("inv");
        assert!(agregar_actividad_pr(&d, "  ", 5).is_err());
        assert!(agregar_actividad_pr(&d, "#1", 0).is_err());
    }
}
