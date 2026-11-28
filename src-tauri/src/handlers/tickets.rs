//! Canales `feat:tickets:*` en Rust. Las reglas (lo que llega por IPC sin validar, cambios de conector y de configuración,
//! lo que ve la interfaz) están en `sloth_core::features::tickets::servicio`; acá están su `Entorno` sobre la cáscara, los
//! archivos de userData, correr `claude -p`, `codex exec` y `gh`, los eventos `feat:tickets:changed` y lo que Equipo lee en
//! memoria (`para_equipo`, `al_cambiar`).
//!
//! Cuentas y espacios se leen de `sloth-state.json` sin escribirlo: «Empezar» le pide el espacio a su dueño por
//! `workspaces:add`, así anda igual sea el dueño el proceso de apoyo o Rust.
use super::comun::{ahora_ms, fecha_local, texto, ui};
use super::{arg, AlHook};
use crate::entorno::{DialogoArchivo, Entorno};
use crate::router::Router;
use serde_json::{json, Map, Value};
use sloth_core::agente_exe::resolver_exe;
use sloth_core::cuentas::{estado_de_cuenta, exigir_proveedor};
use sloth_core::features::proceso::{entorno_sin_preguntas, Ejecutor};
use sloth_core::features::team_config::{clave_de_repo, leer_team_config_del_repo, Lectura};
use sloth_core::features::team_github::repo_de_carpeta;
use sloth_core::features::tickets::acciones::{aplicar_accion, ticket_id, Aplicar};
use sloth_core::features::tickets::alcance::{alcance_a_pedir, filtro_de, iso_de_ms, leido_tras, mezclar, pendientes_de, sin_pendientes, AlcanceLista};
use sloth_core::features::tickets::almacen::{Almacen, ConfigCruda, FsReal, OpcionesAlmacen};
use sloth_core::features::tickets::archivos::{cargar_cuentas, guardar_archivo_propios, guardar_cuentas, leer_archivo_propios, leer_conectores_equipo, ConectoresEquipo};
use sloth_core::features::tickets::claude_run::{run_claude, OpcionesRun, ProcesoRun};
use sloth_core::features::tickets::codex_config::{servidor_de_prefijo, servidores_de_config_toml, servidores_ignorados, servidores_revisados, MAX_TOML};
use sloth_core::features::tickets::concurrencia::de_a;
use sloth_core::features::tickets::conector::{ConectorDef, ConectorGh, ConectorMcp};
use sloth_core::features::tickets::conectores::CONECTORES;
use sloth_core::features::tickets::cuentas::{
    build_revisar_prompt, con_prefijo, conviene_revisar, problema_en_sesion, revisar_cuenta, revisar_schema, revisar_temprano, servidor_de_la_lista, servidor_pendiente, servidores_de_salida,
};
use sloth_core::features::tickets::descubrir::{build_descubrir_prompt, parse_descubrir, Fuente};
use sloth_core::features::tickets::eleccion::ParaQue;
use sloth_core::features::tickets::entorno_consulta::entorno_consulta;
use sloth_core::features::tickets::errores::{ErrorTickets, Res};
use sloth_core::features::tickets::estado::{estado_vacio, ticket_de_obj, Buscar, Obj};
use sloth_core::features::tickets::gh::{gh_accion, gh_detalle, gh_lista, gh_yo, repo_valido, GhConProceso};
use sloth_core::features::tickets::mcp_ajenos::mcp_ajenos;
use sloth_core::features::tickets::modelo::{Corrida, CuentaRevisada, Detalle, Disponibilidad, EstadoMcp, ResultadoPrueba, ServidorMcp, Ticket, Via, SIN_CONECTOR};
use sloth_core::features::tickets::motor::{
    acciones_soportadas, build_accion_prompt, build_detalle_prompt, build_personas_prompt, build_prompt, misma_herramienta, parse_accion, parse_claude_output, parse_detalle, parse_personas, Limites,
    ResultadoLista,
};
use sloth_core::features::tickets::motor_codex::{error_ignorados, ACCIONES_VERIFICADAS, SOLO_LECTURA};
use sloth_core::features::tickets::motor_tickets::{etiquetar_agente, motor_de, MotorTickets, PedidoMotor, TareaMotor};
use sloth_core::features::tickets::lanzamiento::lanzamiento_de;
use sloth_core::features::tickets::probar::{build_probar_args, build_probar_prompt, datos_de_mcp_get, diagnosticar, limpiar_causa_defecto, nombre_probable, parse_probar, DatosMcp, EntradaDiagnostico, ResultadoDePrueba};
use sloth_core::features::tickets::propios::{esta_aceptado, hash_corto, parsear_import, recortar_avisos, texto_export, armar_registro, ConectorRegistrado, EntradaRegistro, EquipoCrudo, IMPORT_MAX_BYTES};
use sloth_core::features::tickets::reintento::{con_reintento, costo_de_pendiente, OpcionesReintento, PresupuestoReintento};
use sloth_core::features::tickets::servicio::{sin_conector, CuentaInfo, Entorno as EntornoTickets, EspacioInfo, PlanInicio, Servicio};
use sloth_core::features::tickets::texto::{cortar16, Num};
use sloth_core::features::tickets::uso::{costo_valido_f, last_run_tras_error, leer_uso, limites_efectivos, sumar_uso, texto_flag_viejo, texto_tope, tope_vueltas_error, LimitesEfectivos, UsoCorrida, COSTO_MIN};
use sloth_core::features::tickets::modelo::{OrigenConector, Tope};
use sloth_core::proveedores::{motivo_sin_capacidad, nombre_proveedor, ProveedorId};
use sloth_core::proveedores_fs::{como_instalar, env_cuenta, quitar_del_entorno, resolver_exe_claude};
use sloth_core::ptys_core::entorno_limpio;
use sloth_core::usage::{CuentaUso, EscanerUso};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

pub const NOMBRE: &str = "tickets";

const DETALLE_TIMEOUT_MS: u64 = 90_000;
/// Una lista grande (varias personas, terminados) tarda más que un detalle; el plazo de las demás consultas no cambia.
const LISTA_TIMEOUT_MS: u64 = 300_000;
const PERSONAS_TIMEOUT_MS: u64 = 120_000;
const PROBAR_TIMEOUT_MS: u64 = 75_000;
/// Un servidor que no conecta tarda hasta MCP_TIMEOUT (30 s) en decirlo.
const MOTIVO_TIMEOUT_MS: u64 = 45_000;
const REVISAR_TIMEOUT_MS: u64 = 90_000;
/// Todos los intentos de una consulta juntos no pasan de esto.
const REINTENTOS_TOTAL_MS: f64 = 300_000.0;
const GH_TIMEOUT: Duration = Duration::from_secs(30);
const ALTA_DE_ESPACIO: Duration = Duration::from_secs(180);
const REPOS_DE_EQUIPO_MAX: usize = 30;


fn anotar(m: &str) {
    sloth_core::logger_global::aviso(NOMBRE, m);
}

fn otro(m: impl Into<String>) -> ErrorTickets {
    ErrorTickets::otro(m)
}

type ResolverExe = dyn Fn(ProveedorId) -> Option<String> + Send + Sync;

/// Lo que cambia entre la app y los tests: cómo se corren los agentes y gh, cómo se corre git y dónde está cada agente.
pub struct Sistema {
    pub proceso: Arc<dyn ProcesoRun>,
    pub git: Arc<dyn Ejecutor>,
    pub exe: Arc<ResolverExe>,
}

fn exe_real(p: ProveedorId) -> Option<String> {
    let path = std::env::var("PATH").or_else(|_| std::env::var("Path")).unwrap_or_default();
    let win = cfg!(windows);
    let existe = |c: &str| Path::new(c).is_file();
    match p {
        ProveedorId::Claude => {
            let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
            resolver_exe_claude(&path, &home, &existe, &|f| fs::read_to_string(f).ok(), win)
        }
        ProveedorId::Codex => resolver_exe("codex", &path, &existe, win),
        ProveedorId::Copilot => resolver_exe("copilot", &path, &existe, win),
    }
}

impl Sistema {
    pub fn real() -> Sistema {
        Sistema {
            proceso: Arc::new(sloth_core::features::tickets::claude_run::Real),
            git: Arc::new(sloth_core::features::proceso::Real),
            exe: Arc::new(exe_real),
        }
    }
}

/// Las cuentas y los espacios de `sloth-state.json` en el momento de la llamada, y el consumo de las últimas 5 h.
struct Env<'a> {
    cuentas: Vec<CuentaInfo>,
    espacios: Vec<EspacioInfo>,
    crudas: Vec<Value>,
    /// El store se leyó entero: recién entonces se pueden podar las cuentas que ya no están.
    confiable: bool,
    uso: &'a Mutex<EscanerUso>,
}

impl EntornoTickets for Env<'_> {
    fn cuentas(&self) -> Vec<CuentaInfo> {
        self.cuentas.clone()
    }
    fn es_directorio(&self, ruta: &str) -> bool {
        !ruta.is_empty() && Path::new(ruta).is_dir()
    }
    fn existe(&self, ruta: &str) -> bool {
        !ruta.is_empty() && Path::new(ruta).exists()
    }
    fn ahora(&self) -> f64 {
        ahora_ms() as f64
    }
    fn espacios(&self) -> Vec<EspacioInfo> {
        self.espacios.clone()
    }
    fn repo_key(&self, ruta: &str) -> String {
        clave_de_repo(ruta)
    }
    fn consumo_5h(&self, cuenta_id: &str) -> f64 {
        let cuentas: Vec<CuentaUso> = self.crudas.iter().filter_map(CuentaUso::desde_cuenta).collect();
        let mut u = self.uso.lock().unwrap_or_else(|e| e.into_inner());
        let t = u.escanear(&cuentas, ahora_ms() as i64, 0).get(cuenta_id).map(|c| c.last5h.clone());
        t.map_or(0.0, |t| t.input + t.output + t.cache_write + t.cache_read)
    }
}


impl Env<'_> {
    fn cuenta(&self, id: &str) -> Option<&CuentaInfo> {
        self.cuentas.iter().find(|c| c.id == id)
    }
}

struct Datos {
    carpeta: PathBuf,
    s: Servicio,
    /// tickets-conectores.json no se pudo leer ni respaldar, o es de una versión más nueva: no se pisa.
    propios_ilegible: bool,
}

/// Cómo se corre el agente de una cuenta para una consulta.
struct Ejecucion {
    cuenta_id: String,
    label: String,
    exe: String,
    cwd: PathBuf,
    env: BTreeMap<String, String>,
    config_dir: String,
    motor: &'static dyn MotorTickets,
    /// Cómo se llama el agente en los textos («Claude», «Codex»).
    agente: String,
    /// La sesión corrió sin los conectores de claude.ai: su system/init no los trae.
    sin_claude_ai: bool,
}

/// Lo que «Actualizar» arma antes de correr: se toma junto, con el estado tomado, para no leer una config a medias.
struct Preparado {
    dm: ConectorMcp,
    lim: Limites,
    alcance: Option<AlcanceLista>,
    todo: bool,
    model: String,
    assignee: String,
    cancel: Arc<AtomicBool>,
    personas_falta: bool,
}

type Oyente = Arc<dyn Fn() + Send + Sync>;

pub struct Tickets {
    entorno: Arc<Entorno>,
    sis: Sistema,
    datos: Mutex<Option<Datos>>,
    uso: Mutex<EscanerUso>,
    cancelar: Mutex<Option<Arc<AtomicBool>>>,
    oyentes: Mutex<Vec<Oyente>>,
}

fn tomar<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn ticket_a_obj(t: &Ticket) -> Obj {
    match serde_json::to_value(t) {
        Ok(Value::Object(o)) => o,
        _ => Obj::new(),
    }
}

/// Pasa al objeto guardado lo que cambió del ticket sin mover sus claves (y saca las que el ticket ya no tiene).
fn fundir_ticket(previo: &mut Obj, t: &Ticket) {
    let nuevo = ticket_a_obj(t);
    previo.retain(|k, _| nuevo.contains_key(k));
    for (k, v) in nuevo {
        previo.insert(k, v);
    }
}

