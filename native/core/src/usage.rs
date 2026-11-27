//! Escáner de uso de tokens de cada cuenta, a partir de los transcripts `.jsonl` del agente. Equivale a src/main/usage.ts.
//! Lo puro (`parse_line`, `acumular`, `medianoche_local`) no toca disco; `EscanerUso` lee de a bloques y solo lo que se agregó.
//! Los escaneos son síncronos: no hace falta el «ya hay uno en curso» del original, quien llame serializa.
use crate::cupo::{tokens_cupo, ventana_activa, EventoUso, VentanaUso};
use crate::proveedores::{proveedor_id_de, ProveedorId};
use crate::proveedores_fs::carpeta_historial;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const DIA_MS: i64 = 24 * 60 * 60 * 1000;
pub const VENTANA_5H_MS: i64 = 5 * 60 * 60 * 1000;
pub const PROFUNDIDAD_MAX: usize = 4;
pub const BLOQUE_LECTURA: usize = 1024 * 1024;
const FRESCO_MS: i64 = 20_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Entrada {
    pub id: String,
    pub ts: i64,
    pub input: f64,
    pub output: f64,
    pub cache_write: f64,
    pub cache_read: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Totales {
    pub input: f64,
    pub output: f64,
    pub cache_write: f64,
    pub cache_read: f64,
    pub messages: u64,
}

impl Totales {
    fn sumar(&mut self, e: &Entrada) {
        self.input += e.input;
        self.output += e.output;
        self.cache_write += e.cache_write;
        self.cache_read += e.cache_read;
        self.messages += 1;
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsoCuenta {
    pub last5h: Totales,
    pub today: Totales,
    pub last7d: Totales,
    pub scanned_at: i64,
    pub window_start: Option<i64>,
    pub ventana: Option<VentanaUso>,
}

fn dias_desde_epoch(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn num(b: &[u8], desde: usize, n: usize) -> Option<i64> {
    let t = b.get(desde..desde + n)?;
    if !t.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(t.iter().fold(0i64, |a, c| a * 10 + i64::from(c - b'0')))
}

/// El subconjunto ISO de `Date.parse` (`2026-11-17T10:00:00.123Z`, con o sin fracción, con `±hh:mm` o sin zona).
/// Sin zona se toma como UTC: los transcripts siempre traen `Z`.
pub fn parsear_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let anio = num(b, 0, 4)?;
    let mut i = 4;
    let mut mes = 1;
    let mut dia = 1;
    if b.get(i) == Some(&b'-') {
        mes = num(b, i + 1, 2)?;
        i += 3;
        if b.get(i) == Some(&b'-') {
            dia = num(b, i + 1, 2)?;
            i += 3;
        }
    }
    if !(1..=12).contains(&mes) || !(1..=31).contains(&dia) {
        return None;
    }
    let (mut h, mut mi, mut seg, mut ms) = (0, 0, 0, 0);
    let mut desfase_min = 0;
    if i < b.len() {
        if b[i] != b'T' && b[i] != b't' {
            return None;
        }
        h = num(b, i + 1, 2)?;
        if b.get(i + 3) != Some(&b':') {
            return None;
        }
        mi = num(b, i + 4, 2)?;
        i += 6;
        if b.get(i) == Some(&b':') {
            seg = num(b, i + 1, 2)?;
            i += 3;
            if b.get(i) == Some(&b'.') {
                let ini = i + 1;
                let mut j = ini;
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
                if j == ini {
                    return None;
                }
                for k in 0..3 {
                    ms = ms * 10 + b.get(ini + k).filter(|_| ini + k < j).map_or(0, |c| i64::from(c - b'0'));
                }
                i = j;
            }
        }
        if i < b.len() {
            match b[i] {
                b'Z' | b'z' => i += 1,
                b'+' | b'-' => {
                    let signo = if b[i] == b'-' { -1 } else { 1 };
                    let oh = num(b, i + 1, 2)?;
                    if b.get(i + 3) != Some(&b':') {
                        return None;
                    }
                    let om = num(b, i + 4, 2)?;
                    desfase_min = signo * (oh * 60 + om);
                    i += 6;
                }
                _ => return None,
            }
        }
        if i != b.len() {
            return None;
        }
    }
    if h > 24 || mi > 59 || seg > 59 || (h == 24 && (mi, seg, ms) != (0, 0, 0)) {
        return None;
    }
    let dias = dias_desde_epoch(anio, mes, dia);
    Some(dias * DIA_MS + ((h * 60 + mi - desfase_min) * 60 + seg) * 1000 + ms)
}

fn tokens(u: &Value, clave: &str) -> f64 {
    u.get(clave).and_then(Value::as_f64).unwrap_or(0.0)
}

pub fn parse_line(linea: &str) -> Option<Entrada> {
    if !linea.contains("\"usage\"") {
        return None;
    }
    let j: Value = serde_json::from_str(linea).ok()?;
    let u = j.get("message")?.get("usage").filter(|u| u.is_object())?;
    if j.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let ts = parsear_iso_ms(j.get("timestamp").and_then(Value::as_str).filter(|t| !t.is_empty())?)?;
    // Un mismo mensaje aparece en varias líneas (una por bloque): se cuenta una sola vez.
    let id = j["message"].get("id").and_then(Value::as_str).or_else(|| j.get("requestId").and_then(Value::as_str)).map_or_else(|| ts.to_string(), str::to_owned);
    Some(Entrada {
        id,
        ts,
        input: tokens(u, "input_tokens"),
        output: tokens(u, "output_tokens"),
        cache_write: tokens(u, "cache_creation_input_tokens"),
        cache_read: tokens(u, "cache_read_input_tokens"),
    })
}

/// Medianoche de hoy en la zona del usuario, en ms de epoch. `desfase_min` es el de la zona respecto de UTC (Buenos Aires: -180).
pub fn medianoche_local(ahora: i64, desfase_min: i32) -> i64 {
    let off = i64::from(desfase_min) * 60_000;
    (ahora + off).div_euclid(DIA_MS) * DIA_MS - off
}

pub fn acumular<'a>(entradas: impl IntoIterator<Item = &'a Entrada>, ahora: i64, desfase_min: i32) -> UsoCuenta {
    let desde_7d = ahora - 7 * DIA_MS;
    let medianoche = medianoche_local(ahora, desfase_min);
    let entradas: Vec<&Entrada> = entradas.into_iter().collect();
    let mut uso = UsoCuenta { last5h: Totales::default(), today: Totales::default(), last7d: Totales::default(), scanned_at: ahora, window_start: None, ventana: None };
    for e in &entradas {
        if e.ts < desde_7d {
            continue;
        }
        uso.last7d.sumar(e);
        if e.ts >= medianoche {
            uso.today.sumar(e);
        }
        if e.ts >= ahora - VENTANA_5H_MS {
            uso.last5h.sumar(e);
            if uso.window_start.is_none_or(|w| e.ts < w) {
                uso.window_start = Some(e.ts);
            }
        }
    }
    let eventos: Vec<EventoUso> = entradas.iter().map(|e| EventoUso { ts: e.ts as f64, tokens: tokens_cupo(e.input, e.output, e.cache_write) }).collect();
    uso.ventana = ventana_activa(&eventos, ahora as f64);
    uso
}

#[derive(Debug, Clone, PartialEq)]
pub struct CuentaUso {
    pub id: String,
    pub config_dir: PathBuf,
    /// None si el proveedor de la cuenta no tiene la capacidad `uso` (o no se conoce): no se escanea nada.
    pub carpeta_historial: Option<&'static str>,
}

impl CuentaUso {
    pub fn desde_cuenta(cuenta: &Value) -> Option<CuentaUso> {
        let id = cuenta.get("id")?.as_str()?.to_owned();
        let config_dir = PathBuf::from(cuenta.get("configDir")?.as_str()?);
        let carpeta_historial = proveedor_id_de(cuenta).filter(|p: &ProveedorId| p.capacidades().uso).map(carpeta_historial);
        Some(CuentaUso { id, config_dir, carpeta_historial })
    }
}

fn listar_jsonl(dir: &Path, profundidad: usize, salida: &mut Vec<PathBuf>) {
    let Ok(items) = fs::read_dir(dir) else { return };
    let mut items: Vec<_> = items.flatten().collect();
    items.sort_by_key(|i| i.file_name());
    for it in items {
        let Ok(tipo) = it.file_type() else { continue };
        let ruta = it.path();
        if tipo.is_dir() && profundidad < PROFUNDIDAD_MAX {
            listar_jsonl(&ruta, profundidad + 1, salida);
        } else if tipo.is_file() && it.file_name().to_string_lossy().ends_with(".jsonl") {
            salida.push(ruta);
        }
    }
}

pub fn buscar_jsonl(dir: &Path) -> Vec<PathBuf> {
    let mut salida = Vec::new();
    listar_jsonl(dir, 0, &mut salida);
    salida
}

#[derive(Debug, Default)]
struct CacheArchivo {
    /// Bytes ya leídos (siempre hasta el último salto de línea).
    offset: u64,
    mtime_ms: f64,
    entradas: HashMap<String, Entrada>,
}

#[derive(Debug, Default)]
pub struct EscanerUso {
    cache: HashMap<PathBuf, CacheArchivo>,
    ultimo: HashMap<String, UsoCuenta>,
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

impl EscanerUso {
    pub fn nuevo() -> Self {
        Self::default()
    }

    pub fn ultimo(&self) -> &HashMap<String, UsoCuenta> {
        &self.ultimo
    }

    /// Reusa el último resultado si es de hace menos de 20 s y cubre a todas las cuentas.
    pub fn escanear(&mut self, cuentas: &[CuentaUso], ahora: i64, desfase_min: i32) -> &HashMap<String, UsoCuenta> {
        let fresco = self.ultimo.values().next().map(|u| u.scanned_at).filter(|&t| t != 0);
        let mismas = cuentas.iter().all(|c| self.ultimo.contains_key(&c.id));
        if !(fresco.is_some_and(|t| mismas && ahora - t < FRESCO_MS)) {
            self.escanear_ya(cuentas, ahora, desfase_min);
        }
        &self.ultimo
    }

    pub fn escanear_ya(&mut self, cuentas: &[CuentaUso], ahora: i64, desfase_min: i32) {
        let desde_7d = ahora - 7 * DIA_MS;
        let mut resultado = HashMap::new();
        for c in cuentas {
            let archivos = c.carpeta_historial.map(|d| buscar_jsonl(&c.config_dir.join(d))).unwrap_or_default();
            let mut vistas: HashMap<String, Entrada> = HashMap::new();
            for f in &archivos {
                if let Some(cache) = self.leer_nuevo(f, desde_7d as f64) {
                    vistas.extend(cache.entradas.iter().map(|(k, v)| (k.clone(), v.clone())));
                }
            }
            resultado.insert(c.id.clone(), acumular(vistas.values(), ahora, desfase_min));
        }
        self.ultimo = resultado;
    }

    fn leer_nuevo(&mut self, archivo: &Path, desde: f64) -> Option<&CacheArchivo> {
        let Ok(meta) = fs::metadata(archivo) else {
            self.cache.remove(archivo);
            return None;
        };
        let mtime = mtime_ms(&meta);
        if mtime < desde {
            return self.cache.get(archivo);
        }
        let tamano = meta.len();
        let mut c = match self.cache.remove(archivo) {
            Some(c) if tamano >= c.offset => c,
            _ => CacheArchivo::default(),
        };
        if c.mtime_ms == mtime && c.offset == tamano {
            return Some(self.cache.entry(archivo.to_path_buf()).or_insert(c));
        }
        // Un error de lectura deja el archivo como estaba: el próximo escaneo reintenta desde el mismo offset.
        if leer_bloques(archivo, tamano, &mut c).is_ok() {
            c.mtime_ms = mtime;
        }
        // Lo viejo no se usa más: se descarta para no crecer sin límite.
        c.entradas.retain(|_, e| e.ts as f64 >= desde);
        Some(self.cache.entry(archivo.to_path_buf()).or_insert(c))
    }
}

/// Lectura por bloques: memoria acotada aunque el transcript pese cientos de MB. Se corta siempre en '\n'
/// (byte 0x0a, nunca parte de un carácter UTF-8 multibyte).
fn leer_bloques(archivo: &Path, tamano: u64, c: &mut CacheArchivo) -> std::io::Result<()> {
    let mut f = File::open(archivo)?;
    f.seek(SeekFrom::Start(c.offset))?;
    let mut buf = vec![0u8; BLOQUE_LECTURA];
    let mut resto: Vec<u8> = Vec::new();
    let mut pos = c.offset;
    while pos < tamano {
        let pedir = BLOQUE_LECTURA.min((tamano - pos) as usize);
        let leidos = f.read(&mut buf[..pedir])?;
        if leidos == 0 {
            break;
        }
        pos += leidos as u64;
        let mut trozo = std::mem::take(&mut resto);
        trozo.extend_from_slice(&buf[..leidos]);
        let Some(ultimo_nl) = trozo.iter().rposition(|&b| b == b'\n') else {
            resto = trozo;
            continue;
        };
        for linea in String::from_utf8_lossy(&trozo[..ultimo_nl]).split('\n') {
            if let Some(e) = parse_line(linea) {
                c.entradas.insert(e.id.clone(), e);
            }
        }
        resto = trozo[ultimo_nl + 1..].to_vec();
    }
    // Lo que quedó sin salto de línea se relee la próxima vez.
    c.offset = pos - resto.len() as u64;
    Ok(())
}

#[cfg(test)]
mod tests;
