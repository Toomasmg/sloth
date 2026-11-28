//! Lo que comparten los handlers de Rust: la plataforma, la carpeta del perfil que eligió el proceso de apoyo
//! y la lectura (solo lectura) del estado de espacios que sigue guardando ese proceso.
use serde_json::Value;
use sloth_core::app_state::Plataforma;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

pub const ACTIVIDAD_MAX_BYTES: u64 = 256 * 1024;
const ACTIVIDAD_ARCHIVOS: usize = 3;

pub trait PlataformaCompartida: Plataforma + Send + Sync {}
impl<T: Plataforma + Send + Sync> PlataformaCompartida for T {}

pub struct Entorno {
    pub plataforma: Arc<dyn PlataformaCompartida>,
    perfil: RwLock<Option<PathBuf>>,
}

impl Entorno {
    pub fn nuevo(plataforma: Arc<dyn PlataformaCompartida>) -> Arc<Entorno> {
        Arc::new(Entorno { plataforma, perfil: RwLock::new(None) })
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
    let texto = fs::read_to_string(archivo).ok()?;
    let v: Value = serde_json::from_str(texto.strip_prefix('\u{feff}').unwrap_or(&texto)).ok()?;
    v.get("workspaces")?.as_array()?.iter().find(|w| w.get("id").and_then(Value::as_str) == Some(id))?.get("cwd")?.as_str().map(str::to_string)
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
