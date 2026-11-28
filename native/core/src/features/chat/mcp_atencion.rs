//! Chat por Claude: lo que hace el main con cada línea que llega por el pipe, PURO (todo lo de afuera entra por
//! `AtencionDeps`). La cuenta sale del token; el espacio que manda la terminal solo se muestra. Equivale a
//! chat-mcp-atencion.ts. Cada conexión corre en su hilo: un pedido que espera permiso bloquea ese hilo hasta que la
//! persona responde o vence el plazo.
use super::fecha::iso_de_ms;
use super::mcp_core::*;
use super::tipos::*;
use super::{mensaje_corto, Res};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const NO_AUTORIZADO: &str = "No autorizado.";
pub const NO_PERMITIDO: &str = "El usuario no lo permitió (o no respondió a tiempo).";
pub const APAGADO: &str = "El chat por Claude está apagado. Se prende en Configuración → Chat.";
pub const CUENTA_NO: &str = "Esta cuenta de Claude no tiene permitido usar el chat. Se elige en Configuración → Chat.";

#[derive(Debug, Clone, PartialEq)]
pub struct MsgLeido {
    pub author_login: String,
    pub body: String,
    pub created_at: i64,
    pub deleted_at: Option<i64>,
    pub notice: bool,
    pub via_claude: bool,
}

pub trait AtencionDeps: Send + Sync {
    fn config(&self) -> McpConfig;
    fn existentes(&self) -> Vec<String>;
    fn conversaciones(&self) -> Res<Vec<ConvCandidata>>;
    fn leer_ultimos(&self, conv: &ChatConvRef, n: usize) -> Res<Vec<MsgLeido>>;
    fn enviar(&self, conv: &ChatConvRef, texto: &str) -> Res<()>;
    fn via_column(&self) -> bool;
    /// Nombre y cuenta dueña del espacio.
    fn espacio(&self, id: &str) -> Option<(String, String)>;
    fn etiqueta_cuenta(&self, id: &str) -> Option<String>;
    /// «Siempre» en un pedido de leer: el main lo guarda en la config.
    fn guardar_grant(&self, cuenta: &str, conv: &ChatConvRef, nombre: &str);
    fn modo_riesgoso(&self, cuenta: &str, ws: &str) -> Option<ModoRiesgoso>;
    fn pedidos_cambiaron(&self, asks: Vec<ChatMcpAsk>);
    fn avisar(&self, ask: &ChatMcpAsk, donde: &str);
    fn ahora(&self) -> i64;
    fn nuevo_id(&self) -> String;
    fn ask_ms(&self) -> i64 {
        MCP_LIMITS.ask_ms
    }
}

pub type Respuesta = Result<String, String>;

struct Espera {
    resultado: Mutex<Option<bool>>,
    cv: Condvar,
}

struct Pendiente {
    ask: ChatMcpAsk,
    cuenta: String,
    key: String,
    espera: Arc<Espera>,
}

struct Topes {
    leer: Tope,
    enviar: Tope,
}

#[derive(Default)]
struct Interno {
    pendientes: Vec<Pendiente>,
    topes: HashMap<String, Topes>,
}

pub struct Atencion<D: AtencionDeps> {
    d: Arc<D>,
    interno: Mutex<Interno>,
}

fn bloquear<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn msg_de(e: &str) -> String {
    mensaje_corto(e)
}

impl<D: AtencionDeps> Atencion<D> {
    pub fn nueva(d: Arc<D>) -> Self {
        Atencion { d, interno: Mutex::new(Interno::default()) }
    }

    fn lista(i: &Interno) -> Vec<ChatMcpAsk> {
        i.pendientes.iter().map(|p| p.ask.clone()).collect()
    }

    pub fn pendientes(&self) -> Vec<ChatMcpAsk> {
        Self::lista(&bloquear(&self.interno))
    }

    fn emitir(&self, lista: Vec<ChatMcpAsk>) {
        self.d.pedidos_cambiaron(lista);
    }

