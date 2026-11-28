//! Datos del chat: equipos, DMs, mensajes, no leídos, realtime, fotos y avisos. Equivale a chat-data.ts.
//!
//! Reglas: todo Supabase corre en el proceso main; una sola conexión Realtime mientras hay sesión y ventana, con el
//! canal «sloth-inbox» (postgres_changes, respaldo) y uno privado de Broadcast por conversación (entrega rápida; si la
//! migración 0003 no está, esa conversación sigue solo con «sloth-inbox»). Las listas se refrescan al arrancar, al
//! reconectar y al enfocar la ventana (mínimo 30 s entre refrescos). Nunca se loguea el cuerpo de un mensaje ni un token.
//!
//! Sin hilos propios más que los de apoyo: el que consume los eventos de Realtime, los avisos de «leído» diferidos y la
//! purga horaria del borrado automático. Ningún candado se sostiene durante una llamada de red.
use super::fotos::{decodificar_foto_del_equipo, CacheDeFotos, Foto};
use super::fotos_red::{bajar_foto, borrar_foto, subir_foto};
use super::mapa::*;
use super::postgrest::{comprobar, falta_esquema, Consulta, ErrorPg, ResPg, Supabase};
use super::realtime::{Canal, EstadoCanal, EventoRealtime};
use super::texto::{contiene_texto, escapar_like, menciona_a, parsear_retencion, puede_gestionar};
use super::tipos::*;
use super::topicos::*;
use super::{cortar_utf16, Res};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

const REFRESH_MIN_MS: i64 = 30_000;
const NOTIFY_MIN_MS: i64 = 5_000;
const MENTION_MIN_MS: i64 = 2_000;
const READ_MIN_MS: i64 = 2_000;
const PROFILE_CACHE_MAX: usize = 500;
const PHOTO_CACHE_MAX: usize = 50;
const UNREAD_CAP: u32 = 99;
const NOTICE_CHARS: usize = 120;
const PURGE_EVERY_MS: u64 = 3_600_000;
const EXTRAS_RETRY_MS: u64 = 30_000;
const REPLY_GONE: &str = "Solo podés responder a un mensaje de esta conversación.";
const SIN_SESION: &str = "Iniciá sesión en el chat.";
const INBOX: &str = "sloth-inbox";

