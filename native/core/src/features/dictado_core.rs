//! Dictado con Whisper (equivale a src/main/dictado-core.ts, src/shared/dictado.ts, src/shared/wav.ts y lo puro de
//! features/dictado.ts): la UI graba un WAV de 16 kHz, main lo pasa por whisper-cli y devuelve el texto. Acá va lo que no
//! toca el micrófono ni la inferencia: elegir el modelo, armar los argumentos, limpiar la salida y los errores.
use super::dictado_modelo::{ErrorModelo, ModeloError};
use super::export_import_logic::cortar16;
use crate::perfiles_core::es_blanco_js;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EstadoDictado {
    Inactivo,
    Escuchando,
    Transcribiendo,
}

/// Qué falló, para elegir el mensaje y si hay ajustes de Windows para abrir.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TipoErrorDictado {
    Microfono,
    SinMicrofono,
    SinMotor,
    SinModelo,
    Sistema,
    Otro,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ErrorDictado {
    pub tipo: TipoErrorDictado,
    pub mensaje: String,
    /// Hay una pantalla de Configuración de Windows que lo arregla.
    pub ajustes: bool,
}

/// Respuesta de `feat:dictado:transcribir`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResultadoDictado {
    Ok { texto: String },
    Error { error: ErrorDictado },
}

/// Porcentaje (0-100) de un evento `feat:dictado:modelo`; None si no hay bajada en curso o el dato no es válido.
pub fn porcentaje_modelo(p: &Value) -> Option<u8> {
    let o = p.as_object()?;
    let (recibidos, total) = (o.get("recibidos")?.as_f64()?, o.get("total")?.as_f64()?);
    if !(total > 0.0) || !(recibidos >= 0.0) {
        return None;
    }
    Some((100.0 * recibidos / total).floor().min(100.0) as u8)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModeloWhisper {
    pub archivo: &'static str,
    pub url: &'static str,
    /// Es el mismo hash que `X-Linked-ETag` de HuggingFace.
    pub sha256: &'static str,
    /// Tamaño real del archivo: para el progreso si la respuesta no trae content-length y para el tope.
    pub bytes: u64,
}

/// El de siempre (también lo traía el instalador): anda en cualquier PC, pero se equivoca bastante.
pub const MODELO_CHICO: ModeloWhisper = ModeloWhisper {
    archivo: "ggml-small-q5_1.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
    sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    bytes: 190_085_487,
};

/// Mucho más preciso en español, pero el encoder procesa siempre 30 s de audio: en una Core Ultra 5 tarda ~15 s por parte
/// (el chico, ~7). Por eso es opcional («Dictado más preciso»).
pub const MODELO_TURBO: ModeloWhisper = ModeloWhisper {
    archivo: "ggml-large-v3-turbo-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    bytes: 574_041_195,
};

/// HuggingFace redirige a su CDN: solo estos hosts, y solo por https.
pub const MODELO_HOSTS: [&str; 7] = ["huggingface.co", "cdn-lfs.hf.co", "cdn-lfs-us-1.hf.co", "cdn-lfs-eu-1.hf.co", "us.aws.cdn.hf.co", "eu.aws.cdn.hf.co", "cas-bridge.xethub.hf.co"];

/// WAV mono de 16 bits a 16 kHz: 5 minutos son ~9,6 MB.
pub const MAX_WAV_BYTES: usize = 12 * 1024 * 1024;

/// Cada cuánto se avisa el avance a la UI: el stream manda miles de chunks.
pub const AVISO_MS: u64 = 250;

/// Pista para Whisper: el vocabulario técnico y el voseo salen mejor si el modelo los «espera». No se transcribe: solo
/// orienta. Es una frase en castellano con las palabras técnicas adentro: una lista de palabras en inglés hacía que las
/// partes cortas salieran en inglés.
pub const PISTA: &str = "Bueno, che, te cuento lo que quiero que hagas en el proyecto. Fijate el commit en la branch de staging, hacé el merge y revisá el pull request antes del deploy. Dale, avisame.";

/// De lo ya dictado, cuánto se le pasa a la parte siguiente para que siga la oración (caracteres).
const MAX_PREVIO: usize = 220;
const MAX_TEXTO: usize = 4000;

/// `s.slice(-n)` de JavaScript: las últimas n unidades UTF-16, sin partir un par sustituto.
fn cola16(s: &str, n: usize) -> &str {
    let mut unidades = 0;
    for (i, c) in s.char_indices().rev() {
        unidades += c.len_utf16();
        if unidades > n {
            return &s[i + c.len_utf8()..];
        }
    }
    s
}

fn re_blancos() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\s+").expect("regex fija"))
}

