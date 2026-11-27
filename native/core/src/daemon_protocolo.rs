//! Protocolo v2 entre la app y el daemon de terminales: un mensaje JSON por línea ("\n") por un named pipe. Equivale a
//! src/shared/daemon-protocol.ts, src/daemon/auth.ts y src/daemon/paths.ts, y es el mismo formato que habla
//! native/daemon: lo que se encode acá lo entiende ese daemon y viceversa (los fixtures de los tests son bytes reales).
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use subtle::ConstantTimeEq;

/// Va en el nombre del pipe: si cambia el protocolo de forma incompatible, se sube.
pub const PROTOCOLO_VERSION: u32 = 2;
/// Tope de una línea del daemon ya autenticado (el mismo que aplica el daemon a las del cliente).
pub const LINEA_LIMITE: usize = 32 * 1024 * 1024;

pub const DAEMON_EXE_NAME: &str = "sloth-daemon.exe";
pub const DAEMON_SCRIPT_NAME: &str = "sloth-daemon.cjs";

pub const HOOK_EVENTS: [&str; 6] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification", "Stop", "SessionEnd"];

// ---------- Autenticación ----------

pub fn es_hex64(s: &str, solo_minusculas: bool) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || (!solo_minusculas && (b'A'..=b'F').contains(&b)))
}

/// El nonce que manda el daemon tiene que ser hex en minúsculas de 64 caracteres.
pub fn es_nonce(s: &str) -> bool {
    es_hex64(s, true)
}

/// La clave de `daemon-key` acepta mayúsculas y minúsculas.
pub fn es_clave(s: &str) -> bool {
    es_hex64(s, false)
}

pub fn nuevo_nonce() -> String {
    let mut b = [0u8; 32];
    getrandom::getrandom(&mut b).expect("sin fuente de azar del sistema");
    hex::encode(b)
}

fn hmac_hex(key: &str, data: &str) -> String {
    let mut m = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC acepta cualquier largo de clave");
    m.update(data.as_bytes());
    hex::encode(m.finalize().into_bytes())
}

pub fn prueba_daemon(key: &str, nonce_cliente: &str, nonce_daemon: &str) -> String {
    hmac_hex(key, &format!("sloth-daemon|{nonce_cliente}|{nonce_daemon}"))
}

pub fn prueba_cliente(key: &str, nonce_cliente: &str, nonce_daemon: &str) -> String {
    hmac_hex(key, &format!("sloth-client|{nonce_cliente}|{nonce_daemon}"))
}

/// Cada espacio recibe un token derivado: el de uno no sirve para mandar hooks en nombre de otro.
pub fn hook_token_de(hook_token: &str, ws: &str) -> String {
    hmac_hex(hook_token, &format!("ws:{ws}"))
}

pub fn misma_prueba(dada: &str, esperada: &str) -> bool {
    dada.len() == esperada.len() && dada.as_bytes().ct_eq(esperada.as_bytes()).into()
}

// ---------- Nombres de pipe y archivos ----------

/// Lo que hace `path.resolve` de Node en Windows con una ruta absoluta: barras al revés, sin `.` ni `..` y sin barra final.
fn resolver_ruta_windows(ruta: &str) -> String {
    let t = ruta.replace('/', "\\");
    let (prefijo, resto) = if let Some(r) = t.strip_prefix("\\\\") {
        let mut partes = r.splitn(3, '\\');
        let (host, share, resto) = (partes.next().unwrap_or(""), partes.next().unwrap_or(""), partes.next().unwrap_or(""));
        (format!("\\\\{host}\\{share}\\"), resto.to_string())
    } else if t.len() >= 2 && t.as_bytes()[1] == b':' && t.as_bytes()[0].is_ascii_alphabetic() {
        (format!("{}\\", &t[..2]), t[2..].trim_start_matches('\\').to_string())
    } else {
        (String::from("\\"), t.trim_start_matches('\\').to_string())
    };
    let mut pila: Vec<&str> = Vec::new();
    for p in resto.split('\\') {
        match p {
            "" | "." => {}
            ".." => {
                pila.pop();
            }
            otro => pila.push(otro),
        }
    }
    format!("{prefijo}{}", pila.join("\\"))
}

fn pipe_para(user_data_dir: &str, version: u32) -> String {
    let h = hex::encode(Sha256::digest(resolver_ruta_windows(user_data_dir).to_lowercase().as_bytes()));
    format!("\\\\.\\pipe\\sloth-{}-v{version}", &h[..12])
}