fn leer_json_suave(f: &Path) -> Value {
    fs::read_to_string(f).ok().and_then(|t| serde_json::from_str(t.strip_prefix('\u{feff}').unwrap_or(&t)).ok()).unwrap_or_else(|| json!({}))
}

fn prefijo(d: &ConectorMcp) -> &str {
    &d.herramientas.prefijo
}

fn resultado_prueba(r: &ResultadoPrueba) -> Value {
    let mut o = Map::new();
    o.insert("estado".into(), json!(r.estado.como_str()));
    o.insert("mensaje".into(), json!(r.mensaje));
    if let Some(c) = &r.causa {
        o.insert("causa".into(), json!(c));
    }
    if let Some(q) = &r.que_hacer {
        o.insert("queHacer".into(), json!(q));
    }
    o.insert("ms".into(), json!(r.ms));
    Value::Object(o)
}

fn config_cruda(s: &Servicio) -> ConfigCruda {
    ConfigCruda { default_repo: s.estado.config.default_repo.clone(), project_repos: s.estado.config.project_repos.clone() }
}

impl Tickets {
    pub fn nuevo(entorno: Arc<Entorno>, sis: Sistema) -> Arc<Tickets> {
        Arc::new(Tickets { entorno, sis, datos: Mutex::new(None), uso: Mutex::new(EscanerUso::nuevo()), cancelar: Mutex::new(None), oyentes: Mutex::new(Vec::new()) })
    }