/// Lo que `chat` (config y login) le da a la parte de datos.
pub trait Nucleo: Send + Sync {
    /// Cliente de Supabase CON sesión iniciada, o `None`.
    fn cliente(&self) -> Option<Arc<Supabase>>;
    fn me(&self) -> Option<ChatProfile>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AjustesAviso {
    pub notificar_equipo: bool,
    pub no_molestar: bool,
}

/// Lo que la parte de datos necesita del resto de la app (la UI, el SO, los ajustes).
pub trait Entorno: Send + Sync {
    fn emitir(&self, canal: &str, payload: Value);
    fn log(&self, msg: &str);
    /// El estado cambió: hay que mandarle un snapshot nuevo a la UI.
    fn al_cambiar(&self);
    fn ventana_con_foco(&self) -> bool;
    fn ventana_abierta(&self) -> bool;
    fn ajustes(&self) -> AjustesAviso;
    /// Aviso del sistema; al hacer clic se abre `conv`.
    fn notificar(&self, titulo: &str, cuerpo: &str, conv: &ChatConvRef);
    fn ahora_ms(&self) -> i64;
}

/// Los canales de Realtime, para poder probar sin socket.
pub trait Canales: Send + Sync {
    fn unir(&self, c: Canal);
    fn salir(&self, nombre: &str);
    fn renovar_token(&self);
    fn cerrar(&self);
}

impl Canales for super::realtime::Realtime {
    fn unir(&self, c: Canal) {
        super::realtime::Realtime::unir(self, c)
    }
    fn salir(&self, nombre: &str) {
        super::realtime::Realtime::salir(self, nombre)
    }
    fn renovar_token(&self) {
        super::realtime::Realtime::renovar_token(self)
    }
    fn cerrar(&self) {
        super::realtime::Realtime::cerrar(self)
    }
}

pub type Fabrica = Arc<dyn Fn(&Supabase) -> (Arc<dyn Canales>, Receiver<EventoRealtime>) + Send + Sync>;

/// La fábrica de producción: un socket a `<url>/realtime/v1/websocket` con el JWT que dé `token`.
pub fn fabrica_realtime(token: Arc<dyn Fn() -> Option<String> + Send + Sync>) -> Fabrica {
    Arc::new(move |sb: &Supabase| {
        let url = super::realtime::url_websocket(sb.url(), sb.anon_key()).unwrap_or_default();
        let (rt, rx) = super::realtime::Realtime::conectar(super::realtime::ConfigRealtime::nueva(url), token.clone());
        (Arc::new(rt) as Arc<dyn Canales>, rx)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conexion {
    Off,
    Connecting,
    Live,
    Retrying,
}

impl Conexion {
    fn como_str(self) -> &'static str {
        match self {
            Conexion::Off => "off",
            Conexion::Connecting => "connecting",
            Conexion::Live => "live",
            Conexion::Retrying => "retrying",
        }
    }
}

#[derive(Default, Clone)]
struct Listas {
    teams: Vec<ChatTeam>,
    threads: Vec<ChatThread>,
    invites: Vec<ChatInvite>,
}

struct CachePerfiles {
    mapa: HashMap<String, ChatProfile>,
    orden: VecDeque<String>,
}

impl CachePerfiles {
    fn nueva() -> Self {
        CachePerfiles { mapa: HashMap::new(), orden: VecDeque::new() }
    }

    fn poner(&mut self, p: ChatProfile) {
        self.orden.retain(|i| *i != p.id);
        self.orden.push_back(p.id.clone());
        self.mapa.insert(p.id.clone(), p);
        while self.mapa.len() > PROFILE_CACHE_MAX {
            match self.orden.pop_front() {
                Some(v) => {
                    self.mapa.remove(&v);
                }
                None => break,
            }
        }
    }

    fn vaciar(&mut self) {
        self.mapa.clear();
        self.orden.clear();
    }
}

struct Estado {
    gen: u64,
    running: bool,
    conexion: Conexion,
    listas: Listas,
    listas_cargadas: bool,
    vista: ChatView,
    suscripto_una_vez: bool,
    ultimo_refresco: Option<i64>,
    perfiles: CachePerfiles,
    ruta_foto: HashMap<String, String>,
    fotos: CacheDeFotos,
    foto_cargando: HashSet<String>,
    foto_fallida: HashSet<String>,
    ultimo_aviso: HashMap<String, i64>,
    vistos: IdsVistos,
    topicos: HashSet<String>,
    topicos_fallidos: HashSet<String>,
    broadcast_avisado: bool,
    extras: bool,
    via_col: bool,
    limites_codigo: bool,
    dm_vaciar_para_mi: bool,
    escribiendo: Limitador,
    lectura: LimitadorConCola,
    canales: Option<Arc<dyn Canales>>,
    parar_purga: Option<Sender<()>>,
}

impl Estado {
    fn nuevo() -> Self {
        Estado {
            gen: 0,
            running: false,
            conexion: Conexion::Off,
            listas: Listas::default(),
            listas_cargadas: false,
            vista: ChatView::Cerrado,
            suscripto_una_vez: false,
            ultimo_refresco: None,
            perfiles: CachePerfiles::nueva(),
            ruta_foto: HashMap::new(),
            fotos: CacheDeFotos::nueva(PHOTO_CACHE_MAX),
            foto_cargando: HashSet::new(),
            foto_fallida: HashSet::new(),
            ultimo_aviso: HashMap::new(),
            vistos: IdsVistos::default(),
            topicos: HashSet::new(),
            topicos_fallidos: HashSet::new(),
            broadcast_avisado: false,
            extras: false,
            via_col: false,
            limites_codigo: false,
            dm_vaciar_para_mi: false,
            escribiendo: Limitador::default(),
            lectura: LimitadorConCola::nuevo(READ_MIN_MS),
            canales: None,
            parar_purga: None,
        }
    }

    /// Lo que vuelve a cero al parar: todo menos la generación, que solo sube.
    fn reiniciar(&mut self) {
        let gen = self.gen;
        *self = Estado::nuevo();
        self.gen = gen;
    }
}

struct Inner {
    nucleo: Arc<dyn Nucleo>,
    entorno: Arc<dyn Entorno>,
    fabrica: Fabrica,
    estado: Mutex<Estado>,
    /// Los refrescos de listas van de a uno.
    refresco: Mutex<()>,
}

fn bloquear<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn s(v: Option<&Value>) -> &str {
    texto(v)
}

fn unicos(v: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut vistos = HashSet::new();
    v.into_iter().filter(|x| !x.is_empty() && vistos.insert(x.clone())).collect()
}

fn fila_de(v: &Value) -> Option<FilaMensaje> {
    v.as_object().cloned()
}

fn es_fila(raw: &Value) -> bool {
    raw.as_object().is_some_and(|o| ["id", "author_id", "body"].iter().all(|k| o.get(*k).is_some_and(Value::is_string)))
}

fn col_de(conv: &ChatConvRef) -> &'static str {
    if conv.kind == TipoConv::Team {
        "team_id"
    } else {
        "thread_id"
    }
}

fn arg_de(conv: &ChatConvRef) -> Value {
    if conv.kind == TipoConv::Team {
        json!({"p_team": conv.id})
    } else {
        json!({"p_thread": conv.id})
    }
}

fn msj(e: &ErrorPg) -> Option<&str> {
    e.message.as_deref().filter(|m| !m.is_empty())
}

pub struct ChatDatos {
    i: Arc<Inner>,
}

impl ChatDatos {
    pub fn nuevo(nucleo: Arc<dyn Nucleo>, entorno: Arc<dyn Entorno>, fabrica: Fabrica) -> Self {
        ChatDatos { i: Arc::new(Inner { nucleo, entorno, fabrica, estado: Mutex::new(Estado::nuevo()), refresco: Mutex::new(()) }) }
    }

    /// Estado actual para armar el snapshot de la UI (el main le suma `auth`).
    pub fn parte(&self) -> Value {
        self.i.parte()
    }

    /// Al quedar con sesión y ventana: carga las listas y abre UNA conexión realtime. Bloquea hasta la primera carga.
    pub fn arrancar(&self) {
        Inner::arrancar(&self.i)
    }

    /// Al cerrar sesión, cambiar de config o cerrarse la ventana: cierra realtime y vacía las cachés en memoria.
    pub fn parar(&self) {
        self.i.parar()
    }

    /// El foco volvió a la ventana: refresca (con piso de 30 s) y marca leído lo que se está mirando.
    pub fn ventana_enfocada(&self) {
        Inner::ventana_enfocada(&self.i)
    }

    pub fn poner_vista(&self, raw: &Value) -> Res<()> {
        let v = parsear_vista(raw)?;
        let enfocada = self.i.entorno.ventana_con_foco();
        let marcar = match &v {
            ChatView::Abierto(Some(c)) if enfocada && self.i.no_leidos(c) > 0 => Some(c.clone()),
            _ => None,
        };
        bloquear(&self.i.estado).vista = v;
        if let Some(c) = marcar {
            Inner::marcar_leido_callado(&self.i, &c);
        }
        Ok(())
    }

    pub fn conversaciones(&self) -> Res<Vec<super::mcp_core::ConvCandidata>> {
        use super::mcp_core::{ConvCandidata, TipoCandidata};
        let e = bloquear(&self.i.estado);
        if !e.listas_cargadas {
            return Err("Abrí el chat de Sloth para cargar las conversaciones.".into());
        }
        let equipos = e.listas.teams.iter().map(|t| ConvCandidata { conv: ChatConvRef::equipo(&t.id), nombre: t.name.clone(), tipo: TipoCandidata::Equipo });
        let directos = e.listas.threads.iter().map(|t| ConvCandidata { conv: ChatConvRef::directo(&t.id), nombre: t.other.login.clone(), tipo: TipoCandidata::Directo });
        Ok(equipos.chain(directos).collect())
    }

    pub fn leer_ultimos(&self, conv: &ChatConvRef, n: u32) -> Res<Vec<ChatMessage>> {
        self.i.leer_mensajes(conv, None, n)
    }

    pub fn enviar_via_claude(&self, conv: &ChatConvRef, texto: &str, client_id: &str) -> Res<ChatMessage> {
        self.i.enviar_mensaje(conv, texto, client_id, None, true)
    }

    /// El servidor tiene la 0005 (columna `via`).
    pub fn columna_via(&self) -> bool {
        bloquear(&self.i.estado).via_col
    }

    pub fn entrar_por_codigo(&self, raw: &Value) -> Res<ChatTeam> {
        self.i.entrar_por_codigo(raw)
    }

    // ---------- canales IPC ----------

    pub fn mensajes(&self, conv: &Value, antes: Option<&Value>, limite: Option<&Value>) -> Res<Value> {
        let conv = parsear_conv(conv)?;
        let limite = parsear_limite(limite)?;
        let antes = match antes {
            None | Some(Value::Null) => None,
            Some(v) => Some(parsear_uuid(v, "Mensaje inválido.")?),
        };
        Ok(json!(self.i.leer_mensajes(&conv, antes.as_deref(), limite)?))
    }

    pub fn enviar(&self, conv: &Value, cuerpo: &Value, client_id: &Value, responde_a: Option<&Value>) -> Res<Value> {
        let (conv, cuerpo, cid, resp) = (parsear_conv(conv)?, parsear_cuerpo(cuerpo)?, parsear_client_id(client_id)?, parsear_uuid_opcional(responde_a)?);
        Ok(json!(self.i.enviar_mensaje(&conv, &cuerpo, &cid, resp.as_deref(), false)?))
    }

    pub fn editar(&self, conv: &Value, id: &Value, cuerpo: &Value) -> Res<Value> {
        self.i.exigir_extras("Para editar")?;
        let cuerpo = parsear_cuerpo(cuerpo)?;
        Ok(json!(self.i.cambiar_propio(conv, id, json!({"body": cuerpo}), "No podés editar ese mensaje.")?))
    }

    pub fn borrar(&self, conv: &Value, id: &Value) -> Res<Value> {
        self.i.exigir_extras("Para borrar")?;
        let ahora = super::fecha::iso_de_ms(self.i.entorno.ahora_ms());
        Ok(json!(self.i.cambiar_propio(conv, id, json!({"deleted_at": ahora}), "No podés borrar ese mensaje.")?))
    }

    pub fn reaccionar(&self, conv: &Value, id: &Value, emoji: &Value, activar: &Value) -> Res<()> {
        self.i.exigir_extras("Para reaccionar")?;
        let (c, me) = (self.i.cliente()?, self.i.yo()?);
        parsear_conv(conv)?;
        let mensaje = parsear_uuid(id, "Mensaje inválido.")?;
        let emoji = parsear_emoji(emoji)?;
        let Some(activar) = activar.as_bool() else { return Err("Reacción inválida.".into()) };
        let r = if activar {
            c.ejecutar(&Consulta::insert("message_reactions", json!({"message_id": mensaje, "emoji": emoji})))
        } else {
            c.ejecutar(&Consulta::delete("message_reactions").eq("message_id", &mensaje).eq("user_id", &me.id).eq("emoji", emoji))
        };
        match r.error.as_ref().map(ErrorPg::codigo) {
            Some("23505") => return Ok(()),
            Some("42501") => return Err("No podés reaccionar a ese mensaje.".into()),
            _ => {}
        }
        comprobar(&r, "No se pudo guardar la reacción.")
    }

    pub fn buscar(&self, conv: &Value, consulta: &Value) -> Res<Value> {
        let c = self.i.cliente()?;
        let conv = parsear_conv(conv)?;
        let q = parsear_busqueda(consulta)?;
        let extras = bloquear(&self.i.estado).extras;
        let mut cons = Consulta::select("messages", &self.i.columnas()).eq(col_de(&conv), &conv.id).ilike("body", &format!("%{}%", escapar_like(&q)));
        if extras {
            cons = cons.es_nulo("deleted_at").eq("kind", "text");
        }
        let r = c.ejecutar(&cons.orden_desc("created_at").limite(50));
        comprobar(&r, "No se pudo buscar.")?;
        let todas: Vec<FilaMensaje> = r.filas().iter().filter_map(fila_de).collect();
        // Con `*` PostgREST convierte todo en comodín: el resultado se filtra de nuevo con el texto exacto.
        let filas: Vec<FilaMensaje> = if q.contains('*') { todas.into_iter().filter(|f| contiene_texto(s(f.get("body")), &q)).collect() } else { todas };
        self.i.cargar_perfiles(&c, filas.iter().map(|f| s(f.get("author_id")).to_string()).collect());
        let msgs: Vec<ChatMessage> = filas.iter().filter_map(|f| mensaje_de_fila(f, self.i.perfil(s(f.get("author_id"))), EstadoMensaje::Sent)).collect();
        Ok(json!(self.i.enriquecer(&c, &filas, msgs, true)))
    }

    pub fn escribiendo(&self, conv: &Value) -> Res<()> {
        if !bloquear(&self.i.estado).extras {
            return Ok(());
        }
        let c = self.i.cliente()?;
        let conv = parsear_conv(conv)?;
        let ahora = self.i.entorno.ahora_ms();
        if !bloquear(&self.i.estado).escribiendo.pasa(&conv_key(&conv), ahora) {
            return Ok(());
        }
        if c.rpc("chat_typing", &arg_de(&conv)).error.is_some() {
            self.i.entorno.log("chat: no se pudo avisar que estás escribiendo.");
        }
        Ok(())
    }

    pub fn vaciar(&self, conv: &Value, para_mi: &Value) -> Res<()> {
        self.i.exigir_extras("Para vaciar")?;
        let c = self.i.cliente()?;
        let conv = parsear_conv(conv)?;
        let (rol, dm_para_mi) = {
            let e = bloquear(&self.i.estado);
            (e.listas.teams.iter().find(|t| conv.kind == TipoConv::Team && t.id == conv.id).map(|t| t.role), e.dm_vaciar_para_mi)
        };
        if !puede_gestionar(conv.kind, rol) {
            return Err("Solo owner o admin pueden vaciar la conversación del equipo.".into());
        }
        // Lo que confirmó la persona tiene que coincidir con lo que va a hacer el servidor: sin la 0008, vaciar un DM lo
        // borra para los dos.
        if conv.kind == TipoConv::Dm && para_mi.as_bool() != Some(dm_para_mi) {
            return Err("Cambió lo que hace el servidor al vaciar: cerrá este aviso y volvé a intentarlo.".into());
        }
        comprobar(&c.rpc("chat_clear", &arg_de(&conv)), "No se pudo vaciar la conversación.")
    }

    pub fn poner_retencion(&self, equipo: &Value, horas: &Value) -> Res<ChatTeam> {
        self.i.exigir_extras("Para el borrado automático")?;
        let c = self.i.cliente()?;
        let id = parsear_uuid(equipo, "Equipo inválido.")?;
        let horas = parsear_retencion(horas)?;
        comprobar(&c.rpc("chat_set_retention", &json!({"p_team": id, "p_hours": horas})), "No se pudo cambiar el borrado automático.")?;
        self.i.refrescar_listas(true);
        self.i.purgar_vencidos(&c);
        self.i.equipo_ahora(&id)
    }

    pub fn marcar_leido(&self, conv: &Value) -> Res<()> {
        self.i.cliente()?;
        self.i.marcar_leido_remoto(&parsear_conv(conv)?)
    }

    pub fn crear_equipo(&self, raw: &Value) -> Res<ChatTeam> {
        let c = self.i.cliente()?;
        let f = parsear_campos_equipo(raw, ModoEquipo::Crear)?;
        let foto = match &f.photo_base64 {
            Some(Some(b)) => Some(decodificar_foto_del_equipo(b)?),
            _ => None,
        };
        let r = c.rpc("create_team", &json!({"p_name": f.name.clone().unwrap_or_default(), "p_description": f.description.clone().unwrap_or_default()}));
        comprobar(&r, "No se pudo crear el equipo.")?;
        let id = r.data.as_str().filter(|x| !x.is_empty()).ok_or("No se pudo crear el equipo.")?.to_string();
        let error_foto = foto.and_then(|f| self.i.aplicar_foto(&c, &id, Some(&f)).err());
        self.i.refrescar_listas(true);
        if let Some(e) = error_foto {
            return Err(format!("El equipo se creó, pero la foto no se guardó: {e}"));
        }
        self.i.equipo_ahora(&id)
    }

    pub fn actualizar_equipo(&self, id: &Value, raw: &Value) -> Res<ChatTeam> {
        let c = self.i.cliente()?;
        let id = parsear_uuid(id, "Equipo inválido.")?;
        let f = parsear_campos_equipo(raw, ModoEquipo::Editar)?;
        // Primero se valida la foto (sin tocar nada), después el texto y al final la foto.
        let foto: Option<Option<Foto>> = match &f.photo_base64 {
            None => None,
            Some(None) => Some(None),
            Some(Some(b)) => Some(Some(decodificar_foto_del_equipo(b)?)),
        };
        let mut cambios = Map::new();
        if let Some(n) = &f.name {
            cambios.insert("name".into(), json!(n));
        }
        if let Some(d) = &f.description {
            cambios.insert("description".into(), json!(d));
        }
        if !cambios.is_empty() {
            let r = c.ejecutar(&Consulta::update("teams", Value::Object(cambios)).eq("id", &id).columnas("id"));
            comprobar(&r, "No podés editar este equipo.")?;
            if r.filas().is_empty() {
                return Err("No podés editar este equipo.".into());
            }
        }
        if let Some(f) = foto {
            self.i.aplicar_foto(&c, &id, f.as_ref())?;
        }
        self.i.refrescar_listas(true);
        self.i.equipo_ahora(&id)
    }

    pub fn miembros(&self, equipo: &Value) -> Res<Value> {
        let c = self.i.cliente()?;
        let id = parsear_uuid(equipo, "Equipo inválido.")?;
        let r = c.ejecutar(&Consulta::select("team_members", "user_id, role, joined_at").eq("team_id", &id));
        comprobar(&r, "No se pudo leer los miembros.")?;
        self.i.cargar_perfiles(&c, r.filas().iter().map(|f| s(f.get("user_id")).to_string()).collect());
        let mut out: Vec<ChatMember> = r.filas().iter().filter_map(|f| miembro_de_fila(f, self.i.perfil(s(f.get("user_id"))))).collect();
        out.sort_by(comparar_miembros);
        Ok(json!(out))
    }

    pub fn invitar_por_login(&self, equipo: &Value, login: &Value) -> Res<Value> {
        let c = self.i.cliente()?;
        let id = parsear_uuid(equipo, "Equipo inválido.")?;
        let login = parsear_login(login)?;
        let r = c.ejecutar(&Consulta::insert("team_invites", json!({"team_id": id, "github_login_lower": login})).columnas("id, github_login_lower"));
        match r.error.as_ref().map(ErrorPg::codigo) {
            Some("23505") => return Err("Ya invitaste a esa persona.".into()),
            Some("42501") => return Err("Solo owner o admin pueden invitar.".into()),
            _ => {}
        }
        comprobar(&r, "No se pudo invitar.")?;
        let inv = r.primera().map(|f| s(f.get("id")).to_string()).filter(|x| !x.is_empty()).ok_or("No se pudo invitar.")?;
        Ok(json!({"id": inv, "githubLogin": login}))
    }

    pub fn regenerar_codigo(&self, equipo: &Value) -> Res<String> {
        let c = self.i.cliente()?;
        let id = parsear_uuid(equipo, "Equipo inválido.")?;
        let r = c.rpc("regenerate_invite_code", &json!({"p_team": id}));
        comprobar(&r, "No se pudo cambiar el código.")?;
        let codigo = r.data.as_str().filter(|x| x.len() == 16 && x.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).ok_or("No se pudo cambiar el código.")?.to_string();
        let i = self.i.clone();
        std::thread::spawn(move || i.refrescar_listas(true));
        Ok(codigo)
    }

    pub fn aceptar_invitacion(&self, invitacion: &Value) -> Res<ChatTeam> {
        let c = self.i.cliente()?;
        let id = parsear_uuid(invitacion, "Invitación inválida.")?;
        let r = c.rpc("accept_invite", &json!({"p_invite": id}));
        comprobar(&r, "No se pudo aceptar la invitación.")?;
        let equipo = r.data.as_str().filter(|x| !x.is_empty()).ok_or("No se pudo aceptar la invitación.")?.to_string();
        self.i.refrescar_listas(true);
        self.i.equipo_ahora(&equipo)
    }

    pub fn rechazar_invitacion(&self, invitacion: &Value) -> Res<()> {
        let c = self.i.cliente()?;
        let id = parsear_uuid(invitacion, "Invitación inválida.")?;
        let r = c.ejecutar(&Consulta::delete("team_invites").eq("id", &id).columnas("id"));
        comprobar(&r, "No se pudo rechazar la invitación.")?;
        if r.filas().is_empty() {
            return Err("Esa invitación ya no existe.".into());
        }
        self.i.refrescar_listas(true);
        Ok(())
    }

    pub fn salir_del_equipo(&self, equipo: &Value) -> Res<()> {
        let c = self.i.cliente()?;
        let me = self.i.yo()?;
        let id = parsear_uuid(equipo, "Equipo inválido.")?;
        if bloquear(&self.i.estado).listas.teams.iter().find(|t| t.id == id).map(|t| t.role) == Some(ChatRole::Owner) {
            return Err("El owner no puede salir del equipo.".into());
        }
        let r = c.ejecutar(&Consulta::delete("team_members").eq("team_id", &id).eq("user_id", &me.id).columnas("user_id"));
        comprobar(&r, "No se pudo salir del equipo.")?;
        if r.filas().is_empty() {
            return Err("El owner no puede salir del equipo.".into());
        }
        self.i.refrescar_listas(true);
        Ok(())
    }

    /// `remove_member` (0007) saca a la persona y cambia el código en una sola transacción. Sin la 0007, en dos pasos.
    pub fn sacar_miembro(&self, equipo: &Value, usuario: &Value) -> Res<ChatRemoveResult> {
        use super::expulsar::{falta_la_funcion, resultado_de_expulsar};
        let c = self.i.cliente()?;
        let me = self.i.yo()?;
        let id = parsear_uuid(equipo, "Equipo inválido.")?;
        let usuario = parsear_uuid(usuario, "Persona inválida.")?;
        if usuario == me.id {
            return Err("Para salir usá «Salir del equipo».".into());
        }
        let rpc = c.rpc("remove_member", &json!({"p_team": id, "p_user": usuario}));
        if !falta_la_funcion(rpc.error.as_ref().and_then(|e| e.code.as_deref())) {
            comprobar(&rpc, "No podés sacar a esa persona.")?;
            self.i.refrescar_listas(true);
            return Ok(resultado_de_expulsar(true, true));
        }
        self.i.entorno.log("chat: el servidor no tiene remove_member (falta la migración 0007).");
        let r = c.ejecutar(&Consulta::delete("team_members").eq("team_id", &id).eq("user_id", &usuario).eq("role", "member").columnas("user_id"));
        comprobar(&r, "No podés sacar a esa persona.")?;
        if r.filas().is_empty() {
            return Err("No podés sacar a esa persona.".into());
        }
        // Con el código de antes, quien salió vuelve a entrar con la misma invitación: se cambia en el mismo paso.
        let codigo = c.rpc("regenerate_invite_code", &json!({"p_team": id}));
        if let Some(e) = &codigo.error {
            self.i.entorno.log(&format!("chat: no se pudo cambiar el código después de expulsar: {}", e.message.as_deref().or(e.code.as_deref()).unwrap_or("")));
        }
        self.i.refrescar_listas(true);
        Ok(resultado_de_expulsar(false, codigo.error.is_none()))
    }

    pub fn abrir_directo(&self, usuario: &Value) -> Res<ChatThread> {
        let c = self.i.cliente()?;
        let me = self.i.yo()?;
        let usuario = parsear_uuid(usuario, "Persona inválida.")?;
        if usuario == me.id {
            return Err("Elegí a otra persona.".into());
        }
        let r = c.rpc("open_dm", &json!({"p_other": usuario}));
        comprobar(&r, "No se pudo abrir el mensaje directo.")?;
        let id = r.data.as_str().filter(|x| !x.is_empty()).ok_or("No se pudo abrir el mensaje directo.")?.to_string();
        self.i.refrescar_listas(true);
        bloquear(&self.i.estado).listas.threads.iter().find(|t| t.id == id).cloned().ok_or_else(|| "No se pudo abrir el mensaje directo.".to_string())
    }

    #[cfg(test)]
    fn interno(&self) -> &Arc<Inner> {
        &self.i
    }
}

impl Inner {
    fn cliente(&self) -> Res<Arc<Supabase>> {
        self.nucleo.cliente().ok_or_else(|| SIN_SESION.to_string())
    }

    fn yo(&self) -> Res<ChatProfile> {
        self.nucleo.me().ok_or_else(|| SIN_SESION.to_string())
    }

    fn exigir_extras(&self, que: &str) -> Res<()> {
        if bloquear(&self.estado).extras {
            Ok(())
        } else {
            Err(format!("{que}, el servidor del chat necesita la actualización 0004."))
        }
    }

    fn columnas(&self) -> String {
        let e = bloquear(&self.estado);
        format!("{}{}", if e.extras { MSG_COLS_EXTRAS } else { MSG_COLS_BASE }, if e.via_col { ", via" } else { "" })
    }

    fn vigente(&self, g: u64) -> bool {
        bloquear(&self.estado).gen == g
    }

    // ---------- perfiles ----------

    fn perfil(&self, id: &str) -> ChatProfile {
        bloquear(&self.estado).perfiles.mapa.get(id).cloned().unwrap_or_else(|| perfil_ex_miembro(id))
    }

    fn guardar_perfil(&self, p: ChatProfile) {
        bloquear(&self.estado).perfiles.poner(p);
    }

    /// Carga en caché los perfiles que falten. Si falla, quedan como «ex-miembro»: no es fatal.
    fn cargar_perfiles(&self, c: &Supabase, ids: Vec<String>) {
        let faltan = {
            let e = bloquear(&self.estado);
            unicos(ids.into_iter().filter(|id| !e.perfiles.mapa.contains_key(id)))
        };
        if faltan.is_empty() {
            return;
        }
        let r = c.ejecutar(&Consulta::select("profiles", "id, login, name, avatar_url").en("id", &faltan));
        if r.error.is_some() {
            return;
        }
        for f in r.filas() {
            if let Some(p) = perfil_de_fila(f) {
                self.guardar_perfil(p);
            }
        }
    }

    // ---------- detección de migraciones ----------

    fn detectar_extras(&self, c: &Supabase) -> Res<()> {
        let a = c.ejecutar(&Consulta::select("messages", "id, edited_at, deleted_at, reply_to, kind").limite(1));
        let b = c.ejecutar(&Consulta::select("message_reactions", "message_id").limite(1));
        let t = c.ejecutar(&Consulta::select("teams", "id, retention_hours").limite(1));
        let errores: Vec<&ErrorPg> = [&a, &b, &t].into_iter().filter_map(|r| r.error.as_ref()).collect();
        // Solo «no existe la columna o la tabla» dice que falta la 0004; un corte o un 5xx no cambia nada.
        if errores.iter().any(|e| !falta_esquema(e.codigo())) {
            let codigos: Vec<&str> = errores.iter().map(|e| if e.codigo().is_empty() { "?" } else { e.codigo() }).collect();
            return Err(format!("chat: no se pudo comprobar la 0004 ({})", codigos.join(", ")));
        }
        let nuevo = errores.is_empty();
        let cambio = {
            let mut e = bloquear(&self.estado);
            let cambio = e.extras != nuevo;
            e.extras = nuevo;
            cambio
        };
        if cambio {
            self.entorno.al_cambiar();
        }
        Ok(())
    }

    fn detectar_via(&self, c: &Supabase) {
        let r = c.ejecutar(&Consulta::select("messages", "via").limite(1));
        if let Some(e) = &r.error {
            if !falta_esquema(e.codigo()) {
                self.entorno.log(&format!("chat: no se pudo comprobar la actualización 0005: {}", if e.codigo().is_empty() { "?" } else { e.codigo() }));
                return;
            }
        }
        let nuevo = r.error.is_none();
        let cambio = {
            let mut e = bloquear(&self.estado);
            let cambio = e.via_col != nuevo;
            e.via_col = nuevo;
            cambio
        };
        if cambio {
            self.entorno.al_cambiar();
        }
    }

    /// Las dos cosas vienen en la 0008, pero se miran por separado: cada una cambia algo distinto.
    fn detectar_limites_de_codigo(&self, c: &Supabase) {
        let codigos = c.ejecutar(&Consulta::select("team_invite_codes", "expires_at, uses_left").limite(1));
        let vaciado = c.ejecutar(&Consulta::select("dm_threads", "cleared_a").limite(0));
        let errores: Vec<&ErrorPg> = [&codigos, &vaciado].into_iter().filter_map(|r| r.error.as_ref()).collect();
        if errores.iter().any(|e| !falta_esquema(e.codigo())) {
            let cods: Vec<&str> = errores.iter().map(|e| if e.codigo().is_empty() { "?" } else { e.codigo() }).collect();
            self.entorno.log(&format!("chat: no se pudo comprobar la actualización 0008: {}", cods.join(", ")));
            return;
        }
        let (nc, nv) = (codigos.error.is_none(), vaciado.error.is_none());
        let cambio = {
            let mut e = bloquear(&self.estado);
            let cambio = e.limites_codigo != nc || e.dm_vaciar_para_mi != nv;
            e.limites_codigo = nc;
            e.dm_vaciar_para_mi = nv;
            cambio
        };
        if cambio {
            self.entorno.al_cambiar();
        }
    }

    /// Si el chequeo de la 0004 falla por la red, se queda con lo que sabía y reintenta más tarde.
    fn comprobar_extras(self: &Arc<Self>, c: &Supabase, g: u64) {
        if let Err(e) = self.detectar_extras(c) {
            self.entorno.log(&format!("chat: no se pudo comprobar la actualización 0004: {e}"));
            let i = self.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(EXTRAS_RETRY_MS));
                let live = { let e = bloquear(&i.estado); e.running && e.gen == g && e.conexion == Conexion::Live };
                let Some(cl) = i.nucleo.cliente().filter(|_| live) else { return };
                i.comprobar_extras(&cl, g);
                if i.vigente(g) {
                    i.refrescar_listas(true);
                }
            });
        }
    }

    // ---------- enriquecer mensajes ----------

    /// Suma reacciones (si `con_reacciones`) y el mensaje al que responde cada uno. Sin la 0004 no hace nada.
    fn enriquecer(&self, c: &Supabase, filas: &[FilaMensaje], msgs: Vec<ChatMessage>, con_reacciones: bool) -> Vec<ChatMessage> {
        if !bloquear(&self.estado).extras || msgs.is_empty() {
            return msgs;
        }
        let en_pagina: HashMap<&str, &FilaMensaje> = filas.iter().map(|f| (s(f.get("id")), f)).collect();
        let faltan = unicos(filas.iter().map(|f| s(f.get("reply_to")).to_string()).filter(|id| !en_pagina.contains_key(id.as_str())));
        let reacciones = if con_reacciones { Some(c.ejecutar(&Consulta::select("message_reactions", "message_id, user_id, emoji").en("message_id", &msgs.iter().map(|m| m.id.clone()).collect::<Vec<_>>()))) } else { None };
        let padres = if faltan.is_empty() { None } else { Some(c.ejecutar(&Consulta::select("messages", "id, author_id, body, deleted_at").en("id", &faltan))) };
        let filas_react: Vec<Value> = reacciones.filter(|r| r.error.is_none()).map(|r| r.filas().to_vec()).unwrap_or_default();
        let mut filas_padre: Vec<Value> = padres.filter(|r| r.error.is_none()).map(|r| r.filas().to_vec()).unwrap_or_default();
        for f in filas {
            if let Some(p) = en_pagina.get(s(f.get("reply_to"))) {
                filas_padre.push(Value::Object((*p).clone()));
            }
        }
        self.cargar_perfiles(c, filas_react.iter().map(|r| s(r.get("user_id")).to_string()).chain(filas_padre.iter().map(|r| s(r.get("author_id")).to_string())).collect());
        let por_mensaje = reacciones_por_mensaje(&filas_react, |id| self.perfil(id).login);
        let padre_de: HashMap<&str, &Value> = filas_padre.iter().map(|r| (s(r.get("id")), r)).collect();
        let responde: HashMap<&str, &str> = filas.iter().map(|f| (s(f.get("id")), s(f.get("reply_to")))).collect();
        msgs.into_iter()
            .map(|mut m| {
                if let Some(r) = por_mensaje.get(&m.id) {
                    m.reactions = Some(r.clone());
                }
                let padre = padre_de.get(responde.get(m.id.as_str()).copied().unwrap_or(""));
                if let Some(rf) = padre.and_then(|p| referencia_de_respuesta(p, &self.perfil(s(p.get("author_id"))).login)) {
                    m.reply_to = Some(rf);
                }
                m
            })
            .collect()
    }

    // ---------- fotos ----------

    fn con_foto(self: &Arc<Self>, mut t: ChatTeam) -> ChatTeam {
        let ruta = bloquear(&self.estado).ruta_foto.get(&t.id).cloned();
        let Some(ruta) = ruta else { return t };
        let url = bloquear(&self.estado).fotos.obtener(&ruta);
        match url {
            Some(u) => t.photo = Some(u),
            None => self.cargar_foto(&ruta),
        }
        t
    }

    fn cargar_foto(self: &Arc<Self>, ruta: &str) {
        let g = {
            let mut e = bloquear(&self.estado);
            if e.foto_cargando.contains(ruta) || e.foto_fallida.contains(ruta) || !e.running {
                return;
            }
            e.foto_cargando.insert(ruta.to_string());
            e.gen
        };
        let Some(c) = self.nucleo.cliente() else {
            bloquear(&self.estado).foto_cargando.remove(ruta);
            return;
        };
        let (i, ruta) = (self.clone(), ruta.to_string());
        std::thread::spawn(move || {
            let r = bajar_foto(&c, &ruta);
            {
                let mut e = bloquear(&i.estado);
                if e.gen == g {
                    match r {
                        Ok(u) => e.fotos.poner(&ruta, &u),
                        Err(_) => {
                            e.foto_fallida.insert(ruta.clone());
                        }
                    }
                }
                e.foto_cargando.remove(&ruta);
            }
            if i.vigente(g) {
                i.entorno.al_cambiar();
            }
        });
    }

    /// Sube (o quita, con `None`) la foto de un equipo: valida antes, borra la anterior después.
    fn aplicar_foto(&self, c: &Supabase, team_id: &str, foto: Option<&Foto>) -> Res<()> {
        let actual = c.ejecutar(&Consulta::select("teams", "photo_path").eq("id", team_id).limite(1));
        comprobar(&actual, "No se pudo leer la foto actual.")?;
        let vieja = actual.primera().map(|f| s(f.get("photo_path")).to_string()).unwrap_or_default();
        let nueva = match foto {
            Some(f) => Some(subir_foto(c, team_id, &uuid_nuevo()?, f)?),
            None => None,
        };
        let r = c.ejecutar(&Consulta::update("teams", json!({"photo_path": nueva})).eq("id", team_id).columnas("id"));
        if r.error.is_some() || r.filas().is_empty() {
            if let Some(n) = &nueva {
                borrar_foto(c, n);
            }
            return Err("No podés cambiar la foto de este equipo.".into());
        }
        if !vieja.is_empty() && Some(&vieja) != nueva.as_ref() {
            borrar_foto(c, &vieja);
        }
        Ok(())
    }

    // ---------- listas ----------

    fn cargar_listas(&self, c: &Supabase, me: &ChatProfile) -> Res<(Listas, HashMap<String, String>)> {
        let (extras, limites) = {
            let e = bloquear(&self.estado);
            (e.extras, e.limites_codigo)
        };
        let mem = c.ejecutar(&Consulta::select("team_members", "team_id, role").eq("user_id", &me.id));
        let inv = c.ejecutar(&Consulta::select("team_invites", "id, team_id, invited_by, created_at").eq("github_login_lower", &me.login.to_lowercase()));
        let thr = c.ejecutar(&Consulta::select("dm_threads", "id, user_a, user_b, last_read_a, last_read_b"));
        let unr = c.rpc("unread_counts", &json!({}));
        comprobar(&mem, "No se pudieron leer tus equipos.")?;
        comprobar(&inv, "No se pudieron leer las invitaciones.")?;
        comprobar(&thr, "No se pudieron leer los mensajes directos.")?;
        comprobar(&unr, "No se pudieron leer los no leídos.")?;

        let membresias = mem.filas();
        let ids_miembro = unicos(membresias.iter().map(|m| s(m.get("team_id")).to_string()));
        let ids_admin = unicos(membresias.iter().filter(|m| matches!(s(m.get("role")), "owner" | "admin")).map(|m| s(m.get("team_id")).to_string()));
        let ids_todos = unicos(ids_miembro.iter().cloned().chain(inv.filas().iter().map(|i| s(i.get("team_id")).to_string())));

        let vacio = ResPg { data: json!([]), error: None };
        let equipos = if ids_todos.is_empty() { vacio.clone() } else { c.ejecutar(&Consulta::select("teams", if extras { "id, name, description, photo_path, retention_hours" } else { "id, name, description, photo_path" }).en("id", &ids_todos)) };
        let cuentas = if ids_miembro.is_empty() { vacio.clone() } else { c.ejecutar(&Consulta::select("team_members", "team_id").en("team_id", &ids_miembro)) };
        let codigos = if ids_admin.is_empty() { vacio } else { c.ejecutar(&Consulta::select("team_invite_codes", if limites { "team_id, code, expires_at, uses_left" } else { "team_id, code" }).en("team_id", &ids_admin)) };
        comprobar(&equipos, "No se pudieron leer los equipos.")?;
        comprobar(&cuentas, "No se pudieron leer los miembros.")?;
        comprobar(&codigos, "No se pudieron leer los códigos.")?;

        let filas_equipo: HashMap<&str, &Value> = equipos.filas().iter().map(|r| (s(r.get("id")), r)).collect();
        let mut conteo: HashMap<&str, u32> = HashMap::new();
        for r in cuentas.filas() {
            *conteo.entry(s(r.get("team_id"))).or_default() += 1;
        }
        let mut codigo_de: HashMap<&str, &Value> = HashMap::new();
        for r in codigos.filas() {
            if r.get("code").is_some_and(Value::is_string) {
                codigo_de.insert(s(r.get("team_id")), r);
            }
        }
        let no_leidos = indice_de_no_leidos(unr.filas());
        let otros: Vec<String> = thr.filas().iter().filter_map(|t| otro_de(t, &me.id)).collect();
        self.cargar_perfiles(c, otros.into_iter().chain(inv.filas().iter().map(|i| s(i.get("invited_by")).to_string())).collect());

        let mut rutas = HashMap::new();
        let mut teams = Vec::new();
        for m in membresias {
            let id = s(m.get("team_id"));
            let (Some(fila), Some(rol)) = (filas_equipo.get(id), rol_de(m.get("role"))) else { continue };
            let u = no_leidos.get(&conv_key(&ChatConvRef::equipo(id))).cloned().unwrap_or_default();
            let cod = codigo_de.get(id);
            let info = InfoEquipo {
                role: rol,
                member_count: conteo.get(id).copied().unwrap_or(0),
                unread: u.unread,
                last_message_at: u.last_message_at,
                invite_code: cod.map(|r| s(r.get("code")).to_string()),
                invite_expires_at: cod.and_then(|r| a_ms(r.get("expires_at"))).map(|v| v as f64),
                invite_uses_left: cod.and_then(|r| r.get("uses_left")).and_then(Value::as_f64),
            };
            let Some(t) = equipo_de_fila(fila, &info) else { continue };
            teams.push(t);
            if let Some(p) = ruta_de_foto(fila) {
                rutas.insert(id.to_string(), p);
            }
        }
        ordenar_por_actividad(&mut teams, |t| t.last_message_at, |t| t.name.clone());

        let mut threads = Vec::new();
        for r in thr.filas() {
            let Some(otro) = otro_de(r, &me.id) else { continue };
            let u = no_leidos.get(&conv_key(&ChatConvRef::directo(s(r.get("id"))))).cloned().unwrap_or_default();
            let info = InfoHilo { unread: u.unread, last_message_at: u.last_message_at, other_read_at: lectura_del_otro(r, &me.id) };
            if let Some(t) = hilo_de_fila(r, self.perfil(&otro), &info) {
                threads.push(t);
            }
        }
        ordenar_por_actividad(&mut threads, |t| t.last_message_at, |t| t.other.login.clone());

        let mut invites = Vec::new();
        for i in inv.filas() {
            let Some(fila) = filas_equipo.get(s(i.get("team_id"))) else { continue };
            let invitador = bloquear(&self.estado).perfiles.mapa.get(s(i.get("invited_by"))).cloned();
            if let Some(v) = invitacion_de_fila(i, s(fila.get("name")), invitador) {
                invites.push(v);
            }
        }
        Ok((Listas { teams, threads, invites }, rutas))
    }

    /// Recarga las listas. Se serializa; sin `force`, se salta si hubo un refresco hace menos de 30 s.
    fn refrescar_listas(self: &Arc<Self>, forzar: bool) {
        let _fila = bloquear(&self.refresco);
        let g = bloquear(&self.estado).gen;
        let ahora = self.entorno.ahora_ms();
        {
            let e = bloquear(&self.estado);
            if e.gen != g || (!forzar && e.ultimo_refresco.is_some_and(|u| ahora - u < REFRESH_MIN_MS)) {
                return;
            }
        }
        let (Some(c), Some(me)) = (self.nucleo.cliente(), self.nucleo.me()) else { return };
        {
            let mut e = bloquear(&self.estado);
            e.ultimo_refresco = Some(ahora);
            e.perfiles.poner(me.clone());
        }
        let (listas, rutas) = match self.cargar_listas(&c, &me) {
            Ok(r) => r,
            Err(_) => return self.entorno.log("chat: no se pudieron cargar las listas."),
        };
        {
            let mut e = bloquear(&self.estado);
            if e.gen != g {
                return;
            }
            e.listas = listas;
            e.listas_cargadas = true;
            e.ruta_foto = rutas;
            e.foto_fallida.clear();
        }
        self.sincronizar_topicos(g);
        if let Some(cs) = bloquear(&self.estado).canales.clone() {
            cs.renovar_token();
        }
        self.entorno.al_cambiar();
    }

    fn equipo_ahora(self: &Arc<Self>, id: &str) -> Res<ChatTeam> {
        let t = bloquear(&self.estado).listas.teams.iter().find(|t| t.id == id).cloned().ok_or("No se pudo leer el equipo.")?;
        Ok(self.con_foto(t))
    }

    fn parte(self: &Arc<Self>) -> Value {
        let (teams, threads, invites, conexion, extras, dm, cargadas) = {
            let e = bloquear(&self.estado);
            (e.listas.teams.clone(), e.listas.threads.clone(), e.listas.invites.clone(), e.conexion, e.extras, e.dm_vaciar_para_mi, e.listas_cargadas)
        };
        let teams: Vec<ChatTeam> = teams.into_iter().map(|t| self.con_foto(t)).collect();
        let total: u32 = teams.iter().map(|t| t.unread).sum::<u32>() + threads.iter().map(|t| t.unread).sum::<u32>();
        json!({"connection": conexion.como_str(), "teams": teams, "threads": threads, "invites": invites, "unreadTotal": total, "extras": extras, "dmClearForMe": dm, "listsLoaded": cargadas})
    }

    // ---------- no leídos ----------

    fn no_leidos(&self, r: &ChatConvRef) -> u32 {
        let e = bloquear(&self.estado);
        match r.kind {
            TipoConv::Team => e.listas.teams.iter().find(|t| t.id == r.id).map(|t| t.unread),
            TipoConv::Dm => e.listas.threads.iter().find(|t| t.id == r.id).map(|t| t.unread),
        }
        .unwrap_or(0)
    }

    fn conocida(&self, r: &ChatConvRef) -> bool {
        let e = bloquear(&self.estado);
        match r.kind {
            TipoConv::Team => e.listas.teams.iter().any(|t| t.id == r.id),
            TipoConv::Dm => e.listas.threads.iter().any(|t| t.id == r.id),
        }
    }

    fn cambiar_no_leidos(&self, r: &ChatConvRef, f: impl Fn(u32) -> u32) {
        let mut e = bloquear(&self.estado);
        match r.kind {
            TipoConv::Team => e.listas.teams.iter_mut().filter(|t| t.id == r.id).for_each(|t| t.unread = f(t.unread)),
            TipoConv::Dm => e.listas.threads.iter_mut().filter(|t| t.id == r.id).for_each(|t| t.unread = f(t.unread)),
        }
    }

    /// Marca leído en el servidor (RPC) y pone el no leído local en 0.
    fn marcar_leido_remoto(&self, r: &ChatConvRef) -> Res<()> {
        let c = self.cliente()?;
        let args = if r.kind == TipoConv::Team { json!({"p_team": r.id}) } else { json!({"p_thread": r.id}) };
        comprobar(&c.rpc("mark_read", &args), "No se pudo marcar como leído.")?;
        self.cambiar_no_leidos(r, |_| 0);
        self.entorno.al_cambiar();
        Ok(())
    }

    /// Mirando una conversación activa llega un mark_read por mensaje: se juntan en uno cada READ_MIN_MS.
    fn marcar_leido_callado(self: &Arc<Self>, r: &ChatConvRef) {
        let clave = conv_key(r);
        let (turno, g) = {
            let mut e = bloquear(&self.estado);
            (e.lectura.pedir(&clave, self.entorno.ahora_ms()), e.gen)
        };
        let enviar = |i: &Inner, r: &ChatConvRef| {
            if i.marcar_leido_remoto(r).is_err() {
                i.entorno.log("chat: no se pudo marcar como leído.");
            }
        };
        match turno {
            Turno::Cubierto => {}
            Turno::Ahora => enviar(self, r),
            Turno::En(ms) => {
                let (i, r) = (self.clone(), r.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(ms.max(0) as u64));
                    let vivo = {
                        let mut e = bloquear(&i.estado);
                        e.lectura.disparado(&conv_key(&r), i.entorno.ahora_ms());
                        e.gen == g && e.running
                    };
                    if vivo {
                        enviar(&i, &r);
                    }
                });
            }
        }
    }

    // ---------- realtime ----------

    fn arrancar(this: &Arc<Self>) {
        let Some(c) = this.nucleo.cliente() else { return };
        let (g, canales, rx) = {
            let mut e = bloquear(&this.estado);
            if e.running {
                return;
            }
            e.running = true;
            e.gen += 1;
            e.conexion = Conexion::Connecting;
            e.suscripto_una_vez = false;
            let (canales, rx) = (this.fabrica)(&c);
            e.canales = Some(canales.clone());
            (e.gen, canales, rx)
        };
        let i = this.clone();
        std::thread::spawn(move || {
            for ev in rx {
                if !i.vigente(g) {
                    break;
                }
                i.procesar(g, ev);
            }
        });
        canales.unir(Canal::inbox());
        this.entorno.al_cambiar();
        this.comprobar_extras(&c, g);
        this.detectar_via(&c);
        this.detectar_limites_de_codigo(&c);
        this.refrescar_listas(true);
        if !this.vigente(g) {
            return;
        }
        this.purgar_vencidos(&c);
        let (parar, rx_parar) = channel::<()>();
        bloquear(&this.estado).parar_purga = Some(parar);
        let i = this.clone();
        std::thread::spawn(move || {
            while let Err(RecvTimeoutError::Timeout) = rx_parar.recv_timeout(Duration::from_millis(PURGE_EVERY_MS)) {
                match i.nucleo.cliente() {
                    Some(c) if i.vigente(g) => i.purgar_vencidos(&c),
                    _ => break,
                }
            }
        });
    }

    fn parar(&self) {
        let canales = {
            let mut e = bloquear(&self.estado);
            e.gen += 1;
            if let Some(p) = e.parar_purga.take() {
                let _ = p.send(());
            }
            let canales = e.canales.take();
            e.reiniciar();
            canales
        };
        if let Some(c) = canales {
            // Cerrar el socket cierra también los canales rápidos.
            c.cerrar();
        }
    }

    fn ventana_enfocada(self: &Arc<Self>) {
        if !bloquear(&self.estado).running {
            return;
        }
        self.refrescar_listas(false);
        let vista = bloquear(&self.estado).vista.clone();
        if let ChatView::Abierto(Some(c)) = vista {
            if self.no_leidos(&c) > 0 {
                self.marcar_leido_callado(&c);
            }
        }
    }

    /// Borra de verdad lo vencido; la RLS ya lo oculta, así que si falla no se nota en la UI.
    fn purgar_vencidos(&self, c: &Supabase) {
        if !bloquear(&self.estado).extras {
            return;
        }
        let r = c.rpc("chat_purge_expired", &json!({}));
        if let Some(e) = &r.error {
            self.entorno.log(&format!("chat: no se pudo purgar los mensajes vencidos: {} {}", e.codigo(), e.message.as_deref().unwrap_or("")));
        }
    }

    fn procesar(self: &Arc<Self>, g: u64, ev: EventoRealtime) {
        match ev {
            EventoRealtime::Estado { canal, estado } => {
                if canal == INBOX {
                    self.estado_del_inbox(g, estado)
                } else {
                    self.estado_de_topico(g, &canal, estado)
                }
            }
            EventoRealtime::Cambio { canal, tipo, fila } => {
                if canal != INBOX {
                    return;
                }
                if tipo == "INSERT" {
                    self.al_insertar(g, &fila)
                } else {
                    self.al_actualizar(g, &fila)
                }
            }
            EventoRealtime::Broadcast { canal, evento, payload } => {
                let Some(conv) = conv_del_topico(&canal) else { return };
                match evento.as_str() {
                    BROADCAST_EVENT => {
                        if let Some(f) = fila_de_broadcast(&payload, &conv) {
                            self.al_insertar(g, &Value::Object(f))
                        }
                    }
                    UPDATE_EVENT => {
                        if let Some(f) = fila_de_broadcast(&payload, &conv) {
                            self.al_actualizar(g, &Value::Object(f))
                        }
                    }
                    REACTION_EVENT => self.al_reaccionar(g, &conv, &payload),
                    TYPING_EVENT => self.al_escribir(g, &conv, &payload),
                    READ_EVENT => self.al_leer(g, &conv, &payload),
                    MEMBER_REMOVED_EVENT if conv.kind == TipoConv::Team => self.al_sacar_miembro(g, &conv, &payload),
                    _ => {}
                }
            }
        }
    }

    fn estado_del_inbox(self: &Arc<Self>, g: u64, st: EstadoCanal) {
        if !self.vigente(g) {
            return;
        }
        match st {
            EstadoCanal::Subscribed => {
                let reconexion = {
                    let mut e = bloquear(&self.estado);
                    e.conexion = Conexion::Live;
                    let r = e.suscripto_una_vez;
                    if r {
                        e.topicos_fallidos.clear();
                    }
                    e.suscripto_una_vez = true;
                    r
                };
                // Reconexión: las listas y los no leídos no vienen por realtime, se piden una vez.
                if reconexion {
                    if let Some(cl) = self.nucleo.cliente() {
                        self.comprobar_extras(&cl, g);
                        self.detectar_via(&cl);
                        self.detectar_limites_de_codigo(&cl);
                    }
                    if self.vigente(g) {
                        self.refrescar_listas(true);
                    }
                }
            }
            EstadoCanal::ChannelError | EstadoCanal::TimedOut | EstadoCanal::Closed => bloquear(&self.estado).conexion = Conexion::Retrying,
        }
        self.entorno.al_cambiar();
    }

    /// Si un canal privado no entra (sin la migración 0003 la RLS lo rechaza) se cierra y esa conversación sigue solo con
    /// «sloth-inbox». Sin aviso en la UI: el chat anda igual, un poco más lento.
    fn estado_de_topico(&self, g: u64, topico: &str, st: EstadoCanal) {
        if !self.vigente(g) || !matches!(st, EstadoCanal::ChannelError | EstadoCanal::TimedOut) {
            return;
        }
        let primera = {
            let mut e = bloquear(&self.estado);
            e.topicos_fallidos.insert(topico.to_string());
            !std::mem::replace(&mut e.broadcast_avisado, true)
        };
        self.cerrar_topico(topico);
        if primera {
            self.entorno.log("chat: el canal rápido (Broadcast) no está disponible; sigue con postgres_changes. ¿Falta aplicar 0003_realtime_broadcast.sql?");
        }
    }

    fn cerrar_topico(&self, topico: &str) {
        let canales = {
            let mut e = bloquear(&self.estado);
            e.topicos.remove(topico);
            e.canales.clone()
        };
        if let Some(c) = canales {
            c.salir(topico);
        }
    }

    /// Abre o cierra los canales de Broadcast según las conversaciones conocidas.
    fn sincronizar_topicos(&self, g: u64) {
        let (canales, actuales, deseados) = {
            let e = bloquear(&self.estado);
            if !e.running || e.gen != g || self.nucleo.cliente().is_none() {
                return;
            }
            let teams: Vec<ConvActiva> = e.listas.teams.iter().map(|t| ConvActiva { id: &t.id, last_message_at: t.last_message_at }).collect();
            let threads: Vec<ConvActiva> = e.listas.threads.iter().map(|t| ConvActiva { id: &t.id, last_message_at: t.last_message_at }).collect();
            let deseados: Vec<String> = topicos_deseados(&teams, &threads, MAX_TOPICS).into_iter().filter(|t| !e.topicos_fallidos.contains(t)).collect();
            (e.canales.clone(), e.topicos.iter().cloned().collect::<Vec<_>>(), deseados)
        };
        let Some(canales) = canales else { return };
        let cambio = diferencia_de_topicos(&actuales, &deseados);
        for t in &cambio.remove {
            self.cerrar_topico(t);
        }
        for t in cambio.add {
            if conv_del_topico(&t).is_none() {
                continue;
            }
            bloquear(&self.estado).topicos.insert(t.clone());
            canales.unir(Canal::privado(&t));
        }
    }

    fn al_insertar(self: &Arc<Self>, g: u64, raw: &Value) {
        let (Some(me), Some(c)) = (self.nucleo.me(), self.nucleo.cliente()) else { return };
        if !self.vigente(g) || !es_fila(raw) {
            return;
        }
        let Some(fila) = fila_de(raw) else { return };
        if conv_de_fila(&fila).is_none() || !bloquear(&self.estado).vistos.primera_vez(&clave_de_version(&fila)) {
            return;
        }
        let conv = conv_de_fila(&fila).expect("recién comprobada");
        let autor = s(fila.get("author_id")).to_string();
        self.cargar_perfiles(&c, vec![autor.clone()]);
        if !self.vigente(g) {
            return;
        }
        let Some(base) = mensaje_de_fila(&fila, self.perfil(&autor), EstadoMensaje::Sent) else { return };
        let msg = self.enriquecer(&c, std::slice::from_ref(&fila), vec![base.clone()], false).into_iter().next().unwrap_or(base);
        if !self.vigente(g) {
            return;
        }
        // Propio o ajeno: la UI reemplaza su «enviando…» por clientId, así que no se duplica.
        self.entorno.emitir("message", json!(msg));
        if let Some(n) = &msg.notice {
            if matches!(n, ChatNotice::Retention { .. }) {
                self.refrescar_listas(true);
            }
            return;
        }
        if autor == me.id {
            return;
        }
        let enfocada = self.entorno.ventana_con_foco();
        let mirando = matches!(&bloquear(&self.estado).vista, ChatView::Abierto(Some(v)) if misma_conv(v, &conv));
        if enfocada && mirando {
            // Lo está mirando: no suma no leído, pero el servidor tiene que saberlo.
            return self.marcar_leido_callado(&conv);
        }
        if !self.conocida(&conv) {
            // Conversación nueva para esta app (DM o equipo recién creado): la trae el servidor con su no leído.
            return self.refrescar_listas(true);
        }
        self.cambiar_no_leidos(&conv, |n| (n + 1).min(UNREAD_CAP));
        self.entorno.al_cambiar();
        // Avisos del sistema: con «notify.team» activo o si lo mencionan, y fuera de «No molestar».
        let aj = self.entorno.ajustes();
        let mencion = menciona_a(&msg.body, &me.login);
        if !enfocada && (aj.notificar_equipo || mencion) && !aj.no_molestar {
            self.avisar(&conv, &msg.author, &msg.body, mencion);
        }
    }

    fn al_actualizar(self: &Arc<Self>, g: u64, raw: &Value) {
        let Some(c) = self.nucleo.cliente() else { return };
        if !self.vigente(g) || !es_fila(raw) {
            return;
        }
        let Some(fila) = fila_de(raw) else { return };
        if conv_de_fila(&fila).is_none() || !bloquear(&self.estado).vistos.primera_vez(&clave_de_version(&fila)) {
            return;
        }
        let autor = s(fila.get("author_id")).to_string();
        self.cargar_perfiles(&c, vec![autor.clone()]);
        if !self.vigente(g) {
            return;
        }
        let Some(base) = mensaje_de_fila(&fila, self.perfil(&autor), EstadoMensaje::Sent) else { return };
        let msg = self.enriquecer(&c, std::slice::from_ref(&fila), vec![base.clone()], false).into_iter().next().unwrap_or(base);
        if self.vigente(g) {
            self.entorno.emitir("message", json!(msg));
        }
    }

    fn al_reaccionar(&self, g: u64, conv: &ChatConvRef, payload: &Value) {
        let (Some(ev), Some(c)) = (reaccion_de_broadcast(payload), self.nucleo.cliente()) else { return };
        if !self.vigente(g) || self.nucleo.me().is_none() {
            return;
        }
        self.cargar_perfiles(&c, vec![ev.user_id.clone()]);
        if !self.vigente(g) {
            return;
        }
        self.entorno.emitir("reaction", json!({"conv": conv, "messageId": ev.message_id, "emoji": ev.emoji, "userId": ev.user_id, "login": self.perfil(&ev.user_id).login, "op": if ev.agregar { "add" } else { "remove" }}));
    }

    fn al_escribir(&self, g: u64, conv: &ChatConvRef, payload: &Value) {
        let (Some(uid), Some(c), Some(me)) = (escribiendo_de_broadcast(payload), self.nucleo.cliente(), self.nucleo.me()) else { return };
        if !self.vigente(g) || uid == me.id {
            return;
        }
        self.cargar_perfiles(&c, vec![uid.clone()]);
        if self.vigente(g) {
            self.entorno.emitir("typing", json!({"conv": conv, "userId": uid, "login": self.perfil(&uid).login}));
        }
    }

    fn al_leer(&self, g: u64, conv: &ChatConvRef, payload: &Value) {
        let (Some((uid, en)), Some(me)) = (lectura_de_broadcast(payload), self.nucleo.me()) else { return };
        if !self.vigente(g) || conv.kind != TipoConv::Dm || uid == me.id {
            return;
        }
        bloquear(&self.estado).listas.threads.iter_mut().filter(|t| t.id == conv.id).for_each(|t| t.other_read_at = Some(en));
        self.entorno.al_cambiar();
        self.entorno.emitir("read", json!({"conv": conv, "userId": uid, "at": en}));
    }

    /// Realtime no echa al suscripto hasta que se renueva el JWT: al expulsado se le cierra el canal ya.
    fn al_sacar_miembro(self: &Arc<Self>, g: u64, conv: &ChatConvRef, payload: &Value) {
        let Some(uid) = miembro_sacado_de_broadcast(payload, &conv.id) else { return };
        if !self.vigente(g) {
            return;
        }
        // Sin topicos_fallidos: si te vuelven a sumar en esta sesión, el canal tiene que volver a abrirse.
        if self.nucleo.me().is_some_and(|m| m.id == uid) {
            self.cerrar_topico(&format!("team:{}", conv.id));
        }
        self.refrescar_listas(true);
    }

    /// Aviso del sistema para un mensaje ajeno con la ventana sin foco. Como mucho uno cada 5 s por conversación, o cada 2 s
    /// si mencionan al usuario.
    fn avisar(&self, conv: &ChatConvRef, autor: &ChatProfile, cuerpo: &str, mencion: bool) {
        let ahora = self.entorno.ahora_ms();
        let clave = conv_key(conv);
        {
            let mut e = bloquear(&self.estado);
            let min = if mencion { MENTION_MIN_MS } else { NOTIFY_MIN_MS };
            if e.ultimo_aviso.get(&clave).is_some_and(|&u| ahora - u < min) {
                return;
            }
            e.ultimo_aviso.insert(clave, ahora);
        }
        if !self.entorno.ventana_abierta() {
            return;
        }
        let donde = if conv.kind == TipoConv::Team { bloquear(&self.estado).listas.teams.iter().find(|t| t.id == conv.id).map(|t| t.name.clone()).unwrap_or_else(|| "Equipo".into()) } else { "Mensaje directo".to_string() };
        let titulo = if mencion { format!("{} te mencionó · {donde}", autor.login) } else { format!("{} · {donde}", autor.login) };
        self.entorno.notificar(&titulo, &primeros_caracteres(cuerpo, NOTICE_CHARS), conv);
    }

    // ---------- mensajes ----------

    fn leer_mensajes(&self, conv: &ChatConvRef, antes: Option<&str>, limite: u32) -> Res<Vec<ChatMessage>> {
        let c = self.cliente()?;
        let mut q = Consulta::select("messages", &self.columnas()).eq(col_de(conv), &conv.id);
        if let Some(b) = antes {
            let r = c.ejecutar(&Consulta::select("messages", "created_at").eq("id", b).limite(1));
            comprobar(&r, "No se pudo leer la conversación.")?;
            let Some(creado) = r.primera().map(|f| s(f.get("created_at")).to_string()) else { return Ok(Vec::new()) };
            q = q.lt("created_at", &creado);
        }
        let r = c.ejecutar(&q.orden_desc("created_at").limite(limite));
        comprobar(&r, "No se pudo leer la conversación.")?;
        let filas: Vec<FilaMensaje> = r.filas().iter().filter_map(fila_de).collect();
        self.cargar_perfiles(&c, filas.iter().map(|f| s(f.get("author_id")).to_string()).collect());
        let ordenadas = mas_viejo_primero(&filas);
        let msgs: Vec<ChatMessage> = ordenadas.iter().filter_map(|f| mensaje_de_fila(f, self.perfil(s(f.get("author_id"))), EstadoMensaje::Sent)).collect();
        Ok(self.enriquecer(&c, &ordenadas, msgs, true))
    }

    fn enviar_mensaje(&self, conv: &ChatConvRef, texto: &str, client_id: &str, responde_a: Option<&str>, via_claude: bool) -> Res<ChatMessage> {
        let c = self.cliente()?;
        let me = self.yo()?;
        let col = col_de(conv);
        let (extras, via_col) = {
            let e = bloquear(&self.estado);
            (e.extras, e.via_col)
        };
        let usar_col = via_claude && via_col;
        let cuerpo = if via_claude && !via_col { cortar_codepoints(&format!("{VIA_CLAUDE_PREFIX}{texto}"), LIMITE_CUERPO) } else { texto.to_string() };
        let insertar = |resp: Option<&str>| {
            let mut fila = json!({col: conv.id, "client_id": client_id, "body": cuerpo});
            if let (true, Some(r)) = (extras, resp) {
                fila["reply_to"] = json!(r);
            }
            if usar_col {
                fila["via"] = json!("claude");
            }
            c.ejecutar(&Consulta::insert("messages", fila).columnas(&self.columnas()))
        };
        let mut r = insertar(responde_a);
        // Si el citado se borró mientras tanto, el mensaje sale igual, sin la cita: si no, «Reintentar» fallaría siempre.
        if let (Some(e), Some(_)) = (&r.error, responde_a) {
            if e.codigo() == "23503" || (e.codigo() == "P0001" && e.message.as_deref() == Some(REPLY_GONE)) {
                r = insertar(None);
            }
        }
        let Some(e) = r.error.clone() else {
            let fila = r.primera().and_then(fila_de).ok_or("No se pudo enviar el mensaje.")?;
            let msg = mensaje_de_fila(&fila, me, EstadoMensaje::Sent).ok_or("No se pudo enviar el mensaje.")?;
            return Ok(self.enriquecer(&c, &[fila], vec![msg.clone()], false).into_iter().next().unwrap_or(msg));
        };
        if e.codigo() == "23505" {
            // clientId repetido: es un reintento. Se devuelve el mensaje que ya estaba guardado.
            let ex = c.ejecutar(&Consulta::select("messages", &self.columnas()).eq("author_id", &me.id).eq("client_id", client_id).eq(col, &conv.id).limite(1));
            let fila = ex.error.is_none().then(|| ex.primera().and_then(fila_de)).flatten();
            if let Some(f) = fila {
                if let Some(msg) = mensaje_de_fila(&f, me, EstadoMensaje::Sent) {
                    return Ok(self.enriquecer(&c, &[f], vec![msg.clone()], true).into_iter().next().unwrap_or(msg));
                }
            }
            return Err("No se pudo enviar el mensaje.".into());
        }
        if e.codigo() == "P0001" {
            if let Some(m) = msj(&e) {
                return Err(cortar_utf16(m, 300));
            }
        }
        if e.codigo() == "42501" {
            return Err("No podés escribir en esta conversación.".into());
        }
        Err("No se pudo enviar el mensaje.".into())
    }

    fn cambiar_propio(&self, conv: &Value, id: &Value, cambios: Value, denegado: &str) -> Res<ChatMessage> {
        let c = self.cliente()?;
        let me = self.yo()?;
        let conv = parsear_conv(conv)?;
        let id = parsear_uuid(id, "Mensaje inválido.")?;
        let r = c.ejecutar(&Consulta::update("messages", cambios).eq("id", &id).eq("author_id", &me.id).eq(col_de(&conv), &conv.id).columnas(&self.columnas()));
        if r.error.as_ref().map(ErrorPg::codigo) == Some("42501") {
            return Err(denegado.to_string());
        }
        comprobar(&r, denegado)?;
        let fila = r.primera().and_then(fila_de).ok_or(denegado)?;
        let msg = mensaje_de_fila(&fila, me, EstadoMensaje::Sent).ok_or(denegado)?;
        Ok(self.enriquecer(&c, &[fila], vec![msg.clone()], true).into_iter().next().unwrap_or(msg))
    }

    fn entrar_por_codigo(self: &Arc<Self>, raw: &Value) -> Res<ChatTeam> {
        let c = self.cliente()?;
        let codigo = parsear_codigo_invitacion(raw)?;
        let r = c.rpc("join_team_by_code", &json!({"p_code": codigo}));
        comprobar(&r, "No se pudo entrar al equipo.")?;
        let id = r.data.as_str().filter(|x| !x.is_empty()).ok_or("No se pudo entrar al equipo.")?.to_string();
        self.refrescar_listas(true);
        self.equipo_ahora(&id)
    }
}

