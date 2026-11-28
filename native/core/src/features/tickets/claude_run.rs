//! Corre Claude Code headless (`claude -p`) con el prompt por stdin. Equivale a src/main/features/tickets/claude-run.ts.
//! `ProcesoRun` es lo que cambia entre la app y los tests: `Real` lanza el proceso (oculto en Windows, con timeout,
//! cancelación y corte del árbol); `run_claude` decide qué hacer con lo que pasó, sin tocar el sistema.
use super::errores::{ErrorTickets, Res};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const RUN_TIMEOUT_MS: u64 = 120_000;
/// Tope de lo que se lee de stdout: una respuesta rara no llena la memoria.
const MAX_STDOUT: usize = 4 * 1024 * 1024;
const MAX_STDERR: usize = 8000;

pub struct Peticion {
    pub exe: String,
    pub args: Vec<String>,
    pub prompt: String,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub timeout: Duration,
    /// `args` es la línea de comandos ya armada (un .cmd por cmd.exe): no se vuelve a entrecomillar.
    pub verbatim: bool,
    /// Con un corte por línea el hijo es líder de su grupo fuera de Windows: sin eso no se alcanza a sus nietos.
    pub arbol: bool,
    /// Tras el prompt, stdin sigue abierto para lo que pida `Mirada::Escribir` (un servidor que conversa por líneas).
    /// Cerrado, el hijo ve el fin de la entrada apenas termina el prompt, como espera `claude -p`.
    pub stdin_abierto: bool,
}

/// Qué hacer con una línea de stdout apenas llega.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mirada {
    Seguir,
    Cortar,
    /// Mandarle este texto al hijo por stdin (solo con `stdin_abierto`) y seguir leyendo.
    Escribir(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SalidaRun {
    Termino { code: Option<i32>, stdout: String, stderr: String },
    /// `mirar` pidió cortar: el proceso se mató y no hace falta esperar lo que le quedaba.
    Cortada,
    Plazo,
    Cancelada,
    NoAbrio(String),
}

pub trait ProcesoRun: Send + Sync {
    fn correr(&self, p: &Peticion, cancelado: Option<&AtomicBool>, mirar: &mut dyn FnMut(&str) -> Mirada) -> SalidaRun;
}

pub struct Real;

/// En Windows `taskkill /T /F` alcanza al árbol; fuera de Windows se mata el grupo del hijo (que es su líder).
pub fn cortar_arbol(pid: u32, grupo: bool) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = grupo;
        let _ = Command::new("taskkill").args(["/pid", &pid.to_string(), "/T", "/F"]).creation_flags(0x0800_0000).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    #[cfg(not(windows))]
    {
        let objetivo = if grupo { format!("-{pid}") } else { pid.to_string() };
        let _ = Command::new("kill").args(["-KILL", &objetivo]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
}

enum Evento {
    Salida(Vec<u8>),
    Fin,
}

fn leer_hasta_tope<R: Read + Send + 'static>(mut r: R, tope: usize) -> (Arc<Mutex<Vec<u8>>>, Arc<AtomicBool>) {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let destino = buf.clone();
    let listo = Arc::new(AtomicBool::new(false));
    let aviso = listo.clone();
    std::thread::spawn(move || {
        let mut tmp = [0u8; 8192];
        loop {
            match r.read(&mut tmp) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut b = destino.lock().unwrap_or_else(|e| e.into_inner());
                    let resto = tope.saturating_sub(b.len());
                    b.extend_from_slice(&tmp[..n.min(resto)]);
                }
            }
        }
        aviso.store(true, Ordering::SeqCst);
    });
    (buf, listo)
}

fn texto(b: &Arc<Mutex<Vec<u8>>>) -> String {
    String::from_utf8_lossy(&b.lock().unwrap_or_else(|e| e.into_inner())).into_owned()
}