/// El texto va a la terminal: sin caracteres de control (un \r mandaría el mensaje) ni espacios de más.
pub fn limpiar_texto(t: &str) -> String {
    let sin_control: String = {
        let mut out = String::with_capacity(t.len());
        let mut en_control = false;
        for c in t.chars() {
            if matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}') {
                if !en_control {
                    out.push(' ');
                }
                en_control = true;
            } else {
                en_control = false;
                out.push(c);
            }
        }
        out
    };
    let junto = re_blancos().replace_all(&sin_control, " ");
    cortar16(junto.trim_matches(es_blanco_js), MAX_TEXTO).to_string()
}

/// Lo último ya transcripto, limpio y cortado en una palabra entera: el contexto de la parte siguiente.
pub fn previo_de(texto: &Value) -> String {
    let Some(texto) = texto.as_str() else { return String::new() };
    // Primero la cola: limpiar_texto corta a MAX_TEXTO desde el principio.
    let t = limpiar_texto(cola16(texto, MAX_PREVIO * 2));
    if t.encode_utf16().count() <= MAX_PREVIO {
        return t;
    }
    let cola = cola16(&t, MAX_PREVIO);
    match cola.find(' ') {
        Some(i) => cola[i + 1..].to_string(),
        None => cola.to_string(),
    }
}

/// Hilos para whisper-cli: la mitad de los núcleos, entre 2 y 8 (deja aire para la app y las terminales).
pub fn hilos(cpus: usize) -> usize {
    (cpus / 2).clamp(2, 8)
}

pub struct ArgsWhisper<'a> {
    pub model: &'a str,
    pub wav: &'a str,
    pub threads: usize,
    pub previo: Option<&'a str>,
}

pub fn whisper_args(o: &ArgsWhisper) -> Vec<String> {
    let prompt = match o.previo {
        Some(p) if !p.is_empty() => format!("{PISTA} {p}"),
        _ => PISTA.to_string(),
    };
    // --carry-initial-prompt: sin él la pista solo vale para los primeros 30 s y después vuelve el castellano de España
    // («vosotros sabéis»). -mc acota lo que arrastra de una ventana a otra, para que un error no contagie a lo que sigue.
    ["-m", o.model, "-f", o.wav, "-l", "es", "-t", &o.threads.to_string(), "-nt", "-np", "--prompt", &prompt, "--carry-initial-prompt", "-mc", "64"].map(String::from).to_vec()
}

/// Tiempo para transcribir un WAV de 16 kHz mono: 30 s fijos más 4 veces lo que dura (una PC lenta tarda más que el audio).
pub fn timeout_ms(wav_bytes: u64) -> f64 {
    30_000.0 + 4.0 * ((wav_bytes as f64 - 44.0) / 32.0).max(0.0)
}

fn alucinaciones() -> &'static [Regex] {
    static R: OnceLock<Vec<Regex>> = OnceLock::new();
    R.get_or_init(|| {
        [r"\[[^\]]*\]", r"\([^)]*\)", r"(?i)subt[ií]tulos (?:realizados|hechos|creados) por [^\n]*", r"(?i)amara\.org", r"(?i)¡?gracias por (?:ver|mirar)(?: el v[ií]deo)?!?\.?"]
            .iter()
            .map(|p| Regex::new(p).expect("regex fija"))
            .collect()
    })
}