/// Nombre del pipe: único por carpeta userData (así dev y el instalado no se mezclan). Espera una ruta absoluta.
pub fn pipe_name_for(user_data_dir: &str) -> String {
    pipe_para(user_data_dir, PROTOCOLO_VERSION)
}

/// El pipe del protocolo 1, para encontrar y apagar un daemon viejo.
pub fn legacy_pipe_name_for(user_data_dir: &str) -> String {
    pipe_para(user_data_dir, 1)
}

// ---------- Tipos ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpawnSpec {
    pub file: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub running: bool,
    #[serde(rename = "exitCode", default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PtyChunk {
    pub seq: u64,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PtyStartResult {
    pub chunks: Vec<PtyChunk>,
    #[serde(rename = "upTo")]
    pub up_to: u64,
    pub running: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HookEventPayload {
    pub ws: String,
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(rename = "notificationType", default, skip_serializing_if = "Option::is_none")]
    pub notification_type: Option<String>,
    #[serde(rename = "enSegundoPlano", default, skip_serializing_if = "Option::is_none")]
    pub en_segundo_plano: Option<bool>,
    #[serde(rename = "avisoDeTarea", default, skip_serializing_if = "Option::is_none")]
    pub aviso_de_tarea: Option<bool>,
    #[serde(rename = "enFondo", default, skip_serializing_if = "Option::is_none")]
    pub en_fondo: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingPermission {
    pub id: String,
    pub ws: String,
    pub tool: String,
    pub input: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestions: Option<Vec<Value>>,
    pub at: u64,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelloOk {
    pub version: String,
    pub pid: u32,
    #[serde(rename = "hookUrl")]
    pub hook_url: String,
    #[serde(rename = "hookToken")]
    pub hook_token: String,
    pub sessions: Vec<SessionInfo>,
    #[serde(rename = "lastHookEvents")]
    pub last_hook_events: BTreeMap<String, HookEventPayload>,
    pub permissions: Vec<PendingPermission>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<u32>,
}

// ---------- Cliente -> daemon ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum ClientMessage {
    Challenge {
        nonce: String,
    },
    Hello {
        proof: String,
        #[serde(rename = "clientVersion")]
        client_version: String,
    },
    Start {
        rid: u64,
        id: String,
        spawn: SpawnSpec,
    },
    Write {
        id: String,
        data: String,
    },
    Resize {
        id: String,
        cols: u32,
        rows: u32,
    },
    Kill {
        rid: u64,
        id: String,
    },
    List {
        rid: u64,
    },
    Shutdown {
        rid: u64,
    },
    PermissionAnswer {
        #[serde(rename = "reqId")]
        req_id: String,
        /// Objeto `decision` de Claude Code (ej. {behavior:'allow'}) o null = que pregunte en la terminal.
        decision: Value,
    },
}

// ---------- Daemon -> cliente ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum DaemonMessage {
    ChallengeOk {
        nonce: String,
        proof: String,
    },
    HelloOk(HelloOk),
    Reply {
        rid: u64,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Salida agrupada (como mucho un mensaje cada ~16 ms por sesión), seq por chunk.
    Data {
        id: String,
        chunks: Vec<PtyChunk>,
    },
    Exit {
        id: String,
        code: i64,
    },
    Hook {
        event: HookEventPayload,
    },
    Permission {
        req: PendingPermission,
    },
    PermissionResolved {
        id: String,
    },
}

// ---------- Framing ----------

/// Una línea lista para escribir en el pipe, con su `\n`.
pub fn codificar(msg: &ClientMessage) -> String {
    let mut s = serde_json::to_string(msg).expect("un mensaje del cliente siempre se serializa");
    s.push('\n');
    s
}

/// Saludo del protocolo 1: solo sirve para apagar un daemon viejo.
pub fn codificar_hello_legado(token: &str, client_version: &str) -> String {
    format!("{}\n", serde_json::json!({ "t": "hello", "token": token, "clientVersion": client_version }))
}

pub fn decodificar(linea: &[u8]) -> Option<DaemonMessage> {
    serde_json::from_slice(linea).ok()
}

#[derive(Debug, PartialEq, Eq)]
pub struct LineaDemasiadoLarga;

/// Parte el flujo de bytes del pipe en líneas JSON. Las inválidas, vacías o de un tipo desconocido se ignoran, igual que
/// el lector del cliente de Node; un carácter UTF-8 partido entre dos lecturas no se rompe porque se junta antes de decodificar.
#[derive(Debug, Default)]
pub struct LectorLineas {
    buf: Vec<u8>,
}

impl LectorLineas {
    pub fn nuevo() -> Self {
        Self::default()
    }

    pub fn alimentar(&mut self, bytes: &[u8]) -> Result<Vec<DaemonMessage>, LineaDemasiadoLarga> {
        self.buf.extend_from_slice(bytes);
        let mut salida = Vec::new();
        let mut desde = 0;
        while let Some(i) = self.buf[desde..].iter().position(|b| *b == b'\n') {
            let linea = &self.buf[desde..desde + i];
            desde += i + 1;
            if !linea.is_empty() {
                if let Some(m) = decodificar(linea) {
                    salida.push(m);
                }
            }
        }
        self.buf.drain(..desde);
        if self.buf.len() > LINEA_LIMITE {
            return Err(LineaDemasiadoLarga);
        }
        Ok(salida)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const KEY: &str = "abababababababababababababababababababababababababababababababab";

    fn uno(c: char) -> String {
        c.to_string().repeat(64)
    }

    #[test]
    fn pruebas_hmac_coinciden_con_node() {
        assert_eq!(prueba_daemon(KEY, &uno('1'), &uno('2')), "707e30442dd66eb0e8f7fb9d036ebe5d0cde1a0d399c8b9735b7bc97ef61817f");
        assert_eq!(prueba_cliente(KEY, &uno('1'), &uno('2')), "85182ffa6e79a2905d0cbbeefe3e79bf46bc37f67c8fdaab5e7038607e9b5e9d");
        assert_eq!(hook_token_de(KEY, "ws1"), "824659a682f429780e030e69956c2952855d2f71b6d0b9929537205bcf59597d");
    }

    #[test]
    fn misma_prueba_exige_igual_largo_y_contenido() {
        let p = prueba_cliente(KEY, &uno('1'), &uno('2'));
        assert!(misma_prueba(&p, &p.clone()));
        assert!(!misma_prueba("corta", &p));
        assert!(!misma_prueba(&prueba_daemon(KEY, &uno('1'), &uno('2')), &p));
    }

    #[test]
    fn nonce_y_clave() {
        assert!(es_nonce(&uno('a')));
        assert!(!es_nonce(&uno('A')));
        assert!(es_clave(&uno('A')));
        assert!(!es_nonce(&"a".repeat(63)));
        assert!(!es_clave(&format!("{}g", "a".repeat(63))));
        let n = nuevo_nonce();
        assert!(es_nonce(&n));
        assert_ne!(n, nuevo_nonce());
    }

    #[test]
    fn pipe_igual_al_de_node_sin_importar_mayusculas_barras_ni_barra_final() {
        let esperado = "\\\\.\\pipe\\sloth-15ab0150c713-v2";
        assert_eq!(pipe_name_for("C:\\Users\\TOMY\\AppData\\Roaming\\Sloth"), esperado);
        assert_eq!(pipe_name_for("C:\\Users\\Tomy\\AppData\\Roaming\\Sloth\\"), esperado);
        assert_eq!(pipe_name_for("C:/Users/TOMY/AppData/Roaming/Sloth"), esperado);
        assert_eq!(pipe_name_for("C:\\Users\\TOMY\\AppData\\Roaming\\x\\..\\Sloth\\."), esperado);
        assert_eq!(legacy_pipe_name_for("C:\\Users\\TOMY\\AppData\\Roaming\\Sloth"), "\\\\.\\pipe\\sloth-15ab0150c713-v1");
    }

    #[test]
    fn challenge_y_hello_con_los_nombres_del_protocolo() {
        assert_eq!(codificar(&ClientMessage::Challenge { nonce: "n".into() }), "{\"t\":\"challenge\",\"nonce\":\"n\"}\n");
        let h = codificar(&ClientMessage::Hello { proof: "p".into(), client_version: "0.8.0".into() });
        assert_eq!(h, "{\"t\":\"hello\",\"proof\":\"p\",\"clientVersion\":\"0.8.0\"}\n");
        assert_eq!(codificar_hello_legado("tk", "retiro"), "{\"t\":\"hello\",\"token\":\"tk\",\"clientVersion\":\"retiro\"}\n");
    }

    #[test]
    fn mensajes_del_cliente_en_el_formato_del_daemon() {
        let spawn = SpawnSpec {
            file: "pwsh.exe".into(),
            args: vec!["-NoLogo".into()],
            cwd: "C:\\repo".into(),
            env: BTreeMap::from([("A".to_string(), "1".to_string())]),
            cols: 120,
            rows: 30,
        };
        let v: Value = serde_json::from_str(&codificar(&ClientMessage::Start { rid: 3, id: "p1".into(), spawn })).unwrap();
        assert_eq!(v, json!({ "t": "start", "rid": 3, "id": "p1", "spawn": { "file": "pwsh.exe", "args": ["-NoLogo"], "cwd": "C:\\repo", "env": { "A": "1" }, "cols": 120, "rows": 30 } }));
        assert_eq!(codificar(&ClientMessage::Write { id: "p1".into(), data: "ls\r".into() }), "{\"t\":\"write\",\"id\":\"p1\",\"data\":\"ls\\r\"}\n");
        assert_eq!(codificar(&ClientMessage::Resize { id: "p1".into(), cols: 100, rows: 40 }), "{\"t\":\"resize\",\"id\":\"p1\",\"cols\":100,\"rows\":40}\n");
        assert_eq!(codificar(&ClientMessage::Kill { rid: 4, id: "p1".into() }), "{\"t\":\"kill\",\"rid\":4,\"id\":\"p1\"}\n");
        assert_eq!(codificar(&ClientMessage::List { rid: 5 }), "{\"t\":\"list\",\"rid\":5}\n");
        assert_eq!(codificar(&ClientMessage::Shutdown { rid: 6 }), "{\"t\":\"shutdown\",\"rid\":6}\n");
        let r = codificar(&ClientMessage::PermissionAnswer { req_id: "r1".into(), decision: json!({ "behavior": "allow" }) });
        assert_eq!(r, "{\"t\":\"permission-answer\",\"reqId\":\"r1\",\"decision\":{\"behavior\":\"allow\"}}\n");
        let nula = codificar(&ClientMessage::PermissionAnswer { req_id: "r1".into(), decision: Value::Null });
        assert_eq!(nula, "{\"t\":\"permission-answer\",\"reqId\":\"r1\",\"decision\":null}\n");
    }

    #[test]
    fn hello_ok_real_del_daemon() {
        let crudo = br#"{"t":"hello-ok","version":"0.8.0","pid":4242,"hookUrl":"http://127.0.0.1:5000/hook","hookToken":"tok","sessions":[{"id":"a","running":true},{"id":"b","running":false,"exitCode":1}],"lastHookEvents":{"w1":{"ws":"w1","event":"Stop","at":42}},"permissions":[{"id":"q","ws":"w1","tool":"Bash","input":{"command":"ls"},"at":1,"expiresAt":2}],"protocol":2}"#;
        let Some(DaemonMessage::HelloOk(h)) = decodificar(crudo) else { panic!("no se decodificó") };
        assert_eq!((h.version.as_str(), h.pid, h.protocol), ("0.8.0", 4242, Some(2)));
        assert_eq!(h.sessions[1], SessionInfo { id: "b".into(), running: false, exit_code: Some(1) });
        assert_eq!(h.sessions[0].exit_code, None);
        assert_eq!(h.last_hook_events["w1"].at, Some(42));
        assert_eq!(h.permissions[0].expires_at, 2);
        assert_eq!(h.permissions[0].suggestions, None);
    }

    #[test]
    fn hello_ok_sin_protocol_es_de_un_daemon_viejo() {
        let crudo = br#"{"t":"hello-ok","version":"0.7.0","pid":1,"hookUrl":"u","hookToken":"t","sessions":[],"lastHookEvents":{},"permissions":[]}"#;
        let Some(DaemonMessage::HelloOk(h)) = decodificar(crudo) else { panic!("no se decodificó") };
        assert_eq!(h.protocol, None);
    }

    #[test]
    fn mensajes_del_daemon() {
        let m = decodificar(br#"{"t":"challenge-ok","nonce":"n","proof":"p"}"#);
        assert_eq!(m, Some(DaemonMessage::ChallengeOk { nonce: "n".into(), proof: "p".into() }));
        let m = decodificar(br#"{"t":"reply","rid":7,"ok":true,"result":{"chunks":[{"seq":1,"data":"hola"}],"upTo":1,"running":true}}"#);
        let Some(DaemonMessage::Reply { rid, ok, result, error }) = m else { panic!() };
        assert_eq!((rid, ok, error), (7, true, None));
        let r: PtyStartResult = serde_json::from_value(result.unwrap()).unwrap();
        assert_eq!(r, PtyStartResult { chunks: vec![PtyChunk { seq: 1, data: "hola".into() }], up_to: 1, running: true });
        let m = decodificar(br#"{"t":"reply","rid":8,"ok":false,"error":"no existe"}"#);
        assert_eq!(m, Some(DaemonMessage::Reply { rid: 8, ok: false, result: None, error: Some("no existe".into()) }));
        let m = decodificar(br#"{"t":"reply","rid":9,"ok":true,"result":null}"#);
        assert_eq!(m, Some(DaemonMessage::Reply { rid: 9, ok: true, result: None, error: None }));
        assert_eq!(decodificar(br#"{"t":"data","id":"a","chunks":[{"seq":5,"data":"x"}]}"#), Some(DaemonMessage::Data { id: "a".into(), chunks: vec![PtyChunk { seq: 5, data: "x".into() }] }));
        assert_eq!(decodificar(br#"{"t":"exit","id":"a","code":-1}"#), Some(DaemonMessage::Exit { id: "a".into(), code: -1 }));
        assert_eq!(decodificar(br#"{"t":"permission-resolved","id":"q"}"#), Some(DaemonMessage::PermissionResolved { id: "q".into() }));
        assert!(matches!(decodificar(br#"{"t":"hook","event":{"ws":"w","event":"PreToolUse","tool":"Bash","enSegundoPlano":true,"at":3}}"#), Some(DaemonMessage::Hook { .. })));
        assert!(matches!(decodificar(br#"{"t":"permission","req":{"id":"q","ws":"w","tool":"Bash","input":{},"suggestions":[1],"at":1,"expiresAt":2}}"#), Some(DaemonMessage::Permission { .. })));
    }

    #[test]
    fn tipo_desconocido_o_basura_no_decodifica() {
        assert_eq!(decodificar(br#"{"t":"otro"}"#), None);
        assert_eq!(decodificar(b"no es json"), None);
        assert_eq!(decodificar(b"[1]"), None);
    }

    #[test]
    fn lector_junta_lineas_partidas_e_ignora_las_invalidas() {
        let mut l = LectorLineas::nuevo();
        assert!(l.alimentar(b"{\"t\":\"exit\",\"id\":\"a\"").unwrap().is_empty());
        let m = l.alimentar(b",\"code\":0}\n\nbasura\n{\"t\":\"exit\",\"id\":\"b\",\"code\":2}\n{\"t\":\"exit\",").unwrap();
        assert_eq!(m, vec![DaemonMessage::Exit { id: "a".into(), code: 0 }, DaemonMessage::Exit { id: "b".into(), code: 2 }]);
        let m = l.alimentar(b"\"id\":\"c\",\"code\":3}\n").unwrap();
        assert_eq!(m, vec![DaemonMessage::Exit { id: "c".into(), code: 3 }]);
    }

    #[test]
    fn lector_no_rompe_un_caracter_utf8_partido() {
        let linea = "{\"t\":\"data\",\"id\":\"a\",\"chunks\":[{\"seq\":1,\"data\":\"ñandú ✓\"}]}\n".as_bytes();
        let corte = linea.iter().position(|b| *b == 0xC3).unwrap() + 1;
        let mut l = LectorLineas::nuevo();
        assert!(l.alimentar(&linea[..corte]).unwrap().is_empty());
        let m = l.alimentar(&linea[corte..]).unwrap();
        assert_eq!(m, vec![DaemonMessage::Data { id: "a".into(), chunks: vec![PtyChunk { seq: 1, data: "ñandú ✓".into() }] }]);
    }

    #[test]
    fn lector_corta_una_linea_sin_fin_demasiado_larga() {
        let mut l = LectorLineas::nuevo();
        let bloque = vec![b'a'; 1024 * 1024];
        let mut r = Ok(Vec::new());
        for _ in 0..=32 {
            r = l.alimentar(&bloque);
        }
        assert_eq!(r, Err(LineaDemasiadoLarga));
    }
}
