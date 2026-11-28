//! Función «chat» (lado main): config de Supabase, login con GitHub (PKCE), sesión cifrada, invitaciones y la prueba de
//! conexión. Los datos (equipos, mensajes, realtime) son de `datos.rs`. Equivale a chat.ts.
//!
//! Reglas: los tokens nunca salen de acá (la UI solo ve el snapshot); la sesión va cifrada; la service_role / secret key
//! se rechaza; el navegador solo se abre a https://<host de la config>.
//!
//! Origen de la config: la de Configuración gana. Si no hay, la de `.sloth/team.json` de un espacio solo se usa si la
//! persona la aceptó (repo + url + huella de la key). Si cambia, se corta la sesión.
//!
//! Candados: ninguno se sostiene mientras se llama a `datos`, al entorno o a la red. Todo se toma, se copia y se suelta.
use super::auth::ResultadoLogin;
use super::callback::{iniciar_login_github, DepsLogin, LoginGithub};
use super::config::{huella_de_key, parsear_config_servidor, vista_previa_de_key, ChatServerConfig};
use super::datos::{fabrica_realtime, AjustesAviso, ChatDatos, Entorno, Fabrica, Nucleo};
use super::gotrue::Auth;
use super::http::{ErrorRed, Http, Pedido};
use super::invitacion::{armar_invitacion, decidir_invitacion, parece_invitacion, parsear_invitacion, ChatInvitation, ConfigActiva, DecisionInvitacion, EstadoActual};
use super::mapa::{avatar_de, perfil_de_fila};
use super::postgrest::{Consulta, Credencial, Supabase};
use super::sesion::Sesion;
use super::texto::{confirmacion_de_invitacion, host_de_url, host_no_supabase};
use super::tipos::{ChatConvRef, ChatProfile, CHAT_CALLBACK_PATH, CHAT_CALLBACK_PORTS};
use super::validar::{validar_chat, Pedidor, Respuesta};
use super::Res;
use crate::features::team_config::{clave_de_repo, Lectura};
use crate::persistencia::{escribir_json_atomico, leer_json, respaldar, OpcionesLectura};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

const OWNER_KEY: &str = "sloth:owner";
const TEST_TIMEOUT_MS: u64 = 8000;
const VALIDAR_TIMEOUT_MS: u64 = 8000;
const SIN_CONFIG: &str = "Primero configurá el chat en Configuración → Equipo y chat.";

/// Lo que `chat` necesita del resto de la app.
pub trait EntornoPrincipal: Send + Sync {
    fn emitir(&self, canal: &str, payload: Value);
    fn log(&self, msg: &str);
    /// Aviso visible para la persona (no se pierde en el log).
    fn avisar(&self, texto: &str);
    /// `<userData>/features`.
    fn carpeta_features(&self) -> PathBuf;
    /// Carpetas de repo de los espacios.
    fn repos_de_espacios(&self) -> Vec<String>;
    fn leer_equipo(&self, repo: &str) -> Lectura {
        crate::features::team_config::leer_team_config_del_repo(repo)
    }
    fn abrir_externo(&self, url: &str) -> Res<()>;
    fn portapapeles(&self) -> String;
    fn version_app(&self) -> String;
    fn ahora_ms(&self) -> i64;
    fn ventana_con_foco(&self) -> bool;
    fn ajustes(&self) -> AjustesAviso;
    fn notificar(&self, titulo: &str, cuerpo: &str, conv: &ChatConvRef);
}

#[derive(Debug, Clone, PartialEq)]
enum EstadoAuth {
    SinConfig,
    SinSesion,
    Iniciando { desde: i64, aviso: Option<String> },
    Con(ChatProfile),
    Error(String),
}