/// Primeros `n` code points (`[...text].slice(0, n).join('')`).
fn cortar_codepoints(t: &str, n: usize) -> String {
    t.chars().take(n).collect()
}

/// UUID v4 para el nombre de la foto.
fn uuid_nuevo() -> Res<String> {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).map_err(|e| e.to_string())?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    Ok(format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::chat::http::pruebas::{json_resp, HttpFalso};
    use crate::features::chat::http::{ErrorRed, Pedido, Respuesta};
    use crate::features::chat::postgrest::pruebas::cliente_falso;
    use std::sync::atomic::{AtomicI64, Ordering};

    const ME: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const OTRO: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const EQ: &str = "11111111-1111-4111-8111-111111111111";
    const DM: &str = "22222222-2222-4222-8222-222222222222";
    const M1: &str = "33333333-3333-4333-8333-333333333333";
    const M2: &str = "44444444-4444-4444-8444-444444444444";
    const CID: &str = "55555555-5555-4555-8555-555555555555";

    struct NucleoFalso {
        cliente: Mutex<Option<Arc<Supabase>>>,
    }
    impl Nucleo for NucleoFalso {
        fn cliente(&self) -> Option<Arc<Supabase>> {
            self.cliente.lock().unwrap().clone()
        }
        fn me(&self) -> Option<ChatProfile> {
            Some(ChatProfile::simple(ME, "yo"))
        }
    }

    #[derive(Default)]
    struct EntornoFalso {
        emitidos: Mutex<Vec<(String, Value)>>,
        avisos: Mutex<Vec<(String, String)>>,
        logs: Mutex<Vec<String>>,
        cambios: AtomicI64,
        foco: Mutex<bool>,
        ajustes: Mutex<Option<AjustesAviso>>,
        reloj: AtomicI64,
    }
    impl Entorno for EntornoFalso {
        fn emitir(&self, canal: &str, payload: Value) {
            self.emitidos.lock().unwrap().push((canal.into(), payload));
        }
        fn log(&self, m: &str) {
            self.logs.lock().unwrap().push(m.into());
        }
        fn al_cambiar(&self) {
            self.cambios.fetch_add(1, Ordering::SeqCst);
        }
        fn ventana_con_foco(&self) -> bool {
            *self.foco.lock().unwrap()
        }
        fn ventana_abierta(&self) -> bool {
            true
        }
        fn ajustes(&self) -> AjustesAviso {
            self.ajustes.lock().unwrap().unwrap_or(AjustesAviso { notificar_equipo: true, no_molestar: false })
        }
        fn notificar(&self, t: &str, c: &str, _: &ChatConvRef) {
            self.avisos.lock().unwrap().push((t.into(), c.into()));
        }
        fn ahora_ms(&self) -> i64 {
            self.reloj.load(Ordering::SeqCst)
        }
    }

    #[derive(Default)]
    struct CanalesFalsos {
        unidos: Mutex<Vec<String>>,
        salidos: Mutex<Vec<String>>,
        cerrado: Mutex<bool>,
    }
    impl Canales for CanalesFalsos {
        fn unir(&self, c: Canal) {
            self.unidos.lock().unwrap().push(c.nombre);
        }
        fn salir(&self, n: &str) {
            self.salidos.lock().unwrap().push(n.into());
        }
        fn renovar_token(&self) {}
        fn cerrar(&self) {
            *self.cerrado.lock().unwrap() = true;
        }
    }

    struct Mundo {
        datos: ChatDatos,
        nucleo: Arc<NucleoFalso>,
        entorno: Arc<EntornoFalso>,
        http: Arc<HttpFalso>,
        canales: Arc<CanalesFalsos>,
        eventos: Sender<EventoRealtime>,
    }

    fn perfil_json() -> Value {
        json!([{"id": OTRO, "login": "ana", "name": "Ana", "avatar_url": null}, {"id": ME, "login": "yo"}])
    }

    fn fila_msg(id: &str, autor: &str, cuerpo: &str, creado: &str) -> Value {
        json!({"id": id, "client_id": CID, "team_id": EQ, "thread_id": null, "author_id": autor, "body": cuerpo, "created_at": creado})
    }

    /// Router de Supabase de mentira: cada pedido se contesta según método y ruta; lo no previsto da 404.
    fn mundo(router: impl Fn(&Pedido) -> Result<Respuesta, ErrorRed> + Send + Sync + 'static) -> Mundo {
        let http = HttpFalso::nuevo(move |p| {
            if p.url.contains("/rest/v1/profiles") {
                return json_resp(200, perfil_json());
            }
            router(p)
        });
        let sb = Arc::new(cliente_falso(http.clone()));
        let nucleo = Arc::new(NucleoFalso { cliente: Mutex::new(Some(sb)) });
        let entorno = Arc::new(EntornoFalso::default());
        let canales = Arc::new(CanalesFalsos::default());
        let (tx, rx) = channel();
        let rx = Mutex::new(Some(rx));
        let cs = canales.clone();
        let fabrica: Fabrica = Arc::new(move |_| (cs.clone() as Arc<dyn Canales>, rx.lock().unwrap().take().expect("una sola conexión")));
        let datos = ChatDatos::nuevo(nucleo.clone(), entorno.clone(), fabrica);
        Mundo { datos, nucleo, entorno, http, canales, eventos: tx }
    }

    fn con_extras(m: &Mundo) {
        bloquear(&m.datos.interno().estado).extras = true;
    }

    fn en_marcha(m: &Mundo) {
        let mut e = bloquear(&m.datos.interno().estado);
        e.running = true;
        e.gen = 1;
    }

    fn listas(m: &Mundo, teams: Vec<ChatTeam>, threads: Vec<ChatThread>) {
        let mut e = bloquear(&m.datos.interno().estado);
        e.listas = Listas { teams, threads, invites: Vec::new() };
        e.listas_cargadas = true;
    }

    fn equipo(id: &str, rol: ChatRole) -> ChatTeam {
        let fila = json!({"id": id, "name": "Equipo", "description": ""});
        equipo_de_fila(&fila, &InfoEquipo::nueva(rol, 2, 0)).unwrap()
    }

    fn hilo(id: &str) -> ChatThread {
        hilo_de_fila(&json!({"id": id}), ChatProfile::simple(OTRO, "ana"), &InfoHilo { unread: 0, last_message_at: None, other_read_at: None }).unwrap()
    }

    fn conv_eq() -> Value {
        json!({"kind": "team", "id": EQ})
    }

    fn ok_vacio() -> Result<Respuesta, ErrorRed> {
        json_resp(200, json!([]))
    }

    fn pidio(m: &Mundo, parte: &str) -> bool {
        m.http.urls().iter().any(|u| u.contains(parte))
    }

    // ----- leer -----

    #[test]
    fn leer_mensajes_los_devuelve_del_mas_viejo_al_mas_nuevo_con_el_autor() {
        let m = mundo(|_| json_resp(200, json!([fila_msg(M2, OTRO, "segundo", "2024-01-01T00:00:02+00:00"), fila_msg(M1, ME, "primero", "2024-01-01T00:00:01+00:00")])));
        let r = m.datos.mensajes(&conv_eq(), None, None).unwrap();
        let a = r.as_array().unwrap();
        assert_eq!((a[0]["body"].as_str(), a[0]["author"]["login"].as_str()), (Some("primero"), Some("yo")));
        assert_eq!((a[1]["body"].as_str(), a[1]["author"]["login"].as_str()), (Some("segundo"), Some("ana")));
        let u = m.http.urls().into_iter().find(|u| u.contains("/rest/v1/messages")).unwrap();
        assert!(u.contains("team_id=eq.") && u.contains("order=created_at.desc") && u.contains("limit=50"), "{u}");
    }

    #[test]
    fn leer_antes_de_un_mensaje_pide_su_fecha_y_si_no_existe_devuelve_vacio() {
        let m = mundo(|p| if p.url.contains("select=created_at") { ok_vacio() } else { panic!("no debería pedir más: {}", p.url) });
        assert_eq!(m.datos.mensajes(&conv_eq(), Some(&json!(M1)), Some(&json!(10))).unwrap(), json!([]));
        let m = mundo(|p| if p.url.contains("select=created_at") { json_resp(200, json!([{"created_at": "2024-01-01T00:00:01.5+00:00"}])) } else { ok_vacio() });
        m.datos.mensajes(&conv_eq(), Some(&json!(M1)), Some(&json!(10))).unwrap();
        let u = m.http.urls().into_iter().find(|u| u.contains("created_at=lt.")).unwrap();
        assert!(u.contains("limit=10"), "{u}");
    }

    #[test]
    fn sin_sesion_o_con_argumentos_malos_falla_con_el_mensaje_de_siempre() {
        let m = mundo(|_| ok_vacio());
        assert_eq!(m.datos.mensajes(&json!({"kind": "x"}), None, None), Err("Conversación inválida.".to_string()));
        assert_eq!(m.datos.mensajes(&conv_eq(), Some(&json!("no-uuid")), None), Err("Mensaje inválido.".to_string()));
    }

    fn sin_sesion(m: &Mundo) {
        *m.nucleo.cliente.lock().unwrap() = None;
    }

    #[test]
    fn sin_sesion_los_canales_dicen_que_hay_que_iniciar_sesion() {
        let m = mundo(|_| panic!("sin sesión no hay red"));
        sin_sesion(&m);
        assert_eq!(m.datos.mensajes(&conv_eq(), None, None), Err("Iniciá sesión en el chat.".to_string()));
        assert_eq!(m.datos.enviar(&conv_eq(), &json!("x"), &json!(CID), None), Err("Iniciá sesión en el chat.".to_string()));
        assert_eq!(m.datos.marcar_leido(&conv_eq()), Err("Iniciá sesión en el chat.".to_string()));
        m.datos.arrancar();
        assert!(m.canales.unidos.lock().unwrap().is_empty());
    }

    #[test]
    fn un_error_de_postgrest_en_la_lectura_no_filtra_detalles() {
        let m = mundo(|_| json_resp(500, json!({"code": "XX000", "message": "detalle interno"})));
        assert_eq!(m.datos.mensajes(&conv_eq(), None, None), Err("No se pudo leer la conversación.".to_string()));
    }

    // ----- enviar -----

    #[test]
    fn enviar_inserta_con_client_id_y_devuelve_el_mensaje() {
        let m = mundo(|p| if p.metodo == "POST" { json_resp(201, json!([fila_msg(M1, ME, "hola", "2024-01-01T00:00:01+00:00")])) } else { ok_vacio() });
        let r = m.datos.enviar(&conv_eq(), &json!("  hola  "), &json!(CID), None).unwrap();
        assert_eq!((r["id"].as_str(), r["body"].as_str(), r["status"].as_str()), (Some(M1), Some("hola"), Some("sent")));
        let p = m.http.pedidos.lock().unwrap().iter().find(|p| p.metodo == "POST").cloned().unwrap();
        let cuerpo: Value = serde_json::from_slice(p.cuerpo.as_ref().unwrap()).unwrap();
        assert_eq!(cuerpo, json!({"team_id": EQ, "client_id": CID, "body": "hola"}));
    }

    #[test]
    fn enviar_con_extras_manda_la_cita_y_si_el_citado_se_borro_reintenta_sin_ella() {
        let intentos = Arc::new(AtomicI64::new(0));
        let n = intentos.clone();
        let m = mundo(move |p| {
            if p.metodo != "POST" {
                return ok_vacio();
            }
            if n.fetch_add(1, Ordering::SeqCst) == 0 {
                return json_resp(409, json!({"code": "23503", "message": "fk"}));
            }
            json_resp(201, json!([fila_msg(M1, ME, "hola", "2024-01-01T00:00:01+00:00")]))
        });
        con_extras(&m);
        m.datos.enviar(&conv_eq(), &json!("hola"), &json!(CID), Some(&json!(M2))).unwrap();
        let posts: Vec<Value> = m.http.pedidos.lock().unwrap().iter().filter(|p| p.metodo == "POST").map(|p| serde_json::from_slice(p.cuerpo.as_ref().unwrap()).unwrap()).collect();
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[0]["reply_to"], M2);
        assert!(posts[1].get("reply_to").is_none());
    }

    #[test]
    fn un_client_id_repetido_devuelve_el_mensaje_que_ya_estaba() {
        let m = mundo(|p| {
            if p.metodo == "POST" {
                return json_resp(409, json!({"code": "23505", "message": "dup"}));
            }
            json_resp(200, json!([fila_msg(M1, ME, "ya estaba", "2024-01-01T00:00:01+00:00")]))
        });
        let r = m.datos.enviar(&conv_eq(), &json!("hola"), &json!(CID), None).unwrap();
        assert_eq!(r["body"], "ya estaba");
        let u = m.http.urls().into_iter().find(|u| u.starts_with("GET") && u.contains("client_id=eq.")).unwrap();
        assert!(u.contains("author_id=eq.") && u.contains("team_id=eq."), "{u}");
    }

    #[test]
    fn los_errores_de_enviar_se_traducen() {
        let con_error = |estado, code: &'static str, msg: &'static str| {
            let m = mundo(move |p| if p.metodo == "POST" { json_resp(estado, json!({"code": code, "message": msg})) } else { ok_vacio() });
            m.datos.enviar(&conv_eq(), &json!("hola"), &json!(CID), None).unwrap_err()
        };
        assert_eq!(con_error(400, "P0001", "Estás limitado."), "Estás limitado.");
        assert_eq!(con_error(403, "42501", "rls"), "No podés escribir en esta conversación.");
        assert_eq!(con_error(500, "XX000", "x"), "No se pudo enviar el mensaje.");
    }

    #[test]
    fn enviar_via_claude_sin_la_0005_antepone_el_prefijo_y_con_ella_usa_la_columna() {
        let responder = |p: &Pedido| if p.metodo == "POST" { json_resp(201, json!([fila_msg(M1, ME, "x", "2024-01-01T00:00:01+00:00")])) } else { ok_vacio() };
        let m = mundo(responder);
        m.datos.enviar_via_claude(&ChatConvRef::equipo(EQ), "hola", CID).unwrap();
        let p = m.http.pedidos.lock().unwrap().iter().find(|p| p.metodo == "POST").cloned().unwrap();
        assert_eq!(serde_json::from_slice::<Value>(p.cuerpo.as_ref().unwrap()).unwrap()["body"], "[vía Claude] hola");
        let m = mundo(responder);
        bloquear(&m.datos.interno().estado).via_col = true;
        m.datos.enviar_via_claude(&ChatConvRef::equipo(EQ), "hola", CID).unwrap();
        let p = m.http.pedidos.lock().unwrap().iter().find(|p| p.metodo == "POST").cloned().unwrap();
        let cuerpo: Value = serde_json::from_slice(p.cuerpo.as_ref().unwrap()).unwrap();
        assert_eq!((cuerpo["body"].as_str(), cuerpo["via"].as_str()), (Some("hola"), Some("claude")));
    }

    #[test]
    fn el_prefijo_de_claude_no_hace_pasar_el_tope_de_caracteres() {
        let m = mundo(|p| if p.metodo == "POST" { json_resp(201, json!([fila_msg(M1, ME, "x", "2024-01-01T00:00:01+00:00")])) } else { ok_vacio() });
        m.datos.enviar_via_claude(&ChatConvRef::equipo(EQ), &"é".repeat(LIMITE_CUERPO), CID).unwrap();
        let p = m.http.pedidos.lock().unwrap().iter().find(|p| p.metodo == "POST").cloned().unwrap();
        let b = serde_json::from_slice::<Value>(p.cuerpo.as_ref().unwrap()).unwrap()["body"].as_str().unwrap().to_string();
        assert_eq!(b.chars().count(), LIMITE_CUERPO);
        assert!(b.starts_with("[vía Claude] "));
    }

    // ----- editar, borrar, reaccionar, buscar -----

    #[test]
    fn editar_borrar_y_reaccionar_piden_la_0004() {
        let m = mundo(|_| ok_vacio());
        let esperado = |que: &str| format!("{que}, el servidor del chat necesita la actualización 0004.");
        assert_eq!(m.datos.editar(&conv_eq(), &json!(M1), &json!("x")), Err(esperado("Para editar")));
        assert_eq!(m.datos.borrar(&conv_eq(), &json!(M1)), Err(esperado("Para borrar")));
        assert_eq!(m.datos.reaccionar(&conv_eq(), &json!(M1), &json!("👍"), &json!(true)), Err(esperado("Para reaccionar")));
        assert_eq!(m.datos.vaciar(&conv_eq(), &json!(false)), Err(esperado("Para vaciar")));
        assert_eq!(m.datos.poner_retencion(&json!(EQ), &json!(24)), Err(esperado("Para el borrado automático")));
    }

    #[test]
    fn editar_actualiza_solo_el_mensaje_propio_de_esa_conversacion() {
        let m = mundo(|p| if p.metodo == "PATCH" { json_resp(200, json!([fila_msg(M1, ME, "editado", "2024-01-01T00:00:01+00:00")])) } else { ok_vacio() });
        con_extras(&m);
        let r = m.datos.editar(&conv_eq(), &json!(M1), &json!("editado")).unwrap();
        assert_eq!(r["body"], "editado");
        let p = m.http.pedidos.lock().unwrap().iter().find(|p| p.metodo == "PATCH").cloned().unwrap();
        assert!(p.url.contains(&format!("id=eq.{M1}")) && p.url.contains(&format!("author_id=eq.{ME}")) && p.url.contains(&format!("team_id=eq.{EQ}")), "{}", p.url);
    }

    #[test]
    fn editar_sin_filas_o_con_rls_dice_que_no_podes() {
        let m = mundo(|p| if p.metodo == "PATCH" { ok_vacio() } else { panic!() });
        con_extras(&m);
        assert_eq!(m.datos.editar(&conv_eq(), &json!(M1), &json!("x")), Err("No podés editar ese mensaje.".to_string()));
        let m = mundo(|_| json_resp(403, json!({"code": "42501", "message": "x"})));
        con_extras(&m);
        assert_eq!(m.datos.borrar(&conv_eq(), &json!(M1)), Err("No podés borrar ese mensaje.".to_string()));
    }

    #[test]
    fn borrar_pone_deleted_at_con_la_hora_del_reloj() {
        let m = mundo(|p| if p.metodo == "PATCH" { json_resp(200, json!([fila_msg(M1, ME, "x", "2024-01-01T00:00:01+00:00")])) } else { ok_vacio() });
        con_extras(&m);
        m.entorno.reloj.store(1_700_000_000_000, Ordering::SeqCst);
        m.datos.borrar(&conv_eq(), &json!(M1)).unwrap();
        let p = m.http.pedidos.lock().unwrap().iter().find(|p| p.metodo == "PATCH").cloned().unwrap();
        assert_eq!(serde_json::from_slice::<Value>(p.cuerpo.as_ref().unwrap()).unwrap()["deleted_at"], super::super::fecha::iso_de_ms(1_700_000_000_000));
    }

    #[test]
    fn reaccionar_agrega_o_quita_y_un_duplicado_no_es_error() {
        let m = mundo(|_| json_resp(201, json!([])));
        con_extras(&m);
        m.datos.reaccionar(&conv_eq(), &json!(M1), &json!("👍"), &json!(true)).unwrap();
        m.datos.reaccionar(&conv_eq(), &json!(M1), &json!("👍"), &json!(false)).unwrap();
        let ms: Vec<String> = m.http.pedidos.lock().unwrap().iter().map(|p| p.metodo.to_string()).collect();
        assert_eq!(ms, ["POST", "DELETE"]);
        let d = m.http.pedidos.lock().unwrap()[1].url.clone();
        assert!(d.contains(&format!("user_id=eq.{ME}")) && d.contains("message_id=eq."), "{d}");
        let dup = mundo(|_| json_resp(409, json!({"code": "23505", "message": "x"})));
        con_extras(&dup);
        assert_eq!(dup.datos.reaccionar(&conv_eq(), &json!(M1), &json!("👍"), &json!(true)), Ok(()));
        assert_eq!(dup.datos.reaccionar(&conv_eq(), &json!(M1), &json!("💩"), &json!(true)), Err("Reacción inválida.".to_string()));
        assert_eq!(dup.datos.reaccionar(&conv_eq(), &json!(M1), &json!("👍"), &json!("si")), Err("Reacción inválida.".to_string()));
    }

    #[test]
    fn buscar_escapa_los_comodines_y_con_extras_excluye_borrados_y_avisos() {
        let m = mundo(|_| json_resp(200, json!([fila_msg(M1, OTRO, "100% listo", "2024-01-01T00:00:01+00:00")])));
        con_extras(&m);
        let r = m.datos.buscar(&conv_eq(), &json!("100%")).unwrap();
        assert_eq!(r.as_array().unwrap().len(), 1);
        let u = m.http.urls().into_iter().find(|u| u.contains("ilike")).unwrap();
        let parsed = url::Url::parse(&u.replace("GET ", "")).unwrap();
        let q: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
        assert_eq!(q["body"], "ilike.%100\\%%");
        assert_eq!((q["deleted_at"].as_str(), q["kind"].as_str(), q["limit"].as_str()), ("is.null", "eq.text", "50"));
    }

    #[test]
    fn buscar_con_asterisco_filtra_de_nuevo_porque_postgrest_lo_vuelve_comodin() {
        let m = mundo(|_| json_resp(200, json!([fila_msg(M1, OTRO, "a*b", "2024-01-01T00:00:01+00:00"), fila_msg(M2, OTRO, "axb", "2024-01-01T00:00:02+00:00")])));
        let r = m.datos.buscar(&conv_eq(), &json!("a*b")).unwrap();
        let a = r.as_array().unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0]["body"], "a*b");
        assert_eq!(m.datos.buscar(&conv_eq(), &json!("a")), Err("Escribí al menos 2 letras.".to_string()));
    }

    // ----- vaciar, retención, escribiendo -----

    #[test]
    fn vaciar_un_equipo_exige_ser_admin_y_un_dm_exige_coincidir_con_lo_que_hace_el_servidor() {
        let m = mundo(|_| json_resp(200, Value::Null));
        con_extras(&m);
        listas(&m, vec![equipo(EQ, ChatRole::Member)], vec![hilo(DM)]);
        assert_eq!(m.datos.vaciar(&conv_eq(), &json!(false)), Err("Solo owner o admin pueden vaciar la conversación del equipo.".to_string()));
        let dm = json!({"kind": "dm", "id": DM});
        assert_eq!(m.datos.vaciar(&dm, &json!(true)), Err("Cambió lo que hace el servidor al vaciar: cerrá este aviso y volvé a intentarlo.".to_string()));
        m.datos.vaciar(&dm, &json!(false)).unwrap();
        assert!(pidio(&m, "/rpc/chat_clear"));
        listas(&m, vec![equipo(EQ, ChatRole::Admin)], vec![]);
        m.datos.vaciar(&conv_eq(), &json!(null)).unwrap();
    }

    #[test]
    fn escribiendo_avisa_una_vez_por_ventana_y_solo_con_extras() {
        let m = mundo(|_| json_resp(200, Value::Null));
        m.datos.escribiendo(&conv_eq()).unwrap();
        assert!(!pidio(&m, "chat_typing"));
        con_extras(&m);
        m.entorno.reloj.store(10_000, Ordering::SeqCst);
        m.datos.escribiendo(&conv_eq()).unwrap();
        m.entorno.reloj.store(11_000, Ordering::SeqCst);
        m.datos.escribiendo(&conv_eq()).unwrap();
        m.entorno.reloj.store(13_000, Ordering::SeqCst);
        m.datos.escribiendo(&conv_eq()).unwrap();
        assert_eq!(m.http.urls().iter().filter(|u| u.contains("chat_typing")).count(), 2);
    }

    #[test]
    fn poner_retencion_manda_las_horas_o_null_y_rechaza_plazos_raros() {
        let m = mundo(router_completo);
        con_extras(&m);
        en_marcha(&m);
        assert_eq!(m.datos.poner_retencion(&json!(EQ), &json!(99)), Err("Plazo inválido.".to_string()));
        m.datos.poner_retencion(&json!(EQ), &json!(168)).unwrap();
        m.datos.poner_retencion(&json!(EQ), &json!(null)).unwrap();
        let horas: Vec<Value> = m.http.pedidos.lock().unwrap().iter().filter(|p| p.url.contains("/rpc/chat_set_retention")).map(|p| serde_json::from_slice::<Value>(p.cuerpo.as_ref().unwrap()).unwrap()["p_hours"].clone()).collect();
        assert_eq!(horas, [json!(168), json!(null)]);
        assert!(pidio(&m, "/rpc/chat_purge_expired"), "y purga lo vencido");
    }

    // ----- equipos -----

    #[test]
    fn crear_equipo_devuelve_el_equipo_de_las_listas_refrescadas() {
        let m = mundo(|p| {
            if p.url.contains("/rpc/create_team") {
                return json_resp(200, json!(EQ));
            }
            if p.url.contains("/rpc/unread_counts") {
                return json_resp(200, json!([{"kind": "team", "id": EQ, "unread": 3, "last_at": "2024-01-01T00:00:01+00:00"}]));
            }
            if p.url.contains("/rest/v1/team_members") && p.url.contains("user_id=eq.") {
                return json_resp(200, json!([{"team_id": EQ, "role": "owner"}]));
            }
            if p.url.contains("/rest/v1/team_members") {
                return json_resp(200, json!([{"team_id": EQ}, {"team_id": EQ}]));
            }
            if p.url.contains("/rest/v1/teams") {
                return json_resp(200, json!([{"id": EQ, "name": "Nuevo", "description": "d", "photo_path": null}]));
            }
            if p.url.contains("/rest/v1/team_invite_codes") {
                return json_resp(200, json!([{"team_id": EQ, "code": "0123456789abcdef"}]));
            }
            ok_vacio()
        });
        en_marcha(&m);
        let t = m.datos.crear_equipo(&json!({"name": "Nuevo", "description": "d"})).unwrap();
        assert_eq!((t.id.as_str(), t.name.as_str(), t.member_count, t.unread), (EQ, "Nuevo", 2, 3));
        assert_eq!(t.invite_code.as_deref(), Some("0123456789abcdef"));
        assert_eq!(t.role, ChatRole::Owner);
        let p = m.datos.parte();
        assert_eq!((p["unreadTotal"].as_u64(), p["listsLoaded"].as_bool()), (Some(3), Some(true)));
    }

    #[test]
    fn crear_equipo_valida_la_foto_antes_de_crear_nada() {
        let m = mundo(|_| panic!("no debería tocar la red"));
        assert_eq!(m.datos.crear_equipo(&json!({"name": "x", "photoBase64": "no es base64!"})), Err("La foto no es válida.".to_string()));
        assert!(m.datos.crear_equipo(&json!({"nombre": "x"})).is_err());
    }

    #[test]
    fn actualizar_equipo_sin_filas_afectadas_dice_que_no_podes() {
        let m = mundo(|p| if p.metodo == "PATCH" { ok_vacio() } else { panic!("{}", p.url) });
        assert_eq!(m.datos.actualizar_equipo(&json!(EQ), &json!({"name": "Otro"})), Err("No podés editar este equipo.".to_string()));
    }

    #[test]
    fn miembros_vienen_ordenados_con_su_perfil() {
        let m = mundo(|p| if p.url.contains("/rest/v1/team_members") { json_resp(200, json!([{"user_id": OTRO, "role": "member", "joined_at": "2024-01-01T00:00:01+00:00"}, {"user_id": ME, "role": "owner", "joined_at": "2024-01-01T00:00:00+00:00"}])) } else { ok_vacio() });
        let r = m.datos.miembros(&json!(EQ)).unwrap();
        let a = r.as_array().unwrap();
        assert_eq!((a[0]["role"].as_str(), a[0]["profile"]["login"].as_str()), (Some("owner"), Some("yo")));
        assert_eq!((a[1]["role"].as_str(), a[1]["profile"]["login"].as_str()), (Some("member"), Some("ana")));
    }

    #[test]
    fn invitar_por_login_traduce_duplicado_y_permiso() {
        let ok = mundo(|_| json_resp(201, json!([{"id": M1, "github_login_lower": "ana"}])));
        assert_eq!(ok.datos.invitar_por_login(&json!(EQ), &json!("Ana")).unwrap(), json!({"id": M1, "githubLogin": "ana"}));
        let dup = mundo(|_| json_resp(409, json!({"code": "23505", "message": "x"})));
        assert_eq!(dup.datos.invitar_por_login(&json!(EQ), &json!("ana")), Err("Ya invitaste a esa persona.".to_string()));
        let no = mundo(|_| json_resp(403, json!({"code": "42501", "message": "x"})));
        assert_eq!(no.datos.invitar_por_login(&json!(EQ), &json!("ana")), Err("Solo owner o admin pueden invitar.".to_string()));
    }

    #[test]
    fn el_codigo_regenerado_tiene_que_tener_16_hex() {
        let m = mundo(|_| json_resp(200, json!("0123456789abcdef")));
        assert_eq!(m.datos.regenerar_codigo(&json!(EQ)).unwrap(), "0123456789abcdef");
        let mal = mundo(|_| json_resp(200, json!("ZZ")));
        assert_eq!(mal.datos.regenerar_codigo(&json!(EQ)), Err("No se pudo cambiar el código.".to_string()));
    }

    #[test]
    fn rechazar_una_invitacion_que_ya_no_existe_avisa() {
        let m = mundo(|_| ok_vacio());
        assert_eq!(m.datos.rechazar_invitacion(&json!(M1)), Err("Esa invitación ya no existe.".to_string()));
    }

    #[test]
    fn el_owner_no_puede_salir_del_equipo() {
        let m = mundo(|_| panic!("no debería llamar"));
        listas(&m, vec![equipo(EQ, ChatRole::Owner)], vec![]);
        assert_eq!(m.datos.salir_del_equipo(&json!(EQ)), Err("El owner no puede salir del equipo.".to_string()));
        let sin = mundo(|_| ok_vacio());
        assert_eq!(sin.datos.salir_del_equipo(&json!(EQ)), Err("El owner no puede salir del equipo.".to_string()));
    }

    #[test]
    fn sacar_miembro_usa_el_rpc_y_si_no_existe_lo_hace_en_dos_pasos() {
        let m = mundo(|p| if p.url.contains("/rpc/remove_member") { json_resp(200, Value::Null) } else { ok_vacio() });
        let r = m.datos.sacar_miembro(&json!(EQ), &json!(OTRO)).unwrap();
        assert!(r.codigo_nuevo);
        assert_eq!(m.datos.sacar_miembro(&json!(EQ), &json!(ME)), Err("Para salir usá «Salir del equipo».".to_string()));
        let viejo = mundo(|p| {
            if p.url.contains("/rpc/remove_member") {
                return json_resp(404, json!({"code": "PGRST202", "message": "no function"}));
            }
            if p.metodo == "DELETE" {
                return json_resp(200, json!([{"user_id": OTRO}]));
            }
            if p.url.contains("/rpc/regenerate_invite_code") {
                return json_resp(200, json!("0123456789abcdef"));
            }
            ok_vacio()
        });
        let r = viejo.datos.sacar_miembro(&json!(EQ), &json!(OTRO)).unwrap();
        assert!(r.codigo_nuevo && r.aviso.contains("0007"));
        assert!(viejo.entorno.logs.lock().unwrap().iter().any(|l| l.contains("0007")));
        let d = viejo.http.urls().into_iter().find(|u| u.starts_with("DELETE")).unwrap();
        assert!(d.contains("role=eq.member"), "{d}");
    }

    #[test]
    fn sacar_miembro_sin_codigo_nuevo_avisa_que_la_invitacion_vieja_sigue_valiendo() {
        let m = mundo(|p| {
            if p.url.contains("/rpc/remove_member") {
                return json_resp(404, json!({"code": "PGRST202", "message": "x"}));
            }
            if p.metodo == "DELETE" {
                return json_resp(200, json!([{"user_id": OTRO}]));
            }
            if p.url.contains("/rpc/regenerate_invite_code") {
                return json_resp(500, json!({"code": "XX", "message": "x"}));
            }
            ok_vacio()
        });
        let r = m.datos.sacar_miembro(&json!(EQ), &json!(OTRO)).unwrap();
        assert!(!r.codigo_nuevo && r.aviso.contains("NO cambió"));
    }

    #[test]
    fn abrir_un_dm_con_uno_mismo_no_se_puede_y_devuelve_el_hilo_de_las_listas() {
        let m = mundo(|p| {
            if p.url.contains("/rpc/open_dm") {
                return json_resp(200, json!(DM));
            }
            if p.url.contains("/rpc/unread_counts") {
                return json_resp(200, json!([]));
            }
            if p.url.contains("/rest/v1/dm_threads") {
                return json_resp(200, json!([{"id": DM, "user_a": ME, "user_b": OTRO}]));
            }
            ok_vacio()
        });
        en_marcha(&m);
        assert_eq!(m.datos.abrir_directo(&json!(ME)), Err("Elegí a otra persona.".to_string()));
        let t = m.datos.abrir_directo(&json!(OTRO)).unwrap();
        assert_eq!((t.id.as_str(), t.other.login.as_str()), (DM, "ana"));
    }

    // ----- listas: piso de 30 s y errores -----

    #[test]
    fn las_listas_no_se_refrescan_dos_veces_en_30_s_salvo_forzado() {
        let m = mundo(|p| if p.url.contains("/rpc/unread_counts") { json_resp(200, json!([])) } else { ok_vacio() });
        en_marcha(&m);
        m.entorno.reloj.store(100_000, Ordering::SeqCst);
        m.datos.interno().refrescar_listas(false);
        let n = m.http.urls().len();
        m.entorno.reloj.store(110_000, Ordering::SeqCst);
        m.datos.interno().refrescar_listas(false);
        assert_eq!(m.http.urls().len(), n);
        m.datos.interno().refrescar_listas(true);
        assert!(m.http.urls().len() > n);
        m.entorno.reloj.store(150_000, Ordering::SeqCst);
        let n2 = m.http.urls().len();
        m.datos.interno().refrescar_listas(false);
        assert!(m.http.urls().len() > n2);
    }

    #[test]
    fn si_falla_una_lista_se_loguea_y_las_anteriores_quedan() {
        let m = mundo(|p| if p.url.contains("/rest/v1/team_members") { json_resp(500, json!({"code": "XX", "message": "x"})) } else { ok_vacio() });
        en_marcha(&m);
        listas(&m, vec![equipo(EQ, ChatRole::Member)], vec![]);
        m.datos.interno().refrescar_listas(true);
        assert_eq!(m.datos.parte()["teams"].as_array().unwrap().len(), 1);
        assert!(m.entorno.logs.lock().unwrap().iter().any(|l| l.contains("no se pudieron cargar las listas")));
    }

    // ----- migraciones -----

    #[test]
    fn detectar_extras_distingue_falta_de_migracion_de_un_corte() {
        let m = mundo(|p| if p.url.contains("/rest/v1/messages") { json_resp(400, json!({"code": "42703", "message": "x"})) } else { ok_vacio() });
        let c = m.datos.interno().cliente().unwrap();
        m.datos.interno().detectar_extras(&c).unwrap();
        assert!(!bloquear(&m.datos.interno().estado).extras);
        let sano = mundo(|_| ok_vacio());
        let c2 = sano.datos.interno().cliente().unwrap();
        sano.datos.interno().detectar_extras(&c2).unwrap();
        assert!(bloquear(&sano.datos.interno().estado).extras);
        let corte = mundo(|_| Err(ErrorRed::Conexion("x".into())));
        corte.datos.interno().detectar_extras(&corte.datos.interno().cliente().unwrap()).unwrap_err();
        assert!(!bloquear(&corte.datos.interno().estado).extras);
        let quinientos = mundo(|_| json_resp(500, json!({"code": "XX000", "message": "x"})));
        let e = quinientos.datos.interno().detectar_extras(&quinientos.datos.interno().cliente().unwrap()).unwrap_err();
        assert!(e.contains("XX000"), "{e}");
    }

    #[test]
    fn detectar_via_y_los_limites_de_codigo_se_miran_por_separado() {
        let m = mundo(|p| {
            if p.url.contains("select=via") {
                return ok_vacio();
            }
            if p.url.contains("team_invite_codes") {
                return json_resp(400, json!({"code": "42703", "message": "x"}));
            }
            ok_vacio()
        });
        let c = m.datos.interno().cliente().unwrap();
        m.datos.interno().detectar_via(&c);
        m.datos.interno().detectar_limites_de_codigo(&c);
        let e = bloquear(&m.datos.interno().estado);
        assert!(e.via_col && !e.limites_codigo && e.dm_vaciar_para_mi);
    }

    // ----- tiempo real -----

    fn insertar_ajeno(m: &Mundo, id: &str, cuerpo: &str) {
        m.datos.interno().procesar(1, EventoRealtime::Cambio { canal: INBOX.into(), tipo: "INSERT".into(), fila: fila_msg(id, OTRO, cuerpo, "2024-01-01T00:00:05+00:00") });
    }

    #[test]
    fn un_mensaje_ajeno_se_emite_suma_no_leido_y_avisa_si_no_hay_foco() {
        let m = mundo(|_| ok_vacio());
        en_marcha(&m);
        listas(&m, vec![equipo(EQ, ChatRole::Member)], vec![]);
        insertar_ajeno(&m, M1, "hola @yo");
        let emitidos = m.entorno.emitidos.lock().unwrap().clone();
        assert_eq!(emitidos.len(), 1);
        assert_eq!((emitidos[0].0.as_str(), emitidos[0].1["body"].as_str(), emitidos[0].1["author"]["login"].as_str()), ("message", Some("hola @yo"), Some("ana")));
        assert_eq!(m.datos.parte()["teams"][0]["unread"], 1);
        assert_eq!(m.entorno.avisos.lock().unwrap().clone(), vec![("ana te mencionó · Equipo".to_string(), "hola @yo".to_string())]);
    }

    #[test]
    fn el_mismo_mensaje_por_broadcast_y_por_postgres_changes_se_procesa_una_vez() {
        let m = mundo(|_| ok_vacio());
        en_marcha(&m);
        listas(&m, vec![equipo(EQ, ChatRole::Member)], vec![]);
        insertar_ajeno(&m, M1, "hola");
        insertar_ajeno(&m, M1, "hola");
        assert_eq!(m.entorno.emitidos.lock().unwrap().len(), 1);
        assert_eq!(m.datos.parte()["teams"][0]["unread"], 1);
    }

    #[test]
    fn mirando_la_conversacion_con_foco_no_suma_no_leido_y_lo_marca_leido() {
        let m = mundo(|_| json_resp(200, Value::Null));
        en_marcha(&m);
        listas(&m, vec![equipo(EQ, ChatRole::Member)], vec![]);
        *m.entorno.foco.lock().unwrap() = true;
        bloquear(&m.datos.interno().estado).vista = ChatView::Abierto(Some(ChatConvRef::equipo(EQ)));
        insertar_ajeno(&m, M1, "hola");
        assert_eq!(m.datos.parte()["teams"][0]["unread"], 0);
        assert!(pidio(&m, "/rpc/mark_read"));
        assert!(m.entorno.avisos.lock().unwrap().is_empty());
    }

    #[test]
    fn no_molestar_o_notificaciones_apagadas_no_avisan_pero_una_mencion_si() {
        let m = mundo(|_| ok_vacio());
        en_marcha(&m);
        listas(&m, vec![equipo(EQ, ChatRole::Member)], vec![]);
        *m.entorno.ajustes.lock().unwrap() = Some(AjustesAviso { notificar_equipo: false, no_molestar: false });
        insertar_ajeno(&m, M1, "sin mención");
        assert!(m.entorno.avisos.lock().unwrap().is_empty());
        insertar_ajeno(&m, M2, "che @yo");
        assert_eq!(m.entorno.avisos.lock().unwrap().len(), 1);
        *m.entorno.ajustes.lock().unwrap() = Some(AjustesAviso { notificar_equipo: true, no_molestar: true });
        m.entorno.reloj.store(1_000_000, Ordering::SeqCst);
        insertar_ajeno(&m, "66666666-6666-4666-8666-666666666666", "otro @yo");
        assert_eq!(m.entorno.avisos.lock().unwrap().len(), 1);
    }

    #[test]
    fn los_avisos_de_una_conversacion_se_espacian_5_segundos_o_2_si_mencionan() {
        let m = mundo(|_| ok_vacio());
        en_marcha(&m);
        listas(&m, vec![equipo(EQ, ChatRole::Member)], vec![]);
        let ids = ["a1111111-1111-4111-8111-111111111111", "a2222222-2222-4222-8222-222222222222", "a3333333-3333-4333-8333-333333333333", "a4444444-4444-4444-8444-444444444444"];
        m.entorno.reloj.store(10_000, Ordering::SeqCst);
        insertar_ajeno(&m, ids[0], "uno");
        m.entorno.reloj.store(12_000, Ordering::SeqCst);
        insertar_ajeno(&m, ids[1], "dos");
        assert_eq!(m.entorno.avisos.lock().unwrap().len(), 1, "2 s no alcanzan para uno común (5 s)");
        m.entorno.reloj.store(11_500, Ordering::SeqCst);
        insertar_ajeno(&m, ids[2], "tres @yo");
        assert_eq!(m.entorno.avisos.lock().unwrap().len(), 1, "1,5 s no alcanza ni para una mención (2 s)");
        m.entorno.reloj.store(12_000, Ordering::SeqCst);
        insertar_ajeno(&m, ids[3], "cuatro @yo");
        assert_eq!(m.entorno.avisos.lock().unwrap().len(), 2);
    }

    #[test]
    fn un_mensaje_de_una_conversacion_desconocida_refresca_las_listas() {
        let m = mundo(|p| if p.url.contains("/rpc/unread_counts") { json_resp(200, json!([])) } else { ok_vacio() });
        en_marcha(&m);
        insertar_ajeno(&m, M1, "hola");
        assert!(pidio(&m, "/rpc/unread_counts"));
    }

    #[test]
    fn un_aviso_de_retencion_se_emite_y_refresca_pero_no_suma_no_leido() {
        let m = mundo(|p| if p.url.contains("/rpc/unread_counts") { json_resp(200, json!([])) } else { ok_vacio() });
        en_marcha(&m);
        listas(&m, vec![equipo(EQ, ChatRole::Member)], vec![]);
        let mut fila = fila_msg(M1, OTRO, "168", "2024-01-01T00:00:05+00:00");
        fila["kind"] = json!("retention");
        m.datos.interno().procesar(1, EventoRealtime::Cambio { canal: INBOX.into(), tipo: "INSERT".into(), fila });
        assert_eq!(m.entorno.emitidos.lock().unwrap()[0].1["notice"]["kind"], "retention");
        assert!(pidio(&m, "/rpc/unread_counts"));
        assert!(m.entorno.avisos.lock().unwrap().is_empty());
    }

    #[test]
    fn lo_que_llega_por_realtime_con_forma_rara_se_ignora() {
        let m = mundo(|_| panic!("no debería tocar la red"));
        en_marcha(&m);
        for fila in [json!(null), json!({"id": 5}), json!({"id": M1, "author_id": OTRO, "body": "x"})] {
            m.datos.interno().procesar(1, EventoRealtime::Cambio { canal: INBOX.into(), tipo: "INSERT".into(), fila });
        }
        m.datos.interno().procesar(2, EventoRealtime::Cambio { canal: INBOX.into(), tipo: "INSERT".into(), fila: fila_msg(M1, OTRO, "x", "2024-01-01T00:00:05+00:00") });
        assert!(m.entorno.emitidos.lock().unwrap().is_empty());
    }

    #[test]
    fn una_edicion_del_mismo_mensaje_cuenta_como_nueva_version() {
        let m = mundo(|_| ok_vacio());
        en_marcha(&m);
        let mut fila = fila_msg(M1, OTRO, "editado", "2024-01-01T00:00:05+00:00");
        fila["edited_at"] = json!("2024-01-01T00:01:00+00:00");
        m.datos.interno().procesar(1, EventoRealtime::Cambio { canal: INBOX.into(), tipo: "UPDATE".into(), fila: fila_msg(M1, OTRO, "original", "2024-01-01T00:00:05+00:00") });
        m.datos.interno().procesar(1, EventoRealtime::Cambio { canal: INBOX.into(), tipo: "UPDATE".into(), fila: fila.clone() });
        m.datos.interno().procesar(1, EventoRealtime::Cambio { canal: INBOX.into(), tipo: "UPDATE".into(), fila });
        assert_eq!(m.entorno.emitidos.lock().unwrap().len(), 2);
    }

    #[test]
    fn el_broadcast_de_otra_conversacion_que_la_del_topico_se_descarta() {
        let m = mundo(|_| ok_vacio());
        en_marcha(&m);
        listas(&m, vec![equipo(EQ, ChatRole::Member)], vec![]);
        let ajena = fila_msg(M1, OTRO, "x", "2024-01-01T00:00:05+00:00");
        m.datos.interno().procesar(1, EventoRealtime::Broadcast { canal: format!("thread:{DM}"), evento: "message".into(), payload: ajena.clone() });
        assert!(m.entorno.emitidos.lock().unwrap().is_empty());
        m.datos.interno().procesar(1, EventoRealtime::Broadcast { canal: format!("team:{EQ}"), evento: "message".into(), payload: ajena });
        assert_eq!(m.entorno.emitidos.lock().unwrap().len(), 1);
    }

    #[test]
    fn reaccion_escribiendo_y_lectura_por_broadcast_se_validan_y_se_emiten() {
        let m = mundo(|_| ok_vacio());
        en_marcha(&m);
        listas(&m, vec![], vec![hilo(DM)]);
        let top = format!("thread:{DM}");
        let ev = |evento: &str, payload: Value| EventoRealtime::Broadcast { canal: top.clone(), evento: evento.into(), payload };
        m.datos.interno().procesar(1, ev("reaction", json!({"message_id": M1, "user_id": OTRO, "emoji": "👍", "op": "add"})));
        m.datos.interno().procesar(1, ev("reaction", json!({"message_id": M1, "user_id": OTRO, "emoji": "💩", "op": "add"})));
        m.datos.interno().procesar(1, ev("typing", json!({"user_id": OTRO})));
        m.datos.interno().procesar(1, ev("typing", json!({"user_id": ME})));
        m.datos.interno().procesar(1, ev("read", json!({"user_id": OTRO, "at": "2024-01-01T00:00:00+00:00"})));
        let e = m.entorno.emitidos.lock().unwrap().clone();
        let nombres: Vec<&str> = e.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(nombres, ["reaction", "typing", "read"]);
        assert_eq!((e[0].1["login"].as_str(), e[0].1["op"].as_str()), (Some("ana"), Some("add")));
        assert_eq!(e[2].1["at"], 1_704_067_200_000i64);
        assert_eq!(m.datos.parte()["threads"][0]["otherReadAt"], 1_704_067_200_000i64);
    }

    #[test]
    fn expulsar_a_uno_mismo_cierra_su_canal_y_refresca() {
        let m = mundo(|p| if p.url.contains("/rpc/unread_counts") { json_resp(200, json!([])) } else { ok_vacio() });
        en_marcha(&m);
        listas(&m, vec![equipo(EQ, ChatRole::Member)], vec![]);
        bloquear(&m.datos.interno().estado).topicos.insert(format!("team:{EQ}"));
        bloquear(&m.datos.interno().estado).canales = Some(m.canales.clone());
        m.datos.interno().procesar(1, EventoRealtime::Broadcast { canal: format!("team:{EQ}"), evento: "member_removed".into(), payload: json!({"user_id": ME, "team_id": EQ}) });
        assert_eq!(*m.canales.salidos.lock().unwrap(), vec![format!("team:{EQ}")]);
        assert!(pidio(&m, "/rpc/unread_counts"));
    }

    #[test]
    fn un_canal_privado_que_no_entra_se_cierra_y_se_avisa_una_sola_vez() {
        let m = mundo(|_| ok_vacio());
        en_marcha(&m);
        bloquear(&m.datos.interno().estado).canales = Some(m.canales.clone());
        for t in [format!("team:{EQ}"), format!("thread:{DM}")] {
            m.datos.interno().procesar(1, EventoRealtime::Estado { canal: t, estado: EstadoCanal::ChannelError });
        }
        assert_eq!(m.canales.salidos.lock().unwrap().len(), 2);
        assert_eq!(m.entorno.logs.lock().unwrap().iter().filter(|l| l.contains("Broadcast")).count(), 1);
        assert_eq!(bloquear(&m.datos.interno().estado).topicos_fallidos.len(), 2);
    }

    #[test]
    fn el_estado_del_inbox_se_traduce_a_la_conexion() {
        let m = mundo(|p| if p.url.contains("/rpc/unread_counts") { json_resp(200, json!([])) } else { ok_vacio() });
        en_marcha(&m);
        let con = |m: &Mundo| m.datos.parte()["connection"].as_str().unwrap().to_string();
        m.datos.interno().procesar(1, EventoRealtime::Estado { canal: INBOX.into(), estado: EstadoCanal::Subscribed });
        assert_eq!(con(&m), "live");
        m.datos.interno().procesar(1, EventoRealtime::Estado { canal: INBOX.into(), estado: EstadoCanal::Closed });
        assert_eq!(con(&m), "retrying");
        m.datos.interno().procesar(1, EventoRealtime::Estado { canal: INBOX.into(), estado: EstadoCanal::TimedOut });
        assert_eq!(con(&m), "retrying");
        bloquear(&m.datos.interno().estado).topicos_fallidos.insert("team:x".into());
        m.datos.interno().procesar(1, EventoRealtime::Estado { canal: INBOX.into(), estado: EstadoCanal::Subscribed });
        assert_eq!(con(&m), "live");
        assert!(bloquear(&m.datos.interno().estado).topicos_fallidos.is_empty(), "al reconectar se vuelven a probar los canales rápidos");
        assert!(pidio(&m, "/rpc/unread_counts"), "y se recargan las listas");
    }

    #[test]
    fn sincronizar_topicos_abre_los_de_las_conversaciones_y_cierra_los_que_sobran() {
        let m = mundo(|_| ok_vacio());
        en_marcha(&m);
        bloquear(&m.datos.interno().estado).canales = Some(m.canales.clone());
        listas(&m, vec![equipo(EQ, ChatRole::Member)], vec![hilo(DM)]);
        m.datos.interno().sincronizar_topicos(1);
        let mut u = m.canales.unidos.lock().unwrap().clone();
        u.sort();
        assert_eq!(u, vec![format!("team:{EQ}"), format!("thread:{DM}")]);
        listas(&m, vec![equipo(EQ, ChatRole::Member)], vec![]);
        m.datos.interno().sincronizar_topicos(1);
        assert_eq!(*m.canales.salidos.lock().unwrap(), vec![format!("thread:{DM}")]);
        m.datos.interno().sincronizar_topicos(1);
        assert_eq!(m.canales.unidos.lock().unwrap().len(), 2, "sin cambios no vuelve a unir");
    }

    // ----- ciclo de vida -----

    fn router_completo(p: &Pedido) -> Result<Respuesta, ErrorRed> {
        if p.url.contains("/rpc/unread_counts") {
            return json_resp(200, json!([]));
        }
        if p.url.contains("/rest/v1/team_members") && p.url.contains("user_id=eq.") {
            return json_resp(200, json!([{"team_id": EQ, "role": "member"}]));
        }
        if p.url.contains("/rest/v1/teams") && p.url.contains("id=in.") {
            return json_resp(200, json!([{"id": EQ, "name": "Equipo", "description": "", "photo_path": null}]));
        }
        ok_vacio()
    }

    #[test]
    fn arrancar_abre_el_inbox_detecta_migraciones_carga_listas_y_los_canales_rapidos() {
        let m = mundo(router_completo);
        m.datos.arrancar();
        assert_eq!(m.canales.unidos.lock().unwrap()[0], "sloth-inbox");
        assert!(m.canales.unidos.lock().unwrap().contains(&format!("team:{EQ}")));
        let p = m.datos.parte();
        assert_eq!((p["listsLoaded"].as_bool(), p["extras"].as_bool(), p["connection"].as_str()), (Some(true), Some(true), Some("connecting")));
        assert_eq!(m.datos.conversaciones().unwrap().len(), 1);
        assert!(pidio(&m, "/rpc/chat_purge_expired"));
        m.datos.arrancar();
        assert_eq!(m.canales.unidos.lock().unwrap().iter().filter(|n| *n == "sloth-inbox").count(), 1, "no abre dos conexiones");
        m.datos.parar();
    }

    #[test]
    fn el_hilo_de_eventos_entrega_lo_que_manda_el_socket() {
        let m = mundo(router_completo);
        m.datos.arrancar();
        m.eventos.send(EventoRealtime::Estado { canal: INBOX.into(), estado: EstadoCanal::Subscribed }).unwrap();
        m.eventos.send(EventoRealtime::Cambio { canal: INBOX.into(), tipo: "INSERT".into(), fila: fila_msg(M1, OTRO, "por el socket", "2024-01-01T00:00:05+00:00") }).unwrap();
        // El hilo consumidor es asíncrono: se espera el efecto; el plazo es solo para que un fallo no cuelgue la corrida.
        let limite = std::time::Instant::now() + Duration::from_secs(30);
        while m.entorno.emitidos.lock().unwrap().is_empty() {
            assert!(std::time::Instant::now() < limite, "el mensaje no llegó");
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(m.entorno.emitidos.lock().unwrap()[0].1["body"], "por el socket");
        m.datos.parar();
    }

    #[test]
    fn parar_cierra_el_socket_y_vacia_todo() {
        let m = mundo(router_completo);
        m.datos.arrancar();
        m.datos.parar();
        assert!(*m.canales.cerrado.lock().unwrap());
        let p = m.datos.parte();
        assert_eq!((p["connection"].as_str(), p["listsLoaded"].as_bool(), p["extras"].as_bool(), p["teams"].as_array().unwrap().len()), (Some("off"), Some(false), Some(false), 0));
        assert!(m.datos.conversaciones().is_err());
    }

    #[test]
    fn enfocar_la_ventana_marca_leido_lo_que_se_esta_mirando() {
        let m = mundo(|_| json_resp(200, Value::Null));
        en_marcha(&m);
        let mut t = equipo(EQ, ChatRole::Member);
        t.unread = 4;
        listas(&m, vec![t], vec![]);
        *m.entorno.foco.lock().unwrap() = true;
        m.datos.poner_vista(&json!({"open": true, "conv": conv_eq()})).unwrap();
        assert!(pidio(&m, "/rpc/mark_read"));
        assert_eq!(m.datos.parte()["teams"][0]["unread"], 0);
        assert!(m.datos.poner_vista(&json!({"open": "si"})).is_err());
    }

    #[test]
    fn el_uuid_de_las_fotos_es_un_v4_valido() {
        let u = uuid_nuevo().unwrap();
        assert!(es_uuid(&u, true));
        assert_eq!(&u[14..15], "4");
        assert_ne!(u, uuid_nuevo().unwrap());
    }
}