/// Salida de whisper-cli (stdout con -nt -np) → texto para la terminal. Vacío si no se dijo nada. Lo que Whisper «escucha»
/// en el silencio o el ruido (marcas entre corchetes o paréntesis, frases de subtítulos con las que fue entrenado) se saca.
pub fn texto_de_salida(stdout: &str) -> String {
    let mut t = stdout.to_string();
    for re in alucinaciones() {
        t = re.replace_all(&t, " ").into_owned();
    }
    let t = limpiar_texto(&t);
    // Si solo quedó puntuación, no se dijo nada.
    static R: OnceLock<Regex> = OnceLock::new();
    if R.get_or_init(|| Regex::new(r"[\p{L}\p{N}]").expect("regex fija")).is_match(&t) { t } else { String::new() }
}

/// ¿Es un WAV de verdad (cabecera RIFF/WAVE) y de un tamaño razonable?
pub fn wav_valido(b: &[u8]) -> bool {
    b.len() >= 44 && b.len() <= MAX_WAV_BYTES && &b[0..4] == b"RIFF" && &b[8..12] == b"WAVE"
}

/// Muestras float (-1..1) de un canal → WAV PCM de 16 bits, que es lo que lee whisper-cli.
pub fn encode_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let datos = samples.len() as u32 * 2;
    let mut b = Vec::with_capacity(44 + samples.len() * 2);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + datos).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&sample_rate.to_le_bytes());
    b.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&datos.to_le_bytes());
    for &m in samples {
        let s = (m as f64).clamp(-1.0, 1.0);
        let v = if s < 0.0 { s * 32768.0 } else { s * 32767.0 };
        b.extend_from_slice(&(v as i16).to_le_bytes());
    }
    b
}

/// Nivel de la señal (RMS). Por debajo de ~0,005 es silencio: no vale la pena pasarlo a Whisper.
pub fn rms(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>() / samples.len() as f64).sqrt()
}

fn mensaje_de(tipo: TipoErrorDictado) -> &'static str {
    match tipo {
        TipoErrorDictado::Microfono => "No hay acceso al micrófono. Revisá que esté conectado y que Windows deje usarlo a las apps de escritorio.",
        TipoErrorDictado::SinMicrofono => "No encontramos un micrófono. Conectá uno y probá de nuevo.",
        TipoErrorDictado::SinMotor => "Falta el motor de dictado. Reinstalá Sloth con la última versión.",
        TipoErrorDictado::SinModelo => "No pudimos bajar el modelo de dictado (sin conexión). Probá de nuevo cuando tengas internet.",
        TipoErrorDictado::Sistema => "El dictado por ahora funciona solo en Windows.",
        TipoErrorDictado::Otro => "No se pudo dictar.",
    }
}

/// Pantallas de Configuración de Windows que arreglan cada error (lista cerrada: es lo único que se abre).
pub fn ajustes_dictado(tipo: TipoErrorDictado) -> Option<&'static str> {
    match tipo {
        TipoErrorDictado::Microfono => Some("ms-settings:privacy-microphone"),
        TipoErrorDictado::SinMicrofono => Some("ms-settings:sound"),
        _ => None,
    }
}

/// El tipo de error por su nombre en el IPC (`feat:dictado:ajustes`); None si no hay pantalla de ajustes para él.
pub fn ajustes_por_nombre(tipo: &Value) -> Option<&'static str> {
    let t = match tipo.as_str()? {
        "microfono" => TipoErrorDictado::Microfono,
        "sin-microfono" => TipoErrorDictado::SinMicrofono,
        _ => return None,
    };
    ajustes_dictado(t)
}