impl ProcesoRun for Real {
    fn correr(&self, p: &Peticion, cancelado: Option<&AtomicBool>, mirar: &mut dyn FnMut(&str) -> Mirada) -> SalidaRun {
        let mut c = Command::new(&p.exe);
        c.current_dir(&p.cwd).env_clear().envs(&p.env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: sin consola que parpadee.
            c.creation_flags(0x0800_0000);
            if p.verbatim {
                for a in &p.args {
                    c.raw_arg(a);
                }
            } else {
                c.args(&p.args);
            }
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::process::CommandExt;
            c.args(&p.args);
            if p.arbol {
                c.process_group(0);
            }
        }
        let mut hijo = match c.spawn() {
            Ok(h) => h,
            Err(e) => return SalidaRun::NoAbrio(e.to_string()),
        };
        let pid = hijo.id();
        let mut entrada = hijo.stdin.take();
        if p.stdin_abierto {
            // Lo que se conversa son pocas líneas: escribirlas acá no traba aunque el hijo todavía no lea.
            if let Some(s) = entrada.as_mut() {
                if s.write_all(p.prompt.as_bytes()).and_then(|()| s.flush()).is_err() {
                    entrada = None;
                }
            }
        } else if let Some(mut stdin) = entrada.take() {
            let prompt = p.prompt.clone();
            std::thread::spawn(move || {
                let _ = stdin.write_all(prompt.as_bytes());
            });
        }
        let err = hijo.stderr.take().map(|e| leer_hasta_tope(e, MAX_STDERR));
        let (tx, rx) = channel::<Evento>();
        if let Some(mut out) = hijo.stdout.take() {
            std::thread::spawn(move || {
                let mut tmp = [0u8; 8192];
                loop {
                    match out.read(&mut tmp) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send(Evento::Salida(tmp[..n].to_vec())).is_err() {
                                return;
                            }
                        }
                    }
                }
                let _ = tx.send(Evento::Fin);
            });
        } else {
            let _ = tx.send(Evento::Fin);
        }
        let limite = Instant::now() + p.timeout;
        let mut out: Vec<u8> = Vec::new();
        let mut pendiente: Vec<u8> = Vec::new();
        let matar = |hijo: &mut std::process::Child| {
            cortar_arbol(pid, p.arbol);
            let _ = hijo.kill();
            let _ = hijo.wait();
        };
        loop {
            if cancelado.is_some_and(|c| c.load(Ordering::SeqCst)) {
                matar(&mut hijo);
                return SalidaRun::Cancelada;
            }
            if Instant::now() >= limite {
                matar(&mut hijo);
                return SalidaRun::Plazo;
            }
            match rx.recv_timeout(Duration::from_millis(25)) {
                Ok(Evento::Salida(d)) => {
                    let resto = MAX_STDOUT.saturating_sub(out.len());
                    out.extend_from_slice(&d[..d.len().min(resto)]);
                    pendiente.extend_from_slice(&d);
                    while let Some(i) = pendiente.iter().position(|b| *b == b'\n') {
                        let linea: Vec<u8> = pendiente.drain(..=i).collect();
                        let l = String::from_utf8_lossy(&linea[..linea.len() - 1]).into_owned();
                        match mirar(&l) {
                            Mirada::Seguir => {}
                            Mirada::Cortar => {
                                matar(&mut hijo);
                                return SalidaRun::Cortada;
                            }
                            Mirada::Escribir(t) => {
                                if let Some(s) = entrada.as_mut() {
                                    if s.write_all(t.as_bytes()).and_then(|()| s.flush()).is_err() {
                                        entrada = None;
                                    }
                                }
                            }
                        }
                    }
                    if pendiente.len() > MAX_STDOUT {
                        pendiente.clear();
                    }
                }
                Ok(Evento::Fin) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
        drop(entrada);
        let code = hijo.wait().ok().and_then(|s| s.code());
        // El lector de stderr termina junto con el hijo; si un nieto sostiene el pipe se usa lo que llegó.
        if let Some((_, listo)) = &err {
            for _ in 0..100 {
                if listo.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::yield_now();
                std::thread::sleep(Duration::from_millis(2));
            }
        }
        SalidaRun::Termino { code, stdout: String::from_utf8_lossy(&out).into_owned(), stderr: err.as_ref().map(|(b, _)| texto(b)).unwrap_or_default() }
    }
}

pub struct OpcionesRun<'a, T> {
    pub exe: String,
    pub args: Vec<String>,
    pub prompt: String,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    /// A quién se le pregunta, para el mensaje de plazo («{conector} no respondió en…»).
    pub quien: String,
    pub timeout_ms: Option<u64>,
    pub cancelado: Option<&'a AtomicBool>,
    pub parse: &'a dyn Fn(&str) -> Res<T>,
    /// Mira cada línea de stdout apenas llega: si devuelve algo, se corta el proceso y ese es el resultado.
    pub temprano: Option<&'a dyn Fn(&str) -> Option<T>>,
    /// Mira cada línea de stdout: si devuelve un error se corta el árbol de procesos y se rechaza con él. Un motor lo usa
    /// para emular un tope que su CLI no tiene.
    pub cortar_si: Option<&'a dyn Fn(&str) -> Option<ErrorTickets>>,
    /// Cómo se llama el programa en «No pude abrir …».
    pub agente: Option<String>,
    pub verbatim: bool,
}