    /// La cuenta sigue habilitada y con el mismo token que autenticó el pedido.
    fn vigente(&self, cuenta: &str, hash: &str) -> bool {
        let cfg = self.d.config();
        cfg.enabled && debe_registrar(cfg.enabled, &cfg.cuentas, cuenta, &self.d.existentes()) && cfg.hash_de(cuenta) == Some(hash)
    }

    /// Saca el pendiente y despierta a quien espera. `None` si ya no estaba.
    fn cerrar(i: &mut Interno, id: &str, ok: bool) -> Option<Vec<ChatMcpAsk>> {
        let pos = i.pendientes.iter().position(|p| p.ask.id == id)?;
        let p = i.pendientes.remove(pos);
        *bloquear(&p.espera.resultado) = Some(ok);
        p.espera.cv.notify_all();
        Some(Self::lista(i))
    }

    fn esperar(&self, espera: &Espera, id: &str, ask_ms: i64) -> bool {
        let limite = Instant::now() + Duration::from_millis(ask_ms.max(0) as u64);
        let mut r = bloquear(&espera.resultado);
        loop {
            if let Some(ok) = *r {
                return ok;
            }
            let Some(resto) = limite.checked_duration_since(Instant::now()) else { break };
            r = espera.cv.wait_timeout(r, resto).unwrap_or_else(|e| e.into_inner()).0;
        }
        drop(r);
        let lista = Self::cerrar(&mut bloquear(&self.interno), id, false);
        if let Some(l) = lista {
            self.emitir(l);
        }
        bloquear(&espera.resultado).unwrap_or(false)
    }

    fn preguntar(&self, cuenta: &str, ws: &str, cand: &ConvCandidata, op: ChatMcpOp, preview: Option<&str>) -> bool {
        // El origen y, en «enviar», el texto son parte del pedido: aprobar uno no aprueba otro.
        let key = json!([cuenta, ws, conv_key(&cand.conv), if op == ChatMcpOp::Leer { "leer" } else { "enviar" }, preview.unwrap_or("")]).to_string();
        let ask_ms = self.d.ask_ms();
        let (espera, ask, lista) = {
            let mut i = bloquear(&self.interno);
            if let Some(p) = i.pendientes.iter().find(|p| p.key == key) {
                let (e, id) = (p.espera.clone(), p.ask.id.clone());
                drop(i);
                return self.esperar(&e, &id, ask_ms);
            }
            if i.pendientes.len() >= MCP_LIMITS.max_pendientes {
                return false;
            }
            let w = if ws.is_empty() { None } else { self.d.espacio(ws) };
            let mut ask = ChatMcpAsk {
                id: self.d.nuevo_id(),
                op,
                conv: cand.conv.clone(),
                nombre: limpiar_nombre(&cand.nombre),
                account: limpiar_nombre(&self.d.etiqueta_cuenta(cuenta).unwrap_or_else(|| "cuenta sin nombre".into())),
                workspace: None,
                preview: None,
                sin_siempre: None,
                expires_at: self.d.ahora() + ask_ms,
            };
            if let Some((nombre, dueno)) = w {
                if dueno == cuenta {
                    ask.workspace = Some(limpiar_nombre(&nombre));
                }
            }
            ask.preview = preview.map(String::from);
            if op == ChatMcpOp::Leer {
                ask.sin_siempre = self.d.modo_riesgoso(cuenta, ws);
            }
            let espera = Arc::new(Espera { resultado: Mutex::new(None), cv: Condvar::new() });
            i.pendientes.push(Pendiente { ask: ask.clone(), cuenta: cuenta.into(), key, espera: espera.clone() });
            (espera, ask.clone(), Self::lista(&i))
        };
        self.emitir(lista);
        let donde = if cand.tipo == TipoCandidata::Directo { format!("@{}", ask.nombre) } else { ask.nombre.clone() };
        self.d.avisar(&ask, &donde);
        self.esperar(&espera, &ask.id, ask_ms)
    }

