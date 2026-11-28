//! Bandeja del sistema: quién trabaja y quién te necesita, el tooltip y el menú, qué pasa al tocar la X (bandeja, aviso o
//! cerrar) con los textos de sus diálogos, el punto ámbar de la barra de tareas y `features/tray.json` (versionado).
//! Equivale a la lógica de src/main/features/tray.ts, tray-dot.ts y tray-settings.ts; la ventana y los diálogos son de afuera.
use crate::avisos::Avisos;
use crate::persistencia::{escribir_json_atomico, leer_json, respaldar, OpcionesLectura};
use crate::versionado::{migrar, EstadoVersion, Migraciones};
use serde_json::{json, Map, Value};
use std::cell::Cell;
use std::path::{Path, PathBuf};

const VERSION_BANDEJA: u32 = 1;

fn plural(n: usize, uno: &str, varios: &str) -> String {
    format!("{n} {}", if n == 1 { uno } else { varios })
}

/// Espacios que trabajan y los que te necesitan (esperan una respuesta o un permiso), sin repetir y en el orden en que
/// aparecen: el primero es al que lleva el menú.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Resumen {
    pub trabajando: usize,
    pub necesitan: Vec<String>,
}

fn ids_de_espacios(estado: &Value) -> Vec<&str> {
    estado.get("workspaces").and_then(Value::as_array).into_iter().flatten().filter_map(|w| w.get("id").and_then(Value::as_str)).collect()
}

/// `estado` es lo que devuelve `state:get` (espacios y agentes) y `pendientes` lo de `permission:pending`. Los agentes de
/// un espacio que ya no existe no cuentan.
pub fn resumir(estado: &Value, pendientes: &Value) -> Resumen {
    let espacios = ids_de_espacios(estado);
    let mut r = Resumen::default();
    let necesita = |id: &str, r: &mut Resumen| {
        if !r.necesitan.iter().any(|x| x == id) {
            r.necesitan.push(id.to_string());
        }
    };
    for (id, st) in estado.get("agents").and_then(Value::as_object).into_iter().flatten() {
        if !espacios.contains(&id.as_str()) {
            continue;
        }
        match st.get("state").and_then(Value::as_str) {
            Some("working") => r.trabajando += 1,
            Some("waiting") => necesita(id, &mut r),
            _ => {}
        }
    }
    for p in pendientes.as_array().into_iter().flatten() {
        if let Some(ws) = p.get("workspaceId").and_then(Value::as_str).filter(|ws| espacios.contains(ws)) {
            necesita(ws, &mut r);
        }
    }
    r
}

impl Resumen {
    /// Cambió algo que se ve: así la bandeja no se toca en cada evento.
    pub fn firma(&self) -> String {
        let mut ids = self.necesitan.clone();
        ids.sort();
        format!("{}|{}", self.trabajando, ids.join(","))
    }

    /// Alguien empezó a necesitarte desde el resumen anterior: la ventana titila si no tiene el foco.
    pub fn hay_nuevos(&self, antes: &Resumen) -> bool {
        self.necesitan.iter().any(|id| !antes.necesitan.contains(id))
    }

    pub fn tooltip(&self) -> String {
        format!("Sloth · {} trabajando · {} te necesitan", self.trabajando, self.necesitan.len())
    }

    /// Descripción del punto ámbar de la barra de tareas; `None` sin nadie que te necesite.
    pub fn descripcion_del_punto(&self) -> Option<String> {
        (!self.necesitan.is_empty()).then(|| format!("{} espacios te necesitan", self.necesitan.len()))
    }