    fn env(&self) -> Env<'_> {
        let estado = self.entorno.estado();
        let lista = |k: &str| estado.get(k).and_then(Value::as_array).cloned();
        let confiable = lista("accounts").is_some();
        let crudas = lista("accounts").unwrap_or_default();
        let cuentas = crudas
            .iter()
            .filter_map(|c| {
                let id = texto(c, "id")?;
                let con_sesion = estado_de_cuenta(c).get("loggedIn") == Some(&Value::Bool(true));
                Some(CuentaInfo { label: texto(c, "label").unwrap_or_else(|| id.clone()), id, cuenta: c.clone(), con_sesion })
            })
            .collect();
        let espacios = lista("workspaces")
            .unwrap_or_default()
            .iter()
            .filter_map(|w| {
                Some(EspacioInfo { id: texto(w, "id")?, repo_path: texto(w, "repoPath").unwrap_or_default(), ticket: texto(w, "ticket"), created_at: w.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0) })
            })
            .collect();
        Env { cuentas, espacios, crudas, confiable, uso: &self.uso }
    }

    /// El estado de tickets del perfil activo (lo carga la primera vez, o si el perfil cambió) con el entorno de ahora.
    fn con<T>(&self, f: impl FnOnce(&mut Datos, &Env) -> T) -> Res<T> {
        let carpeta = self.entorno.carpeta_features().map_err(otro)?;
        let env = self.env();
        let mut g = tomar(&self.datos);
        if g.as_ref().is_none_or(|d| d.carpeta != carpeta) {
            *g = Some(self.cargar(carpeta, &env));
        }
        Ok(f(g.as_mut().expect("recién cargado"), &env))
    }

    fn cargar(&self, carpeta: PathBuf, env: &Env) -> Datos {
        let almacen = Almacen::nuevo(OpcionesAlmacen { fs: Box::new(FsReal), carpeta: carpeta.clone(), log: Box::new(anotar), ahora: Box::new(|| ahora_ms() as f64) });
        let mut d = Datos { carpeta, s: Servicio::nuevo(almacen, estado_vacio(SIN_CONECTOR)), propios_ilegible: false };
        // Antes de cargar el estado: si el conector guardado es del equipo de un repo de los ajustes, tiene que estar en el registro.
        let cruda = d.s.almacen.config_cruda();
        self.recargar_propios(&mut d, env, cruda.as_ref());
        let registro = std::mem::take(&mut d.s.registro);
        let aceptados = d.s.archivo_propios.aceptados.clone();
        let clave = |k: &str| clave_de_repo(k);
        let buscar: Buscar = &|id: &str| registro.iter().find(|r| r.def.id() == id && esta_aceptado(r, &aceptados, &clave)).map(|r| &r.def);
        d.s.estado = d.s.almacen.cargar(buscar);
        d.s.registro = registro;
        let cruda = config_cruda(&d.s);
        self.recargar_propios(&mut d, env, Some(&cruda));
        let c = cargar_cuentas(&FsReal, &d.carpeta.join("tickets-cuentas.json"), ahora_ms() as f64);
        for l in c.logs {
            anotar(&l);
        }
        d.s.cuentas_revisadas = c.cuentas;
        d
    }

    /// Los repos donde buscar `.sloth/conectores.json`: los de los espacios y los de los ajustes de Tickets.
    fn repos_de_equipo(env: &Env, config: Option<&ConfigCruda>) -> Vec<String> {
        let mut candidatos: Vec<String> = env.espacios.iter().map(|w| w.repo_path.clone()).collect();
        if let Some(c) = config {
            candidatos.extend(c.default_repo.clone());
            candidatos.extend(c.project_repos.iter().map(|(_, v)| v.clone()));
        }
        let mut repos: Vec<(String, String)> = Vec::new();
        for p in candidatos {
            if repos.len() >= REPOS_DE_EQUIPO_MAX {
                break;
            }
            if p.is_empty() {
                continue;
            }
            let k = clave_de_repo(&p);
            if !repos.iter().any(|(x, _)| *x == k) && Path::new(&p).exists() {
                repos.push((k, p));
            }
        }
        repos.into_iter().map(|(_, p)| p).collect()
    }

    /// Relee los conectores propios y los del equipo. Sin config, solo los repos de los espacios.
    fn recargar_propios(&self, d: &mut Datos, env: &Env, config: Option<&ConfigCruda>) {
        let fs_real = FsReal;
        let r = leer_archivo_propios(&fs_real, &d.carpeta.join("tickets-conectores.json"), ahora_ms() as f64);
        d.propios_ilegible = r.ilegible;
        d.s.archivo_propios = r.archivo;
        let mut avisos = r.avisos;
        let mut equipos: Vec<EquipoCrudo> = Vec::new();
        for repo in Self::repos_de_equipo(env, config) {
            match leer_conectores_equipo(&fs_real, Path::new(&repo)) {
                ConectoresEquipo::Aviso(a) => avisos.push(a),
                ConectoresEquipo::Lista(l) if !l.is_empty() => {
                    let equipo = match leer_team_config_del_repo(&repo) {
                        Lectura::Ok { config, .. } => config.equipo,
                        _ => Path::new(&repo).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| repo.clone()),
                    };
                    equipos.push(EquipoCrudo { repo_key: clave_de_repo(&repo), repo, equipo, conectores: l });
                }
                _ => {}
            }
        }
        let usuario: Vec<Value> = d.s.archivo_propios.conectores.iter().map(ConectorDef::a_valor).collect();
        let (lista, mas) = armar_registro(&EntradaRegistro { incluidos: &CONECTORES, usuario: &usuario, equipos: &equipos, hash: &hash_corto });
        d.s.registro = lista;
        avisos.extend(mas);
        d.s.avisos_propios = recortar_avisos(&avisos);
    }

    fn snapshot(&self) -> Res<Value> {
        self.con(|d, env| d.s.snapshot(env))
    }

    fn avisar(&self) {
        match self.snapshot() {
            Ok(s) => self.entorno.emitir(NOMBRE, "changed", &[s]),
            Err(e) => anotar(&format!("tickets: no pude armar el estado: {e}")),
        }
        let oyentes: Vec<Oyente> = tomar(&self.oyentes).clone();
        for f in oyentes {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f())).is_err() {
                anotar("tickets: un oyente de Equipo falló");
            }
        }
    }

    fn cambio(&self) {
        let _ = self.con(|d, _| d.s.guardar());
        self.avisar();
    }

    /// Equipo se entera de cada cambio para rearmar su vista.
    pub fn al_cambiar(&self, f: Oyente) {
        tomar(&self.oyentes).push(f);
    }

    /// Lo que trajo el conector activo, para la vista Equipo. Antes de que el perfil esté listo, nada.
    pub fn para_equipo(&self) -> Value {
        self.con(|d, env| d.s.tickets_para_equipo(env))
            .unwrap_or_else(|_| json!({ "conector": null, "tickets": [], "estados": [], "running": false, "model": "", "confirmar": true }))
    }

    fn guardar_cuentas(&self) {
        let r = self.con(|d, env| {
            let existe = |id: &str| env.cuentas.iter().any(|c| c.id == id);
            guardar_cuentas(&FsReal, &d.carpeta.join("tickets-cuentas.json"), &d.carpeta, std::process::id(), &d.s.cuentas_revisadas, &existe, env.confiable)
        });
        if let Ok(Some(m)) = r {
            anotar(&m);
        }
    }

    /// El conector con el prefijo del servidor que tiene esa cuenta; las herramientas cortas son siempre las del conector.
    fn def_para(s: &Servicio, def: &ConectorMcp, cuenta_id: &str) -> ConectorMcp {
        match s.disp_en(def, cuenta_id) {
            Disponibilidad::Tiene { adaptado: true, prefijo, .. } => con_prefijo(def, &prefijo).unwrap_or_else(|_| def.clone()),
            _ => def.clone(),
        }
    }

    /// Los topes de la config; `max_turns` pisa el de la config solo para una consulta ya validada.
    fn limites(s: &Servicio, max_turns: Option<u32>) -> Limites {
        Limites { max_turns: max_turns.map(f64::from).or(s.estado.config.max_turns.map(|n| n.0)), max_cost_usd: s.estado.config.max_cost_usd.map(|n| n.0) }
    }

    fn con_restante(lim: Limites, p: PresupuestoReintento) -> Limites {
        Limites { max_cost_usd: p.restante_usd.or(lim.max_cost_usd), ..lim }
    }

    fn efectivos(lim: Limites) -> LimitesEfectivos {
        limites_efectivos(lim.max_turns, lim.max_cost_usd)
    }

    /// Con `mcp`, si la cuenta lo usa con un servidor que no es de claude.ai, la sesión no conecta los de claude.ai.
    fn ejecucion(&self, d: &Datos, env: &Env, nombre: &str, cuenta_id: &str, mcp: Option<&ConectorMcp>) -> Res<Ejecucion> {
        let acc = env.cuenta(cuenta_id).ok_or_else(|| otro(format!("La cuenta para consultar {nombre} ya no existe. Elegí otra en Configuración.")))?;
        let p = exigir_proveedor(&acc.cuenta).map_err(otro)?;
        let motor = motor_de(&acc.cuenta).filter(|_| p.capacidades().tickets_headless);
        let Some(motor) = motor else {
            let m = motivo_sin_capacidad(&acc.cuenta, "ticketsHeadless").unwrap_or_else(|| "no consulta tickets.".into());
            return Err(otro(format!("La cuenta «{}» es de {}: {m}", acc.label, nombre_proveedor(&acc.cuenta))));
        };
        if !acc.con_sesion {
            return Err(otro(format!("La cuenta «{}» no tiene sesión iniciada.", acc.label)));
        }
        let Some(exe) = (self.sis.exe)(p) else {
            return Err(otro(if p == ProveedorId::Claude {
                "No encontré el ejecutable de Claude Code (claude.exe) en el PATH.".to_string()
            } else {
                format!("No encontré {} en el PATH. {}", nombre_proveedor(&acc.cuenta), como_instalar(p))
            }));
        };
        let cwd = d.carpeta.join("tickets-run");
        fs::create_dir_all(&cwd).map_err(|e| otro(e.to_string()))?;
        let config_dir = acc.cuenta.get("configDir").and_then(Value::as_str).unwrap_or_default().to_string();
        let consulta = entorno_consulta(mcp.map(|m| Self::def_para(&d.s, m, &acc.id)).as_ref().map(prefijo));
        let mut entorno = consulta.env;
        entorno.extend(entorno_limpio(std::env::vars(), &|k| quitar_del_entorno(p, k)));
        entorno.extend(env_cuenta(p, &config_dir));
        Ok(Ejecucion { cuenta_id: acc.id.clone(), label: acc.label.clone(), exe, cwd, env: entorno, config_dir, motor, agente: p.etiqueta().into(), sin_claude_ai: consulta.sin_claude_ai })
    }

    /// Cuenta con la que se leen y escriben tickets: la que consultó la última vez.
    fn cuenta(&self, d: &Datos, env: &Env, def: &ConectorDef) -> Res<Ejecucion> {
        let Some(id) = d.s.estado.config.query_account_id.clone() else { return Err(otro(format!("Actualizá {} primero para elegir la cuenta que lo conecta.", def.nombre()))) };
        self.ejecucion(d, env, def.nombre(), &id, def.mcp())
    }

    fn ajenos_de(run: &Ejecucion, def: &ConectorMcp) -> Vec<String> {
        let dir = Path::new(&run.config_dir);
        mcp_ajenos(&leer_json_suave(&dir.join("settings.json")), &leer_json_suave(&dir.join(".claude.json")), prefijo(def))
    }

    /// Nombres de los servidores del config.toml de la cuenta: solo ese archivo, nunca auth.json. Sin archivo, ninguno.
    fn servidores_de_codex(run: &Ejecucion) -> Res<Vec<String>> {
        let archivo = Path::new(&run.config_dir).join("config.toml");
        let texto = match fs::metadata(&archivo) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => {
                anotar(&format!("tickets: no pude leer el config.toml de «{}»: {e}", run.label));
                return Err(otro(format!("No pude leer el config.toml de la cuenta «{}».", run.label)));
            }
            // Se mira el tamaño antes de leer: un archivo enorme no se carga entero.
            Ok(m) if m.len() as usize > MAX_TOML => None,
            Ok(_) => match fs::read_to_string(&archivo) {
                Ok(t) => Some(t),
                Err(e) => {
                    anotar(&format!("tickets: no pude leer el config.toml de «{}»: {e}", run.label));
                    return Err(otro(format!("No pude leer el config.toml de la cuenta «{}».", run.label)));
                }
            },
        };
        texto
            .and_then(|t| servidores_de_config_toml(&t))
            .ok_or_else(|| otro(format!("No pude entender el config.toml de la cuenta «{}»: no sé qué servidores MCP tiene.", run.label)))
    }

    /// Completa el pedido con lo que el motor no puede saber solo. Con Codex: qué servidores tiene la cuenta y cuál es el del conector.
    fn pedido_para(run: &Ejecucion, p: &mut PedidoMotor) -> Res<()> {
        if run.motor.lee_init() {
            return Ok(());
        }
        p.servidores_cuenta = Some(Self::servidores_de_codex(run)?);
        p.servidor_elegido = p.def.and_then(|d| servidor_de_prefijo(prefijo(d)));
        Ok(())
    }

    /// Corre el agente de la cuenta con el pedido del motor. Con Claude, el ejecutable y el argv tal cual; otro agente que viene
    /// en un .cmd de npm corre por cmd.exe con la línea armada y validada, y puede cortar por línea.
    #[allow(clippy::too_many_arguments)]
    fn correr<T>(&self, run: &Ejecucion, pedido: &PedidoMotor, prompt: &str, quien: &str, timeout_ms: u64, cancel: Option<&AtomicBool>, parse: &dyn Fn(&str) -> Res<T>, temprano: Option<&dyn Fn(&str) -> Option<T>>) -> Res<T> {
        let args = run.motor.argv(pedido)?;
        let (exe, args, verbatim) = if run.motor.id() == ProveedorId::Claude {
            (run.exe.clone(), args, false)
        } else {
            let l = lanzamiento_de(&run.exe, &args, cfg!(windows))?;
            (l.file, l.args, l.verbatim)
        };
        let mut env = run.env.clone();
        env.extend(run.motor.env_extra(pedido));
        let cortar = |l: &str| run.motor.cortar_si(l, pedido);
        let mut o = OpcionesRun::nuevo(&exe, args, prompt, run.cwd.clone(), quien, parse);
        o.env = env;
        o.timeout_ms = Some(timeout_ms);
        o.cancelado = cancel;
        o.verbatim = verbatim;
        o.temprano = temprano;
        if run.motor.id() != ProveedorId::Claude {
            o.cortar_si = Some(&cortar);
            o.agente = Some(run.agente.clone());
        }
        run_claude(self.sis.proceso.as_ref(), &o)
    }

    /// `claude` con argumentos propios (probar, `mcp get`), sin pasar por el motor.
    fn correr_crudo<T>(&self, run: &Ejecucion, args: Vec<String>, prompt: &str, quien: &str, timeout_ms: u64, parse: &dyn Fn(&str) -> Res<T>) -> Res<T> {
        let mut o = OpcionesRun::nuevo(&run.exe, args, prompt, run.cwd.clone(), quien, parse);
        o.env = run.env.clone();
        o.timeout_ms = Some(timeout_ms);
        run_claude(self.sis.proceso.as_ref(), &o)
    }

    /// Un error común (los propios pasan tal cual) con el aviso de claude viejo, si corresponde. Con otro agente, solo cambia el nombre.
    fn legible(e: ErrorTickets, run: Option<&Ejecucion>) -> ErrorTickets {
        if let Some(r) = run.filter(|r| r.motor.id() != ProveedorId::Claude) {
            return etiquetar_agente(e, &r.agente);
        }
        match &e {
            ErrorTickets::Otro(m) => texto_flag_viejo(m).map_or(e.clone(), otro),
            _ => e,
        }
    }

    /// Se anota también lo que cortó un tope: ese costo ya se gastó.
    fn registrar_uso(&self, conector_id: &str, u: &UsoCorrida) {
        let _ = self.con(|d, _| d.s.estado.uso = Some(sumar_uso(d.s.estado.uso.as_ref(), &fecha_local(ahora_ms()), conector_id, u)));
        self.cambio();
    }

    /// Antes del parser del conector: anota lo gastado y, si cortó un tope, lo dice en vez de leer una salida a medias.
    fn medir_uso(&self, conector_id: &str, s: &str, lim: &LimitesEfectivos, accion: bool) -> Res<()> {
        let Some(u) = leer_uso(s) else { return Ok(()) };
        self.registrar_uso(conector_id, &u);
        match u.tope {
            Some(t) => {
                let limite = if t == Tope::Vueltas { f64::from(lim.vueltas) } else { lim.costo.unwrap_or(0.0) };
                Err(tope_vueltas_error(texto_tope(t, limite, accion), t, u))
            }
            None => Ok(()),
        }
    }

    /// Lo que dijo el system/init de una consulta pisa lo revisado: es lo más nuevo que se sabe de esa cuenta. Parcial: la sesión
    /// corrió sin los conectores de claude.ai, así que los que no vinieron se conservan.
    fn actualizar_desde_init(&self, cuenta_id: &str, sesion: &[ServidorMcp], parcial: bool) {
        let _ = self.con(|d, _| {
            let previa = d.s.cuentas_revisadas.get(cuenta_id).cloned();
            let de_claude_ai: Vec<ServidorMcp> = if parcial {
                previa.iter().flat_map(|p| p.servidores.iter()).filter(|s| s.nombre.starts_with("claude.ai ") && !sesion.iter().any(|x| x.prefijo == s.prefijo)).cloned().collect()
            } else {
                Vec::new()
            };
            let servidores = sesion.iter().cloned().chain(de_claude_ai).collect();
            d.s.cuentas_revisadas.insert(cuenta_id, CuentaRevisada { revisada_en: previa.map_or(Num(ahora_ms() as f64), |p| p.revisada_en), servidores, error: None });
        });
        self.guardar_cuentas();
    }

    fn error_de_sesion(&self, def: &ConectorMcp, p: Disponibilidad, run: &Ejecucion, por_defecto: &str, costo: Option<f64>) -> ErrorTickets {
        let msg = self.con(|d, env| d.s.texto_cuenta(env, def, &p, &run.cuenta_id, &run.label)).ok().flatten().unwrap_or_else(|| por_defecto.to_string());
        match p {
            Disponibilidad::Tiene { estado: EstadoMcp::Pendiente, .. } => servidor_pendiente(&msg, costo),
            _ => otro(msg),
        }
    }

    /// Si la sesión arrancó antes de que el servidor termine de conectar, se vuelve a intentar (hasta tres veces): sin esto, entre
    /// una de cada tres y una de cada dos consultas daba un error engañoso. Entre todos los intentos no pasan de 5 minutos ni del
    /// tope de costo: cada uno recibe lo que queda.
    fn con_reintento<T>(max_cost: Option<f64>, corre: &mut dyn FnMut(PresupuestoReintento) -> Res<T>) -> Res<T> {
        let reintentable = |e: &ErrorTickets| matches!(e, ErrorTickets::ServidorPendiente { .. });
        con_reintento(
            corre,
            &OpcionesReintento {
                intentos_max: 3,
                tiempo_max_ms: REINTENTOS_TOTAL_MS,
                costo_max_usd: costo_valido_f(max_cost),
                minimo_ms: 15_000.0,
                minimo_usd: COSTO_MIN,
                reintentable: &reintentable,
                costo_de: Some(&costo_de_pendiente),
                ahora: &|| ahora_ms() as f64,
            },
        )
    }

    fn pedido<'a>(tarea: TareaMotor, def: &'a ConectorMcp, model: &str, run: &Ejecucion, lim: Limites) -> Res<PedidoMotor<'a>> {
        let mut p = PedidoMotor::nuevo(tarea, model);
        p.def = Some(def);
        p.ajenos = Self::ajenos_de(run, def);
        p.limites = lim;
        Self::pedido_para(run, &mut p)?;
        Ok(p)
    }

    /// Una consulta que no llama a ninguna herramienta y solo lee system/init (o el config.toml con Codex). El error queda en el
    /// caché de la cuenta.
    fn revisar_una(&self, id: &str) {
        let previa = self.con(|d, _| d.s.cuentas_revisadas.get(id).map(|c| c.servidores.clone())).ok().flatten();
        let model = self.con(|d, _| d.s.estado.config.model.clone()).unwrap_or_default();
        let r = (|| -> Res<CuentaRevisada> {
            let run = self.con(|d, env| self.ejecucion(d, env, "los conectores", id, None))??;
            if !run.motor.lee_init() {
                let nombres = Self::servidores_de_codex(&run)?;
                let ignorados = servidores_ignorados(&nombres);
                anotar(&format!("tickets: revisar: {} servidores en el config de {}", nombres.len(), run.agente));
                return Ok(CuentaRevisada { revisada_en: Num(ahora_ms() as f64), servidores: servidores_revisados(&nombres), error: (!ignorados.is_empty()).then(|| error_ignorados(&ignorados)) });
            }
            let mut pedido = PedidoMotor::nuevo(TareaMotor::Revisar, &model);
            pedido.schema = Some(revisar_schema());
            let parse = |s: &str| revisar_cuenta(&run.motor.normalizar(s, &pedido), ahora_ms() as f64);
            let temprano = |l: &str| revisar_temprano(l, ahora_ms() as f64);
            let r = self.correr(&run, &pedido, &build_revisar_prompt(), "Claude", REVISAR_TIMEOUT_MS, None, &parse, Some(&temprano))?;
            anotar(&format!("tickets: revisar: {} servidores", r.servidores.len()));
            Ok(r)
        })();
        let c = r.unwrap_or_else(|e| {
            anotar("tickets: revisar: error");
            CuentaRevisada { revisada_en: Num(ahora_ms() as f64), servidores: previa.unwrap_or_default(), error: Some(cortar16(&e.mensaje(), 500).to_string()) }
        });
        let _ = self.con(|d, _| d.s.cuentas_revisadas.insert(id, c));
    }

    /// Si el caché dice que la cuenta no puede (y es viejo), se la mira de nuevo antes de creerlo; el pedido se arma con lo nuevo.
    fn con_cuenta_al_dia(&self, def: &ConectorMcp, cuenta_id: &str) -> Res<Ejecucion> {
        let (run, conviene) = self.con(|d, env| -> Res<(Ejecucion, bool)> {
            let run = self.ejecucion(d, env, def.nombre(), cuenta_id, Some(def))?;
            let revisada = d.s.cuentas_revisadas.get(cuenta_id).map(|c| c.revisada_en.0);
            Ok((run, !d.s.revisando && conviene_revisar(&d.s.disp_en(def, cuenta_id), revisada, ahora_ms() as f64)))
        })??;
        if !conviene {
            return Ok(run);
        }
        self.con(|d, _| d.s.revisando = true)?;
        self.avisar();
        self.revisar_una(cuenta_id);
        let _ = self.con(|d, _| d.s.revisando = false);
        self.guardar_cuentas();
        self.cambio();
        self.con(|d, env| self.ejecucion(d, env, def.nombre(), cuenta_id, Some(def)))?
    }

    fn cuenta_pedida(&self, raw: &Value, def: Option<&ConectorDef>, para: ParaQue) -> Res<String> {
        if let Some(s) = raw.as_str().filter(|s| !s.is_empty()) {
            return Ok(s.to_string());
        }
        self.con(|d, env| match d.s.estado.config.query_account_id.clone() {
            Some(id) => Ok(id),
            None => d.s.elegir_cuenta_para(env, def, para),
        })?
    }

    fn texto_plazo(&self, def: &ConectorMcp, run: &Ejecucion, segundos: u64, mensaje: &str) -> String {
        let conectado = self.con(|d, _| matches!(d.s.disp_en(def, &run.cuenta_id), Disponibilidad::Tiene { estado: EstadoMcp::Conectado, .. })).unwrap_or(false);
        if conectado {
            format!("{} está conectado, pero tardó más de {segundos} s en armar la lista (hay muchos tickets). Probá de nuevo; si sigue, sacá personas o estados del filtro, o acortá la ventana de días.", def.nombre())
        } else {
            mensaje.to_string()
        }
    }

    /// Una lista vacía sin el servidor (o sin sus herramientas) en la sesión no es «no hay tickets».
    fn leer_lista(&self, def: &ConectorMcp, dm: &ConectorMcp, run: &Ejecucion, s: &str, ef: &LimitesEfectivos, por_alcance: bool) -> Res<ResultadoLista> {
        let sesion = servidores_de_salida(s);
        if let Some(se) = &sesion {
            self.actualizar_desde_init(&run.cuenta_id, se, run.sin_claude_ai);
        }
        self.medir_uso(def.id(), s, ef, false)?;
        let costo = leer_uso(s).and_then(|u| u.cost_usd);
        let falta = Disponibilidad::Falta { parecido: None };
        let r = match parse_claude_output(&ConectorDef::Mcp(dm.clone()), s, por_alcance) {
            Err(ErrorTickets::ConectorFalta(m)) => return Err(self.error_de_sesion(def, problema_en_sesion(def, prefijo(dm), sesion.as_deref()).unwrap_or(falta), run, &m, costo)),
            r => r?,
        };
        if r.tickets.is_empty() {
            if let Some(p) = problema_en_sesion(def, prefijo(dm), sesion.as_deref()) {
                return Err(self.error_de_sesion(def, p, run, &format!("«{}» no pudo leer {}. Tocá «Volver a revisar».", run.label, def.nombre()), costo));
            }
        }
        Ok(r)
    }

    /// Las personas se piden aparte y una sola vez; después, a pedido. Solo guarda id y nombre.
    fn leer_personas(&self, def: &ConectorMcp, dm: &ConectorMcp, run: &Ejecucion, cancel: &AtomicBool, lim: Limites, model: &str) -> Res<()> {
        let ef = Self::efectivos(lim);
        let personas = Self::con_reintento(lim.max_cost_usd, &mut |p| {
            let pedido = Self::pedido(TareaMotor::Personas, dm, model, run, Self::con_restante(lim, p))?;
            let parse = |s: &str| {
                let n = run.motor.normalizar(s, &pedido);
                let sesion = servidores_de_salida(&n);
                if let Some(se) = &sesion {
                    self.actualizar_desde_init(&run.cuenta_id, se, run.sin_claude_ai);
                }
                self.medir_uso(def.id(), &n, &ef, false)?;
                match parse_personas(dm, &n) {
                    Err(ErrorTickets::ConectorFalta(m)) => {
                        let d = problema_en_sesion(def, prefijo(dm), sesion.as_deref()).unwrap_or(Disponibilidad::Falta { parecido: None });
                        Err(self.error_de_sesion(def, d, run, &m, leer_uso(&n).and_then(|u| u.cost_usd)))
                    }
                    r => r,
                }
            };
            let tiempo = (PERSONAS_TIMEOUT_MS as f64).min(p.restante_ms) as u64;
            self.correr(run, &pedido, &build_personas_prompt(dm), def.nombre(), tiempo, Some(cancel), &parse, None)
        })?;
        if personas.is_empty() {
            return Err(otro(format!("{} no devolvió personas. Probá de nuevo.", def.nombre())));
        }
        self.con(|d, _| {
            d.s.estado.personas = Some(personas);
            d.s.estado.personas_at = Some(Num(ahora_ms() as f64));
        })
    }

    fn empezar_consulta(&self, d: &mut Datos) -> Arc<AtomicBool> {
        let c = Arc::new(AtomicBool::new(false));
        d.s.corriendo = true;
        *tomar(&self.cancelar) = Some(c.clone());
        c
    }

    fn terminar_consulta(&self) {
        let _ = self.con(|d, _| d.s.corriendo = false);
        *tomar(&self.cancelar) = None;
        self.cambio();
    }

    fn gh<'a>(&'a self, cancelado: Option<&'a AtomicBool>) -> GhConProceso<'a> {
        let mut env: BTreeMap<String, String> = entorno_limpio(std::env::vars(), &|_| false).into_iter().collect();
        env.extend(entorno_sin_preguntas());
        GhConProceso { proceso: self.sis.proceso.as_ref(), cwd: self.entorno.raiz(), env, timeout: GH_TIMEOUT, cancelado }
    }

    /// `dueño/repo` del remoto de la carpeta elegida en los ajustes o, si no se eligió, la del último espacio.
    fn repo_gh(&self) -> Res<String> {
        let (elegida, ultima) = self.con(|d, env| (d.s.estado.config.default_repo.clone(), d.s.last_repo(env)))?;
        if let Some(e) = elegida.filter(|e| !e.is_empty()) {
            let repo = repo_de_carpeta(self.sis.git.as_ref(), &e).ok_or_else(|| otro("La carpeta elegida en los ajustes de Tickets no tiene un remoto de GitHub (origin)."))?;
            return repo_valido(&repo).map(String::from);
        }
        match ultima.and_then(|u| repo_de_carpeta(self.sis.git.as_ref(), &u)) {
            Some(repo) => repo_valido(&repo).map(String::from),
            None => Err(otro("Elegí la carpeta de un repo de GitHub en los ajustes de Tickets.")),
        }
    }

    fn refresh_gh(&self, g: &ConectorGh) -> Res<Value> {
        let cancel = self.con(|d, _| self.empezar_consulta(d))?;
        self.avisar();
        let inicio = ahora_ms() as f64;
        let r = (|| -> Res<usize> {
            let repo = self.repo_gh()?;
            if cancel.load(Ordering::SeqCst) {
                return Err(otro("Consulta cancelada."));
            }
            let gh = self.gh(Some(&cancel));
            let (me, tickets) = std::thread::scope(|s| {
                let yo = s.spawn(|| gh_yo(&gh, g));
                let t = gh_lista(&gh, g, &repo);
                (yo.join().unwrap_or_else(|_| Err(otro("gh falló."))), t)
            });
            let (me, tickets) = (me?, tickets?);
            let n = tickets.len();
            self.con(|d, _| {
                let st = &mut d.s.estado;
                st.tickets = tickets.iter().map(ticket_a_obj).collect();
                st.estados = None;
                st.me = Some(me);
                st.fetched_at = Some(Num(ahora_ms() as f64));
                st.fetched_by = None;
                st.leido_con = None;
                st.last_run = Some(Corrida { duration_ms: Some(Num(ahora_ms() as f64 - inicio)), ..Corrida::default() });
                st.last_error = None;
                d.s.detalles.clear();
                d.s.no_disponible = Default::default();
            })?;
            Ok(n)
        })();
        if let Err(e) = &r {
            let _ = self.con(|d, _| {
                d.s.estado.last_run = last_run_tras_error(d.s.estado.last_run.as_ref(), Some(e), 0);
                d.s.estado.last_error = Some(e.mensaje());
            });
        }
        self.terminar_consulta();
        Ok(json!({ "count": r? }))
    }

    fn refresh(&self, raw_cuenta: &Value, raw_vueltas: &Value, raw_modo: &Value) -> Res<Value> {
        let (usadas, solo_faltante, def) = self.con(|d, env| -> Res<_> {
            let (u, f) = d.s.args_de_refresh(raw_vueltas, raw_modo)?;
            Ok((u, f, d.s.activo(env)?.clone()))
        })??;
        let mcp = match &def {
            ConectorDef::Gh(g) => return self.refresh_gh(g),
            ConectorDef::Mcp(m) => m.clone(),
        };
        let cuenta = self.cuenta_pedida(raw_cuenta, Some(&def), ParaQue::Consulta)?;
        let run = self.con_cuenta_al_dia(&mcp, &cuenta)?;
        if let Err(e) = self.con(|d, env| d.s.chequear_cuenta(env, &mcp, &run.cuenta_id))? {
            let _ = self.con(|d, _| {
                d.s.estado.last_run = last_run_tras_error(d.s.estado.last_run.as_ref(), Some(&e), usadas);
                d.s.estado.last_error = Some(e.mensaje());
            });
            self.cambio();
            return Err(e);
        }
        let prep = self.con(|d, env| -> Option<Result<Preparado, usize>> {
            let dm = Self::def_para(&d.s, &mcp, &run.cuenta_id);
            let dm_def = ConectorDef::Mcp(dm.clone());
            let por_alcance = Servicio::con_filtro(&dm_def);
            let st = &d.s.estado;
            let filtro = filtro_de(&st.config, &dm_def);
            let pendiente = pendientes_de(&filtro, st.leido.as_ref(), &dm_def, st.me.as_ref());
            let todo = !solo_faltante || pendiente.todo;
            if por_alcance && !todo && sin_pendientes(&pendiente) {
                return Some(Err(d.s.tickets_visibles(env, &def).len()));
            }
            let alcance = por_alcance.then(|| alcance_a_pedir(&filtro, &pendiente, &dm_def, ahora_ms() as f64, st.me.as_ref(), todo));
            let (lim, model, assignee, personas_falta) = (Self::limites(&d.s, Some(usadas)), st.config.model.clone(), st.config.assignee_id.clone(), por_alcance && st.personas.is_none());
            let cancel = self.empezar_consulta(d);
            d.s.estado.last_run = last_run_tras_error(d.s.estado.last_run.as_ref(), None, usadas);
            Some(Ok(Preparado { dm, lim, alcance, todo, model, assignee, cancel, personas_falta }))
        })?;
        let prep = match prep {
            Some(Ok(p)) => p,
            Some(Err(count)) => return Ok(json!({ "count": count })),
            None => return Err(otro("No se pudo preparar la consulta.")),
        };
        self.avisar();
        let ef = Self::efectivos(prep.lim);
        let dm = &prep.dm;
        let r = std::thread::scope(|sc| {
            // La primera vez se piden las personas en paralelo con la lista: no suman tiempo. Si fallan, la lista sigue y se
            // vuelven a pedir en la próxima.
            let personas = prep.personas_falta.then(|| {
                sc.spawn(|| {
                    if let Err(e) = self.leer_personas(&mcp, dm, &run, &prep.cancel, prep.lim, &prep.model) {
                        if !prep.cancel.load(Ordering::SeqCst) {
                            anotar(&format!("tickets: no pude leer las personas de {}: {}", mcp.nombre(), e.mensaje()));
                        }
                    }
                })
            });
            let r = Self::con_reintento(prep.lim.max_cost_usd, &mut |p| {
                let pedido = Self::pedido(TareaMotor::Lista, dm, &prep.model, &run, Self::con_restante(prep.lim, p))?;
                let parse = |s: &str| self.leer_lista(&mcp, dm, &run, &run.motor.normalizar(s, &pedido), &ef, prep.alcance.is_some());
                let tiempo = (LISTA_TIMEOUT_MS as f64).min(p.restante_ms) as u64;
                self.correr(&run, &pedido, &build_prompt(dm, &prep.assignee, prep.alcance.as_ref()), mcp.nombre(), tiempo, Some(&prep.cancel), &parse, None)
            });
            if r.is_err() {
                prep.cancel.store(true, Ordering::SeqCst);
            }
            if let Some(h) = personas {
                let _ = h.join();
            }
            r
        });
        let salida = match r {
            Ok(r) => self.con(|d, env| {
                let st = &mut d.s.estado;
                if r.me.is_some() {
                    st.me = r.me.clone();
                }
                let tickets = match &prep.alcance {
                    Some(a) => mezclar(&st.a_tickets(), &r.tickets, a, st.me.as_ref(), prep.todo),
                    None => r.tickets.clone(),
                };
                st.tickets = tickets.iter().map(ticket_a_obj).collect();
                if let Some(a) = &prep.alcance {
                    let dm_def = ConectorDef::Mcp(dm.clone());
                    st.leido = Some(leido_tras(&filtro_de(&st.config, &dm_def), st.leido.as_ref(), a, prep.todo, &dm_def, r.no_leidos.unwrap_or(0)));
                }
                if r.estados.as_ref().is_some_and(|e| !e.is_empty()) {
                    st.estados = r.estados.clone();
                }
                st.fetched_at = Some(Num(ahora_ms() as f64));
                st.fetched_by = Some(run.cuenta_id.clone());
                st.leido_con = Some(prefijo(dm).to_string());
                st.last_run = Some(Corrida { tokens: r.tokens.map(Num), cost_usd: r.cost_usd.map(Num), duration_ms: r.duration_ms.map(Num), num_turns: r.num_turns.map(Num), max_turns: Some(Num(f64::from(usadas))), tope: None });
                st.last_error = None;
                st.config.query_account_id = Some(run.cuenta_id.clone());
                d.s.detalles.clear();
                d.s.no_disponible = Default::default();
                let mut o = json!({ "count": d.s.tickets_visibles(env, &def).len() });
                if let Some(t) = r.tokens {
                    o["tokens"] = json!(t);
                }
                o
            }),
            Err(e) => {
                // Con Claude el tope llega en el sobre y medir_uso lo anota; con otro motor lo corta cortar_si antes de parsear: ese
                // gasto también cuenta.
                if let ErrorTickets::Tope { uso, .. } = &e {
                    if run.motor.id() != ProveedorId::Claude {
                        self.registrar_uso(mcp.id(), uso);
                    }
                }
                let msg = match &e {
                    ErrorTickets::ConectorFalta(m) => self.con(|d, env| d.s.texto_cuenta(env, &mcp, &Disponibilidad::Falta { parecido: None }, &run.cuenta_id, &run.label)).ok().flatten().unwrap_or_else(|| m.clone()),
                    ErrorTickets::Plazo { segundos, mensaje } => self.texto_plazo(&mcp, &run, *segundos, mensaje),
                    _ => Self::legible(e.clone(), Some(&run)).mensaje(),
                };
                let _ = self.con(|d, _| {
                    d.s.estado.last_run = last_run_tras_error(d.s.estado.last_run.as_ref(), Some(&e), usadas);
                    d.s.estado.last_error = Some(msg.clone());
                });
                Err(otro(msg))
            }
        };
        self.terminar_consulta();
        salida
    }

    /// Vuelve a pedir la lista de personas (id y nombre) con la cuenta que consulta.
    fn personas(&self, raw_cuenta: &Value) -> Res<Value> {
        let def = self.con(|d, env| -> Res<ConectorDef> {
            if d.s.corriendo {
                return Err(otro("Ya hay una consulta en curso."));
            }
            let def = d.s.activo(env)?.clone();
            if !Servicio::con_filtro(&def) || def.via() != Via::Mcp {
                return Err(otro(format!("{} no lista personas desde Sloth.", def.nombre())));
            }
            Ok(def)
        })??;
        let Some(mcp) = def.mcp().cloned() else { return Err(otro(format!("{} no lista personas desde Sloth.", def.nombre()))) };
        let cuenta = self.cuenta_pedida(raw_cuenta, Some(&def), ParaQue::Consulta)?;
        let run = self.con_cuenta_al_dia(&mcp, &cuenta)?;
        self.con(|d, env| d.s.chequear_cuenta(env, &mcp, &run.cuenta_id))??;
        let (dm, lim, model, cancel) = self.con(|d, _| (Self::def_para(&d.s, &mcp, &run.cuenta_id), Self::limites(&d.s, None), d.s.estado.config.model.clone(), self.empezar_consulta(d)))?;
        self.avisar();
        let r = self.leer_personas(&mcp, &dm, &run, &cancel, lim, &model);
        let r = match r {
            Ok(()) => self.con(|d, _| d.s.estado.config.query_account_id = Some(run.cuenta_id.clone())),
            Err(ErrorTickets::Plazo { segundos, mensaje }) => Err(otro(self.texto_plazo(&mcp, &run, segundos, &mensaje))),
            Err(e) => Err(otro(Self::legible(e, Some(&run)).mensaje())),
        };
        self.terminar_consulta();
        r?;
        self.snapshot()
    }

    fn cancel(&self) -> Value {
        if let Some(c) = tomar(&self.cancelar).as_ref() {
            c.store(true, Ordering::SeqCst);
        }
        json!(true)
    }

    fn set_filtro(&self, raw: &Value) -> Res<Value> {
        self.con(|d, env| d.s.set_filtro(env, raw))??;
        self.avisar();
        self.snapshot()
    }

    fn set_config(&self, raw: &Value) -> Res<Value> {
        self.con(|d, env| d.s.set_config(env, raw))??;
        self.avisar();
        self.snapshot()
    }

    fn mostrar_espacio(&self, id: &str) {
        ui(&self.entorno, json!({ "type": "open-pane", "id": id }));
    }

    /// «Empezar en Sloth»: el espacio del ticket, o uno nuevo pedido al dueño del store (si el conector declara un comando,
    /// arranca con `<comando> <id>`, con el id ya validado contra el formato del conector).
    fn start(&self, raw_id: &Value, raw_cuenta: &Value) -> Res<Value> {
        match self.con(|d, env| d.s.planear_inicio(env, raw_id, raw_cuenta))?? {
            PlanInicio::Existente { espacio_id } => {
                self.mostrar_espacio(&espacio_id);
                Ok(json!({ "id": espacio_id, "created": false }))
            }
            PlanInicio::Crear { id, repo_path, cuenta_id, prompt_inicial } => {
                let mut input = json!({ "name": id, "repoPath": repo_path, "accountId": cuenta_id, "autoStartClaude": true, "ticket": id });
                if let Some(p) = prompt_inicial {
                    input["initialPrompt"] = json!(p);
                }
                input["resume"] = json!(true);
                let ws = self.entorno.pedir("workspaces:add", vec![input], ALTA_DE_ESPACIO).map_err(otro)?;
                let ws_id = texto(&ws, "id").ok_or_else(|| otro("No se pudo crear el espacio del ticket."))?;
                if let Err(e) = self.entorno.registrar_ticket(&id, &texto(&ws, "name").unwrap_or_default(), ahora_ms()) {
                    anotar(&format!("tickets: no pude anotar la actividad: {e}"));
                }
                // El comando de la terminal suele asignar o mover el ticket: el detalle guardado deja de valer.
                let _ = self.con(|d, _| d.s.detalles.remove(&id));
                self.mostrar_espacio(&ws_id);
                Ok(json!({ "id": ws_id, "created": true }))
            }
        }
    }

    /// La lista de la que salió `id`: si mientras se leía cambió (otro conector, otra carpeta, otra consulta), lo leído ya no es de ella.
    fn marca_de_lista(s: &Servicio) -> (Option<f64>, String) {
        (s.estado.fetched_at.map(|n| n.0), s.estado.config.conector_id.clone())
    }

    /// Lectura del detalle al abrir un ticket (criterios con id, comentarios, horas cargadas). Sin `fresco`, sale de la caché si está.
    fn detail(&self, raw_id: &Value, raw_fresco: &Value) -> Res<Value> {
        let fresco = raw_fresco == &Value::Bool(true);
        let (id, t, def, cache, marca) = self.con(|d, env| -> Res<_> {
            let (id, t) = d.s.preparar_detalle(env, raw_id)?;
            let cache = if fresco { None } else { d.s.detalles.get(&id).cloned() };
            Ok((id, t, d.s.activo(env)?.clone(), cache, Self::marca_de_lista(&d.s)))
        })??;
        if let Some(c) = cache {
            return serde_json::to_value(c).map_err(|e| otro(e.to_string()));
        }
        let guardar = |det: &Detalle| {
            let _ = self.con(|d, _| {
                if Self::marca_de_lista(&d.s) == marca && d.s.estado.tickets.iter().any(|o| o.get("id").and_then(Value::as_str) == Some(id.as_str())) {
                    d.s.guardar_detalle(&id, det.clone());
                }
            });
        };
        let det = match &def {
            ConectorDef::Gh(g) => gh_detalle(&self.gh(None), g, &id, t.proyecto.as_deref())?,
            ConectorDef::Mcp(m) => {
                let (run, dc, lim, model) = self.con(|d, env| -> Res<_> {
                    let run = self.cuenta(d, env, &def)?;
                    let dp = Self::def_para(&d.s, m, &run.cuenta_id);
                    let dc = servidor_de_la_lista(d.s.estado.leido_con.as_deref(), &dp)?.clone();
                    Ok((run, dc, Self::limites(&d.s, None), d.s.estado.config.model.clone()))
                })??;
                let ef = Self::efectivos(lim);
                let r = Self::pedido(TareaMotor::Detalle, &dc, &model, &run, lim).and_then(|pedido| {
                    let parse = |s: &str| {
                        let n = run.motor.normalizar(s, &pedido);
                        self.medir_uso(def.id(), &n, &ef, false)?;
                        parse_detalle(&dc, &n)
                    };
                    self.correr(&run, &pedido, &build_detalle_prompt(&dc, &id), def.nombre(), DETALLE_TIMEOUT_MS, None, &parse, None)
                });
                match r {
                    Ok(det) => det,
                    Err(ErrorTickets::ConectorFalta(_)) => return Err(otro(format!("No pudimos leer el detalle: {}", sin_conector(&def)))),
                    Err(e) => {
                        if let ErrorTickets::Tope { uso, .. } = &e {
                            if run.motor.id() != ProveedorId::Claude {
                                self.registrar_uso(def.id(), uso);
                            }
                        }
                        return Err(Self::legible(e, Some(&run)));
                    }
                }
            }
        };
        guardar(&det);
        serde_json::to_value(det).map_err(|e| otro(e.to_string()))
    }

    fn detalle_de(&self, id: &str) -> Value {
        self.con(|d, _| d.s.detalles.get(id).and_then(|x| serde_json::to_value(x).ok())).ok().flatten().unwrap_or(Value::Null)
    }

    /// Una acción pedida con un clic sobre un ticket: UNA llamada que habilita solo la herramienta de esa acción, o gh. Devuelve
    /// el detalle actualizado (si estaba cargado) para que la UI reemplace lo optimista.
    fn accion(&self, raw_a: &Value, raw_id: &Value, raw_in: &Value) -> Res<Value> {
        let prep = self.con(|d, env| -> Res<_> {
            match d.s.preparar_accion(env, raw_a, raw_id, raw_in)? {
                None => Ok(Err(ticket_id(d.s.activo(env)?, raw_id)?)),
                Some(p) => Ok(Ok(p)),
            }
        })??;
        let (a, t, input) = match prep {
            Err(id) => return Ok(json!({ "detail": self.detalle_de(&id) })),
            Ok(p) => p,
        };
        let id = t.id.clone();
        let (def, run_dc, lim, model, me) = self.con(|d, env| -> Res<_> {
            let def = d.s.activo(env)?.clone();
            let run_dc = match def.mcp() {
                Some(m) => {
                    let run = self.cuenta(d, env, &def)?;
                    let dc = servidor_de_la_lista(d.s.estado.leido_con.as_deref(), &Self::def_para(&d.s, m, &run.cuenta_id))?.clone();
                    if run.motor.id() == ProveedorId::Codex && !ACCIONES_VERIFICADAS {
                        return Err(otro(SOLO_LECTURA));
                    }
                    Some((run, dc))
                }
                None => None,
            };
            let lim = Self::limites(&d.s, None);
            d.s.escribiendo.insert(id.clone());
            Ok((def, run_dc, lim, d.s.estado.config.model.clone(), d.s.estado.me.clone()))
        })??;
        let ef = Self::efectivos(lim);
        let r: Res<Option<i64>> = match (&def, &run_dc) {
            (ConectorDef::Gh(g), _) => gh_accion(&self.gh(None), g, t.proyecto.as_deref(), a, &input, me.as_ref()).map(|_| None),
            (ConectorDef::Mcp(_), Some((run, dc))) => {
                let mut pedido = PedidoMotor::nuevo(TareaMotor::Accion, &model);
                pedido.def = Some(dc);
                pedido.ajenos = Self::ajenos_de(run, dc);
                pedido.limites = lim;
                pedido.accion = Some(a);
                Self::pedido_para(run, &mut pedido).and_then(|_| {
                    let parse = |s: &str| {
                        let n = run.motor.normalizar(s, &pedido);
                        self.medir_uso(def.id(), &n, &ef, true)?;
                        parse_accion(dc, &n, a)
                    };
                    self.correr(run, &pedido, &build_accion_prompt(dc, a, &input)?, def.nombre(), DETALLE_TIMEOUT_MS, None, &parse, None)
                })
            }
            (ConectorDef::Mcp(_), None) => Err(otro("No se pudo preparar la acción.")),
        };
        let salida = match r {
            Ok(minutos_total) => {
                let fecha = iso_de_ms(ahora_ms() as f64);
                let detail = self.con(|d, _| {
                    if let Some(obj) = d.s.estado.tickets.iter_mut().find(|o| o.get("id").and_then(Value::as_str) == Some(id.as_str())) {
                        let mut tk = ticket_de_obj(obj);
                        aplicar_accion(a, &mut tk, &input, Aplicar { me: me.as_ref(), detalle: d.s.detalles.get_mut(&id), minutos_total, fecha });
                        fundir_ticket(obj, &tk);
                    }
                    d.s.detalles.get(&id).and_then(|x| serde_json::to_value(x).ok()).unwrap_or(Value::Null)
                })?;
                anotar(&format!("tickets({}): accion {} en {id}: ok", def.id(), a.como_str()));
                Ok(json!({ "detail": detail }))
            }
            Err(e) => {
                let _ = self.con(|d, _| match &e {
                    ErrorTickets::HerramientaFalta(m) => {
                        for k in misma_herramienta(&def, a) {
                            d.s.no_disponible.insert(k.como_str(), m.clone());
                        }
                    }
                    ErrorTickets::ConectorFalta(_) => {
                        for k in acciones_soportadas(&def) {
                            d.s.no_disponible.insert(k.como_str(), sin_conector(&def));
                        }
                    }
                    _ => {}
                });
                anotar(&format!("tickets({}): accion {} en {id}: error", def.id(), a.como_str()));
                Err(Self::legible(e, run_dc.as_ref().map(|(r, _)| r)))
            }
        };
        let _ = self.con(|d, _| d.s.escribiendo.remove(&id));
        self.cambio();
        salida
    }

    fn no_incluido<'a>(s: &'a Servicio, v: &Value) -> Res<&'a ConectorRegistrado> {
        match v.as_str().and_then(|id| s.registrado(id)) {
            Some(r) if r.origen != OrigenConector::Incluido => Ok(r),
            _ => Err(otro("Ese conector propio ya no existe.")),
        }
    }

    fn propios(&self) -> Res<Value> {
        self.con(|d, env| {
            let c = config_cruda(&d.s);
            self.recargar_propios(d, env, Some(&c));
        })?;
        self.avisar();
        self.con(|d, env| json!({ "lista": d.s.lista_propios(env), "avisos": d.s.avisos_propios }))
    }

    fn propio(&self, raw_id: &Value) -> Res<Value> {
        self.con(|d, _| Self::no_incluido(&d.s, raw_id).map(|r| r.def.a_valor()))?
    }

    fn descubrir(&self, raw_prefijo: &Value, raw_cuenta: &Value) -> Res<Value> {
        let p = self.con(|d, _| d.s.prefijo_a_descubrir(raw_prefijo))??;
        let prompt = build_descubrir_prompt(&p)?;
        self.con(|d, _| d.s.revisando = true)?;
        let r = (|| -> Res<Value> {
            let cuenta = self.cuenta_pedida(raw_cuenta, None, ParaQue::Descubrir)?;
            let (run, model) = self.con(|d, env| self.ejecucion(d, env, "las herramientas", &cuenta, None).map(|r| (r, d.s.estado.config.model.clone())))??;
            if !run.motor.lee_init() {
                return Err(otro(format!("Esta cuenta no puede buscar herramientas todavía: {} no informa los servidores de la sesión. Probá con una cuenta de Claude Code.", run.agente)));
            }
            let pedido = PedidoMotor::nuevo(TareaMotor::Descubrir, &model);
            let parse = |s: &str| parse_descubrir(&p, &run.motor.normalizar(s, &pedido));
            let r = self.correr(&run, &pedido, &prompt, "Claude", 90_000, None, &parse, None)?;
            let fuente = if r.fuente == Fuente::Sesion { "sesion" } else { "claude" };
            anotar(&format!("tickets: descubrir: {} herramientas ({fuente})", r.herramientas.len()));
            Ok(json!({ "herramientas": r.herramientas, "fuente": fuente, "bloqueadas": r.bloqueadas }))
        })();
        let _ = self.con(|d, _| d.s.revisando = false);
        r
    }

    /// «Volver a revisar»: una consulta por cuenta, de a tres, que no llama a ninguna herramienta y solo lee system/init.
    fn revisar_cuentas(&self, raw: &Value) -> Res<Value> {
        let ids = self.con(|d, env| -> Res<Vec<String>> {
            let ids = d.s.ids_a_revisar(env, raw)?;
            d.s.revisando = true;
            Ok(ids)
        })??;
        self.avisar();
        let _ = de_a(&ids, 3, &|id: &String| -> Result<(), ()> {
            self.revisar_una(id);
            Ok(())
        });
        let _ = self.con(|d, _| d.s.revisando = false);
        self.guardar_cuentas();
        self.cambio();
        self.snapshot()
    }

    /// Por qué un servidor no conecta y dónde está definido: lo único que se lee de `claude mcp get` (lo demás puede traer credenciales).
    fn datos_de_servidor(&self, run: &Ejecucion, nombre: &str) -> Option<DatosMcp> {
        if !nombre_probable(nombre) {
            return None;
        }
        let parse = |s: &str| Ok(datos_de_mcp_get(s));
        match self.correr_crudo(run, vec!["mcp".into(), "get".into(), nombre.into()], "", "Claude", MOTIVO_TIMEOUT_MS, &parse) {
            Ok(d) => Some(d),
            Err(e) => {
                anotar(&format!("tickets: probar: no pude leer el motivo del servidor: {}", limpiar_causa_defecto(&e.mensaje())));
                None
            }
        }
    }

    /// Una consulta de lectura con la herramienta más simple del conector, para ver que responde de verdad.
    fn consulta_minima(&self, def: &ConectorMcp, run: &Ejecucion) -> ResultadoDePrueba {
        let Ok((dp, lim, model)) = self.con(|d, _| (Self::def_para(&d.s, def, &run.cuenta_id), Self::limites(&d.s, None), d.s.estado.config.model.clone())) else {
            return ResultadoDePrueba::Cayo("Sloth todavía está arrancando.".into());
        };
        let ef = Self::efectivos(lim);
        let parse = |s: &str| {
            if let Some(se) = servidores_de_salida(s) {
                self.actualizar_desde_init(&run.cuenta_id, &se, run.sin_claude_ai);
            }
            self.medir_uso(def.id(), s, &ef, false)?;
            parse_probar(&dp, s)
        };
        let args = build_probar_args(&dp, &model, &Self::ajenos_de(run, &dp), lim);
        match self.correr_crudo(run, args, &build_probar_prompt(&dp), def.nombre(), PROBAR_TIMEOUT_MS, &parse) {
            Ok(p) => ResultadoDePrueba::Prueba(p),
            Err(ErrorTickets::Plazo { segundos, .. }) => ResultadoDePrueba::PlazoS(segundos as f64),
            Err(e) => ResultadoDePrueba::Cayo(limpiar_causa_defecto(&Self::legible(e, Some(run)).mensaje())),
        }
    }

    /// «Probar»: vuelve a mirar la cuenta, si el servidor no conecta pregunta por qué y, si conecta, hace una consulta mínima.
    fn probar(&self, raw_cuenta: &Value) -> Res<Value> {
        let mcp = self.con(|d, env| d.s.preparar_probar(env).cloned())??;
        let def = ConectorDef::Mcp(mcp.clone());
        let id = self.cuenta_pedida(raw_cuenta, Some(&def), ParaQue::Consulta)?;
        let label = self.con(|_, env| env.cuenta(&id).map(|c| c.label.clone()))?.unwrap_or_else(|| id.clone());
        let inicio = ahora_ms() as f64;
        let ms = || (ahora_ms() as f64 - inicio).max(0.0) as u64;
        self.con(|d, _| d.s.revisando = true)?;
        self.avisar();
        let r = (|| -> Res<ResultadoPrueba> {
            let previo = self.con(|d, env| self.ejecucion(d, env, mcp.nombre(), &id, Some(&mcp)))??;
            if !previo.motor.lee_init() {
                return Ok(ResultadoPrueba {
                    estado: sloth_core::features::tickets::modelo::EstadoPrueba::Error,
                    mensaje: format!("Probar todavía no anda con {}: no informa el estado de los servidores.", previo.agente),
                    causa: None,
                    que_hacer: Some("Usá «Actualizar» en el tablero para ver si lee los tickets.".into()),
                    ms: ms(),
                });
            }
            self.revisar_una(&id);
            let disp = self.con(|d, _| d.s.disp_en(&mcp, &id))?;
            // El pedido se arma de nuevo: lo que acaba de ver la revisión puede cambiar a qué servidor se le habla.
            let run = self.con(|d, env| self.ejecucion(d, env, mcp.nombre(), &id, Some(&mcp)))??;
            let (datos, prueba) = match &disp {
                Disponibilidad::Tiene { nombre, estado: EstadoMcp::Fallo | EstadoMcp::Pendiente | EstadoMcp::NecesitaAuth, .. } => (self.datos_de_servidor(&run, nombre), None),
                Disponibilidad::Tiene { estado: EstadoMcp::Conectado, verificado: true, .. } => (None, Some(self.consulta_minima(&mcp, &run))),
                _ => (None, None),
            };
            let error_revision = self.con(|d, _| d.s.cuentas_revisadas.get(&id).and_then(|c| c.error.clone()))?;
            Ok(diagnosticar(&EntradaDiagnostico { def: &mcp, cuenta: &label, d: &disp, error_revision, datos, prueba, ms: ms() }))
        })();
        let _ = self.con(|d, _| d.s.revisando = false);
        self.guardar_cuentas();
        self.cambio();
        r.map(|r| resultado_prueba(&r))
    }

    /// Guarda tickets-conectores.json y relee el registro. Si no se pudo guardar, lo que cambió en memoria vuelve atrás.
    fn con_archivo(&self, f: impl FnOnce(&mut Servicio, &Env) -> Res<sloth_core::features::tickets::propios::ArchivoPropios>) -> Res<Value> {
        self.con(|d, env| -> Res<()> {
            let respaldo = (d.s.estado.clone(), d.s.no_disponible.clone(), d.s.detalles.clone());
            let nuevo = f(&mut d.s, env)?;
            if let Err(m) = guardar_archivo_propios(&d.carpeta.join("tickets-conectores.json"), &nuevo, d.propios_ilegible) {
                (d.s.estado, d.s.no_disponible, d.s.detalles) = respaldo;
                return Err(otro(m));
            }
            d.s.archivo_propios = nuevo;
            let c = config_cruda(&d.s);
            self.recargar_propios(d, env, Some(&c));
            Ok(())
        })??;
        self.cambio();
        self.snapshot()
    }

    fn guardar_propio(&self, raw: &Value, raw_anterior: &Value) -> Res<Value> {
        self.con_archivo(|s, _| s.guardar_propio(raw, raw_anterior, &CONECTORES))
    }

    fn borrar_propio(&self, raw_id: &Value) -> Res<Value> {
        self.con_archivo(|s, _| s.borrar_propio(raw_id))
    }

    fn aceptar(&self, raw_id: &Value, raw_hash: &Value) -> Res<Value> {
        self.con(|d, env| {
            let c = config_cruda(&d.s);
            self.recargar_propios(d, env, Some(&c));
        })?;
        self.con_archivo(|s, env| s.aceptar(env, raw_id, raw_hash))
    }

    fn exportar_propio(&self, raw_id: &Value) -> Res<Value> {
        let def = self.con(|d, _| Self::no_incluido(&d.s, raw_id).map(|r| r.def.clone()))??;
        let p = &self.entorno.plataforma;
        let titulo = format!("Exportar el conector {}", def.nombre());
        let o = DialogoArchivo { titulo: &titulo, ruta_sugerida: Some(p.carpeta_documentos().join(format!("{}.sloth-conector.json", def.id()))), filtro: ("Conector de Sloth", &["json"]) };
        let Some(ruta) = p.guardar_como(&o) else { return Ok(Value::Null) };
        let ruta = ruta.to_string_lossy().into_owned();
        let tmp = PathBuf::from(format!("{ruta}.{}.tmp", std::process::id()));
        let escrito = fs::write(&tmp, texto_export(&def)).and_then(|_| fs::rename(&tmp, &ruta));
        if let Err(e) = escrito {
            let _ = fs::remove_file(&tmp);
            return Err(otro(e.to_string()));
        }
        Ok(json!({ "path": ruta }))
    }

    fn importar_propio(&self) -> Res<Value> {
        let o = DialogoArchivo { titulo: "Importar un conector", ruta_sugerida: None, filtro: ("Conector de Sloth", &["json"]) };
        let Some(archivo) = self.entorno.plataforma.elegir_archivo(&o) else { return Ok(Value::Null) };
        let tam = fs::metadata(&archivo).map_err(|e| otro(e.to_string()))?.len();
        if tam as usize > IMPORT_MAX_BYTES {
            return Err(otro(format!("El archivo pesa más de {} KB.", IMPORT_MAX_BYTES / 1024)));
        }
        let texto = fs::read_to_string(&archivo).map_err(|e| otro(e.to_string()))?;
        let def = parsear_import(&texto).map_err(otro)?;
        let choca = self.con(|d, _| {
            let id = def.id();
            let previo = d.s.registrado(id).map(|r| r.origen.clone());
            if d.s.archivo_propios.conectores.iter().any(|c| c.id() == id) {
                json!("propio")
            } else if matches!(previo, Some(OrigenConector::Equipo { .. })) {
                json!("equipo")
            } else if previo.is_some() || CONECTORES.iter().any(|c| c.id() == id) {
                json!("incluido")
            } else {
                Value::Null
            }
        })?;
        Ok(json!({ "def": def.a_valor(), "choca": choca }))
    }
}