    fn exigir_permiso(&self, cuenta: &str, hash: &str, ws: &str, cand: &ConvCandidata, op: ChatMcpOp, preview: Option<&str>) -> Res<()> {
        let guardado = self.d.modo_riesgoso(cuenta, ws).is_none() && permitido(&self.d.config().grants, cuenta, &cand.conv, op);
        if !guardado && !self.preguntar(cuenta, ws, cand, op, preview) {
            return Err(NO_PERMITIDO.into());
        }
        // Mientras esperaba, el usuario pudo apagar, desmarcar la cuenta o borrarla.
        if !self.vigente(cuenta, hash) {
            return Err(if self.d.config().enabled { CUENTA_NO } else { APAGADO }.into());
        }
        Ok(())
    }

    fn tomar(&self, cuenta: &str, leer: bool) -> bool {
        let ahora = self.d.ahora();
        let mut i = bloquear(&self.interno);
        let t = i.topes.entry(cuenta.to_string()).or_insert_with(|| Topes {
            leer: Tope::nuevo(MCP_LIMITS.leer_por_minuto as usize, 60_000),
            enviar: Tope::nuevo(MCP_LIMITS.enviar_por_minuto as usize, 60_000),
        });
        if leer {
            t.leer.tomar(ahora)
        } else {
            t.enviar.tomar(ahora)
        }
    }

    fn atender(&self, cuenta: &str, hash: &str, ws: &str, pedido: &McpPedido) -> Res<String> {
        let sin_lecturas = || format!("Más de {} lecturas en un minuto. Esperá un poco.", MCP_LIMITS.leer_por_minuto);
        match pedido {
            McpPedido::Listar => {
                if !self.tomar(cuenta, true) {
                    return Err(sin_lecturas());
                }
                let convs: Vec<Value> = self
                    .d
                    .conversaciones()?
                    .iter()
                    .map(|c| {
                        let nombre = if c.tipo == TipoCandidata::Directo { format!("@{}", c.nombre) } else { c.nombre.clone() };
                        json!({"id": conv_key(&c.conv), "tipo": c.tipo.como_str(), "nombre": nombre})
                    })
                    .collect();
                Ok(envolver_contenido("Conversaciones del chat de Sloth. Usá el id en chat_leer y chat_enviar.", &Value::Array(convs)))
            }
            McpPedido::Leer { conversacion, n } => {
                let n = validar_n(n.as_ref())?;
                let cand = resolver_conversacion(conversacion, &self.d.conversaciones()?)?;
                if !self.tomar(cuenta, true) {
                    return Err(sin_lecturas());
                }
                self.exigir_permiso(cuenta, hash, ws, &cand, ChatMcpOp::Leer, None)?;
                let via = self.d.via_column();
                let msgs = self.d.leer_ultimos(&cand.conv, n)?;
                let items: Vec<Value> = msgs
                    .iter()
                    .filter(|m| !m.notice && m.deleted_at.is_none())
                    .map(|m| {
                        let via_claude = if via { m.via_claude } else { m.body.starts_with(VIA_CLAUDE_PREFIX) };
                        json!({"autor": format!("@{}", m.author_login), "fecha": iso_de_ms(m.created_at), "texto": m.body, "viaClaude": via_claude})
                    })
                    .collect();
                Ok(envolver_contenido(&format!("Últimos {} mensajes de {}, del más viejo al más nuevo.", items.len(), conv_key(&cand.conv)), &Value::Array(items)))
            }
            McpPedido::Enviar { conversacion, texto } => {
                let max = if self.d.via_column() { MCP_LIMITS.max_texto } else { MCP_LIMITS.max_texto - VIA_CLAUDE_PREFIX.chars().count() };
                let texto = validar_texto(texto, max)?;
                let cand = resolver_conversacion(conversacion, &self.d.conversaciones()?)?;
                if !self.tomar(cuenta, false) {
                    return Err(format!("Más de {} mensajes en un minuto. Esperá un poco.", MCP_LIMITS.enviar_por_minuto));
                }
                self.exigir_permiso(cuenta, hash, ws, &cand, ChatMcpOp::Enviar, Some(&texto))?;
                self.d.enviar(&cand.conv, &texto)?;
                // Sin el nombre: lo eligió una persona y esto vuelve a Claude fuera del bloque de datos.
                Ok(format!("Enviado a {}.", conv_key(&cand.conv)))
            }
        }
    }