impl<'a, T> OpcionesRun<'a, T> {
    pub fn nuevo(exe: &str, args: Vec<String>, prompt: &str, cwd: PathBuf, quien: &str, parse: &'a dyn Fn(&str) -> Res<T>) -> Self {
        OpcionesRun {
            exe: exe.into(),
            args,
            prompt: prompt.into(),
            cwd,
            env: BTreeMap::new(),
            quien: quien.into(),
            timeout_ms: None,
            cancelado: None,
            parse,
            temprano: None,
            cortar_si: None,
            agente: None,
            verbatim: false,
        }
    }
}

enum Corte<T> {
    Resultado(T),
    Error(ErrorTickets),
}

/// Devuelve el error con un mensaje legible. Un error propio (conector o herramienta que falta) pasa tal cual; uno de
/// texto suma cómo salió el proceso.
pub fn run_claude<T>(ej: &dyn ProcesoRun, o: &OpcionesRun<T>) -> Res<T> {
    let timeout_ms = o.timeout_ms.unwrap_or(RUN_TIMEOUT_MS);
    let peticion = Peticion {
        exe: o.exe.clone(),
        args: o.args.clone(),
        prompt: o.prompt.clone(),
        cwd: o.cwd.clone(),
        env: o.env.clone(),
        timeout: Duration::from_millis(timeout_ms),
        verbatim: o.verbatim,
        arbol: o.cortar_si.is_some(),
        stdin_abierto: false,
    };
    let corte: RefCell<Option<Corte<T>>> = RefCell::new(None);
    let mut mirar = |l: &str| -> Mirada {
        if o.temprano.is_none() && o.cortar_si.is_none() {
            return Mirada::Seguir;
        }
        if let Some(f) = o.cortar_si {
            if let Some(e) = f(l) {
                *corte.borrow_mut() = Some(Corte::Error(e));
                return Mirada::Cortar;
            }
        }
        if let Some(f) = o.temprano {
            if let Some(r) = f(l) {
                *corte.borrow_mut() = Some(Corte::Resultado(r));
                return Mirada::Cortar;
            }
        }
        Mirada::Seguir
    };
    match ej.correr(&peticion, o.cancelado, &mut mirar) {
        SalidaRun::NoAbrio(m) => Err(ErrorTickets::otro(format!("No pude abrir {}: {m}", o.agente.as_deref().unwrap_or("Claude")))),
        SalidaRun::Plazo => Err(ErrorTickets::plazo(&o.quien, (timeout_ms + 500) / 1000)),
        SalidaRun::Cancelada => Err(ErrorTickets::otro("Consulta cancelada.")),
        SalidaRun::Cortada => match corte.into_inner() {
            Some(Corte::Resultado(r)) => Ok(r),
            Some(Corte::Error(e)) => Err(e),
            None => Err(ErrorTickets::otro("Consulta cancelada.")),
        },
        SalidaRun::Termino { code, stdout, stderr } => match (o.parse)(&stdout) {
            Ok(r) => Ok(r),
            Err(ErrorTickets::Otro(m)) => {
                let extra = match code {
                    Some(c) if c != 0 => {
                        let e = stderr.trim();
                        let detalle = if e.is_empty() { String::new() } else { format!(": {}", super::texto::cortar16(e, 300)) };
                        format!(" (salió con código {c}{detalle})")
                    }
                    _ => String::new(),
                };
                Err(ErrorTickets::otro(format!("{m}{extra}")))
            }
            Err(e) => Err(e),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as M;

    /// Un proceso de mentira: entrega las líneas que se le dan y termina como se le diga.
    struct Falso {
        lineas: Vec<&'static str>,
        fin: SalidaRun,
        vistas: M<usize>,
    }

    impl Falso {
        fn nuevo(lineas: Vec<&'static str>, fin: SalidaRun) -> Self {
            Falso { lineas, fin, vistas: M::new(0) }
        }
    }

    impl ProcesoRun for Falso {
        fn correr(&self, _: &Peticion, _: Option<&AtomicBool>, mirar: &mut dyn FnMut(&str) -> Mirada) -> SalidaRun {
            for l in &self.lineas {
                *self.vistas.lock().unwrap() += 1;
                if mirar(l) == Mirada::Cortar {
                    return SalidaRun::Cortada;
                }
            }
            self.fin.clone()
        }
    }

    fn termino(out: &str) -> SalidaRun {
        SalidaRun::Termino { code: Some(0), stdout: out.into(), stderr: String::new() }
    }

    fn base<'a, T>(parse: &'a dyn Fn(&str) -> Res<T>) -> OpcionesRun<'a, T> {
        OpcionesRun::nuevo("claude", vec![], "", PathBuf::from("."), "Test", parse)
    }

    #[test]
    fn devuelve_lo_que_parsea() {
        let parse = |s: &str| -> Res<String> { Ok(s.to_uppercase()) };
        assert_eq!(run_claude(&Falso::nuevo(vec![], termino("hola")), &base(&parse)).unwrap(), "HOLA");
    }

    #[test]
    fn conserva_la_variante_del_error_que_tira_parse() {
        let parse = |_: &str| -> Res<u8> { Err(ErrorTickets::ConectorFalta("falta".into())) };
        assert_eq!(run_claude(&Falso::nuevo(vec![], termino("x")), &base(&parse)).unwrap_err(), ErrorTickets::ConectorFalta("falta".into()));
    }

    #[test]
    fn un_error_de_texto_suma_el_codigo_y_el_stderr_si_salio_mal() {
        let parse = |_: &str| -> Res<u8> { Err(ErrorTickets::otro("no entendí")) };
        let con = |code: Option<i32>, stderr: &str| SalidaRun::Termino { code, stdout: String::new(), stderr: stderr.into() };
        let e = |s: SalidaRun| run_claude(&Falso::nuevo(vec![], s), &base(&parse)).unwrap_err().mensaje();
        assert_eq!(e(con(Some(0), "")), "no entendí");
        assert_eq!(e(con(Some(2), "")), "no entendí (salió con código 2)");
        assert_eq!(e(con(Some(2), "  roto\n")), "no entendí (salió con código 2: roto)");
        assert_eq!(e(con(None, "x")), "no entendí");
    }

    #[test]
    fn con_temprano_corta_apenas_una_linea_alcanza() {
        let parse = |_: &str| -> Res<u32> { Ok(0) };
        let temprano = |l: &str| l.contains("init").then_some(7u32);
        let mut o = base(&parse);
        o.temprano = Some(&temprano);
        let f = Falso::nuevo(vec!["nada", "init", "después"], termino(""));
        assert_eq!(run_claude(&f, &o).unwrap(), 7);
        assert_eq!(*f.vistas.lock().unwrap(), 2);
    }

    #[test]
    fn un_temprano_que_no_decide_deja_seguir_hasta_el_final() {
        let parse = |s: &str| -> Res<usize> { Ok(s.lines().count()) };
        let temprano = |_: &str| None::<usize>;
        let mut o = base(&parse);
        o.temprano = Some(&temprano);
        assert_eq!(run_claude(&Falso::nuevo(vec!["uno", "dos"], termino("uno\ndos\n")), &o).unwrap(), 2);
    }

    #[test]
    fn con_cortar_si_rechaza_con_el_error_que_devuelve() {
        let parse = |_: &str| -> Res<u32> { Ok(0) };
        let corta = |l: &str| (l == "corta").then(|| ErrorTickets::otro("tope"));
        let mut o = base(&parse);
        o.cortar_si = Some(&corta);
        let f = Falso::nuevo(vec!["a", "corta", "b"], termino(""));
        assert_eq!(run_claude(&f, &o).unwrap_err(), ErrorTickets::otro("tope"));
        assert_eq!(*f.vistas.lock().unwrap(), 2);
    }

    #[test]
    fn cortar_si_gana_sobre_temprano_en_la_misma_linea() {
        let parse = |_: &str| -> Res<u32> { Ok(0) };
        let corta = |_: &str| Some(ErrorTickets::otro("tope"));
        let temprano = |_: &str| Some(1u32);
        let mut o = base(&parse);
        o.cortar_si = Some(&corta);
        o.temprano = Some(&temprano);
        assert_eq!(run_claude(&Falso::nuevo(vec!["x"], termino("")), &o).unwrap_err(), ErrorTickets::otro("tope"));
    }

    #[test]
    fn nombra_al_agente_en_no_pude_abrir() {
        let parse = |_: &str| -> Res<u8> { Ok(0) };
        let f = Falso::nuevo(vec![], SalidaRun::NoAbrio("no existe".into()));
        assert_eq!(run_claude(&f, &base(&parse)).unwrap_err().mensaje(), "No pude abrir Claude: no existe");
        let mut o = base(&parse);
        o.agente = Some("Codex".into());
        assert_eq!(run_claude(&f, &o).unwrap_err().mensaje(), "No pude abrir Codex: no existe");
    }

    #[test]
    fn el_plazo_vencido_es_un_error_de_plazo_con_el_texto_de_siempre() {
        let parse = |_: &str| -> Res<u8> { Ok(0) };
        let mut o = base(&parse);
        o.timeout_ms = Some(300);
        let e = run_claude(&Falso::nuevo(vec![], SalidaRun::Plazo), &o).unwrap_err();
        assert_eq!(e, ErrorTickets::Plazo { segundos: 0, mensaje: "Test no respondió en 0 s. Probá de nuevo.".into() });
        let e = run_claude(&Falso::nuevo(vec![], SalidaRun::Plazo), &base(&parse)).unwrap_err();
        assert_eq!(e.mensaje(), "Test no respondió en 120 s. Probá de nuevo.");
    }

    #[test]
    fn la_cancelacion_es_un_error_legible() {
        let parse = |_: &str| -> Res<u8> { Ok(0) };
        assert_eq!(run_claude(&Falso::nuevo(vec![], SalidaRun::Cancelada), &base(&parse)).unwrap_err().mensaje(), "Consulta cancelada.");
    }

    fn peticion(args: &[&str]) -> Peticion {
        let (exe, mut base) = if cfg!(windows) { ("cmd.exe", vec!["/C".to_string()]) } else { ("sh", vec!["-c".to_string()]) };
        base.extend(args.iter().map(|a| a.to_string()));
        let env: BTreeMap<String, String> = std::env::vars().collect();
        Peticion { exe: exe.into(), args: base, prompt: String::new(), cwd: PathBuf::from("."), env, timeout: Duration::from_secs(60), verbatim: false, arbol: true, stdin_abierto: false }
    }

    fn largo() -> &'static str {
        if cfg!(windows) {
            "echo uno & ping -n 60 127.0.0.1 >nul"
        } else {
            "echo uno; sleep 60"
        }
    }

    #[test]
    fn real_lee_la_salida_y_el_codigo() {
        let p = peticion(&[if cfg!(windows) { "echo hola& exit 3" } else { "echo hola; exit 3" }]);
        let SalidaRun::Termino { code, stdout, .. } = Real.correr(&p, None, &mut |_| Mirada::Seguir) else { panic!() };
        assert_eq!(code, Some(3));
        assert_eq!(stdout.trim(), "hola");
    }

    #[test]
    fn real_con_un_programa_que_no_existe_no_abre() {
        let mut p = peticion(&[]);
        p.exe = "no-existe-este-programa-sloth".into();
        assert!(matches!(Real.correr(&p, None, &mut |_| Mirada::Seguir), SalidaRun::NoAbrio(_)));
    }

    #[test]
    fn real_corta_el_arbol_apenas_la_mirada_lo_pide() {
        let p = peticion(&[largo()]);
        let mut vistas = Vec::new();
        let r = Real.correr(&p, None, &mut |l| {
            vistas.push(l.trim().to_string());
            Mirada::Cortar
        });
        assert_eq!(r, SalidaRun::Cortada);
        assert_eq!(vistas, vec!["uno".to_string()]);
    }

    #[test]
    fn real_con_stdin_abierto_conversa_por_lineas() {
        let guion = if cfg!(windows) { "set /p sloth_a=& call echo r-%sloth_a%& set /p sloth_b=& call echo r-%sloth_b%& ping -n 60 127.0.0.1 >nul" } else { "read a; echo r-$a; read b; echo r-$b; sleep 60" };
        let mut p = peticion(&[guion]);
        p.prompt = "uno\n".into();
        p.stdin_abierto = true;
        let mut vistas = Vec::new();
        let r = Real.correr(&p, None, &mut |l| {
            let l = l.trim().to_string();
            vistas.push(l.clone());
            if l == "r-uno" { Mirada::Escribir("dos\n".into()) } else { Mirada::Cortar }
        });
        assert_eq!(r, SalidaRun::Cortada);
        assert_eq!(vistas, ["r-uno", "r-dos"]);
    }

    #[test]
    fn real_vence_su_plazo_y_mata_al_hijo() {
        let mut p = peticion(&[largo()]);
        p.timeout = Duration::from_millis(1);
        assert_eq!(Real.correr(&p, None, &mut |_| Mirada::Seguir), SalidaRun::Plazo);
    }

    #[test]
    fn real_respeta_la_cancelacion() {
        let p = peticion(&[largo()]);
        let c = AtomicBool::new(true);
        assert_eq!(Real.correr(&p, Some(&c), &mut |_| Mirada::Seguir), SalidaRun::Cancelada);
    }
}