pub fn error_dictado(tipo: TipoErrorDictado, detalle: Option<&str>) -> ErrorDictado {
    let detalle = detalle.filter(|d| !d.is_empty());
    let mensaje = match (tipo, detalle) {
        (TipoErrorDictado::Otro, Some(d)) => format!("{} ({})", mensaje_de(tipo), cortar16(d, 80)),
        (TipoErrorDictado::SinModelo, Some("disco")) => "No hay espacio para bajar el modelo de dictado.".to_string(),
        (TipoErrorDictado::SinModelo, Some("servidor")) => "El servidor del modelo de dictado respondió algo inesperado. Actualizá Sloth o probá más tarde.".to_string(),
        _ => mensaje_de(tipo).to_string(),
    };
    ErrorDictado { tipo, mensaje, ajustes: ajustes_dictado(tipo).is_some() }
}

/// El modelo elegido en Configuración (`terminal.dictadoPreciso`).
pub fn modelo_elegido(preciso: bool) -> &'static ModeloWhisper {
    if preciso { &MODELO_TURBO } else { &MODELO_CHICO }
}

/// Primero lo bajado a userData; después lo que traiga la carpeta del motor (dev e instalaciones viejas).
pub fn buscar_modelo(m: &ModeloWhisper, carpetas: &[&Path], existe: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    carpetas.iter().map(|d| d.join(m.archivo)).find(|p| existe(p))
}

/// Tope de lo que se acepta bajar: un 10 % más que el tamaño real.
pub fn tope_del_modelo(m: &ModeloWhisper) -> u64 {
    (m.bytes as f64 * 1.1).ceil() as u64
}

/// Lo que ve el usuario cuando falla la bajada del modelo.
pub fn error_de_modelo(err: &ModeloError) -> ErrorDictado {
    match err.tipo {
        ErrorModelo::Escritura => error_dictado(TipoErrorDictado::Otro, Some("no se pudo guardar el modelo")),
        ErrorModelo::Invalido => error_dictado(TipoErrorDictado::Otro, None),
        t => {
            let detalle = match t {
                ErrorModelo::Disco => Some("disco"),
                ErrorModelo::Hash | ErrorModelo::Http => Some("servidor"),
                _ => None,
            };
            error_dictado(TipoErrorDictado::SinModelo, detalle)
        }
    }
}

/// El detalle del error de whisper-cli: un proceso cortado por el tiempo se dice «tardó demasiado».
pub fn detalle_de_fallo(mensaje: &str) -> Option<&'static str> {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)timed out|ETIMEDOUT|SIGTERM").expect("regex fija")).is_match(mensaje).then_some("tardó demasiado")
}

