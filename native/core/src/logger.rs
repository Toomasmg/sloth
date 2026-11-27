//! Log de Sloth: líneas de una sola entrada, buffer en memoria y archivo con rotación por tamaño.
//! Equivale a src/main/logger.ts. Nada de lo que falla acá se propaga: un log roto no puede tirar abajo a quien reporta.
//!
//! La redacción de secretos y rutas (src/main/diag/redactar.ts) se inyecta como función: este módulo no la conoce.
use crate::acotar::{acotar, recortar_utf16};
use crate::rotacion::plan_rotacion;
use std::collections::VecDeque;
use std::fmt::Display;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const BASE: &str = "sloth";
pub const MAX_POR_DEFECTO: u64 = 512 * 1024;
pub const MANTENER_POR_DEFECTO: u64 = 3;
const LARGO_LINEA: usize = 4000;
const LARGO_ENTRADA_MAX: usize = 200_000;
const BUFFER: usize = 200;
// Si la rotación falla (archivo tomado por un antivirus) se sigue escribiendo igual hasta este múltiplo de max.
const TOPE_SIN_ROTAR: u64 = 2;
const ESPERA_REINTENTO_ROTACION_MS: i64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Nivel {
    Error,
    Aviso,
    Info,
}

impl Nivel {
    pub fn como_str(self) -> &'static str {
        match self {
            Nivel::Error => "error",
            Nivel::Aviso => "aviso",
            Nivel::Info => "info",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntradaLog {
    pub t: i64,
    pub nivel: Nivel,
    pub origen: String,
    pub msg: String,
}

pub type Redactor = Box<dyn Fn(&str) -> String + Send + Sync>;
pub type Reloj = Box<dyn Fn() -> i64 + Send + Sync>;

pub struct OpcionesLogger {
    pub dir: PathBuf,
    pub redactar: Redactor,
    pub max: u64,
    pub mantener: u64,
    pub ahora: Reloj,
    /// Sin archivo: solo el buffer en memoria (el logger global antes de iniciarse).
    pub solo_memoria: bool,
}

impl OpcionesLogger {
    pub fn nuevas(dir: impl Into<PathBuf>, redactar: Redactor) -> Self {
        OpcionesLogger {
            dir: dir.into(),
            redactar,
            max: MAX_POR_DEFECTO,
            mantener: MANTENER_POR_DEFECTO,
            ahora: Box::new(ahora_ms),
            solo_memoria: false,
        }
    }
}

pub fn ahora_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

struct Estado {
    recientes: VecDeque<EntradaLog>,
    fallo: Option<String>,
    con_archivo: bool,
    tamano_visto: u64,
    rotar_desde: i64,
}

pub struct Logger {
    dir: PathBuf,
    archivo: PathBuf,
    redactar: Redactor,
    max: u64,
    mantener: u64,
    ahora: Reloj,
    estado: Mutex<Estado>,
}

fn es_espacio_js(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// Cada corrida de blancos que contiene un salto de línea pasa a ` | `, como `\s*[\r\n]+\s*` en JavaScript.
pub fn una_linea(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut corrida = String::new();
    let mut con_salto = false;
    let cerrar = |out: &mut String, corrida: &mut String, con_salto: &mut bool| {
        if *con_salto {
            out.push_str(" | ");
        } else {
            out.push_str(corrida);
        }
        corrida.clear();
        *con_salto = false;
    };
    for c in s.chars() {
        if es_espacio_js(c) {
            corrida.push(c);
            con_salto |= c == '\r' || c == '\n';
        } else {
            cerrar(&mut out, &mut corrida, &mut con_salto);
            out.push(c);
        }
    }
    cerrar(&mut out, &mut corrida, &mut con_salto);
    out
}

fn texto_de_fallo(redactar: &Redactor, donde: &str, e: &dyn Display) -> String {
    acotar(&redactar(&format!("{donde}: {e}")), 500)
}

/// El mensaje del error y, debajo, cada causa: lo más cercano al stack que da `Error` en Node.
pub fn con_causas(e: &dyn std::error::Error) -> String {
    let mut texto = e.to_string();
    let mut causa = e.source();
    while let Some(c) = causa {
        texto.push_str(&format!("\ncausado por: {c}"));
        causa = c.source();
    }
    texto
}

/// `Date.prototype.toISOString` para un instante en milisegundos desde la época.
pub fn iso_utc(ms: i64) -> String {
    let dias = ms.div_euclid(86_400_000);
    let resto = ms.rem_euclid(86_400_000);
    let z = dias + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dia = doy - (153 * mp + 2) / 5 + 1;
    let mes = if mp < 10 { mp + 3 } else { mp - 9 };
    let anio = yoe + era * 400 + i64::from(mes <= 2);
    format!(
        "{anio:04}-{mes:02}-{dia:02}T{:02}:{:02}:{:02}.{:03}Z",
        resto / 3_600_000,
        resto / 60_000 % 60,
        resto / 1000 % 60,
        resto % 1000
    )
}

pub fn linea_de_log(t: i64, nivel: Nivel, origen: &str, msg: &str) -> String {
    format!("{} {} [{origen}] {msg}\n", iso_utc(t), nivel.como_str())
}

impl Logger {
    pub fn nuevo(opts: OpcionesLogger) -> Logger {
        let mut estado = Estado {
            recientes: VecDeque::new(),
            fallo: None,
            con_archivo: !opts.solo_memoria,
            tamano_visto: 0,
            rotar_desde: 0,
        };
        if estado.con_archivo {
            if let Err(e) = fs::create_dir_all(&opts.dir) {
                estado.fallo = Some(texto_de_fallo(&opts.redactar, "no se pudo crear la carpeta de logs", &e));
                estado.con_archivo = false;
            }
        }
        Logger {
            archivo: opts.dir.join(format!("{BASE}.log")),
            dir: opts.dir,
            redactar: opts.redactar,
            max: opts.max,
            mantener: opts.mantener,
            ahora: opts.ahora,
            estado: Mutex::new(estado),
        }
    }

    fn bloquear(&self) -> std::sync::MutexGuard<'_, Estado> {
        self.estado.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn limpiar(&self, s: &str) -> String {
        acotar(&(self.redactar)(recortar_utf16(s, LARGO_ENTRADA_MAX)), LARGO_LINEA)
    }

    fn rotar_si_hace_falta(&self, estado: &mut Estado) -> std::io::Result<()> {
        let tamano = match fs::metadata(&self.archivo) {
            Ok(m) => m.len(),
            Err(e) if e.kind() == ErrorKind::NotFound => 0,
            Err(e) => return Err(e),
        };
        estado.tamano_visto = tamano;
        if tamano < self.max {
            return Ok(());
        }
        let existentes: Vec<String> =
            fs::read_dir(&self.dir)?.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        let plan = plan_rotacion(tamano, self.max, &existentes, BASE, self.mantener);
        if !plan.rotar {
            return Ok(());
        }
        for f in &plan.borrar {
            fs::remove_file(self.dir.join(f))?;
        }
        for m in &plan.mover {
            fs::rename(self.dir.join(&m.de), self.dir.join(&m.a))?;
        }
        Ok(())
    }

    fn escribir(&self, nivel: Nivel, origen: &str, crudo: &str) {
        let t = (self.ahora)();
        let msg = una_linea(&self.limpiar(crudo));
        let origen = una_linea(origen);
        let mut estado = self.bloquear();
        estado.recientes.push_back(EntradaLog { t, nivel, origen: origen.clone(), msg: msg.clone() });
        if estado.recientes.len() > BUFFER {
            estado.recientes.pop_front();
        }
        if !estado.con_archivo {
            return;
        }
        if t >= estado.rotar_desde {
            if let Err(e) = self.rotar_si_hace_falta(&mut estado) {
                estado.fallo = Some(texto_de_fallo(&self.redactar, "no se pudo rotar el log", &e));
                estado.rotar_desde = t + ESPERA_REINTENTO_ROTACION_MS;
            }
        }
        if t < estado.rotar_desde && estado.tamano_visto >= self.max.saturating_mul(TOPE_SIN_ROTAR) {
            return;
        }
        let linea = linea_de_log(t, nivel, &origen, &msg);
        let escrito = OpenOptions::new().append(true).create(true).open(&self.archivo).and_then(|mut f| f.write_all(linea.as_bytes()));
        if let Err(e) = escrito {
            estado.fallo = Some(texto_de_fallo(&self.redactar, "no se pudo escribir el log", &e));
        }
    }

    pub fn error(&self, origen: &str, e: impl Display) {
        self.escribir(Nivel::Error, origen, &e.to_string());
    }

    pub fn aviso(&self, origen: &str, msg: &str) {
        self.escribir(Nivel::Aviso, origen, msg);
    }

    pub fn info(&self, origen: &str, msg: &str) {
        self.escribir(Nivel::Info, origen, msg);
    }

    pub fn recientes(&self, n: usize) -> Vec<EntradaLog> {
        let estado = self.bloquear();
        let salta = estado.recientes.len().saturating_sub(n);
        estado.recientes.iter().skip(salta).cloned().collect()
    }

    pub fn fallo(&self) -> Option<String> {
        self.bloquear().fallo.clone()
    }

    pub fn archivo(&self) -> &Path {
        &self.archivo
    }
}

#[cfg(test)]
mod tests;