    pub fn atender_linea(&self, linea: &str) -> Respuesta {
        if linea.encode_utf16().count() > MCP_LIMITS.max_linea {
            return Err(NO_AUTORIZADO.into());
        }
        let p = parsear_pedido(linea).map_err(|_| NO_AUTORIZADO.to_string())?;
        let cfg = self.d.config();
        let cuenta = cuenta_del_token(&p.token, &cfg.tokens).ok_or_else(|| NO_AUTORIZADO.to_string())?;
        if !cfg.enabled {
            return Err(APAGADO.into());
        }
        let hash = cfg.hash_de(&cuenta).unwrap_or_default().to_string();
        if !self.vigente(&cuenta, &hash) {
            return Err(CUENTA_NO.into());
        }
        self.atender(&cuenta, &hash, &p.ws, &p.pedido).map_err(|e| msg_de(&e))
    }

    pub fn responder(&self, id: &str, choice: ChatMcpChoice) -> Res<()> {
        let mut i = bloquear(&self.interno);
        let Some(p) = i.pendientes.iter().find(|p| p.ask.id == id) else { return Ok(()) };
        if choice == ChatMcpChoice::Always {
            if p.ask.op != ChatMcpOp::Leer {
                return Err("Para enviar no hay «siempre»: cada mensaje se confirma.".into());
            }
            if let Some(m) = p.ask.sin_siempre {
                return Err(format!("Con la cuenta en {} no hay «siempre»: cada lectura se confirma.", m.como_str()));
            }
            let (cuenta, conv, nombre) = (p.cuenta.clone(), p.ask.conv.clone(), p.ask.nombre.clone());
            drop(i);
            self.d.guardar_grant(&cuenta, &conv, &nombre);
            let lista = Self::cerrar(&mut bloquear(&self.interno), id, true);
            if let Some(l) = lista {
                self.emitir(l);
            }
            return Ok(());
        }
        let lista = Self::cerrar(&mut i, id, choice == ChatMcpChoice::Once);
        drop(i);
        if let Some(l) = lista {
            self.emitir(l);
        }
        Ok(())
    }