/// Segundos de audio de un WAV de 16 kHz mono, con un decimal (para el log).
pub fn segundos_de_audio(wav_bytes: u64) -> f64 {
    ((wav_bytes as f64 - 44.0) / 3200.0 + 0.5).floor() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(previo: Option<&str>) -> Vec<String> {
        whisper_args(&ArgsWhisper { model: "m.bin", wav: "a.wav", threads: 4, previo })
    }

    fn valor_de<'a>(a: &'a [String], flag: &str) -> &'a str {
        &a[a.iter().position(|x| x == flag).unwrap() + 1]
    }

    #[test]
    fn whisper_args_pide_espanol_sin_marcas_de_tiempo_y_con_la_pista() {
        let a = args(None);
        assert_eq!(a[..8], ["-m", "m.bin", "-f", "a.wav", "-l", "es", "-t", "4"]);
        assert!(a.contains(&"-nt".into()) && a.contains(&"-np".into()) && a.contains(&"--prompt".into()));
    }

    #[test]
    fn whisper_args_repite_la_pista_en_cada_ventana_y_acota_el_contexto() {
        let a = args(None);
        assert!(a.contains(&"--carry-initial-prompt".into()));
        assert_eq!(valor_de(&a, "-mc"), "64");
    }

    #[test]
    fn whisper_args_suma_lo_ya_dictado_a_la_pista() {
        assert_eq!(valor_de(&args(Some("y después revisá")), "--prompt"), format!("{PISTA} y después revisá"));
        assert_eq!(valor_de(&args(Some("")), "--prompt"), PISTA);
        assert_eq!(valor_de(&args(None), "--prompt"), PISTA);
    }

    #[test]
    fn previo_de_la_cola_de_lo_dictado_limpia_y_en_una_palabra_entera() {
        assert_eq!(previo_de(&Value::Null), "");
        assert_eq!(previo_de(&json!(42)), "");
        assert_eq!(previo_de(&json!("hola\r\nche")), "hola che");
        let largo = format!("{}final", "palabra ".repeat(1000));
        let p = previo_de(&json!(largo));
        assert!(p.len() <= 220 && p.ends_with("final") && p.starts_with("palabra"), "{p}");
    }

    #[test]
    fn previo_de_cuenta_unidades_utf16_y_no_parte_emojis() {
        let largo = format!("{}fin", "😀 ".repeat(500));
        let p = previo_de(&json!(largo));
        assert!(p.encode_utf16().count() <= 220 && p.ends_with("fin"));
        assert!(p.starts_with('😀'));
    }

    #[test]
    fn timeout_ms_crece_con_lo_que_dura_el_audio() {
        assert_eq!(timeout_ms(44), 30_000.0);
        assert_eq!(timeout_ms(44 + 32_000 * 25), 130_000.0);
        assert_eq!(timeout_ms(44 + 32_000 * 300), 1_230_000.0);
        assert_eq!(timeout_ms(0), 30_000.0);
    }

    #[test]
    fn hilos_la_mitad_de_los_nucleos_entre_2_y_8() {
        assert_eq!((hilos(1), hilos(4), hilos(14), hilos(64)), (2, 2, 7, 8));
    }

    #[test]
    fn texto_de_salida_limpia_la_salida_de_whisper_cli() {
        assert_eq!(texto_de_salida("\n Hacé el commit en staging.\n Revisá los tests.\n"), "Hacé el commit en staging. Revisá los tests.");
    }

    #[test]
    fn texto_de_salida_saca_lo_que_whisper_inventa_con_silencio_o_ruido() {
        assert_eq!(texto_de_salida(" [BLANK_AUDIO]\n"), "");
        assert_eq!(texto_de_salida(" (música)"), "");
        assert_eq!(texto_de_salida(" Subtítulos realizados por la comunidad de Amara.org"), "");
        assert_eq!(texto_de_salida(" ¡Gracias por ver el video!"), "");
        assert_eq!(texto_de_salida(" ..."), "");
        assert_eq!(texto_de_salida(" [risas] Abrí el PR."), "Abrí el PR.");
        assert_eq!(texto_de_salida(" SUBTITULOS HECHOS POR alguien\nHola"), "Hola");
    }

    #[test]
    fn el_texto_dictado_no_lleva_caracteres_de_control_un_cr_mandaria_el_mensaje() {
        assert_eq!(limpiar_texto("hacé el\r\nticket\x1b[2J  ya "), "hacé el ticket [2J ya");
    }

    #[test]
    fn limpiar_texto_corta_a_4000_y_trata_los_controles_del_c1() {
        assert_eq!(limpiar_texto(&"a".repeat(5000)).len(), 4000);
        assert_eq!(limpiar_texto("a\u{85}b\u{9f}c"), "a b c");
        assert_eq!(limpiar_texto("\u{a0}\u{feff}x\u{3000}"), "x");
    }

    #[test]
    fn wav_valido_acepta_un_wav_de_verdad_y_rechaza_lo_demas() {
        assert!(wav_valido(&encode_wav(&[0.0; 1600], 16000)));
        assert!(!wav_valido(&[0u8; 100]));
        assert!(!wav_valido(&[0u8; 10]));
        let mut grande = vec![0u8; MAX_WAV_BYTES + 1];
        grande[..12].copy_from_slice(&encode_wav(&[0.0], 16000)[..12]);
        assert!(!wav_valido(&grande));
        let mut justo = vec![0u8; MAX_WAV_BYTES];
        justo[..12].copy_from_slice(&encode_wav(&[0.0], 16000)[..12]);
        assert!(wav_valido(&justo));
    }

    #[test]
    fn encode_wav_arma_la_cabecera_y_las_muestras_como_el_ts() {
        let w = encode_wav(&[0.0, 1.0, -1.0, 2.0, 0.5, f32::NAN], 16000);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(w[4..8].try_into().unwrap()), 36 + 12);
        assert_eq!(&w[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(w[24..28].try_into().unwrap()), 16000);
        assert_eq!(u32::from_le_bytes(w[28..32].try_into().unwrap()), 32000);
        assert_eq!(&w[36..40], b"data");
        assert_eq!(u32::from_le_bytes(w[40..44].try_into().unwrap()), 12);
        let muestras: Vec<i16> = w[44..].chunks(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(muestras, vec![0, 32767, -32768, 32767, 16383, 0]);
    }

    #[test]
    fn rms_mide_el_nivel_de_la_senal() {
        assert_eq!(rms(&[]), 0.0);
        assert!((rms(&[0.5, -0.5, 0.5, -0.5]) - 0.5).abs() < 1e-12);
        assert!(rms(&[0.001; 100]) < 0.005);
    }

    #[test]
    fn error_dictado_arma_el_mensaje_y_dice_si_hay_ajustes_para_abrir() {
        assert!(error_dictado(TipoErrorDictado::Microfono, None).ajustes);
        assert!(!error_dictado(TipoErrorDictado::SinMotor, None).ajustes);
        assert!(error_dictado(TipoErrorDictado::Otro, Some("tardó demasiado")).mensaje.contains("tardó demasiado"));
        assert!(!error_dictado(TipoErrorDictado::SinModelo, None).ajustes);
        assert!(error_dictado(TipoErrorDictado::SinModelo, None).mensaje.contains("sin conexión"));
        assert!(error_dictado(TipoErrorDictado::SinModelo, Some("disco")).mensaje.contains("espacio"));
        assert!(!error_dictado(TipoErrorDictado::SinModelo, Some("servidor")).mensaje.contains("sin conexión"));
    }

    #[test]
    fn el_detalle_de_un_error_otro_se_corta_a_80() {
        let m = error_dictado(TipoErrorDictado::Otro, Some(&"x".repeat(200))).mensaje;
        assert_eq!(m, format!("No se pudo dictar. ({})", "x".repeat(80)));
        assert_eq!(error_dictado(TipoErrorDictado::Otro, Some("")).mensaje, "No se pudo dictar.");
    }

    #[test]
    fn los_errores_se_serializan_con_los_nombres_del_ts() {
        let v = serde_json::to_value(error_dictado(TipoErrorDictado::SinMicrofono, None)).unwrap();
        assert_eq!(v["tipo"], "sin-microfono");
        assert_eq!(v["ajustes"], true);
        assert_eq!(serde_json::to_value(EstadoDictado::Transcribiendo).unwrap(), "transcribiendo");
    }

    #[test]
    fn los_ajustes_son_una_lista_cerrada() {
        assert_eq!(ajustes_por_nombre(&json!("microfono")), Some("ms-settings:privacy-microphone"));
        assert_eq!(ajustes_por_nombre(&json!("sin-microfono")), Some("ms-settings:sound"));
        for t in [json!("sin-motor"), json!("otro"), json!("toString"), json!("__proto__"), json!(5), Value::Null] {
            assert_eq!(ajustes_por_nombre(&t), None, "{t}");
        }
    }

    #[test]
    fn porcentaje_modelo_acota_y_rechaza_datos_invalidos() {
        assert_eq!(porcentaje_modelo(&json!({ "recibidos": 50, "total": 200 })), Some(25));
        assert_eq!(porcentaje_modelo(&json!({ "recibidos": 500, "total": 200 })), Some(100));
        assert_eq!(porcentaje_modelo(&json!({ "recibidos": 0, "total": 10 })), Some(0));
        for p in [Value::Null, json!(3), json!({ "recibidos": 1 }), json!({ "recibidos": 1, "total": 0 }), json!({ "recibidos": -1, "total": 5 }), json!({ "recibidos": "1", "total": 5 })] {
            assert_eq!(porcentaje_modelo(&p), None, "{p}");
        }
    }

    #[test]
    fn los_modelos_son_datos_coherentes_con_las_reglas_de_la_bajada() {
        for m in [MODELO_CHICO, MODELO_TURBO] {
            assert_eq!(m.sha256.len(), 64);
            assert!(m.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
            assert!(m.url.ends_with(m.archivo));
            assert!(super::super::dictado_modelo::host_permitido(m.url, &MODELO_HOSTS), "{}", m.url);
            assert!(m.bytes > 0 && tope_del_modelo(&m) > m.bytes && tope_del_modelo(&m) <= m.bytes + m.bytes / 9);
        }
        assert_eq!(tope_del_modelo(&MODELO_CHICO), 209_094_036);
    }

    #[test]
    fn se_elige_el_modelo_segun_el_ajuste_y_se_busca_primero_en_userdata() {
        assert_eq!(modelo_elegido(true).archivo, MODELO_TURBO.archivo);
        assert_eq!(modelo_elegido(false).archivo, MODELO_CHICO.archivo);
        let (datos, motor) = (Path::new("/datos/whisper"), Path::new("/app/vendor/whisper"));
        let hay_en = |dirs: &'static [&'static str]| move |p: &Path| dirs.iter().any(|d| p.starts_with(d));
        assert_eq!(buscar_modelo(&MODELO_CHICO, &[datos, motor], &hay_en(&["/datos", "/app"])), Some(datos.join("ggml-small-q5_1.bin")));
        assert_eq!(buscar_modelo(&MODELO_CHICO, &[datos, motor], &hay_en(&["/app"])), Some(motor.join("ggml-small-q5_1.bin")));
        assert_eq!(buscar_modelo(&MODELO_CHICO, &[datos, motor], &hay_en(&[])), None);
    }

    #[test]
    fn los_errores_de_la_bajada_se_traducen_a_lo_que_ve_el_usuario() {
        let de = |tipo, reintentable| error_de_modelo(&ModeloError { mensaje: "x".into(), tipo, reintentable });
        assert_eq!(de(ErrorModelo::Escritura, false).tipo, TipoErrorDictado::Otro);
        assert!(de(ErrorModelo::Escritura, false).mensaje.contains("no se pudo guardar el modelo"));
        assert!(de(ErrorModelo::Disco, false).mensaje.contains("espacio"));
        assert!(de(ErrorModelo::Hash, true).mensaje.contains("servidor"));
        assert!(de(ErrorModelo::Http, false).mensaje.contains("servidor"));
        assert!(de(ErrorModelo::SinRed, true).mensaje.contains("sin conexión"));
        assert_eq!(de(ErrorModelo::Invalido, false).mensaje, "No se pudo dictar.");
    }

    #[test]
    fn un_proceso_cortado_por_el_tiempo_se_dice_tardo_demasiado() {
        assert_eq!(detalle_de_fallo("Command failed: timed out"), Some("tardó demasiado"));
        assert_eq!(detalle_de_fallo("spawn ETIMEDOUT"), Some("tardó demasiado"));
        assert_eq!(detalle_de_fallo("killed SIGTERM"), Some("tardó demasiado"));
        assert_eq!(detalle_de_fallo("exit 1"), None);
    }

    #[test]
    fn segundos_de_audio_redondea_a_un_decimal() {
        assert_eq!(segundos_de_audio(44 + 32_000), 1.0);
        assert_eq!(segundos_de_audio(44), 0.0);
        assert_eq!(segundos_de_audio(44 + 48_000), 1.5);
    }
}