    pub fn menu(&self) -> Vec<ItemMenu> {
        let mut m = vec![ItemMenu::Accion(Accion::Mostrar, "Mostrar Sloth".into())];
        let n = self.necesitan.len();
        if n > 0 {
            m.push(ItemMenu::Accion(Accion::AbrirPendiente, format!("{n} {}", if n == 1 { "espacio te necesita" } else { "espacios te necesitan" })));
        }
        m.push(ItemMenu::Separador);
        m.push(ItemMenu::Accion(Accion::ApagarYSalir, "Apagar todas las terminales y salir…".into()));
        m.push(ItemMenu::Accion(Accion::Salir, "Salir (las terminales siguen corriendo)".into()));
        m
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Accion {
    Mostrar,
    AbrirPendiente,
    ApagarYSalir,
    Salir,
}

impl Accion {
    pub fn id(self) -> &'static str {
        match self {
            Accion::Mostrar => "mostrar",
            Accion::AbrirPendiente => "pendiente",
            Accion::ApagarYSalir => "apagar",
            Accion::Salir => "salir",
        }
    }

    pub fn desde_id(id: &str) -> Option<Accion> {
        [Accion::Mostrar, Accion::AbrirPendiente, Accion::ApagarYSalir, Accion::Salir].into_iter().find(|a| a.id() == id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemMenu {
    Accion(Accion, String),
    Separador,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cierre {
    /// «Ocultar en la bandeja» quedó elegido: la ventana se esconde y Sloth sigue.
    Ocultar,
    Cerrar,
    Preguntar,
}

/// Qué hacer con la X. `corriendo` se calcula solo si hace falta (pregunta a quien maneja las terminales).
pub fn decidir_cierre(a_la_bandeja: bool, hay_bandeja: bool, confirmar: bool, corriendo: impl FnOnce() -> usize) -> Cierre {
    if a_la_bandeja && hay_bandeja {
        return Cierre::Ocultar;
    }
    if !confirmar || corriendo() == 0 {
        return Cierre::Cerrar;
    }
    Cierre::Preguntar
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TipoDialogo {
    Pregunta,
    Advertencia,
}

impl TipoDialogo {
    /// Como el `type` de `showMessageBox` de Electron.
    pub fn nombre(self) -> &'static str {
        match self {
            TipoDialogo::Pregunta => "question",
            TipoDialogo::Advertencia => "warning",
        }
    }
}

/// Un diálogo con botones propios (y casilla opcional), como `dialog.showMessageBox`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dialogo {
    pub tipo: TipoDialogo,
    pub titulo: String,
    pub mensaje: String,
    pub detalle: String,
    pub botones: Vec<String>,
    pub por_defecto: usize,
    pub cancelar: usize,
    pub casilla: Option<String>,
}

impl Dialogo {
    /// La forma de lo que veían las pruebas e2e en Electron (`message`, `detail`, `buttons`, `type`, `checkboxLabel`).
    pub fn a_json(&self) -> Value {
        json!({ "type": self.tipo.nombre(), "title": self.titulo, "message": self.mensaje, "detail": self.detalle, "buttons": self.botones, "checkboxLabel": self.casilla })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RespuestaDialogo {
    pub boton: usize,
    pub casilla: bool,
}

/// El aviso de la X con terminales abiertas: qué les pasa (según «Terminales vivas») y, si hay bandeja, la opción de ocultar.
pub fn dialogo_de_cierre(corriendo: usize, ocupados: usize, conservar: bool, hay_bandeja: bool) -> Dialogo {
    let terminales = plural(corriendo, "terminal abierta", "terminales abiertas");
    let ocupadas = match ocupados {
        0 => String::new(),
        1 => " Claude está trabajando en 1 de ellas.".into(),
        n => format!(" Claude está trabajando en {n} de ellas."),
    };
    let detalle = if conservar {
        format!("Tenés {terminales}.{ocupadas} Siguen corriendo en segundo plano y vuelven tal cual al abrir Sloth.")
    } else {
        format!("Tenés {terminales}.{ocupadas} Se van a cerrar junto con el Claude de cada una, y lo que esté haciendo se corta.")
    };
    let botones: Vec<String> =
        if hay_bandeja { vec!["Cerrar Sloth".into(), "Ocultar en la bandeja".into(), "Cancelar".into()] } else { vec!["Cerrar Sloth".into(), "Cancelar".into()] };
    let ultimo = botones.len() - 1;
    Dialogo {
        tipo: if conservar { TipoDialogo::Pregunta } else { TipoDialogo::Advertencia },
        titulo: "Sloth".into(),
        mensaje: "¿Cerrar Sloth?".into(),
        detalle,
        botones,
        por_defecto: ultimo,
        cancelar: ultimo,
        casilla: Some("No volver a preguntar".into()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eleccion {
    Cerrar,
    Bandeja,
    Cancelar,
}

pub fn eleccion_de_cierre(r: RespuestaDialogo, hay_bandeja: bool) -> Eleccion {
    match r.boton {
        0 => Eleccion::Cerrar,
        1 if hay_bandeja => Eleccion::Bandeja,
        _ => Eleccion::Cancelar,
    }
}

/// «Apagar todas las terminales y salir…» del menú de la bandeja.
pub fn dialogo_de_apagado(corriendo: usize) -> Dialogo {
    let detalle = if corriendo > 0 {
        format!("Se van a cerrar {} (y el Claude que corre en cada una). Lo que no esté guardado se pierde.", plural(corriendo, "terminal", "terminales"))
    } else {
        "No hay terminales corriendo. Sloth se cierra.".into()
    };
    Dialogo {
        tipo: TipoDialogo::Advertencia,
        titulo: "Sloth".into(),
        mensaje: "Apagar todas las terminales y salir".into(),
        detalle,
        botones: vec!["Apagar y salir".into(), "Cancelar".into()],
        por_defecto: 1,
        cancelar: 1,
        casilla: None,
    }
}

/// Punto ámbar con borde oscuro y antialias, en BGRA sin premultiplicar (lo que espera un ícono de Windows de 32 bits).
pub fn punto_ambar(tam: usize) -> Vec<u8> {
    let mut buf = vec![0u8; tam * tam * 4];
    let t = tam as f64;
    let c = t / 2.0;
    let r_borde = t / 2.0 - t / 16.0;
    let r_dentro = r_borde - t / 8.0;
    let mezcla = |borde: u8, dentro: u8, a: f64| (f64::from(borde) + (f64::from(dentro) - f64::from(borde)) * a).round() as u8;
    for y in 0..tam {
        for x in 0..tam {
            let d = ((x as f64 + 0.5 - c).powi(2) + (y as f64 + 0.5 - c).powi(2)).sqrt();
            let a_borde = (r_borde - d + 0.5).clamp(0.0, 1.0);
            if a_borde <= 0.0 {
                continue;
            }
            let a_dentro = (r_dentro - d + 0.5).clamp(0.0, 1.0);
            // Ámbar #f5b041 por dentro y borde #16181f (el fondo de la app) para que se lea sobre el ícono.
            let i = (y * tam + x) * 4;
            buf[i] = mezcla(0x1f, 0x41, a_dentro);
            buf[i + 1] = mezcla(0x18, 0xb0, a_dentro);
            buf[i + 2] = mezcla(0x16, 0xf5, a_dentro);
            buf[i + 3] = (255.0 * a_borde).round() as u8;
        }
    }
    buf
}

/// Ajustes de la bandeja (`closeToTray`: al cerrar la ventana, ocultarla en vez de salir; por defecto no).
pub struct ArchivoBandeja<'a> {
    archivo: PathBuf,
    a_la_bandeja: bool,
    resto: Map<String, Value>,
    futura: bool,
    por_respaldar: bool,
    avisos: &'a Avisos,
}

impl<'a> ArchivoBandeja<'a> {
    /// Sin `version` el archivo es de la v1 (el de Electron); una versión más nueva se lee pero nunca se reescribe.
    pub fn abrir(archivo: &Path, avisos: &'a Avisos) -> Self {
        let estado = Cell::new(None);
        let migraciones = Migraciones::new();
        let validar = |v: &Value| {
            let r = migrar(v, &migraciones, VERSION_BANDEJA);
            if r.estado == EstadoVersion::Invalida {
                return None;
            }
            estado.set(Some(r.estado));
            r.datos.as_object().cloned()
        };
        let lectura = leer_json(archivo, &OpcionesLectura::nuevas(&validar, &Map::new), avisos);
        let futura = estado.get() == Some(EstadoVersion::Futura);
        if futura {
            avisos.version_futura(archivo);
        }
        let mut resto = lectura.valor;
        let a_la_bandeja = resto.get("closeToTray") == Some(&Value::Bool(true));
        resto.remove("version");
        resto.remove("closeToTray");
        ArchivoBandeja { archivo: archivo.to_path_buf(), a_la_bandeja, resto, futura, por_respaldar: estado.get() == Some(EstadoVersion::Migrado), avisos }
    }

    pub fn a_la_bandeja(&self) -> bool {
        self.a_la_bandeja
    }

    /// Lo que devuelven `feat:tray:get` y `feat:tray:set`.
    pub fn a_json(&self) -> Value {
        json!({ "closeToTray": self.a_la_bandeja })
    }

    /// El valor queda en memoria aunque no se pueda guardar (versión futura): así la sesión respeta la elección.
    pub fn guardar(&mut self, a_la_bandeja: bool) -> Result<(), String> {
        self.a_la_bandeja = a_la_bandeja;
        if self.futura {
            self.avisos.version_futura(&self.archivo);
            return Ok(());
        }
        if self.por_respaldar && self.archivo.exists() {
            respaldar(&self.archivo).map_err(|e| format!("No pude respaldar tray.json antes de actualizarlo ({e})."))?;
        }
        self.por_respaldar = false;
        let mut datos = Map::new();
        datos.insert("version".into(), json!(VERSION_BANDEJA));
        datos.insert("closeToTray".into(), json!(a_la_bandeja));
        datos.extend(self.resto.clone());
        escribir_json_atomico(&self.archivo, &Value::Object(datos)).map(|_| ()).map_err(|e| e.to_string())
    }
}

/// `closeToTray` de un pedido de la UI, con los mismos errores que tray.ts.
pub fn validar_pedido(pedido: &Value) -> Result<bool, String> {
    // Como `typeof patch !== 'object'`: una lista pasa este control y falla en el siguiente.
    if !(pedido.is_object() || pedido.is_array()) {
        return Err("Configuración inválida.".into());
    }
    pedido
        .get("closeToTray").and_then(Value::as_bool).ok_or_else(|| "closeToTray tiene que ser true o false.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn estado(agentes: Value) -> Value {
        json!({ "workspaces": [{ "id": "a" }, { "id": "b" }, { "id": "c" }], "agents": agentes })
    }

    #[test]
    fn el_resumen_cuenta_trabajando_y_suma_esperas_y_permisos_sin_repetir() {
        let e = estado(json!({ "a": { "state": "working" }, "b": { "state": "waiting" }, "c": { "state": "done" }, "borrado": { "state": "working" } }));
        let p = json!([{ "workspaceId": "c" }, { "workspaceId": "b" }, { "workspaceId": "otro" }]);
        assert_eq!(resumir(&e, &p), Resumen { trabajando: 1, necesitan: vec!["b".into(), "c".into()] });
        assert_eq!(resumir(&Value::Null, &Value::Null), Resumen::default());
    }

    #[test]
    fn tooltip_menu_y_punto_siguen_los_textos_de_electron() {
        let vacio = Resumen::default();
        assert_eq!(vacio.tooltip(), "Sloth · 0 trabajando · 0 te necesitan");
        assert_eq!(vacio.descripcion_del_punto(), None);
        assert_eq!(
            vacio.menu(),
            vec![
                ItemMenu::Accion(Accion::Mostrar, "Mostrar Sloth".into()),
                ItemMenu::Separador,
                ItemMenu::Accion(Accion::ApagarYSalir, "Apagar todas las terminales y salir…".into()),
                ItemMenu::Accion(Accion::Salir, "Salir (las terminales siguen corriendo)".into()),
            ]
        );
        let uno = Resumen { trabajando: 2, necesitan: vec!["a".into()] };
        assert_eq!(uno.tooltip(), "Sloth · 2 trabajando · 1 te necesitan");
        assert_eq!(uno.menu()[1], ItemMenu::Accion(Accion::AbrirPendiente, "1 espacio te necesita".into()));
        let dos = Resumen { trabajando: 0, necesitan: vec!["a".into(), "b".into()] };
        assert_eq!(dos.menu()[1], ItemMenu::Accion(Accion::AbrirPendiente, "2 espacios te necesitan".into()));
        assert_eq!(dos.descripcion_del_punto().as_deref(), Some("2 espacios te necesitan"));
    }

    #[test]
    fn la_firma_ignora_el_orden_y_los_nuevos_hacen_titilar() {
        let a = Resumen { trabajando: 1, necesitan: vec!["a".into(), "b".into()] };
        let b = Resumen { trabajando: 1, necesitan: vec!["b".into(), "a".into()] };
        assert_eq!(a.firma(), b.firma());
        assert!(!b.hay_nuevos(&a));
        let c = Resumen { trabajando: 1, necesitan: vec!["c".into()] };
        assert!(c.hay_nuevos(&a));
        assert!(!Resumen::default().hay_nuevos(&a));
    }

    #[test]
    fn las_acciones_del_menu_van_y_vuelven_por_su_id() {
        for a in [Accion::Mostrar, Accion::AbrirPendiente, Accion::ApagarYSalir, Accion::Salir] {
            assert_eq!(Accion::desde_id(a.id()), Some(a));
        }
        assert_eq!(Accion::desde_id("otra"), None);
    }

    #[test]
    fn la_x_oculta_cierra_o_pregunta() {
        let nunca = || -> usize { panic!("no hacía falta contar las terminales") };
        assert_eq!(decidir_cierre(true, true, true, nunca), Cierre::Ocultar);
        assert_eq!(decidir_cierre(false, true, false, nunca), Cierre::Cerrar);
        assert_eq!(decidir_cierre(true, false, true, || 0), Cierre::Cerrar);
        assert_eq!(decidir_cierre(false, true, true, || 0), Cierre::Cerrar);
        assert_eq!(decidir_cierre(false, true, true, || 2), Cierre::Preguntar);
    }

    #[test]
    fn el_aviso_de_cierre_cuenta_terminales_y_agentes_ocupados() {
        let d = dialogo_de_cierre(1, 0, true, true);
        assert_eq!((d.mensaje.as_str(), d.tipo, d.por_defecto, d.cancelar), ("¿Cerrar Sloth?", TipoDialogo::Pregunta, 2, 2));
        assert_eq!(d.detalle, "Tenés 1 terminal abierta. Siguen corriendo en segundo plano y vuelven tal cual al abrir Sloth.");
        assert_eq!(d.botones, ["Cerrar Sloth", "Ocultar en la bandeja", "Cancelar"]);
        assert_eq!(d.casilla.as_deref(), Some("No volver a preguntar"));
        let d = dialogo_de_cierre(3, 1, false, false);
        assert_eq!(d.tipo, TipoDialogo::Advertencia);
        assert_eq!(d.detalle, "Tenés 3 terminales abiertas. Claude está trabajando en 1 de ellas. Se van a cerrar junto con el Claude de cada una, y lo que esté haciendo se corta.");
        assert_eq!((d.botones.len(), d.cancelar), (2, 1));
        assert!(dialogo_de_cierre(3, 2, true, true).detalle.contains("Claude está trabajando en 2 de ellas."));
        assert_eq!(d.a_json()["type"], json!("warning"));
        assert_eq!(d.a_json()["checkboxLabel"], json!("No volver a preguntar"));
    }

    #[test]
    fn la_eleccion_depende_de_si_hay_bandeja() {
        let r = |boton| RespuestaDialogo { boton, casilla: false };
        assert_eq!(eleccion_de_cierre(r(0), true), Eleccion::Cerrar);
        assert_eq!(eleccion_de_cierre(r(1), true), Eleccion::Bandeja);
        assert_eq!(eleccion_de_cierre(r(2), true), Eleccion::Cancelar);
        assert_eq!(eleccion_de_cierre(r(1), false), Eleccion::Cancelar);
    }

    #[test]
    fn el_aviso_de_apagado_dice_cuantas_terminales_se_cierran() {
        assert_eq!(dialogo_de_apagado(1).detalle, "Se van a cerrar 1 terminal (y el Claude que corre en cada una). Lo que no esté guardado se pierde.");
        assert!(dialogo_de_apagado(4).detalle.starts_with("Se van a cerrar 4 terminales"));
        let d = dialogo_de_apagado(0);
        assert_eq!(d.detalle, "No hay terminales corriendo. Sloth se cierra.");
        assert_eq!((d.botones.len(), d.por_defecto, d.cancelar, d.casilla), (2, 1, 1, None));
    }

    #[test]
    fn el_punto_es_ambar_en_el_centro_transparente_en_las_esquinas_y_con_borde_oscuro() {
        for tam in [16, 32] {
            let p = punto_ambar(tam);
            assert_eq!(p.len(), tam * tam * 4);
            let px = |x: usize, y: usize| &p[(y * tam + x) * 4..(y * tam + x) * 4 + 4];
            assert_eq!(px(tam / 2, tam / 2), [0x41, 0xb0, 0xf5, 255]);
            assert_eq!(px(0, 0)[3], 0);
            let borde = px(tam / 2, tam / 16 + 1);
            assert_eq!(borde[3], 255);
            assert!(borde[2] < 0x80, "{borde:?}");
        }
    }

    fn carpeta(nombre: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sloth-core-tray-{nombre}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn leer(p: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
    }

    #[test]
    fn sin_archivo_no_se_oculta_en_la_bandeja() {
        let d = carpeta("sin");
        let avisos = Avisos::nuevo();
        let a = ArchivoBandeja::abrir(&d.join("tray.json"), &avisos);
        assert!(!a.a_la_bandeja());
        assert_eq!(a.a_json(), json!({ "closeToTray": false }));
    }

    #[test]
    fn el_archivo_de_electron_se_lee_se_respalda_y_se_guarda_con_version_1_conservando_campos() {
        let d = carpeta("v1");
        let f = d.join("tray.json");
        fs::write(&f, "\u{feff}{\"closeToTray\":true,\"otro\":{\"x\":1}}").unwrap();
        let avisos = Avisos::nuevo();
        let mut a = ArchivoBandeja::abrir(&f, &avisos);
        assert!(a.a_la_bandeja());
        a.guardar(false).unwrap();
        assert_eq!(leer(&f), json!({ "version": 1, "closeToTray": false, "otro": { "x": 1 } }));
        let respaldos: Vec<_> = fs::read_dir(&d).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().contains(".bak")).collect();
        assert_eq!(respaldos.len(), 1, "falta el respaldo del archivo viejo");
        a.guardar(true).unwrap();
        assert_eq!(ArchivoBandeja::abrir(&f, &avisos).a_json(), json!({ "closeToTray": true }));
        assert!(avisos.tomar().is_empty());
    }

    #[test]
    fn closetotray_que_no_es_true_cuenta_como_false() {
        let d = carpeta("raro");
        let f = d.join("tray.json");
        fs::write(&f, r#"{"version":1,"closeToTray":"si"}"#).unwrap();
        let avisos = Avisos::nuevo();
        assert!(!ArchivoBandeja::abrir(&f, &avisos).a_la_bandeja());
    }

    #[test]
    fn una_version_futura_se_lee_pero_nunca_se_reescribe() {
        let d = carpeta("futura");
        let f = d.join("tray.json");
        let original = r#"{"version":2,"closeToTray":true,"nuevo":1}"#;
        fs::write(&f, original).unwrap();
        let avisos = Avisos::nuevo();
        let mut a = ArchivoBandeja::abrir(&f, &avisos);
        assert!(a.a_la_bandeja());
        a.guardar(false).unwrap();
        assert!(!a.a_la_bandeja());
        assert_eq!(fs::read_to_string(&f).unwrap(), original);
        assert!(avisos.tomar().iter().any(|t| t.contains("versión más nueva")));
    }

    #[test]
    fn un_archivo_roto_se_aparta_y_arranca_sin_bandeja() {
        let d = carpeta("roto");
        let f = d.join("tray.json");
        fs::write(&f, "{no").unwrap();
        let avisos = Avisos::nuevo();
        assert!(!ArchivoBandeja::abrir(&f, &avisos).a_la_bandeja());
        assert!(!f.exists());
        assert_eq!(avisos.tomar().len(), 1);
    }

    #[test]
    fn el_pedido_de_la_ui_se_valida_con_los_textos_de_electron() {
        assert_eq!(validar_pedido(&json!({ "closeToTray": true })), Ok(true));
        assert_eq!(validar_pedido(&json!(null)), Err("Configuración inválida.".into()));
        assert_eq!(validar_pedido(&json!("x")), Err("Configuración inválida.".into()));
        assert_eq!(validar_pedido(&json!({ "closeToTray": "si" })), Err("closeToTray tiene que ser true o false.".into()));
    }
}