    pub fn denegar_todos(&self) {
        let lista = {
            let mut i = bloquear(&self.interno);
            if i.pendientes.is_empty() {
                return;
            }
            let ids: Vec<String> = i.pendientes.iter().map(|p| p.ask.id.clone()).collect();
            let mut ultima = Vec::new();
            for id in ids {
                if let Some(l) = Self::cerrar(&mut i, &id, false) {
                    ultima = l;
                }
            }
            ultima
        };
        self.emitir(lista);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;

    const T1: &str = "11111111-1111-4111-8111-111111111111";

    fn tok_a() -> String {
        "a".repeat(64)
    }
    fn tok_b() -> String {
        "b".repeat(64)
    }

    struct Falsa {
        cfg: Mutex<McpConfig>,
        asks: Mutex<Vec<Vec<ChatMcpAsk>>>,
        enviados: Mutex<Vec<String>>,
        grants: Mutex<Vec<String>>,
        modo: Mutex<Option<ModoRiesgoso>>,
        via: Mutex<bool>,
        n: AtomicUsize,
        ask_ms: i64,
    }

    impl AtencionDeps for Falsa {
        fn config(&self) -> McpConfig {
            bloquear(&self.cfg).clone()
        }
        fn existentes(&self) -> Vec<String> {
            vec!["A".into(), "B".into()]
        }
        fn conversaciones(&self) -> Res<Vec<ConvCandidata>> {
            Ok(vec![ConvCandidata { conv: ChatConvRef::equipo(T1), nombre: "Diseño\u{202e}".into(), tipo: TipoCandidata::Equipo }])
        }
        fn leer_ultimos(&self, _: &ChatConvRef, _: usize) -> Res<Vec<MsgLeido>> {
            Ok(vec![MsgLeido { author_login: "ana".into(), body: "hola".into(), created_at: 0, deleted_at: None, notice: false, via_claude: false }])
        }
        fn enviar(&self, _: &ChatConvRef, texto: &str) -> Res<()> {
            bloquear(&self.enviados).push(texto.into());
            Ok(())
        }
        fn via_column(&self) -> bool {
            *bloquear(&self.via)
        }
        fn espacio(&self, id: &str) -> Option<(String, String)> {
            match id {
                "wA" => Some(("Espacio A".into(), "A".into())),
                "wB" => Some(("Espacio B".into(), "B".into())),
                _ => None,
            }
        }
        fn etiqueta_cuenta(&self, id: &str) -> Option<String> {
            Some(format!("Cuenta {id}"))
        }
        fn guardar_grant(&self, cuenta: &str, conv: &ChatConvRef, _: &str) {
            bloquear(&self.grants).push(format!("{cuenta}|{}", conv_key(conv)));
            let mut c = bloquear(&self.cfg);
            c.grants = con_grant(&c.grants, cuenta, conv, "x", 0);
        }
        fn modo_riesgoso(&self, _: &str, _: &str) -> Option<ModoRiesgoso> {
            *bloquear(&self.modo)
        }
        fn pedidos_cambiaron(&self, asks: Vec<ChatMcpAsk>) {
            bloquear(&self.asks).push(asks);
        }
        fn avisar(&self, _: &ChatMcpAsk, _: &str) {}
        fn ahora(&self) -> i64 {
            1000
        }
        fn nuevo_id(&self) -> String {
            format!("id{}", self.n.fetch_add(1, Ordering::SeqCst) + 1)
        }
        fn ask_ms(&self) -> i64 {
            self.ask_ms
        }
    }

    fn armar_con(cfg: McpConfig, ask_ms: i64) -> Arc<Atencion<Falsa>> {
        let d = Falsa {
            cfg: Mutex::new(cfg),
            asks: Mutex::default(),
            enviados: Mutex::default(),
            grants: Mutex::default(),
            modo: Mutex::new(None),
            via: Mutex::new(true),
            n: AtomicUsize::new(0),
            ask_ms,
        };
        Arc::new(Atencion::nueva(Arc::new(d)))
    }

    fn cfg_base() -> McpConfig {
        McpConfig {
            enabled: true,
            cuentas: vec!["A".into(), "B".into()],
            grants: vec![],
            tokens: vec![("A".into(), hash_token(&tok_a())), ("B".into(), hash_token(&tok_b()))],
        }
    }

    fn armar() -> Arc<Atencion<Falsa>> {
        armar_con(cfg_base(), 5000)
    }

    fn linea(token: &str, pedido: Value, ws: &str) -> String {
        json!({"token": token, "ws": ws, "pedido": pedido}).to_string()
    }

    fn leer() -> Value {
        json!({"op": "leer", "conversacion": format!("team:{T1}")})
    }

    fn ultimo(s: &Atencion<Falsa>) -> Vec<ChatMcpAsk> {
        bloquear(&s.d.asks).last().cloned().unwrap_or_default()
    }

    /// Lanza el pedido en otro hilo y espera a que aparezcan `n` pendientes.
    fn lanzar(s: &Arc<Atencion<Falsa>>, l: String, n: usize) -> thread::JoinHandle<Respuesta> {
        let s2 = s.clone();
        let h = thread::spawn(move || s2.atender_linea(&l));
        esperar_pendientes(s, n);
        h
    }

    fn esperar_pendientes(s: &Atencion<Falsa>, n: usize) {
        let hasta = Instant::now() + Duration::from_secs(5);
        while s.pendientes().len() != n {
            assert!(Instant::now() < hasta, "no llegaron {n} pendientes");
            thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn token_incorrecto_con_el_largo_correcto_no_autorizado() {
        assert_eq!(armar().atender_linea(&linea(&"c".repeat(64), json!({"op": "listar"}), "")), Err(NO_AUTORIZADO.into()));
    }

    #[test]
    fn una_linea_mas_larga_que_el_tope_no_se_procesa() {
        let s = armar();
        let r = s.atender_linea(&linea(&tok_a(), json!({"op": "enviar", "conversacion": T1, "texto": "x".repeat(MCP_LIMITS.max_linea)}), ""));
        assert_eq!(r, Err(NO_AUTORIZADO.into()));
        assert!(bloquear(&s.d.asks).is_empty());
    }

    #[test]
    fn cuenta_no_marcada_su_token_ya_no_vale_para_nada() {
        let s = armar_con(McpConfig { cuentas: vec!["A".into()], ..cfg_base() }, 5000);
        assert_eq!(s.atender_linea(&linea(&tok_b(), json!({"op": "listar"}), "")), Err(CUENTA_NO.into()));
        assert!(s.atender_linea(&linea(&tok_a(), json!({"op": "listar"}), "")).is_ok());
    }

    #[test]
    fn apagado_nada_pasa() {
        let s = armar_con(McpConfig { enabled: false, ..cfg_base() }, 5000);
        assert_eq!(s.atender_linea(&linea(&tok_a(), json!({"op": "listar"}), "")), Err(APAGADO.into()));
    }

    #[test]
    fn listar_devuelve_los_datos_envueltos_y_con_arroba_en_los_directos() {
        let r = armar().atender_linea(&linea(&tok_a(), json!({"op": "listar"}), "")).unwrap();
        assert!(r.starts_with("Conversaciones del chat de Sloth. Usá el id en chat_leer y chat_enviar.\n<<contenido_del_chat"));
        assert!(r.contains(&format!("\"id\": \"team:{T1}\"")) && r.contains("\"tipo\": \"equipo\""));
    }

    #[test]
    fn la_cuenta_del_dialogo_sale_del_token_y_el_espacio_de_otra_cuenta_no_se_muestra() {
        let s = armar();
        let h = lanzar(&s, linea(&tok_b(), leer(), "wA"), 1);
        let ask = ultimo(&s).remove(0);
        assert_eq!(ask.account, "Cuenta B");
        assert_eq!(ask.workspace, None);
        assert_eq!(ask.nombre, "Diseño");
        s.responder(&ask.id, ChatMcpChoice::Deny).unwrap();
        assert_eq!(h.join().unwrap(), Err(NO_PERMITIDO.into()));
    }

    #[test]
    fn el_espacio_de_la_misma_cuenta_se_muestra_como_dato() {
        let s = armar();
        let h = lanzar(&s, linea(&tok_a(), leer(), "wA"), 1);
        let ask = ultimo(&s).remove(0);
        assert_eq!(ask.workspace.as_deref(), Some("Espacio A"));
        s.responder(&ask.id, ChatMcpChoice::Once).unwrap();
        assert!(h.join().unwrap().is_ok());
    }

    #[test]
    fn dedupe_por_origen_el_mismo_pedido_desde_otra_cuenta_abre_su_propio_dialogo() {
        let s = armar();
        let pa = lanzar(&s, linea(&tok_a(), leer(), ""), 1);
        let s2 = s.clone();
        let l = linea(&tok_a(), leer(), "");
        let pa2 = thread::spawn(move || s2.atender_linea(&l));
        thread::sleep(Duration::from_millis(50));
        let pb = lanzar(&s, linea(&tok_b(), leer(), ""), 2);
        let pend = ultimo(&s);
        assert_eq!(pend.len(), 2);
        s.responder(&pend[0].id, ChatMcpChoice::Once).unwrap();
        assert!(pa.join().unwrap().is_ok());
        assert!(pa2.join().unwrap().is_ok());
        assert_eq!(s.pendientes().len(), 1);
        s.responder(&pend[1].id, ChatMcpChoice::Deny).unwrap();
        assert!(pb.join().unwrap().is_err());
    }

    #[test]
    fn si_se_desmarca_la_cuenta_mientras_espera_aprobar_no_alcanza() {
        let s = armar();
        let h = lanzar(&s, linea(&tok_a(), leer(), ""), 1);
        bloquear(&s.d.cfg).cuentas = vec!["B".into()];
        s.responder(&ultimo(&s)[0].id, ChatMcpChoice::Once).unwrap();
        assert_eq!(h.join().unwrap(), Err(CUENTA_NO.into()));
    }

    #[test]
    fn si_se_apaga_o_cambia_el_token_mientras_espera_tampoco() {
        let s = armar();
        let h = lanzar(&s, linea(&tok_a(), leer(), ""), 1);
        bloquear(&s.d.cfg).enabled = false;
        s.responder(&ultimo(&s)[0].id, ChatMcpChoice::Once).unwrap();
        assert_eq!(h.join().unwrap(), Err(APAGADO.into()));
        let s2 = armar();
        let h2 = lanzar(&s2, linea(&tok_a(), leer(), ""), 1);
        bloquear(&s2.d.cfg).tokens[0].1 = hash_token(&"d".repeat(64));
        s2.responder(&ultimo(&s2)[0].id, ChatMcpChoice::Once).unwrap();
        assert_eq!(h2.join().unwrap(), Err(CUENTA_NO.into()));
    }

    #[test]
    fn siempre_para_leer_queda_por_cuenta_otra_cuenta_vuelve_a_preguntar() {
        let s = armar();
        let h = lanzar(&s, linea(&tok_a(), leer(), ""), 1);
        s.responder(&ultimo(&s)[0].id, ChatMcpChoice::Always).unwrap();
        assert!(h.join().unwrap().is_ok());
        assert_eq!(*bloquear(&s.d.grants), vec![format!("A|team:{T1}")]);
        let antes = bloquear(&s.d.asks).len();
        assert!(s.atender_linea(&linea(&tok_a(), leer(), "")).is_ok());
        assert_eq!(bloquear(&s.d.asks).len(), antes);
        let pb = lanzar(&s, linea(&tok_b(), leer(), ""), 1);
        assert_eq!(ultimo(&s).len(), 1);
        s.responder(&ultimo(&s)[0].id, ChatMcpChoice::Deny).unwrap();
        assert!(pb.join().unwrap().is_err());
    }

    #[test]
    fn enviar_no_acepta_siempre_y_muestra_el_texto_exacto() {
        let s = armar();
        let h = lanzar(&s, linea(&tok_a(), json!({"op": "enviar", "conversacion": T1, "texto": "  hola\r\nchau "}), ""), 1);
        let ask = ultimo(&s).remove(0);
        assert_eq!(ask.preview.as_deref(), Some("hola\nchau"));
        assert!(s.responder(&ask.id, ChatMcpChoice::Always).unwrap_err().contains("siempre"));
        assert_eq!(s.pendientes().len(), 1);
        s.responder(&ask.id, ChatMcpChoice::Once).unwrap();
        assert_eq!(h.join().unwrap(), Ok(format!("Enviado a team:{T1}.")));
        assert_eq!(*bloquear(&s.d.enviados), vec!["hola\nchau".to_string()]);
    }

    #[test]
    fn sin_la_columna_via_el_tope_de_texto_descuenta_el_prefijo() {
        let s = armar();
        *bloquear(&s.d.via) = false;
        let r = s.atender_linea(&linea(&tok_a(), json!({"op": "enviar", "conversacion": T1, "texto": "a".repeat(MCP_LIMITS.max_texto)}), ""));
        assert!(r.unwrap_err().contains("caracteres"));
    }

    #[test]
    fn listar_cuenta_para_el_tope_de_lecturas() {
        let s = armar();
        for _ in 0..MCP_LIMITS.leer_por_minuto {
            assert!(s.atender_linea(&linea(&tok_a(), json!({"op": "listar"}), "")).is_ok());
        }
        assert!(s.atender_linea(&linea(&tok_a(), json!({"op": "listar"}), "")).is_err());
        assert!(s.atender_linea(&linea(&tok_b(), json!({"op": "listar"}), "")).is_ok());
    }

    fn con_grant_de_a() -> McpConfig {
        McpConfig { grants: vec![ChatMcpGrant { account_id: "A".into(), conv: ChatConvRef::equipo(T1), nombre: "x".into(), at: 0.0 }], ..cfg_base() }
    }

    #[test]
    fn con_la_cuenta_en_bypass_un_siempre_guardado_igual_pregunta_y_marca_sin_siempre() {
        let s = armar_con(con_grant_de_a(), 5000);
        *bloquear(&s.d.modo) = Some(ModoRiesgoso::BypassPermissions);
        let h = lanzar(&s, linea(&tok_a(), leer(), ""), 1);
        let ask = ultimo(&s).remove(0);
        assert_eq!(ask.sin_siempre, Some(ModoRiesgoso::BypassPermissions));
        s.responder(&ask.id, ChatMcpChoice::Once).unwrap();
        assert!(h.join().unwrap().is_ok());
    }

    #[test]
    fn con_la_cuenta_en_bypass_responder_siempre_tira_error_y_el_pedido_sigue() {
        let s = armar();
        *bloquear(&s.d.modo) = Some(ModoRiesgoso::AcceptEdits);
        let h = lanzar(&s, linea(&tok_a(), leer(), ""), 1);
        let ask = ultimo(&s).remove(0);
        assert!(s.responder(&ask.id, ChatMcpChoice::Always).unwrap_err().contains("no hay «siempre»"));
        assert_eq!(s.pendientes().len(), 1);
        assert!(bloquear(&s.d.grants).is_empty());
        s.responder(&ask.id, ChatMcpChoice::Deny).unwrap();
        assert!(h.join().unwrap().is_err());
    }

    #[test]
    fn sin_modo_riesgoso_un_grant_guardado_no_pregunta_y_el_pedido_no_trae_sin_siempre() {
        let s = armar_con(con_grant_de_a(), 5000);
        assert!(s.atender_linea(&linea(&tok_a(), leer(), "")).is_ok());
        assert!(bloquear(&s.d.asks).is_empty());
        let s2 = armar();
        let h = lanzar(&s2, linea(&tok_a(), leer(), ""), 1);
        assert_eq!(ultimo(&s2)[0].sin_siempre, None);
        s2.responder(&ultimo(&s2)[0].id, ChatMcpChoice::Once).unwrap();
        h.join().unwrap().unwrap();
    }

    #[test]
    fn un_pedido_sin_respuesta_vence_y_se_deniega() {
        let s = armar_con(cfg_base(), 60);
        assert_eq!(s.atender_linea(&linea(&tok_a(), leer(), "")), Err(NO_PERMITIDO.into()));
        assert!(s.pendientes().is_empty());
        assert!(ultimo(&s).is_empty());
    }

    #[test]
    fn denegar_todos_cierra_lo_pendiente() {
        let s = armar();
        let h = lanzar(&s, linea(&tok_a(), leer(), ""), 1);
        s.denegar_todos();
        assert_eq!(h.join().unwrap(), Err(NO_PERMITIDO.into()));
    }

    #[test]
    fn no_hay_mas_de_cinco_pedidos_pendientes() {
        let s = armar();
        let mut hs = Vec::new();
        for i in 0..MCP_LIMITS.max_pendientes {
            let texto = format!("t{i}");
            hs.push(lanzar(&s, linea(&tok_a(), json!({"op": "enviar", "conversacion": T1, "texto": texto}), ""), i + 1));
        }
        assert_eq!(s.atender_linea(&linea(&tok_a(), json!({"op": "enviar", "conversacion": T1, "texto": "otro"}), "")), Err(NO_PERMITIDO.into()));
        s.denegar_todos();
        for h in hs {
            assert!(h.join().unwrap().is_err());
        }
    }
}