impl AlHook for Tickets {
    fn al_hook(&self, _: &str, _: Option<&str>) {}

    /// La UI pide el estado de Tickets una sola vez, al arrancar: si fue antes del perfil, le llega ahora.
    fn al_perfil(&self) {
        self.avisar();
    }

    /// Lo que esté corriendo se corta, como el `dispose` del TS.
    fn al_salir(&self) {
        self.cancel();
    }
}

fn a_respuesta(r: Res<Value>) -> crate::router::Respuesta {
    r.map_err(|e| e.mensaje())
}

pub fn registrar(router: &mut Router, entorno: Arc<Entorno>) -> Arc<Tickets> {
    let t = Tickets::nuevo(entorno, Sistema::real());
    registrar_con(router, t.clone());
    t
}

pub(crate) fn registrar_con(router: &mut Router, t: Arc<Tickets>) {
    macro_rules! canal {
        ($op:literal, |$f:ident, $a:ident| $cuerpo:expr) => {{
            let $f = t.clone();
            router.registrar(concat!("feat:tickets:", $op), move |$a: Vec<Value>| {
                let _ = &$a;
                a_respuesta($cuerpo)
            });
        }};
    }
    canal!("state", |f, a| f.snapshot());
    canal!("refresh", |f, a| f.refresh(arg(&a, 0), arg(&a, 1), arg(&a, 2)));
    canal!("setFiltro", |f, a| f.set_filtro(arg(&a, 0)));
    canal!("personas", |f, a| f.personas(arg(&a, 0)));
    canal!("cancel", |f, a| Ok(f.cancel()));
    canal!("setConfig", |f, a| f.set_config(arg(&a, 0)));
    canal!("hasRepo", |f, a| f.con(|d, env| d.s.tiene_repo(env, arg(&a, 0))).and_then(|r| r).map(Value::Bool));
    canal!("start", |f, a| f.start(arg(&a, 0), arg(&a, 1)));
    canal!("detail", |f, a| f.detail(arg(&a, 0), arg(&a, 1)));
    canal!("accion", |f, a| f.accion(arg(&a, 0), arg(&a, 1), arg(&a, 2)));
    canal!("propios", |f, a| f.propios());
    canal!("propio", |f, a| f.propio(arg(&a, 0)));
    canal!("descubrir", |f, a| f.descubrir(arg(&a, 0), arg(&a, 1)));
    canal!("revisarCuentas", |f, a| f.revisar_cuentas(arg(&a, 0)));
    canal!("probar", |f, a| f.probar(arg(&a, 0)));
    canal!("guardarPropio", |f, a| f.guardar_propio(arg(&a, 0), arg(&a, 1)));
    canal!("borrarPropio", |f, a| f.borrar_propio(arg(&a, 0)));
    canal!("aceptar", |f, a| f.aceptar(arg(&a, 0), arg(&a, 1)));
    canal!("exportarPropio", |f, a| f.exportar_propio(arg(&a, 0)));
    canal!("importarPropio", |f, a| f.importar_propio());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};
    use sloth_core::features::proceso::Salida;
    use sloth_core::features::tickets::claude_run::{Mirada, Peticion, SalidaRun};

    type Guion = dyn Fn(&Peticion) -> String + Send + Sync;
    type Pedido = (String, Vec<String>, String, BTreeMap<String, String>);

    /// claude, codex y gh de mentira: el guion da la salida de cada pedido y se anota todo lo que se corrió.
    struct Proceso {
        guion: Box<Guion>,
        pedidos: Mutex<Vec<Pedido>>,
    }

    impl ProcesoRun for Proceso {
        fn correr(&self, p: &Peticion, cancelado: Option<&AtomicBool>, mirar: &mut dyn FnMut(&str) -> Mirada) -> SalidaRun {
            self.pedidos.lock().unwrap().push((p.exe.clone(), p.args.clone(), p.prompt.clone(), p.env.clone()));
            if cancelado.is_some_and(|c| c.load(Ordering::SeqCst)) {
                return SalidaRun::Cancelada;
            }
            let out = (self.guion)(p);
            for l in out.lines() {
                if mirar(l) == Mirada::Cortar {
                    return SalidaRun::Cortada;
                }
            }
            SalidaRun::Termino { code: Some(0), stdout: out, stderr: String::new() }
        }
    }

    struct Git;

    impl Ejecutor for Git {
        fn ejecutar(&self, cmd: &str, args: &[String], _: Option<&Path>, _: Duration) -> Salida {
            if cmd == "git" && args.join(" ").ends_with("remote get-url origin") {
                Salida::ok("https://github.com/o/r.git\n")
            } else {
                Salida::error(1, "no simulado")
            }
        }
    }

    struct Prueba {
        t: EntornoDePrueba,
        proceso: Arc<Proceso>,
        router: Router,
        tickets: Arc<Tickets>,
        repo: PathBuf,
    }

    fn armar(nombre: &str, guion: impl Fn(&Peticion) -> String + Send + Sync + 'static) -> Prueba {
        let t = EntornoDePrueba::nuevo(nombre);
        let repo = t.carpeta.join("repo");
        let cuenta = t.carpeta.join("cuenta");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&cuenta).unwrap();
        fs::write(cuenta.join(".claude.json"), json!({ "oauthAccount": { "emailAddress": "ana@ejemplo.com" } }).to_string()).unwrap();
        t.fijar_estado(&json!({ "version": 1,
            "accounts": [{ "id": "c1", "label": "Ana", "configDir": cuenta.to_string_lossy() }],
            "workspaces": [{ "id": "w1", "name": "web", "repoPath": repo.to_string_lossy(), "cwd": repo.to_string_lossy(), "accountId": "c1", "createdAt": 1 }] }));
        let proceso = Arc::new(Proceso { guion: Box::new(guion), pedidos: Mutex::new(vec![]) });
        let sis = Sistema { proceso: proceso.clone(), git: Arc::new(Git), exe: Arc::new(|_| Some("claude.exe".into())) };
        let tickets = Tickets::nuevo(t.entorno.clone(), sis);
        let mut router = Router::nuevo(Arc::new(ReenvioNulo));
        registrar_con(&mut router, tickets.clone());
        Prueba { t, proceso, router, tickets, repo }
    }

    impl Prueba {
        async fn ok(&self, op: &str, args: Vec<Value>) -> Value {
            self.router.invocar(format!("feat:tickets:{op}"), args).await.unwrap_or_else(|e| panic!("{op}: {e}"))
        }
        async fn err(&self, op: &str, args: Vec<Value>) -> String {
            self.router.invocar(format!("feat:tickets:{op}"), args).await.unwrap_err()
        }
        fn guardado(&self) -> Value {
            serde_json::from_str(&fs::read_to_string(self.t.carpeta.join("perfil/features/tickets.json")).unwrap()).unwrap()
        }
        fn eventos(&self, canal: &str) -> Vec<Value> {
            self.t.eventos().into_iter().filter(|(c, _)| c == canal).map(|(_, a)| a[0].clone()).collect()
        }
    }

    const ATL: &str = "mcp__claude_ai_Atlassian_MCP__";

    fn init_jira() -> String {
        json!({ "type": "system", "subtype": "init", "mcp_servers": [{ "name": "claude.ai Atlassian MCP", "status": "connected" }],
            "tools": [format!("{ATL}atlassianUserInfo"), format!("{ATL}getAccessibleAtlassianResources"), format!("{ATL}searchJiraIssuesUsingJql")] })
        .to_string()
    }

    fn sobre(o: Value) -> String {
        json!({ "type": "result", "subtype": "success", "is_error": false, "result": "", "num_turns": 3, "total_cost_usd": 0.02, "usage": { "input_tokens": 10, "output_tokens": 5 }, "structured_output": o }).to_string()
    }

    /// Claude con el conector de Jira conectado: la revisión ve el servidor y la lista trae un ticket.
    fn claude_con_jira(p: &Peticion) -> String {
        if p.prompt == build_revisar_prompt() {
            return format!("{}\n", init_jira());
        }
        format!("{}\n{}\n", init_jira(), sobre(json!({ "tickets": [{ "id": "PROJ-1", "titulo": "Arreglar el login" }] })))
    }

    fn gh_con_un_issue(p: &Peticion) -> String {
        let l = p.args.join(" ");
        if l.starts_with("api user") {
            "tomy\n".into()
        } else if l.starts_with("issue list") {
            json!([{ "number": 12, "title": "Se cae", "assignees": [{ "login": "tomy" }], "labels": [], "url": "https://github.com/o/r/issues/12", "body": "" }]).to_string()
        } else {
            String::new()
        }
    }

    #[test]
    fn registra_los_veinte_canales_y_tickets_y_team_quedan_fuera_del_proceso_de_apoyo() {
        let p = armar("tk-canales", |_| String::new());
        for op in [
            "state", "refresh", "setFiltro", "personas", "cancel", "setConfig", "hasRepo", "start", "detail", "accion", "propios", "propio", "descubrir", "revisarCuentas", "probar", "guardarPropio",
            "borrarPropio", "aceptar", "exportarPropio", "importarPropio",
        ] {
            assert!(p.router.atiende(&format!("feat:tickets:{op}")), "{op}");
        }
        assert_eq!(p.router.canales().len(), 20);
        assert!(super::super::FUNCIONES_EN_RUST.contains(&"tickets") && super::super::FUNCIONES_EN_RUST.contains(&"team"));
    }

    #[tokio::test]
    async fn antes_de_que_el_perfil_este_listo_responde_que_esta_arrancando() {
        let t = EntornoDePrueba::sin_perfil("tk-arranque");
        let sis = Sistema { proceso: Arc::new(Proceso { guion: Box::new(|_| String::new()), pedidos: Mutex::new(vec![]) }), git: Arc::new(Git), exe: Arc::new(|_| None) };
        let tickets = Tickets::nuevo(t.entorno.clone(), sis);
        let mut router = Router::nuevo(Arc::new(ReenvioNulo));
        registrar_con(&mut router, tickets.clone());
        assert_eq!(router.invocar("feat:tickets:state".into(), vec![]).await.unwrap_err(), "Sloth todavía está arrancando.");
        assert_eq!(tickets.para_equipo()["conector"], Value::Null);
        assert!(t.eventos().is_empty());
        t.entorno.fijar_perfil(t.carpeta.join("perfil"));
        tickets.al_perfil();
        let ev = t.eventos();
        assert_eq!(ev[0].0, "feat:tickets:changed", "sin conector, la UI igual recibe el estado y muestra «Conectá tus tickets»");
        assert_eq!(ev[0].1[0]["conector"]["disponible"], json!(false));
    }

    #[tokio::test]
    async fn sin_conector_el_estado_no_inventa_nada_y_la_config_se_valida_como_en_el_ts() {
        let p = armar("tk-config", |_| String::new());
        let s = p.ok("state", vec![]).await;
        assert_eq!((s["conector"]["disponible"].clone(), s["tickets"].clone(), s["running"].clone()), (json!(false), json!([]), json!(false)));
        assert_eq!(p.err("setConfig", vec![json!("x")]).await, "Configuración inválida.");
        assert_eq!(p.err("setConfig", vec![json!({ "conectorId": "trello" })]).await, "Ese conector no está en esta versión de Sloth.");
        assert_eq!(p.err("setConfig", vec![json!({ "model": "gpt" })]).await, "Modelo inválido.");
        assert_eq!(p.err("setConfig", vec![json!({ "defaultRepo": "Z:/no/existe" })]).await, "Repo por defecto: la carpeta no existe.");
        assert_eq!(p.err("refresh", vec![]).await, "Todavía no elegiste un conector. Elegilo en los ajustes de Tickets.");
        assert_eq!(p.err("accion", vec![json!("borrar"), json!("X-1"), Value::Null]).await, "Acción inválida.");
        let s = p.ok("setConfig", vec![json!({ "conectorId": "jira", "queryAccountId": "c1" })]).await;
        assert_eq!(s["conector"]["id"], json!("jira"));
        assert_eq!(p.guardado()["config"]["conectorId"], json!("jira"));
        assert!(!p.eventos("feat:tickets:changed").is_empty());
    }

    #[tokio::test]
    async fn actualizar_con_jira_revisa_la_cuenta_corre_claude_con_el_entorno_de_la_cuenta_y_guarda_la_lista() {
        let p = armar("tk-jira", claude_con_jira);
        p.ok("setConfig", vec![json!({ "conectorId": "jira" })]).await;
        let r = p.ok("refresh", vec![]).await;
        assert_eq!(r["count"], json!(1));
        let pedidos = p.proceso.pedidos.lock().unwrap().clone();
        assert_eq!(pedidos.len(), 1, "una cuenta sin revisar se prueba directo: la lista trae su system/init");
        let (exe, args, prompt, env) = &pedidos[0];
        assert_eq!(exe, "claude.exe");
        assert!(args.contains(&"--verbose".to_string()));
        assert!(prompt.contains("searchJiraIssuesUsingJql"));
        let cuenta = p.t.carpeta.join("cuenta").to_string_lossy().into_owned();
        assert_eq!(env.get("CLAUDE_CONFIG_DIR"), Some(&cuenta));
        assert!(!env.contains_key("ANTHROPIC_API_KEY") && !env.keys().any(|k| k.starts_with("SLOTH_")));
        let g = p.guardado();
        assert_eq!(g["tickets"][0]["id"], json!("PROJ-1"));
        assert_eq!(g["config"]["queryAccountId"], json!("c1"));
        assert_eq!(g["fetchedBy"], json!("c1"));
        assert_eq!(g["lastRun"]["numTurns"], json!(3));
        assert!(g["uso"].is_object(), "lo gastado se anota por día");
        let cuentas: Value = serde_json::from_str(&fs::read_to_string(p.t.carpeta.join("perfil/features/tickets-cuentas.json")).unwrap()).unwrap();
        assert_eq!(cuentas["cuentas"]["c1"]["servidores"][0]["nombre"], json!("claude.ai Atlassian MCP"));
        let snaps = p.eventos("feat:tickets:changed");
        assert!(snaps.iter().any(|s| s["running"] == json!(true)) && snaps.last().unwrap()["running"] == json!(false));
        let equipo = p.tickets.para_equipo();
        assert_eq!(equipo["conector"]["id"], json!("jira"));
        assert_eq!(equipo["tickets"][0]["id"], json!("PROJ-1"));
    }

    #[tokio::test]
    async fn un_error_de_la_consulta_queda_en_last_error_y_no_deja_la_consulta_trabada() {
        let p = armar("tk-error", |p| if p.prompt == build_revisar_prompt() { format!("{}\n", init_jira()) } else { "esto no es json".into() });
        p.ok("setConfig", vec![json!({ "conectorId": "jira" })]).await;
        let e = p.err("refresh", vec![]).await;
        assert!(!e.is_empty());
        let s = p.ok("state", vec![]).await;
        assert_eq!(s["running"], json!(false));
        assert_eq!(s["lastError"], json!(e));
        assert_eq!(p.err("refresh", vec![Value::Null, json!(0)]).await, "Tope de vueltas inválido.");
        assert_eq!(p.err("refresh", vec![Value::Null, Value::Null, json!("raro")]).await, "Modo de actualización inválido.");
    }

    #[tokio::test]
    async fn github_lee_con_gh_el_repo_de_la_carpeta_elegida_sin_pasar_por_claude() {
        let p = armar("tk-gh", gh_con_un_issue);
        p.ok("setConfig", vec![json!({ "conectorId": "github", "defaultRepo": p.repo.to_string_lossy() })]).await;
        assert_eq!(p.ok("refresh", vec![]).await, json!({ "count": 1 }));
        let pedidos = p.proceso.pedidos.lock().unwrap().clone();
        assert!(pedidos.iter().all(|(exe, ..)| exe == "gh"));
        assert!(pedidos.iter().any(|(_, a, ..)| a.join(" ").contains("issue list --repo o/r")));
        assert!(pedidos.iter().all(|(.., env)| env.get("GH_PROMPT_DISABLED").map(String::as_str) == Some("1")));
        let s = p.ok("state", vec![]).await;
        assert_eq!(s["tickets"][0]["id"], json!("12"));
        assert_eq!(s["carpetas"]["12"], json!(p.repo.to_string_lossy()));
        assert_eq!(p.ok("hasRepo", vec![json!("12")]).await, json!(true));
    }

    #[tokio::test]
    async fn empezar_pide_el_espacio_al_dueno_del_store_con_el_id_validado_y_lo_muestra() {
        let p = armar("tk-start", gh_con_un_issue);
        let pedidos: Arc<Mutex<Vec<(String, Vec<Value>)>>> = Arc::default();
        let anotados = pedidos.clone();
        p.t.fijar_apoyo(move |canal, args| {
            anotados.lock().unwrap().push((canal.to_string(), args.to_vec()));
            Ok(json!({ "id": "nuevo", "name": "12" }))
        });
        p.ok("setConfig", vec![json!({ "conectorId": "github", "defaultRepo": p.repo.to_string_lossy() })]).await;
        p.ok("refresh", vec![]).await;
        assert!(!p.err("start", vec![json!("12 & calc"), Value::Null]).await.is_empty());
        assert!(pedidos.lock().unwrap().is_empty(), "un id que no tiene el formato del conector no llega a ninguna terminal");
        assert_eq!(p.ok("start", vec![json!("12"), json!("c1")]).await, json!({ "id": "nuevo", "created": true }));
        let pedidos = pedidos.lock().unwrap().clone();
        assert_eq!(pedidos[0].0, "workspaces:add");
        assert_eq!(pedidos[0].1[0], json!({ "name": "12", "repoPath": p.repo.to_string_lossy(), "accountId": "c1", "autoStartClaude": true, "ticket": "12", "resume": true }));
        assert!(p.t.eventos().contains(&("ui:command".to_string(), vec![json!({ "type": "open-pane", "id": "nuevo" })])));
        let act = fs::read_to_string(p.t.carpeta.join("perfil/actividad/actividad.jsonl")).unwrap();
        assert!(act.contains("\"tipo\":\"ticket\",\"espacio\":\"12\",\"ticket\":\"12\""), "{act}");
    }

    #[tokio::test]
    async fn un_conector_propio_se_guarda_se_exporta_y_se_importa_con_los_dialogos_de_la_plataforma() {
        let p = armar("tk-propios", |_| String::new());
        let mut propio = CONECTORES.iter().find(|c| c.id() == "linear").unwrap().a_valor();
        propio["id"] = json!("mi-jira");
        propio["nombre"] = json!("Mi Jira");
        p.ok("guardarPropio", vec![propio.clone(), Value::Null]).await;
        let lista = p.ok("propios", vec![]).await;
        assert_eq!(lista["lista"][0]["id"], json!("mi-jira"));
        assert_eq!(p.ok("propio", vec![json!("mi-jira")]).await["nombre"], json!("Mi Jira"));
        assert_eq!(p.err("propio", vec![json!("jira")]).await, "Ese conector propio ya no existe.");
        let archivo: Value = serde_json::from_str(&fs::read_to_string(p.t.carpeta.join("perfil/features/tickets-conectores.json")).unwrap()).unwrap();
        assert_eq!(archivo["conectores"][0]["id"], json!("mi-jira"));

        assert_eq!(p.ok("exportarPropio", vec![json!("mi-jira")]).await, Value::Null, "cancelar el diálogo no escribe nada");
        let destino = p.t.carpeta.join("mi-jira.sloth-conector.json").to_string_lossy().into_owned();
        *p.t.plataforma.guardar_en.lock().unwrap() = Some(PathBuf::from(&destino));
        assert_eq!(p.ok("exportarPropio", vec![json!("mi-jira")]).await, json!({ "path": destino }));
        assert!(fs::read_to_string(&destino).unwrap().contains("\"mi-jira\""));

        *p.t.plataforma.elegido.lock().unwrap() = Some(PathBuf::from(&destino));
        let imp = p.ok("importarPropio", vec![]).await;
        assert_eq!((imp["def"]["id"].clone(), imp["choca"].clone()), (json!("mi-jira"), json!("propio")));

        p.ok("borrarPropio", vec![json!("mi-jira")]).await;
        assert_eq!(p.ok("propios", vec![]).await["lista"], json!([]));
        assert_eq!(p.err("borrarPropio", vec![json!("jira")]).await, "Ese conector propio ya no existe. Los del equipo se sacan de .sloth/conectores.json.");
    }

    #[tokio::test]
    async fn descubrir_valida_el_prefijo_antes_de_armar_el_prompt() {
        let p = armar("tk-descubrir", |_| String::new());
        assert_eq!(p.err("descubrir", vec![json!(5), Value::Null]).await, "Prefijo inválido.");
        assert_eq!(p.err("descubrir", vec![json!("x".repeat(65)), Value::Null]).await, "Prefijo inválido.");
        assert!(p.proceso.pedidos.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancelar_sin_consulta_en_curso_no_falla() {
        let p = armar("tk-cancel", |_| String::new());
        assert_eq!(p.ok("cancel", vec![]).await, json!(true));
    }

    #[test]
    fn fundir_ticket_conserva_el_orden_y_saca_lo_que_ya_no_esta() {
        let mut o: Obj = serde_json::from_value(json!({ "id": "A-1", "raro": 1, "titulo": "x", "responsable": "Ana", "estado": "a" })).unwrap();
        let mut t = ticket_de_obj(&o);
        t.responsable = None;
        t.estado = Some("b".into());
        fundir_ticket(&mut o, &t);
        assert_eq!(Value::Object(o), json!({ "id": "A-1", "raro": 1, "titulo": "x", "estado": "b" }));
    }
}