impl EstadoAuth {
    fn a_json(&self) -> Value {
        match self {
            EstadoAuth::SinConfig => json!({"status": "unconfigured"}),
            EstadoAuth::SinSesion => json!({"status": "signedOut"}),
            EstadoAuth::Iniciando { desde, aviso } => {
                let mut v = json!({"status": "signingIn", "startedAt": desde});
                if let Some(a) = aviso {
                    v["aviso"] = json!(a);
                }
                v
            }
            EstadoAuth::Con(me) => json!({"status": "signedIn", "me": me}),
            EstadoAuth::Error(m) => json!({"status": "error", "message": m}),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Aceptada {
    repo: String,
    supabase_url: String,
    key_hash: String,
}

#[derive(Debug, Clone, Default)]
struct Guardado {
    config: Option<ChatServerConfig>,
    aceptada: Option<Aceptada>,
    /// Host fuera de supabase.co que la persona ya vio avisado (o confirmó al cargarlo).
    avisado_host: Option<String>,
}

impl Guardado {
    fn a_json(&self) -> Value {
        let mut o = Map::new();
        if let Some(c) = &self.config {
            o.insert("config".into(), json!({"supabaseUrl": c.supabase_url, "anonKey": c.anon_key}));
        }
        if let Some(a) = &self.aceptada {
            o.insert("accepted".into(), json!({"repo": a.repo, "supabaseUrl": a.supabase_url, "keyHash": a.key_hash}));
        }
        if let Some(h) = &self.avisado_host {
            o.insert("avisadoHost".into(), json!(h));
        }
        Value::Object(o)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Origen {
    Ajustes,
    TeamJson,
}

#[derive(Debug, Clone)]
struct Activa {
    cfg: ChatServerConfig,
    origen: Origen,
    repo: Option<String>,
    /// Para detectar cambios de config.
    id: String,
}

#[derive(Debug, Clone)]
struct Oferta {
    cfg: ChatServerConfig,
    repo: String,
    team_name: String,
    /// Huella de la key que se le mostró a la persona: al aceptar, tiene que seguir igual.
    hash: String,
}

/// El cliente de Supabase de una config: la sesión (GoTrue) y las consultas (PostgREST) firmadas con ella.
struct Cliente {
    auth: Arc<Auth>,
    sb: Arc<Supabase>,
}

struct Estado {
    guardado: Guardado,
    activa: Option<Activa>,
    oferta: Option<Oferta>,
    cliente: Option<Arc<Cliente>>,
    me: Option<ChatProfile>,
    auth: EstadoAuth,
    login: Option<Arc<LoginGithub>>,
    corriendo: bool,
    ventana: bool,
    /// Código de una invitación que espera el login con GitHub (solo vale para la config con ese id).
    invitacion_pendiente: Option<(String, String)>,
}

fn bloquear<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Lo que `datos` ve del núcleo: el cliente solo mientras hay sesión iniciada.
struct NucleoDeEstado(Arc<Mutex<Estado>>);

impl Nucleo for NucleoDeEstado {
    fn cliente(&self) -> Option<Arc<Supabase>> {
        let e = bloquear(&self.0);
        match (&e.auth, &e.cliente) {
            (EstadoAuth::Con(_), Some(c)) => Some(c.sb.clone()),
            _ => None,
        }
    }

    fn me(&self) -> Option<ChatProfile> {
        bloquear(&self.0).me.clone()
    }
}

/// El `Entorno` de `datos` es el de la app, salvo `al_cambiar`: el snapshot lo arma `chat`, que le suma `auth`.
struct EntornoDeDatos {
    base: Arc<dyn EntornoPrincipal>,
    principal: Weak<Principal>,
}

impl Entorno for EntornoDeDatos {
    fn emitir(&self, canal: &str, payload: Value) {
        self.base.emitir(canal, payload)
    }
    fn log(&self, msg: &str) {
        self.base.log(msg)
    }
    fn al_cambiar(&self) {
        if let Some(p) = self.principal.upgrade() {
            p.emitir_snapshot();
        }
    }
    fn ventana_con_foco(&self) -> bool {
        self.base.ventana_con_foco()
    }
    fn ventana_abierta(&self) -> bool {
        self.principal.upgrade().is_some_and(|p| bloquear(&p.e).ventana)
    }
    fn ajustes(&self) -> AjustesAviso {
        self.base.ajustes()
    }
    fn notificar(&self, titulo: &str, cuerpo: &str, conv: &ChatConvRef) {
        self.base.notificar(titulo, cuerpo, conv)
    }
    fn ahora_ms(&self) -> i64 {
        self.base.ahora_ms()
    }
}

/// La sesión que reusa «celular» para el canal remoto.
pub struct SesionChat {
    pub sb: Arc<Supabase>,
    pub auth: Arc<Auth>,
    pub user_id: String,
    pub supabase_url: String,
    pub anon_key: String,
}

pub struct Principal {
    e: Arc<Mutex<Estado>>,
    entorno: Arc<dyn EntornoPrincipal>,
    http: Arc<dyn Http>,
    sesion: Arc<Sesion>,
    archivo: PathBuf,
    datos: Arc<ChatDatos>,
    /// «Probar conexión» y la validación van de a una.
    validando: Mutex<()>,
    puertos: Mutex<Vec<u16>>,
}

fn msg_corto(m: &str) -> String {
    super::mensaje_corto(m)
}

fn host_de(url: &str) -> String {
    url::Url::parse(url).ok().and_then(|u| host_de_url(&u)).unwrap_or_default()
}

fn nombre_de_host(url: &str) -> String {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default()
}

impl Principal {
    /// `http` sale a la red; las pruebas ponen uno falso. `fabrica` abre el socket de Realtime (o uno falso).
    pub fn nuevo(entorno: Arc<dyn EntornoPrincipal>, http: Arc<dyn Http>, sesion: Arc<Sesion>, fabrica: Option<Fabrica>) -> Arc<Self> {
        let archivo = entorno.carpeta_features().join("chat.json");
        let guardado = cargar_guardado(&archivo, entorno.as_ref());
        let e = Arc::new(Mutex::new(Estado {
            guardado,
            activa: None,
            oferta: None,
            cliente: None,
            me: None,
            auth: EstadoAuth::SinConfig,
            login: None,
            corriendo: false,
            ventana: false,
            invitacion_pendiente: None,
        }));
        let p = Arc::new_cyclic(|w: &Weak<Principal>| {
            let fabrica = fabrica.unwrap_or_else(|| {
                let est = e.clone();
                fabrica_realtime(Arc::new(move || bloquear(&est).cliente.as_ref().and_then(|c| c.auth.token_de_acceso())))
            });
            let datos = ChatDatos::nuevo(Arc::new(NucleoDeEstado(e.clone())), Arc::new(EntornoDeDatos { base: entorno.clone(), principal: w.clone() }), fabrica);
            Principal { e: e.clone(), entorno, http, sesion, archivo, datos: Arc::new(datos), validando: Mutex::new(()), puertos: Mutex::new(CHAT_CALLBACK_PORTS.to_vec()) }
        });
        p.refrescar();
        p
    }

    /// Puertos del callback del login (las pruebas usan el 0: cualquiera libre).
    pub fn usar_puertos(&self, puertos: Vec<u16>) {
        *bloquear(&self.puertos) = puertos;
    }

    pub fn datos(&self) -> &Arc<ChatDatos> {
        &self.datos
    }

    /// Se lee en cada uso porque la sesión cambia sin aviso (login, logout, otra config).
    pub fn sesion_chat(&self) -> Option<SesionChat> {
        let e = bloquear(&self.e);
        match (&e.cliente, &e.activa, &e.auth, &e.me) {
            (Some(c), Some(a), EstadoAuth::Con(_), Some(me)) => Some(SesionChat { sb: c.sb.clone(), auth: c.auth.clone(), user_id: me.id.clone(), supabase_url: a.cfg.supabase_url.clone(), anon_key: a.cfg.anon_key.clone() }),
            _ => None,
        }
    }

    fn persistir(&self) -> Res<()> {
        let datos = bloquear(&self.e).guardado.a_json();
        escribir_json_atomico(&self.archivo, &datos).map(|_| ()).map_err(|e| e.to_string())
    }

    // ---------- snapshot ----------

    pub fn snapshot(&self) -> Value {
        let auth = bloquear(&self.e).auth.a_json();
        let mut v = self.datos.parte();
        if let Some(o) = v.as_object_mut() {
            let mut sal = Map::new();
            sal.insert("auth".into(), auth);
            sal.extend(std::mem::take(o));
            return Value::Object(sal);
        }
        json!({"auth": auth})
    }

    fn emitir_snapshot(&self) {
        let s = self.snapshot();
        self.entorno.emitir("snapshot", s);
    }

    // ---------- sesión y cliente ----------

    /// Marca la sesión guardada con el proyecto al que pertenece; si es de otro, la borra.
    fn asegurar_dueno(&self, cfg: &ChatServerConfig) {
        let id = format!("{}|{}", cfg.supabase_url, huella_de_key(&cfg.anon_key));
        if self.sesion.get_item(OWNER_KEY).as_deref() == Some(id.as_str()) {
            return;
        }
        self.sesion.limpiar();
        self.sesion.set_item(OWNER_KEY, &id);
    }

    fn crear_cliente(self: &Arc<Self>, cfg: &ChatServerConfig) -> Arc<Cliente> {
        self.asegurar_dueno(cfg);
        let ahora = self.entorno.clone();
        let auth = Arc::new(Auth::nuevo(self.http.clone(), &cfg.supabase_url, &cfg.anon_key, self.sesion.clone(), move || ahora.ahora_ms() / 1000));
        let sb = Arc::new(Supabase::nuevo(self.http.clone(), &cfg.supabase_url, &cfg.anon_key, auth.clone() as Arc<dyn Credencial>, &format!("sloth/{}", self.entorno.version_app())));
        let c = Arc::new(Cliente { auth: auth.clone(), sb });
        // El servidor rechazó para siempre la renovación (SIGNED_OUT): se corta lo de esta sesión. En otro hilo porque el
        // aviso sale desde adentro de una consulta que `datos` puede tener en curso.
        let (debil, mio) = (Arc::downgrade(self), Arc::downgrade(&c));
        auth.al_cerrarse(move || {
            let (Some(p), Some(c)) = (debil.upgrade(), mio.upgrade()) else { return };
            std::thread::spawn(move || p.sesion_cerrada(&c));
        });
        c
    }

    fn sesion_cerrada(self: &Arc<Self>, c: &Arc<Cliente>) {
        {
            let mut e = bloquear(&self.e);
            let actual = e.cliente.as_ref().is_some_and(|x| Arc::ptr_eq(x, c));
            if !actual || matches!(e.auth, EstadoAuth::Iniciando { .. }) {
                return;
            }
            e.me = None;
            e.auth = EstadoAuth::SinSesion;
        }
        self.parar_datos();
        self.emitir_snapshot();
    }

    fn es_el_cliente(&self, c: &Arc<Cliente>) -> bool {
        bloquear(&self.e).cliente.as_ref().is_some_and(|x| Arc::ptr_eq(x, c))
    }

    /// Carga el perfil de GitHub de quien tiene sesión. Sin perfil, cierra la sesión: no es de GitHub.
    fn cargar_yo(&self, c: &Arc<Cliente>) -> Res<()> {
        let u = c.auth.usuario()?;
        let id = u.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        let r = c.sb.ejecutar(&Consulta::select("profiles", "id, login, name, avatar_url").eq("id", &id).limite(1));
        if r.error.is_some() {
            return Err("No se pudo leer tu perfil. Probá de nuevo.".into());
        }
        let Some(perfil) = r.primera().and_then(perfil_de_fila) else {
            c.auth.cerrar_sesion_local();
            self.sesion.limpiar();
            if let Some(a) = bloquear(&self.e).activa.clone() {
                self.asegurar_dueno(&a.cfg);
            }
            let mut e = bloquear(&self.e);
            e.me = None;
            e.auth = EstadoAuth::Error("Entrá con GitHub.".into());
            return Ok(());
        };
        let perfil = ChatProfile { avatar_url: avatar_de(r.primera().and_then(|f| f.get("avatar_url"))), ..perfil };
        let mut e = bloquear(&self.e);
        e.me = Some(perfil.clone());
        e.auth = EstadoAuth::Con(perfil);
        Ok(())
    }

    /// Con sesión guardada, la recupera sin abrir el navegador.
    fn restaurar_sesion(self: &Arc<Self>, c: Arc<Cliente>) {
        let resultado = if c.auth.sesion_actual().is_some() && self.es_el_cliente(&c) { Some(self.cargar_yo(&c)) } else { None };
        let Some(r) = resultado else { return };
        if !self.es_el_cliente(&c) {
            return;
        }
        if let Err(m) = r {
            bloquear(&self.e).auth = EstadoAuth::Error(msg_corto(&m));
        }
        self.emitir_snapshot();
        self.actualizar_datos();
    }

    /// Datos y realtime solo con sesión y ventana abierta. Una sola conexión realtime.
    fn actualizar_datos(self: &Arc<Self>) {
        let arrancar = {
            let mut e = bloquear(&self.e);
            let quiere = e.cliente.is_some() && matches!(e.auth, EstadoAuth::Con(_)) && e.ventana;
            if quiere && !e.corriendo {
                e.corriendo = true;
                true
            } else {
                if !quiere && e.corriendo {
                    drop(e);
                    self.parar_datos();
                }
                false
            }
        };
        if arrancar {
            let d = self.datos.clone();
            std::thread::spawn(move || d.arrancar());
        }
    }

    fn parar_datos(&self) {
        {
            let mut e = bloquear(&self.e);
            if !e.corriendo {
                return;
            }
            e.corriendo = false;
        }
        self.datos.parar();
    }

    // ---------- qué config vale ----------

    /// La de Configuración, o la de un team.json aceptado; si no, una oferta.
    fn resolver_config(&self) -> (Option<Activa>, Option<Oferta>) {
        let guardado = bloquear(&self.e).guardado.clone();
        if let Some(cfg) = guardado.config {
            let id = format!("settings|{}|{}", cfg.supabase_url, huella_de_key(&cfg.anon_key));
            return (Some(Activa { cfg, origen: Origen::Ajustes, repo: None, id }), None);
        }
        let mut primera: Option<Oferta> = None;
        let mut vistos = HashSet::new();
        for repo in self.entorno.repos_de_espacios() {
            if repo.is_empty() || !vistos.insert(clave_de_repo(&repo)) {
                continue;
            }
            let Lectura::Ok { config, .. } = self.entorno.leer_equipo(&repo) else { continue };
            let Some(chat) = config.chat else { continue };
            let cfg = ChatServerConfig { supabase_url: chat.supabase_url, anon_key: chat.anon_key };
            let h = huella_de_key(&cfg.anon_key);
            if let Some(a) = &guardado.aceptada {
                if a.repo == clave_de_repo(&repo) && a.supabase_url == cfg.supabase_url && a.key_hash == h {
                    let id = format!("team|{}|{}|{h}", clave_de_repo(&repo), cfg.supabase_url);
                    return (Some(Activa { cfg, origen: Origen::TeamJson, repo: Some(repo), id }), None);
                }
            }
            primera.get_or_insert(Oferta { cfg, repo, team_name: config.equipo, hash: h });
        }
        (None, primera)
    }

    /// Recalcula la config. Si cambió, corta el login y la sesión en curso y arma el cliente nuevo.
    fn refrescar(self: &Arc<Self>) {
        let (nueva, oferta) = self.resolver_config();
        let (viejo_login, avisar_invitacion, tenia_activa) = {
            let mut e = bloquear(&self.e);
            e.oferta = oferta;
            if nueva.as_ref().map(|a| a.id.as_str()).unwrap_or("") == e.activa.as_ref().map(|a| a.id.as_str()).unwrap_or("") {
                return;
            }
            (e.login.take(), e.invitacion_pendiente.take().is_some(), e.activa.is_some())
        };
        if let Some(l) = viejo_login {
            l.cancelar();
        }
        if avisar_invitacion {
            self.entorno.emitir("invite", json!({"ok": false, "message": "La configuración del chat cambió mientras iniciabas sesión. Pegá la invitación de nuevo."}));
        }
        self.parar_datos();
        {
            let mut e = bloquear(&self.e);
            e.cliente = None;
            e.me = None;
            e.activa = nueva.clone();
        }
        // Si la config activa cambia, la sesión era de la anterior: se borra. Al arrancar (no había config activa) se
        // conserva, y `crear_cliente` la descarta si es de otro proyecto.
        if tenia_activa || nueva.is_none() {
            self.sesion.limpiar();
        }
        let Some(a) = nueva else {
            bloquear(&self.e).auth = EstadoAuth::SinConfig;
            return self.emitir_snapshot();
        };
        let c = self.crear_cliente(&a.cfg);
        {
            let mut e = bloquear(&self.e);
            e.cliente = Some(c.clone());
            e.auth = EstadoAuth::SinSesion;
        }
        let p = self.clone();
        std::thread::spawn(move || p.restaurar_sesion(c));
        self.emitir_snapshot();
    }

    fn vista(&self) -> Value {
        let e = bloquear(&self.e);
        let mut v = Map::new();
        if let Some(a) = &e.activa {
            let mut act = json!({"supabaseUrl": a.cfg.supabase_url, "keyPreview": vista_previa_de_key(&a.cfg.anon_key), "source": if a.origen == Origen::Ajustes { "settings" } else { "team.json" }});
            if let Some(r) = &a.repo {
                act["repo"] = json!(r);
            }
            v.insert("active".into(), act);
        }
        if let Some(o) = &e.oferta {
            v.insert("offered".into(), json!({"supabaseUrl": o.cfg.supabase_url, "repo": o.repo, "teamName": o.team_name}));
        }
        Value::Object(v)
    }

    // ---------- canales IPC ----------

    pub fn estado(self: &Arc<Self>) -> Value {
        self.refrescar();
        self.snapshot()
    }

    pub fn obtener_config(self: &Arc<Self>) -> Value {
        self.refrescar();
        self.vista()
    }

    pub fn guardar_config(self: &Arc<Self>, entrada: &Value) -> Res<Value> {
        let cfg = if entrada.is_null() { None } else { Some(parsear_config_servidor(entrada)?) };
        {
            let mut e = bloquear(&self.e);
            e.guardado.avisado_host = cfg.as_ref().and_then(|c| host_no_supabase(&c.supabase_url));
            e.guardado.config = cfg;
        }
        self.persistir()?;
        self.refrescar();
        Ok(self.vista())
    }

    pub fn aceptar_config_del_equipo(self: &Arc<Self>, repo: &Value) -> Res<Value> {
        let Some(repo) = repo.as_str().filter(|r| !r.is_empty() && r.encode_utf16().count() <= 1000) else { return Err("Carpeta inválida.".into()) };
        // Sin refrescar antes: se compara contra la oferta que vio la persona, no contra el archivo de ahora.
        let oferta = bloquear(&self.e).oferta.clone().filter(|o| clave_de_repo(&o.repo) == clave_de_repo(repo)).ok_or("No hay una configuración de equipo pendiente para esa carpeta.")?;
        let igual = match self.entorno.leer_equipo(&oferta.repo) {
            Lectura::Ok { config, .. } => config.chat.is_some_and(|c| c.supabase_url == oferta.cfg.supabase_url && huella_de_key(&c.anon_key) == oferta.hash),
            _ => false,
        };
        if !igual {
            // La oferta vuelve a calcularse con el archivo nuevo, para que la persona la vea.
            self.refrescar();
            return Err("El .sloth/team.json cambió desde que se ofreció. Revisalo y probá de nuevo.".into());
        }
        bloquear(&self.e).guardado.aceptada = Some(Aceptada { repo: clave_de_repo(&oferta.repo), supabase_url: oferta.cfg.supabase_url.clone(), key_hash: oferta.hash.clone() });
        self.persistir()?;
        self.refrescar();
        Ok(self.vista())
    }

    /// Prueba real: `GET /auth/v1/health` con la anon key guardada. Nunca usa la service_role; sin redirects.
    pub fn probar_conexion(self: &Arc<Self>) -> Value {
        self.refrescar();
        let (activa, auth) = {
            let e = bloquear(&self.e);
            (e.activa.clone(), e.auth.clone())
        };
        let r = |ok: bool, m: String| json!({"ok": ok, "message": m});
        let Some(a) = activa else { return r(false, "Primero guardá la URL y la clave publicable del proyecto.".into()) };
        let host = host_de(&a.cfg.supabase_url);
        let pedido = Pedido::nuevo("GET", &format!("{}/auth/v1/health", a.cfg.supabase_url)).con_cabecera("apikey", &a.cfg.anon_key).con_timeout(TEST_TIMEOUT_MS);
        let res = match self.http.pedir(&pedido) {
            Ok(x) => x,
            Err(ErrorRed::Timeout) => return r(false, "Supabase no respondió en 8 segundos. Revisá la conexión a internet.".into()),
            Err(ErrorRed::Conexion(_)) => return r(false, format!("Sin conexión: no se pudo llegar a {host}. Revisá la red o la URL.")),
        };
        match res.estado {
            401 | 403 => return r(false, "Supabase rechazó la clave. Revisá que sea la anon / publishable key del proyecto.".into()),
            404 => return r(false, format!("{host} no responde como un proyecto de Supabase. Revisá la URL.")),
            _ if !res.ok() => return r(false, format!("Supabase respondió con un error (código {}). Probá de nuevo en un rato.", res.estado)),
            _ => {}
        }
        match auth {
            EstadoAuth::Con(me) => r(true, format!("Conexión correcta con {host} · sesión de {}.", me.login)),
            _ => r(false, format!("Conexión correcta con {host}, pero falta la sesión de GitHub. Conectala para usar el chat.")),
        }
    }

    /// Con la clave pública y solo lectura: no toca la config guardada ni emite snapshot.
    pub fn validar(self: &Arc<Self>) -> Value {
        self.refrescar();
        let Some(a) = bloquear(&self.e).activa.clone() else {
            return json!([{"id": "config", "estado": "fallo", "titulo": "Sin configuración", "detalle": "Primero guardá la URL y la clave publicable del proyecto."}]);
        };
        let _uno_a_la_vez = bloquear(&self.validando);
        let red = PedidorHttp { http: self.http.clone(), url: a.cfg.supabase_url.clone(), anon_key: a.cfg.anon_key.clone() };
        json!(validar_chat(&a.cfg.supabase_url, &a.cfg.anon_key, &red))
    }

    pub fn portapapeles_con_invitacion(&self) -> Option<String> {
        let t = self.entorno.portapapeles();
        parece_invitacion(&json!(t)).then_some(t)
    }

    // ---------- login ----------

    pub fn iniciar_sesion(self: &Arc<Self>) -> Res<()> {
        let (activa, cliente) = {
            let e = bloquear(&self.e);
            (e.activa.clone(), e.cliente.clone())
        };
        let (Some(a), Some(c)) = (activa, cliente) else { return Err(SIN_CONFIG.into()) };
        {
            let mut e = bloquear(&self.e);
            if matches!(e.auth, EstadoAuth::Con(_) | EstadoAuth::Iniciando { .. }) {
                return Ok(());
            }
            e.auth = EstadoAuth::Iniciando { desde: self.entorno.ahora_ms(), aviso: None };
        }
        self.emitir_snapshot();
        let (sesion, entorno, debil) = (self.sesion.clone(), self.entorno.clone(), Arc::downgrade(self));
        let auth_gh = c.auth.clone();
        let deps = DepsLogin {
            auth: c.auth.clone(),
            host: nombre_de_host(&a.cfg.supabase_url),
            puertos: bloquear(&self.puertos).clone(),
            ruta: CHAT_CALLBACK_PATH.to_string(),
            abrir_externo: Box::new(move |u| entorno.abrir_externo(u)),
            preservar_verificador: Some(Arc::new(move || sesion.preservar_verificador())),
            canje_fallido: Some(Arc::new(move || {
                let Some(p) = debil.upgrade() else { return };
                {
                    let mut e = bloquear(&p.e);
                    let EstadoAuth::Iniciando { desde, .. } = e.auth else { return };
                    e.auth = EstadoAuth::Iniciando { desde, aviso: Some("Llegó un código que no sirvió. Si ya volviste del navegador y no entró, cancelá y probá de nuevo.".into()) };
                }
                p.emitir_snapshot();
            })),
            // Sin red o sin respuesta: que lo diga el propio login.
            github_habilitado: Some(Box::new(move || auth_gh.github_habilitado(TEST_TIMEOUT_MS))),
            timeout_ms: 0,
        };
        let login = match iniciar_login_github(deps) {
            Ok(l) => Arc::new(l),
            Err(m) => {
                bloquear(&self.e).auth = EstadoAuth::Error(msg_corto(&m));
                self.emitir_snapshot();
                return Ok(());
            }
        };
        bloquear(&self.e).login = Some(login.clone());
        let p = self.clone();
        std::thread::spawn(move || p.terminar_login(&login, &c));
        Ok(())
    }

    fn terminar_login(self: &Arc<Self>, l: &Arc<LoginGithub>, c: &Arc<Cliente>) {
        let res = l.esperar();
        {
            let mut e = bloquear(&self.e);
            if !e.login.as_ref().is_some_and(|x| Arc::ptr_eq(x, l)) {
                return;
            }
            e.login = None;
        }
        match &res {
            ResultadoLogin::Cancelado => bloquear(&self.e).auth = EstadoAuth::SinSesion,
            ResultadoLogin::Fallo(m) => bloquear(&self.e).auth = EstadoAuth::Error(m.clone()),
            ResultadoLogin::Ok => {
                if self.es_el_cliente(c) {
                    if let Err(m) = self.cargar_yo(c) {
                        bloquear(&self.e).auth = EstadoAuth::Error(msg_corto(&m));
                    }
                }
            }
        }
        self.emitir_snapshot();
        self.actualizar_datos();
        self.terminar_invitacion_pendiente(res == ResultadoLogin::Cancelado);
    }

    pub fn cancelar_inicio(self: &Arc<Self>) {
        let l = {
            let mut e = bloquear(&self.e);
            if e.login.is_none() && !matches!(e.auth, EstadoAuth::Iniciando { .. }) {
                return;
            }
            let l = e.login.take();
            e.auth = EstadoAuth::SinSesion;
            l
        };
        if let Some(l) = l {
            l.cancelar();
        }
        self.emitir_snapshot();
        self.terminar_invitacion_pendiente(true);
    }

    pub fn cerrar_sesion(self: &Arc<Self>) {
        let (l, cliente, activa) = {
            let mut e = bloquear(&self.e);
            e.invitacion_pendiente = None;
            (e.login.take(), e.cliente.clone(), e.activa.clone())
        };
        if let Some(l) = l {
            l.cancelar();
        }
        self.parar_datos();
        if let Some(c) = cliente {
            c.auth.cerrar_sesion_local();
        }
        self.sesion.limpiar();
        if let Some(a) = &activa {
            self.asegurar_dueno(&a.cfg);
        }
        {
            let mut e = bloquear(&self.e);
            e.me = None;
            e.auth = if activa.is_some() { EstadoAuth::SinSesion } else { EstadoAuth::SinConfig };
        }
        self.emitir_snapshot();
    }

    // ---------- invitaciones ----------

    fn invitacion_fallo(&self, m: &str) {
        self.entorno.emitir("invite", json!({"ok": false, "message": m}));
    }

    /// El RPC dice «no existe o ya lo cambiaron»: para quien recibió la invitación, eso es que venció.
    fn canjear(&self, code: &str) -> Res<Value> {
        self.datos.entrar_por_codigo(&json!(code)).map(|t| json!(t)).map_err(|m| {
            if m.contains("no existe o ya lo cambiaron") {
                "El código de esta invitación ya no anda: lo cambiaron o el equipo ya no existe. Pedí una invitación nueva.".to_string()
            } else {
                m
            }
        })
    }

    /// Después del login: si había una invitación esperando, se canjea y se avisa a la UI.
    fn terminar_invitacion_pendiente(&self, cancelado: bool) {
        let Some((code, config_id)) = bloquear(&self.e).invitacion_pendiente.take() else { return };
        if cancelado {
            return self.invitacion_fallo("Cancelaste el inicio de sesión. El chat quedó configurado: pegá la invitación de nuevo para entrar al equipo.");
        }
        let (auth, activa) = {
            let e = bloquear(&self.e);
            (e.auth.clone(), e.activa.as_ref().map(|a| a.id.clone()))
        };
        match auth {
            EstadoAuth::Con(_) => {}
            EstadoAuth::Error(m) => return self.invitacion_fallo(&m),
            _ => return self.invitacion_fallo("No se pudo iniciar sesión con GitHub. Probá de nuevo."),
        }
        if activa.as_deref() != Some(config_id.as_str()) {
            return self.invitacion_fallo("La configuración del chat cambió mientras iniciabas sesión. Pegá la invitación de nuevo.");
        }
        match self.canjear(&code) {
            Ok(team) => self.entorno.emitir("invite", json!({"ok": true, "team": team})),
            Err(m) => self.invitacion_fallo(&m),
        }
    }

    fn decision_de(self: &Arc<Self>, inv: &ChatInvitation) -> (DecisionInvitacion, String, Option<String>) {
        self.refrescar();
        let e = bloquear(&self.e);
        let active = e.activa.as_ref().map(|a| ConfigActiva { supabase_url: a.cfg.supabase_url.clone(), key_hash: huella_de_key(&a.cfg.anon_key) });
        let actual = e.activa.as_ref().map(|a| host_de(&a.cfg.supabase_url));
        let decision = decidir_invitacion(inv, &EstadoActual { active, signed_in: matches!(e.auth, EstadoAuth::Con(_)) });
        (decision, host_de(&inv.cfg.supabase_url), actual)
    }

    fn vista_de_invitacion(&self, inv: &ChatInvitation, decision: DecisionInvitacion, host: &str, actual: Option<String>) -> Value {
        let mut v = json!({"host": host, "decision": decision.como_str()});
        if let Some(n) = &inv.team_name {
            v["teamName"] = json!(n);
        }
        if let (DecisionInvitacion::ConfirmarReemplazo, Some(h)) = (decision, actual) {
            v["currentHost"] = json!(h);
        }
        v
    }

    pub fn ver_invitacion(self: &Arc<Self>, texto: &Value) -> Res<Value> {
        let inv = parsear_invitacion(texto)?;
        let (d, host, actual) = self.decision_de(&inv);
        Ok(self.vista_de_invitacion(&inv, d, &host, actual))
    }

    /// Si hay que cambiar la config, `confirmado` tiene que ser la misma decisión que vio la persona: así una config que
    /// apareció en el medio no se pisa con la confirmación de otra cosa.
    pub fn entrar_con_invitacion(self: &Arc<Self>, texto: &Value, confirmado: &Value) -> Res<Value> {
        let inv = parsear_invitacion(texto)?;
        let (decision, host, _) = self.decision_de(&inv);
        if matches!(decision, DecisionInvitacion::ConfirmarNueva | DecisionInvitacion::ConfirmarReemplazo) {
            if confirmado.as_str() != Some(confirmacion_de_invitacion(decision.como_str(), &host).as_str()) {
                return Err(format!("Confirmá que querés conectarte a {host} antes de seguir."));
            }
            {
                let mut e = bloquear(&self.e);
                e.guardado.avisado_host = host_no_supabase(&inv.cfg.supabase_url);
                e.guardado.config = Some(inv.cfg.clone());
            }
            self.persistir()?;
            self.refrescar();
        }
        if decision == DecisionInvitacion::Canjear {
            return Ok(json!({"kind": "joined", "team": self.canjear(&inv.code)?}));
        }
        let id = bloquear(&self.e).activa.as_ref().map(|a| a.id.clone()).ok_or("No se pudo guardar la configuración del chat.")?;
        bloquear(&self.e).invitacion_pendiente = Some((inv.code.clone(), id));
        // `iniciar_sesion` no falla por el navegador: deja el error en `auth`.
        self.iniciar_sesion()?;
        let auth = bloquear(&self.e).auth.clone();
        if let EstadoAuth::Error(m) = auth {
            bloquear(&self.e).invitacion_pendiente = None;
            return Err(m);
        }
        Ok(json!({"kind": "signingIn"}))
    }

    /// El código llega de la UI porque al cambiarlo la lista de equipos tarda en refrescarse; se valida igual.
    pub fn texto_de_invitacion(self: &Arc<Self>, equipo: &Value, codigo: &Value) -> Res<String> {
        self.refrescar();
        let cfg = bloquear(&self.e).activa.as_ref().map(|a| a.cfg.clone()).ok_or("El chat no está configurado.")?;
        let id = equipo.as_str().unwrap_or_default();
        let parte = self.datos.parte();
        let team = parte["teams"].as_array().and_then(|t| t.iter().find(|x| x["id"] == id)).cloned().ok_or("No encontré ese equipo.")?;
        if !matches!(team["role"].as_str(), Some("owner" | "admin")) {
            return Err("Solo el owner o un admin puede invitar.".into());
        }
        let code = match codigo {
            Value::Null => team["inviteCode"].as_str().map(String::from),
            Value::String(s) => Some(s.clone()),
            otro => Some(otro.to_string()),
        }
        .filter(|c| !c.is_empty())
        .ok_or("Este equipo todavía no tiene código de invitación. Generalo primero.")?;
        armar_invitacion(&cfg, &code, team["name"].as_str())
    }

    // ---------- ventana y cierre ----------

    pub fn ventana_abierta(self: &Arc<Self>, abierta: bool) {
        bloquear(&self.e).ventana = abierta;
        self.actualizar_datos();
    }

    pub fn ventana_enfocada(&self) {
        self.datos.ventana_enfocada();
    }

    /// Al salir de la app: cancela un login pendiente y corta realtime.
    pub fn cerrar(&self) {
        let l = bloquear(&self.e).login.take();
        if let Some(l) = l {
            l.cancelar();
        }
        self.parar_datos();
    }
}

/// `validar_chat` sobre `Http`: solo manda `apikey` y `accept`, sin redirects y con tope de tiempo.
struct PedidorHttp {
    http: Arc<dyn Http>,
    url: String,
    anon_key: String,
}

impl Pedidor for PedidorHttp {
    fn pedir(&self, ruta: &str, post: Option<&Value>) -> Respuesta {
        let mut p = Pedido::nuevo(if post.is_some() { "POST" } else { "GET" }, &format!("{}{ruta}", self.url)).con_cabecera("apikey", &self.anon_key).con_cabecera("accept", "application/json").con_timeout(VALIDAR_TIMEOUT_MS);
        if let Some(b) = post {
            p = p.con_cabecera("content-type", "application/json").con_cuerpo(b.to_string().into_bytes());
        }
        match self.http.pedir(&p) {
            Ok(r) => Respuesta::Http { status: r.estado, cuerpo: r.json() },
            Err(ErrorRed::Timeout) => Respuesta::Timeout,
            Err(ErrorRed::Conexion(_)) => Respuesta::Red,
        }
    }
}

/// Lee `chat.json`. Una config guardada que no sirve se ignora (con copia y aviso); un host propio que todavía no se
/// avisó se avisa una vez y se marca.
fn cargar_guardado(archivo: &std::path::Path, entorno: &dyn EntornoPrincipal) -> Guardado {
    let validar = |v: &Value| v.as_object().map(|_| v.clone());
    let por_defecto = || json!({});
    let crudo = leer_json(archivo, &OpcionesLectura::nuevas(&validar, &por_defecto), crate::avisos::Avisos::global()).valor;
    let mut out = Guardado::default();
    if let Some(c) = crudo.get("config") {
        match parsear_config_servidor(c) {
            Ok(cfg) => out.config = Some(cfg),
            Err(e) => {
                // Se ignora, pero el próximo guardado reescribe chat.json sin ella: antes queda una copia.
                match respaldar(archivo) {
                    Ok(b) => entorno.avisar(&format!("La configuración guardada del chat no es válida ({e}) y no se usa. Quedó una copia en {}.", b.display())),
                    Err(eb) => entorno.log(&format!("chat: la configuración guardada no es válida y no se pudo respaldar: {eb}")),
                }
            }
        }
    }
    if let Some(a) = crudo.get("accepted").and_then(Value::as_object) {
        let t = |k: &str| a.get(k).and_then(Value::as_str).map(String::from);
        if let (Some(repo), Some(supabase_url), Some(key_hash)) = (t("repo"), t("supabaseUrl"), t("keyHash")) {
            out.aceptada = Some(Aceptada { repo, supabase_url, key_hash });
        }
    }
    let propio = out.config.as_ref().and_then(|c| host_no_supabase(&c.supabase_url));
    if let Some(h) = propio {
        let ya_avisado = crudo.get("avisadoHost").and_then(Value::as_str) == Some(h.as_str());
        out.avisado_host = Some(h.clone());
        if !ya_avisado {
            // Una config guardada antes de que Sloth avisara los servidores propios: se avisa una vez y se marca.
            let marcar = || -> std::io::Result<()> {
                respaldar(archivo)?;
                escribir_json_atomico(archivo, &out.a_json()).map(|_| ())
            };
            if let Err(e) = marcar() {
                entorno.log(&format!("chat: no se pudo marcar el aviso del servidor propio: {e}"));
            }
            entorno.avisar(&format!("El chat usa {h}, que no es un proyecto de Supabase (supabase.co). Tu sesión de GitHub y lo que escribas en el chat pasan por ese servidor. Si no lo reconocés, borralo en Configuración › Chat."));
        }
    }
    out
}

#[cfg(test)]
#[path = "principal_pruebas.rs"]
mod tests;
