//! Cuentas, espacios y paneles abiertos (sloth-state.json). Equivale a src/main/store.ts.
//! Cuentas y espacios son objetos JSON tal cual: se conservan sus campos desconocidos y su orden.
use crate::avisos::Avisos;
use crate::persistencia::{escribir_json_atomico, leer_json, respaldar, OpcionesLectura};
use crate::store_core::{corregir_rutas_viejas, decidir_carga, estado_vacio, validar_estado, EstadoValidado, LecturaEstado};
use crate::versionado::Objeto;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CausaSoloLectura {
    /// Con `VersionFutura` reiniciar no arregla nada: hay que actualizar Sloth.
    VersionFutura,
    Io,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SoloLecturaStore {
    pub motivo: String,
    pub archivo: PathBuf,
    pub causa: CausaSoloLectura,
}

pub struct Store {
    estado: Objeto,
    archivo: PathBuf,
    solo_lectura_motivo: Option<String>,
    causa: CausaSoloLectura,
    carga_confiable: bool,
}

impl Store {
    /// `vieja_raiz` y `nueva_raiz`: las cuentas que vivían en la carpeta de AntiRea se apuntan a la actual.
    pub fn cargar(archivo: &Path, vieja_raiz: &str, nueva_raiz: &str, avisos: &Avisos) -> Store {
        if let Some(dir) = archivo.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let mut s = Store { estado: estado_vacio().estado, archivo: archivo.to_path_buf(), solo_lectura_motivo: None, causa: CausaSoloLectura::Io, carga_confiable: false };
        s.estado = s.cargar_estado(vieja_raiz, nueva_raiz, avisos);
        s
    }

    fn cargar_estado(&mut self, vieja_raiz: &str, nueva_raiz: &str, avisos: &Avisos) -> Objeto {
        let validar = |v: &Value| validar_estado(v);
        let vacio = || estado_vacio();
        let mut o = OpcionesLectura::nuevas(&validar, &vacio);
        o.silencioso = true;
        let r = leer_json(&self.archivo, &o, avisos);
        let mut v: EstadoValidado = r.valor;
        let rutas_corregidas = !r.solo_lectura && {
            let mut cuentas: Vec<Value> = v.estado.get("accounts").and_then(Value::as_array).cloned().unwrap_or_default();
            let cambio = corregir_rutas_viejas(&mut cuentas, vieja_raiz, nueva_raiz);
            if cambio {
                v.estado.insert("accounts".into(), Value::Array(cuentas));
            }
            cambio
        };
        let apartado = r.apartado.as_ref().map(|p| p.display().to_string());
        let motivo = r.motivo.clone();
        let d = decidir_carga(&LecturaEstado { v: estado_clon(&v), apartado, solo_lectura: r.solo_lectura, motivo: motivo.clone() }, rutas_corregidas);
        self.carga_confiable = d.confiable;
        if d.solo_lectura {
            self.solo_lectura_motivo = Some(match &motivo {
                Some(m) => format!("sloth-state.json {m}"),
                None => "sloth-state.json es de una versión más nueva de Sloth".into(),
            });
            self.causa = if motivo.is_some() { CausaSoloLectura::Io } else { CausaSoloLectura::VersionFutura };
        }
        let mut bak: Option<String> = None;
        if d.respaldar {
            match respaldar(&self.archivo) {
                Ok(b) => bak = Some(b.display().to_string()),
                Err(e) => {
                    self.solo_lectura_motivo = Some(format!("no se pudo respaldar sloth-state.json ({e})"));
                    self.causa = CausaSoloLectura::Io;
                    avisos.avisar(format!("No pude respaldar sloth-state.json antes de actualizarlo ({e}). No voy a guardar cambios hasta que reinicies Sloth."));
                }
            }
        }
        if d.guardar && bak.is_some() {
            self.estado = v.estado.clone();
            if let Err(e) = escribir_json_atomico(&self.archivo, &Value::Object(self.estado.clone())) {
                self.solo_lectura_motivo = Some(format!("no se pudo guardar sloth-state.json ({e})"));
                self.causa = CausaSoloLectura::Io;
                avisos.avisar(format!("No pude guardar sloth-state.json ({e}). No voy a guardar cambios hasta que reinicies Sloth."));
            }
        }
        if let Some(aviso) = &d.aviso {
            avisos.avisar(aviso(bak.as_deref()));
        }
        v.estado
    }

    /// Si no se pudo leer, respaldar o guardar sloth-state.json: los cambios de esta sesión no se guardan.
    pub fn solo_lectura(&self) -> Option<SoloLecturaStore> {
        self.solo_lectura_motivo.clone().map(|motivo| SoloLecturaStore { motivo, archivo: self.archivo.clone(), causa: self.causa })
    }

    /// Cuentas y espacios cargaron enteros: solo entonces se poda lo de otras funciones según el store.
    pub fn confiable(&self) -> bool {
        self.carga_confiable && self.solo_lectura_motivo.is_none()
    }

    /// Para crear cuentas o espacios: en solo lectura se perderían al cerrar, mejor no dejar crearlos.
    pub fn exigir_escritura(&self) -> Result<(), String> {
        let Some(motivo) = &self.solo_lectura_motivo else { return Ok(()) };
        let consejo = match self.causa {
            CausaSoloLectura::VersionFutura => "Actualizá Sloth: esta versión es más vieja que tus datos.",
            CausaSoloLectura::Io => "Reiniciá Sloth cuando sloth-state.json se pueda leer.",
        };
        Err(format!("No se va a guardar: {motivo}. {consejo}"))
    }

    fn guardar(&self) -> Result<(), String> {
        if self.solo_lectura_motivo.is_some() {
            return Ok(());
        }
        escribir_json_atomico(&self.archivo, &Value::Object(self.estado.clone())).map(|_| ()).map_err(|e| e.to_string())
    }

    fn lista(&self, k: &str) -> &Vec<Value> {
        static VACIA: Vec<Value> = Vec::new();
        self.estado.get(k).and_then(Value::as_array).unwrap_or(&VACIA)
    }

    fn lista_mut(&mut self, k: &str) -> &mut Vec<Value> {
        if !self.estado.get(k).is_some_and(Value::is_array) {
            self.estado.insert(k.into(), Value::Array(vec![]));
        }
        self.estado.get_mut(k).and_then(Value::as_array_mut).expect("recién creada")
    }

    pub fn accounts(&self) -> &[Value] {
        self.lista("accounts")
    }
    pub fn workspaces(&self) -> &[Value] {
        self.lista("workspaces")
    }
    pub fn open_panes(&self) -> Vec<String> {
        self.lista("openPanes").iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()
    }
    pub fn account(&self, id: &str) -> Option<&Value> {
        self.accounts().iter().find(|a| a["id"] == id)
    }
    pub fn workspace(&self, id: &str) -> Option<&Value> {
        self.workspaces().iter().find(|w| w["id"] == id)
    }

    pub fn add_account(&mut self, cuenta: Value) -> Result<(), String> {
        self.exigir_escritura()?;
        self.lista_mut("accounts").push(cuenta);
        self.guardar()
    }

    /// Mezcla `parche` en la cuenta (menos `id` y `configDir`, que no cambian). None si no existe.
    pub fn update_account(&mut self, id: &str, parche: &Objeto) -> Result<Option<Value>, String> {
        self.actualizar("accounts", id, parche, &["id", "configDir"])
    }

    /// Mezcla `parche` en el espacio (menos `id`). None si no existe.
    pub fn update_workspace(&mut self, id: &str, parche: &Objeto) -> Result<Option<Value>, String> {
        self.actualizar("workspaces", id, parche, &["id"])
    }

    /// Como `update_workspace`, y además saca los campos de `quitar` (en el TypeScript, los que quedaban en `undefined`).
    pub fn update_workspace_quitando(&mut self, id: &str, parche: &Objeto, quitar: &[String]) -> Result<Option<Value>, String> {
        self.actualizar_quitando("workspaces", id, parche, &["id"], quitar)
    }

    fn actualizar(&mut self, lista: &str, id: &str, parche: &Objeto, protegidos: &[&str]) -> Result<Option<Value>, String> {
        self.actualizar_quitando(lista, id, parche, protegidos, &[])
    }

    fn actualizar_quitando(&mut self, lista: &str, id: &str, parche: &Objeto, protegidos: &[&str], quitar: &[String]) -> Result<Option<Value>, String> {
        let Some(item) = self.lista_mut(lista).iter_mut().find(|x| x["id"] == id) else { return Ok(None) };
        let o = item.as_object_mut().ok_or("entrada dañada")?;
        for (k, v) in parche {
            if !protegidos.contains(&k.as_str()) {
                o.insert(k.clone(), v.clone());
            }
        }
        for k in quitar {
            if !protegidos.contains(&k.as_str()) {
                o.shift_remove(k);
            }
        }
        let copia = item.clone();
        self.guardar()?;
        Ok(Some(copia))
    }

    pub fn remove_account(&mut self, id: &str) -> Result<(), String> {
        self.exigir_escritura()?;
        self.lista_mut("accounts").retain(|a| a["id"] != id);
        self.guardar()
    }

    pub fn add_workspace(&mut self, ws: Value) -> Result<(), String> {
        self.exigir_escritura()?;
        self.lista_mut("workspaces").push(ws);
        self.guardar()
    }

    pub fn remove_workspace(&mut self, id: &str) -> Result<(), String> {
        self.exigir_escritura()?;
        self.lista_mut("workspaces").retain(|w| w["id"] != id);
        self.lista_mut("openPanes").retain(|p| p != id);
        self.guardar()
    }

    pub fn set_open_panes(&mut self, ids: &[String]) -> Result<(), String> {
        self.estado.insert("openPanes".into(), Value::Array(ids.iter().cloned().map(Value::String).collect()));
        self.guardar()
    }

    /// La raíz completa tal como se guarda (para empujarla al proceso de apoyo mientras convivan los dos).
    pub fn instantanea(&self) -> Value {
        Value::Object(self.estado.clone())
    }
}

fn estado_clon(v: &EstadoValidado) -> EstadoValidado {
    EstadoValidado {
        estado: v.estado.clone(),
        cuentas_descartadas: v.cuentas_descartadas,
        espacios_descartados: v.espacios_descartados,
        cuentas_repetidas: v.cuentas_repetidas,
        espacios_repetidos: v.espacios_repetidos,
        version_futura: v.version_futura,
        migrado: v.migrado,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn carpeta() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("sloth-store-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn cuenta(id: &str) -> Value {
        json!({ "id": id, "label": id, "configDir": format!("C:\\datos\\{id}"), "createdAt": 1 })
    }
    fn espacio(id: &str) -> Value {
        json!({ "id": id, "name": id, "repoPath": "C:\\repo", "cwd": "C:\\repo", "accountId": "a1", "autoStartClaude": true, "createdAt": 2 })
    }
    fn nombres(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }
    const VIEJA: &str = "C:\\AppData\\AntiRea";
    const NUEVA: &str = "C:\\AppData\\Sloth";

    #[test]
    fn sin_archivo_arranca_vacio_y_confiable_no_porque_no_hay_nada_que_decidir() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let s = Store::cargar(&d.join("sloth-state.json"), VIEJA, NUEVA, &av);
        assert!(s.accounts().is_empty() && s.workspaces().is_empty());
        assert!(s.confiable());
        assert!(s.solo_lectura().is_none());
        assert!(av.tomar().is_empty());
        assert!(!d.join("sloth-state.json").exists(), "no escribe hasta que haya algo que guardar");
    }

    #[test]
    fn actualizar_quitando_saca_campos_sin_mover_el_espacio_ni_tocar_el_id() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let f = d.join("sloth-state.json");
        let mut s = Store::cargar(&f, VIEJA, NUEVA, &av);
        s.add_workspace(json!({ "id": "w1", "name": "a", "icon": "x", "repoPath": "C:\\r", "cwd": "C:\\r", "accountId": "a1", "createdAt": 1 })).unwrap();
        s.add_workspace(espacio("w2")).unwrap();
        let parche = json!({ "name": "b" });
        let w = s.update_workspace_quitando("w1", parche.as_object().unwrap(), &["icon".into(), "id".into()]).unwrap().unwrap();
        assert_eq!(w["name"], "b");
        assert!(w.get("icon").is_none());
        assert_eq!(w["id"], "w1");
        let otra = Store::cargar(&f, VIEJA, NUEVA, &av);
        assert_eq!(otra.workspaces()[0]["id"], "w1");
        assert!(otra.workspaces()[0].get("icon").is_none());
    }

    #[test]
    fn agregar_quitar_y_actualizar_se_guarda_y_se_vuelve_a_leer_igual() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let f = d.join("sloth-state.json");
        let mut s = Store::cargar(&f, VIEJA, NUEVA, &av);
        s.add_account(cuenta("a1")).unwrap();
        s.add_workspace(espacio("w1")).unwrap();
        s.add_workspace(espacio("w2")).unwrap();
        s.set_open_panes(&["w1".into(), "w2".into()]).unwrap();
        let patch = json!({ "name": "Nuevo", "id": "otro" });
        let w = s.update_workspace("w1", patch.as_object().unwrap()).unwrap().unwrap();
        assert_eq!(w["name"], json!("Nuevo"));
        assert_eq!(w["id"], json!("w1"), "el id no cambia");
        assert!(s.update_workspace("no", patch.as_object().unwrap()).unwrap().is_none());
        let cfg = json!({ "configDir": "C:\\otro", "label": "Z" });
        let a = s.update_account("a1", cfg.as_object().unwrap()).unwrap().unwrap();
        assert_eq!((a["label"].clone(), a["configDir"].clone()), (json!("Z"), json!("C:\\datos\\a1")));
        s.remove_workspace("w2").unwrap();
        assert_eq!(s.open_panes(), ["w1"]);

        let otra = Store::cargar(&f, VIEJA, NUEVA, &av);
        assert_eq!(otra.instantanea(), s.instantanea());
        assert_eq!(otra.workspace("w1").unwrap()["name"], json!("Nuevo"));
        assert!(otra.workspace("w2").is_none());
        s.remove_account("a1").unwrap();
        assert!(Store::cargar(&f, VIEJA, NUEVA, &av).account("a1").is_none());
    }

    #[test]
    fn el_archivo_roto_se_aparta_arranca_vacio_y_avisa() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let f = d.join("sloth-state.json");
        fs::write(&f, "{ roto").unwrap();
        let s = Store::cargar(&f, VIEJA, NUEVA, &av);
        assert!(s.accounts().is_empty());
        assert!(!s.confiable());
        assert!(s.solo_lectura().is_none());
        let a = av.tomar();
        assert_eq!(a.len(), 1);
        assert!(a[0].contains("sloth-state.json estaba dañado") && a[0].contains("corrupt-"));
        assert!(nombres(&d).iter().any(|n| n.starts_with("sloth-state.json.corrupt-")));
    }

    #[test]
    fn version_futura_queda_en_solo_lectura_con_respaldo_y_no_se_reescribe() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let f = d.join("sloth-state.json");
        let original = json!({ "version": 2, "accounts": [cuenta("a1")], "workspaces": [], "openPanes": [], "nuevo": { "x": 1 } });
        fs::write(&f, serde_json::to_string(&original).unwrap()).unwrap();
        let mut s = Store::cargar(&f, VIEJA, NUEVA, &av);
        let sl = s.solo_lectura().expect("solo lectura");
        assert_eq!(sl.causa, CausaSoloLectura::VersionFutura);
        assert!(!s.confiable());
        assert!(s.exigir_escritura().unwrap_err().contains("Actualizá Sloth"));
        assert!(s.add_account(cuenta("a2")).is_err());
        s.set_open_panes(&["x".into()]).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&fs::read_to_string(&f).unwrap()).unwrap(), original, "no se reescribió");
        assert!(nombres(&d).iter().any(|n| n.starts_with("sloth-state.json.bak-")));
        assert!(av.tomar()[0].contains("versión más nueva"));
    }

    #[test]
    fn sin_version_se_migra_con_respaldo_y_queda_con_version_1() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let f = d.join("sloth-state.json");
        fs::write(&f, serde_json::to_string(&json!({ "accounts": [cuenta("a1")], "workspaces": [espacio("w1")], "openPanes": ["w1"] })).unwrap()).unwrap();
        let s = Store::cargar(&f, VIEJA, NUEVA, &av);
        assert!(s.confiable());
        assert!(av.tomar().is_empty(), "migrar es silencioso");
        let guardado: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(guardado["version"], json!(1));
        assert!(nombres(&d).iter().any(|n| n.starts_with("sloth-state.json.bak-")));
    }

    #[test]
    fn con_cuentas_danadas_las_saca_respalda_y_avisa() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let f = d.join("sloth-state.json");
        fs::write(&f, serde_json::to_string(&json!({ "version": 1, "accounts": [cuenta("a1"), null], "workspaces": [], "openPanes": [] })).unwrap()).unwrap();
        let s = Store::cargar(&f, VIEJA, NUEVA, &av);
        assert_eq!(s.accounts().len(), 1);
        assert!(!s.confiable());
        let a = av.tomar();
        assert!(a[0].contains("1 cuenta dañada") && a[0].contains("guardé el original como"));
    }

    #[test]
    fn las_rutas_de_antirea_se_corrigen_y_se_guardan() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let f = d.join("sloth-state.json");
        let vieja = json!({ "id": "a1", "label": "A", "configDir": "C:\\AppData\\AntiRea\\accounts\\a1", "createdAt": 1 });
        fs::write(&f, serde_json::to_string(&json!({ "version": 1, "accounts": [vieja], "workspaces": [], "openPanes": [] })).unwrap()).unwrap();
        let s = Store::cargar(&f, VIEJA, NUEVA, &av);
        assert_eq!(s.account("a1").unwrap()["configDir"], json!("C:\\AppData\\Sloth\\accounts\\a1"));
        assert!(s.confiable());
        let guardado: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(guardado["accounts"][0]["configDir"], json!("C:\\AppData\\Sloth\\accounts\\a1"));
    }

    #[test]
    fn un_archivo_que_no_se_puede_leer_deja_el_store_en_solo_lectura_sin_tocarlo() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let f = d.join("sloth-state.json");
        fs::create_dir(&f).unwrap();
        let mut s = Store::cargar(&f, VIEJA, NUEVA, &av);
        assert_eq!(s.solo_lectura().unwrap().causa, CausaSoloLectura::Io);
        assert!(s.exigir_escritura().unwrap_err().contains("Reiniciá Sloth"));
        assert!(s.add_workspace(espacio("w1")).is_err());
        assert!(f.is_dir());
    }
}
