//! La terminal vista desde el celu: el visor que guarda la salida, cuánto entra en cada respuesta, la validación del
//! pedido que manda el celu y el filtro de lo que el xterm del celu contesta solo. Equivale a `celular-terminal-core.ts`.
//! Los largos son los de JavaScript (unidades UTF-16) y los pesos son bytes del JSON ya escapado, como los deja `JSON.stringify`.
use super::largo_utf16;
use crate::daemon_protocolo::PtyChunk;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::LazyLock;

/// Lo que el celu tiene guardado de una terminal: la salida desde que la abrió, recortada al final.
#[derive(Debug, Clone, PartialEq)]
pub struct Visor {
    pub chunks: Vec<PtyChunk>,
    pub tam: usize,
    /// Hasta qué seq llegó la foto inicial; mientras es None, todavía no llegó.
    pub foto: Option<u64>,
    pub usado_en: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tam {
    /// Lo mandaban las páginas viejas para achicar la terminal: se valida y no hace nada, el celu nunca cambia el tamaño de la PC.
    Pc,
    Dim { cols: u32, rows: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PedidoTerminal {
    pub id: String,
    /// Último seq que ya tiene el celu; -1 la primera vez.
    pub desde: i64,
    pub escribir: Option<String>,
    pub tam: Option<Tam>,
    /// Cuánto puede esperar la PC (ms) a que haya salida nueva antes de contestar vacío. Solo en un pedido de mirar.
    pub espera: Option<u32>,
    /// Pedido que solo escribe o cambia el tamaño: la PC contesta ya y sin salida.
    pub solo_escribir: bool,
    /// Identifica a la página (se renueva al recargarla); con `n`, el número de la escritura: la PC no repite una que ya hizo.
    pub sesion: Option<String>,
    pub n: Option<u32>,
}

impl PedidoTerminal {
    pub fn mirar(id: &str, desde: i64) -> Self {
        PedidoTerminal { id: id.into(), desde, escribir: None, tam: None, espera: None, solo_escribir: false, sesion: None, n: None }
    }
}

/// Lo que la salida le dice al celu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Salida {
    /// true: el celu tiene que borrar lo que tiene y escribir `datos` desde cero.
    pub reinicio: bool,
    pub datos: String,
    pub hasta: u64,
    /// Hay más salida ya guardada que no entró en esta respuesta: el celu vuelve a pedir enseguida.
    pub mas: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RespuestaTerminal {
    pub reinicio: bool,
    pub datos: String,
    pub hasta: u64,
    pub mas: bool,
    pub viva: bool,
    pub cols: u32,
    pub rows: u32,
    /// Siempre false: lo lee la página vieja que quedó en caché.
    pub ajustado: bool,
}

impl RespuestaTerminal {
    pub fn de(salida: Salida, viva: bool, cols: u32, rows: u32) -> Self {
        RespuestaTerminal { reinicio: salida.reinicio, datos: salida.datos, hasta: salida.hasta, mas: salida.mas, viva, cols, rows, ajustado: false }
    }
}

pub const MAX_VISOR_CHARS: usize = 150_000;
pub const MAX_ESCRIBIR: usize = 4000;
pub const VISOR_VENCE_MS: i64 = 30_000;
pub const ESPERA_MAX_MS: u32 = 25_000;
const N_MAX: u32 = 1_000_000_000;

/// Lo que va en cada respuesta: la página rechaza sobres de más de 262144 caracteres, y con AES en JS puro un celu lento no debería procesar mucho más de lo que se ve.
pub const MAX_DATOS_PESO: usize = 120_000;

pub fn nuevo_visor(ahora: i64) -> Visor {
    Visor { chunks: Vec::new(), tam: 0, foto: None, usado_en: ahora }
}

fn recortar(v: &mut Visor) {
    while v.tam > MAX_VISOR_CHARS && v.chunks.len() > 1 {
        let c = v.chunks.remove(0);
        v.tam -= largo_utf16(&c.data);
    }
}

/// Salida en vivo. Antes de la foto se guarda igual: la foto puede llegar después y no tiene que perderse nada.
pub fn sumar_salida(v: &mut Visor, chunks: &[PtyChunk]) {
    let ultimo = v.chunks.last().map(|c| c.seq as i64).unwrap_or(-1);
    for c in chunks {
        if c.seq as i64 <= ultimo {
            continue;
        }
        v.tam += largo_utf16(&c.data);
        v.chunks.push(c.clone());
    }
    recortar(v);
}

/// La foto del buffer del daemon, más lo que llegó en vivo mientras se pedía y es posterior.
pub fn poner_foto(v: &mut Visor, foto: &[PtyChunk], up_to: u64) {
    let mut nuevos: Vec<PtyChunk> = foto.iter().filter(|c| c.seq <= up_to).cloned().collect();
    nuevos.extend(v.chunks.iter().filter(|c| c.seq > up_to).cloned());
    v.tam = nuevos.iter().map(|c| largo_utf16(&c.data)).sum();
    v.chunks = nuevos;
    v.foto = Some(up_to);
    recortar(v);
}

fn peso_de(c: char) -> usize {
    match c as u32 {
        0x22 | 0x5c | 0x08 | 0x09 | 0x0a | 0x0c | 0x0d => 2,
        0..=0x1f => 6,
        0x20..=0x7f => 1,
        0x80..=0x7ff => 2,
        0x800..=0xffff => 3,
        _ => 4,
    }
}

/// Lo que `texto` ocupa dentro del JSON de la respuesta, en bytes UTF-8 ya escapados: un ESC pesa 6, una comilla o una
/// barra 2, un salto de línea 2, una letra con tilde 2 y un emoji 4. (Un sustituto suelto de JavaScript, que pesa 6,
/// no existe en un `&str`.)
pub fn peso_json(texto: &str) -> usize {
    texto.chars().map(peso_de).sum()
}

/// El final de `texto` que entra en `max`, sin partir un carácter.
fn cola_que_entra(texto: &str, max: usize) -> &str {
    let mut peso = 0;
    let mut desde = texto.len();
    for (i, c) in texto.char_indices().rev() {
        peso += peso_de(c);
        if peso > max {
            break;
        }
        desde = i;
    }
    &texto[desde..]
}

/// Lo que le falta al celu, sin pasar de `max` (peso en el JSON). Si pide algo que el visor ya recortó (o de otro visor),
/// va la cola más reciente que entre, cortada entre trozos. En una respuesta común van los trozos que entran desde
/// `desde` y `hasta` es el seq del último incluido: el próximo pedido sigue de ahí, sin huecos ni repetidos, y `mas`
/// avisa que quedó salida por mandar. Un trozo solo que no entra en `max` se manda truncado a su final (lo más
/// reciente) y lo que quedó antes se pierde.
pub fn salida_desde(v: &Visor, desde: i64, max: usize) -> Salida {
    let ultimo = v.chunks.last().map(|c| c.seq as i64).unwrap_or_else(|| v.foto.unwrap_or(0) as i64);
    let primero = v.chunks.first().map(|c| c.seq as i64).unwrap_or(ultimo + 1);
    let reinicio = desde < 0 || desde > ultimo || desde < primero - 1;
    let lista: Vec<&PtyChunk> = if reinicio { v.chunks.iter().collect() } else { v.chunks.iter().filter(|c| c.seq as i64 > desde).collect() };
    let Some(ultimo_de_lista) = lista.last() else { return Salida { reinicio, datos: String::new(), hasta: ultimo as u64, mas: false } };
    if reinicio {
        let mut peso = 0;
        let mut i = lista.len();
        while i > 0 {
            let p = peso_json(&lista[i - 1].data);
            if peso + p > max {
                break;
            }
            peso += p;
            i -= 1;
        }
        let datos = if i < lista.len() { lista[i..].iter().map(|c| c.data.as_str()).collect() } else { cola_que_entra(&ultimo_de_lista.data, max).to_string() };
        return Salida { reinicio, datos, hasta: ultimo as u64, mas: false };
    }
    let mut peso = 0;
    let mut n = 0;
    let mut datos = String::new();
    while n < lista.len() {
        let p = peso_json(&lista[n].data);
        if n > 0 && peso + p > max {
            break;
        }
        datos.push_str(if p > max { cola_que_entra(&lista[n].data, max) } else { &lista[n].data });
        peso += p;
        n += 1;
    }
    Salida { reinicio, datos, hasta: lista[n - 1].seq, mas: n < lista.len() }
}

fn id_valido(id: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Un número entero (JSON `5` o `5.0`) dentro de un rango.
fn dim(v: Option<&Value>, min: i64, max: i64) -> Option<i64> {
    let n = v?.as_f64()?;
    (n.fract() == 0.0 && n >= min as f64 && n <= max as f64).then_some(n as i64)
}

/// Valida lo que manda el celu (ya abierto el sello). None = pedido inválido.
pub fn leer_pedido_terminal(b: &Value) -> Option<PedidoTerminal> {
    let o = b.as_object()?;
    let id = o.get("id")?.as_str().filter(|i| id_valido(i, 1, 80))?;
    let desde = dim(o.get("desde"), -1, i64::MAX / 2)?;
    let mut p = PedidoTerminal::mirar(id, desde);
    if let Some(e) = o.get("escribir") {
        p.escribir = Some(e.as_str().filter(|e| !e.is_empty() && largo_utf16(e) <= MAX_ESCRIBIR)?.to_string());
    }
    if let Some(t) = o.get("tam") {
        p.tam = Some(match t {
            Value::String(s) if s == "pc" => Tam::Pc,
            Value::Object(t) => Tam::Dim { cols: dim(t.get("cols"), 20, 500)? as u32, rows: dim(t.get("rows"), 5, 200)? as u32 },
            _ => return None,
        });
    }
    let escribe = p.escribir.is_some() || p.tam.is_some();
    if let Some(e) = o.get("espera") {
        p.espera = Some(dim(Some(e), 0, ESPERA_MAX_MS as i64)? as u32);
    }
    if let Some(s) = o.get("soloEscribir") {
        if s != &Value::Bool(true) || !escribe {
            return None;
        }
        p.solo_escribir = true;
    }
    if p.espera.is_some_and(|e| e > 0) && (escribe || p.solo_escribir) {
        return None;
    }
    if let Some(s) = o.get("sesion") {
        p.sesion = Some(s.as_str().filter(|s| id_valido(s, 8, 40))?.to_string());
    }
    if let Some(n) = o.get("n") {
        if p.sesion.is_none() || !escribe {
            return None;
        }
        p.n = Some(dim(Some(n), 1, N_MAX as i64)? as u32);
    }
    Some(p)
}

/// Los visores que nadie consulta hace rato.
pub fn vencidos(visores: &HashMap<String, Visor>, ahora: i64, vence_ms: i64) -> Vec<String> {
    visores.iter().filter(|(_, v)| ahora - v.usado_en > vence_ms).map(|(id, _)| id.clone()).collect()
}

/// El tamaño de la terminal: el de la PC, que el celu nunca cambia.
pub fn tamano_actual(pc: Option<(u32, u32)>) -> (u32, u32) {
    pc.unwrap_or((80, 24))
}

/// Si el pedido de mirar tiene que quedar abierto: no hay nada nuevo que mandar, la terminal está viva y no es la primera vez.
pub fn debe_esperar(p: &PedidoTerminal, reinicio: bool, datos: &str, viva: bool) -> bool {
    p.espera.is_some_and(|e| e > 0) && !p.solo_escribir && viva && p.desde >= 0 && !reinicio && datos.is_empty()
}

/// La respuesta de un pedido que no trae salida: el celu sigue desde donde estaba.
pub fn sin_salida(p: &PedidoTerminal) -> Salida {
    Salida { reinicio: false, datos: String::new(), hasta: p.desde.max(0) as u64, mas: false }
}

/// Lo que el xterm del celu emite solo y no tipeó nadie: respuestas a consultas del programa (posición del cursor,
/// atributos, modos, tamaño, colores), reportes de foco y de mouse (SGR y X10). El primer grupo es un pegado entre
/// corchetes, que se deja tal cual: lo de adentro es texto del usuario. Los grupos 2 y 3 son los que en JavaScript llevan
/// una condición negativa (`(?!…)`), que `regex` no tiene: se deciden al reemplazar.
static AUTOMATICAS: LazyLock<Regex> = LazyLock::new(|| {
    // `[\x20-￿]` de JavaScript incluye los sustitutos (un emoji son dos unidades): `unidades` los pone en 10D800..10DFFF.
    Regex::new(concat!(
        r"(\x1b\[200~[\s\S]*?(?:\x1b\[201~|$))",
        r"|\x1b\[[?>=]?[0-9;:]*\$y",
        r"|(\x1b\[\??[0-9]+;[0-9]+R)",
        r"|\x1b\[[?>=][0-9;]*c",
        r"|\x1b\[\??[0-9]+(?:;[0-9]+)*n",
        r"|\x1b\[[0-9]+(?:;[0-9]+)*t",
        r"|\x1b\[[IO]",
        r"|(\x1b\[<[0-9]+;[0-9]+;[0-9]+[Mm])",
        r"|\x1b\[M[\x20-\x{FFFF}\x{10D800}-\x{10DFFF}]{3}",
        r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)",
        r"|\x1bP[^\x1b]*\x1b\\",
    ))
    .expect("regex fija")
});

/// El texto como una cadena donde cada unidad UTF-16 es un carácter, para que el largo de las reglas sea el de JavaScript.
fn unidades(t: &str) -> String {
    t.encode_utf16().map(|u| if (0xD800..=0xDFFF).contains(&u) { char::from_u32(0x100000 + u as u32).unwrap_or('\u{FFFD}') } else { char::from_u32(u as u32).unwrap_or('\u{FFFD}') }).collect()
}

fn desde_unidades(t: &str) -> String {
    let u: Vec<u16> = t.chars().map(|c| if (0x10D800..=0x10DFFF).contains(&(c as u32)) { (c as u32 - 0x100000) as u16 } else { c as u32 as u16 }).collect();
    String::from_utf16_lossy(&u)
}

fn es_tecla_con_modificador(m: &str) -> bool {
    let b = m.as_bytes();
    b.len() == 6 && &b[..4] == b"\x1b[1;" && (b'2'..=b'8').contains(&b[4]) && b[5] == b'R'
}

fn es_rueda_del_mouse(m: &str) -> bool {
    m.starts_with("\x1b[<64;") || m.starts_with("\x1b[<65;")
}

/// Le saca a lo que manda el celu las secuencias completas que no tipeó nadie. Solo quita, nunca agrega. Se repite porque
/// al sacar una secuencia pueden juntarse los restos y formar otra; así el resultado ya no cambia si se vuelve a pasar.
/// Dos límites a propósito, para no perder entrada de verdad: ESC[1;2R a ESC[1;8R (F3 con modificador) no se descarta
/// aunque una posición real en la fila 1 se vea igual, y la rueda del mouse (ESC[<64;x;yM y 65) pasa porque es el
/// usuario deslizando. Una página nueva ya filtra cada tecla por separado y no junta lo que empieza con ESC; esto es la
/// defensa de la PC.
pub fn sin_automaticas(texto: &str) -> String {
    let mut t = unidades(texto);
    for _ in 0..16 {
        let r = AUTOMATICAS.replace_all(&t, |c: &regex::Captures| {
            let m = &c[0];
            if c.get(1).is_some() || (c.get(2).is_some() && es_tecla_con_modificador(m)) || (c.get(3).is_some() && es_rueda_del_mouse(m)) {
                m.to_string()
            } else {
                String::new()
            }
        });
        if r == t {
            break;
        }
        t = r.into_owned();
    }
    desde_unidades(&t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::celular::pruebas::clave_de;
    use crate::features::celular::sello::{derivar_claves, sellar_respuesta};
    use serde_json::json;

    fn c(seq: u64) -> PtyChunk {
        PtyChunk { seq, data: format!("[{seq}]") }
    }

    fn cd(seq: u64, data: &str) -> PtyChunk {
        PtyChunk { seq, data: data.into() }
    }

    fn pedido(v: Value) -> Option<PedidoTerminal> {
        leer_pedido_terminal(&v)
    }

    fn salida(reinicio: bool, datos: &str, hasta: u64, mas: bool) -> Salida {
        Salida { reinicio, datos: datos.into(), hasta, mas }
    }

    fn visor_de(chunks: Vec<PtyChunk>) -> Visor {
        let mut v = nuevo_visor(0);
        let hasta = chunks.last().unwrap().seq;
        poner_foto(&mut v, &chunks, hasta);
        v
    }

    #[test]
    fn la_foto_se_junta_con_lo_que_llego_en_vivo_mientras_se_pedia_sin_repetir() {
        let mut v = nuevo_visor(0);
        sumar_salida(&mut v, &[c(4), c(5)]);
        poner_foto(&mut v, &[c(1), c(2), c(3), c(4)], 4);
        assert_eq!(v.chunks.iter().map(|x| x.seq).collect::<Vec<_>>(), [1, 2, 3, 4, 5]);
        assert_eq!(v.foto, Some(4));
    }

    #[test]
    fn la_primera_vez_va_todo_despues_solo_lo_nuevo() {
        let mut v = nuevo_visor(0);
        poner_foto(&mut v, &[c(1), c(2)], 2);
        assert_eq!(salida_desde(&v, -1, MAX_DATOS_PESO), salida(true, "[1][2]", 2, false));
        sumar_salida(&mut v, &[c(3)]);
        assert_eq!(salida_desde(&v, 2, MAX_DATOS_PESO), salida(false, "[3]", 3, false));
        assert_eq!(salida_desde(&v, 3, MAX_DATOS_PESO), salida(false, "", 3, false));
    }

    #[test]
    fn si_el_celu_pide_algo_ya_recortado_o_de_otro_visor_se_le_manda_todo_de_nuevo() {
        let mut v = nuevo_visor(0);
        poner_foto(&mut v, &[c(10), c(11)], 11);
        assert!(salida_desde(&v, 3, MAX_DATOS_PESO).reinicio);
        assert!(salida_desde(&v, 50, MAX_DATOS_PESO).reinicio);
        assert!(!salida_desde(&v, 9, MAX_DATOS_PESO).reinicio);
    }

    #[test]
    fn el_visor_no_pasa_del_tope_pero_nunca_queda_vacio() {
        let mut v = nuevo_visor(0);
        poner_foto(&mut v, &[cd(1, &"x".repeat(MAX_VISOR_CHARS)), cd(2, &"y".repeat(10))], 2);
        assert_eq!(v.chunks.iter().map(|x| x.seq).collect::<Vec<_>>(), [2]);
        let mut w = nuevo_visor(0);
        sumar_salida(&mut w, &[cd(1, &"z".repeat(MAX_VISOR_CHARS + 5))]);
        assert_eq!(w.chunks.len(), 1);
    }

    #[test]
    fn valida_el_pedido_del_celu() {
        assert_eq!(pedido(json!({ "id": "ws-1", "desde": -1 })), Some(PedidoTerminal::mirar("ws-1", -1)));
        let con = pedido(json!({ "id": "ws-1", "desde": 3, "escribir": "hola\r", "tam": { "cols": 60, "rows": 30 } })).unwrap();
        assert_eq!((con.escribir.as_deref(), con.tam), (Some("hola\r"), Some(Tam::Dim { cols: 60, rows: 30 })));
        assert_eq!(pedido(json!({ "id": "ws-1", "desde": 0, "tam": "pc" })).unwrap().tam, Some(Tam::Pc));
        assert_eq!(leer_pedido_terminal(&Value::Null), None);
        for malo in [
            json!({ "id": "../x", "desde": 0 }),
            json!({ "id": "login:abc", "desde": 0 }),
            json!({ "id": "ws", "desde": -2 }),
            json!({ "id": "ws", "desde": 1.5 }),
            json!({ "id": "ws", "desde": 0, "escribir": "" }),
            json!({ "id": "ws", "desde": 0, "escribir": "x".repeat(MAX_ESCRIBIR + 1) }),
            json!({ "id": "ws", "desde": 0, "tam": { "cols": 5, "rows": 30 } }),
            json!({ "id": "ws", "desde": 0, "tam": "grande" }),
        ] {
            assert_eq!(pedido(malo.clone()), None, "{malo}");
        }
    }

    #[test]
    fn espera_entero_de_0_al_tope_cualquier_otra_cosa_invalida_el_pedido() {
        for ok in [0u32, 20000, ESPERA_MAX_MS] {
            assert_eq!(pedido(json!({ "id": "ws", "desde": 4, "espera": ok })).unwrap().espera, Some(ok));
        }
        for mala in [json!(-1), json!(1.5), json!("5"), json!(true), json!(null), json!([]), json!({}), json!(ESPERA_MAX_MS + 1), json!(1e9)] {
            assert_eq!(pedido(json!({ "id": "ws", "desde": 4, "espera": mala })), None, "{mala}");
        }
    }

    #[test]
    fn espera_mayor_que_cero_no_se_mezcla_con_escribir_tam_ni_solo_escribir() {
        assert_eq!(pedido(json!({ "id": "ws", "desde": 0, "espera": 20000, "escribir": "ls" })), None);
        assert_eq!(pedido(json!({ "id": "ws", "desde": 0, "espera": 1, "tam": "pc" })), None);
        assert_eq!(pedido(json!({ "id": "ws", "desde": 0, "espera": 20000, "tam": { "cols": 60, "rows": 30 }, "soloEscribir": true })), None);
        let ok = pedido(json!({ "id": "ws", "desde": 0, "espera": 0, "escribir": "ls" })).unwrap();
        assert_eq!((ok.espera, ok.escribir.as_deref()), (Some(0), Some("ls")));
    }

    #[test]
    fn solo_escribir_solo_true_y_solo_con_algo_que_escribir_o_un_tamano() {
        let a = pedido(json!({ "id": "ws", "desde": 0, "soloEscribir": true, "escribir": "a" })).unwrap();
        assert!(a.solo_escribir && a.escribir.as_deref() == Some("a"));
        assert!(pedido(json!({ "id": "ws", "desde": 0, "soloEscribir": true, "tam": "pc" })).unwrap().solo_escribir);
        for mala in [json!(false), json!(1), json!("true"), json!(null), json!({})] {
            assert_eq!(pedido(json!({ "id": "ws", "desde": 0, "soloEscribir": mala, "escribir": "a" })), None, "{mala}");
        }
        assert_eq!(pedido(json!({ "id": "ws", "desde": 0, "soloEscribir": true })), None);
        assert_eq!(pedido(json!({ "id": "ws", "desde": 0, "soloEscribir": true, "espera": 0 })), None);
    }

    #[test]
    fn sesion_y_n_van_juntos_validados_y_solo_con_una_escritura() {
        let ok = json!({ "id": "ws", "desde": 0, "escribir": "a", "sesion": "abcDEF12", "n": 7 });
        let p = pedido(ok.clone()).unwrap();
        assert_eq!((p.sesion.as_deref(), p.n), (Some("abcDEF12"), Some(7)));
        assert_eq!(pedido(json!({ "id": "ws", "desde": 0, "tam": "pc", "sesion": "a_b-c_d-e", "n": 1 })).unwrap().n, Some(1));
        let mut sin_sesion = ok.clone();
        sin_sesion.as_object_mut().unwrap().remove("sesion");
        assert_eq!(pedido(sin_sesion), None, "n sin sesion");
        let sola = pedido(json!({ "id": "ws", "desde": 0, "espera": 20000, "sesion": "abcDEF12" })).unwrap();
        assert_eq!((sola.sesion.as_deref(), sola.n, sola.espera), (Some("abcDEF12"), None, Some(20000)), "sesion sola (el mirar)");
        for mala in [json!("corta"), json!("x".repeat(41)), json!("con espacio1"), json!("ñandúñandú"), json!(7), json!(null), json!("../../etc")] {
            let mut o = ok.clone();
            o["sesion"] = mala.clone();
            assert_eq!(pedido(o), None, "{mala}");
        }
        for mala in [json!(0), json!(-1), json!(1.5), json!("7"), json!(1_000_000_001), json!(true), json!(null)] {
            let mut o = ok.clone();
            o["n"] = mala.clone();
            assert_eq!(pedido(o), None, "{mala}");
        }
        assert_eq!(pedido(json!({ "id": "ws", "desde": 0, "sesion": "abcDEF12", "n": 1 })), None, "n sin nada que escribir");
        assert_eq!(pedido(json!({ "id": "ws", "desde": 0, "espera": 5, "sesion": "abcDEF12", "n": 1 })), None);
    }

    #[test]
    fn el_pedido_de_antes_sin_los_campos_nuevos_sigue_valiendo_y_no_los_inventa() {
        let p = pedido(json!({ "id": "ws", "desde": 2, "escribir": "x" })).unwrap();
        assert_eq!(p, PedidoTerminal { escribir: Some("x".into()), ..PedidoTerminal::mirar("ws", 2) });
        assert!(p.espera.is_none() && !p.solo_escribir && p.n.is_none());
    }

    #[test]
    fn vencen_los_visores_que_nadie_consulta() {
        let m = HashMap::from([("a".to_string(), nuevo_visor(0)), ("b".to_string(), nuevo_visor(25_000))]);
        assert_eq!(vencidos(&m, 40_000, VISOR_VENCE_MS), ["a"]);
    }

    #[test]
    fn el_tamano_es_el_de_la_pc_el_celu_no_lo_cambia() {
        assert_eq!(tamano_actual(Some((120, 30))), (120, 30));
        assert_eq!(tamano_actual(None), (80, 24));
    }

    const E: &str = "\x1b";

    fn automaticas() -> Vec<(&'static str, String)> {
        vec![
            ("posición del cursor", format!("{E}[24;80R")),
            ("posición con ?", format!("{E}[?24;80R")),
            ("atributos primarios", format!("{E}[?1;2c")),
            ("atributos secundarios", format!("{E}[>0;276;0c")),
            ("modo reportado", format!("{E}[?2004;2$y")),
            ("modo ANSI reportado", format!("{E}[4;2$y")),
            ("estado del dispositivo", format!("{E}[0n")),
            ("estado con ?", format!("{E}[?0n")),
            ("tamaño en caracteres", format!("{E}[8;24;80t")),
            ("foco adentro", format!("{E}[I")),
            ("foco afuera", format!("{E}[O")),
            ("mouse SGR apretado", format!("{E}[<0;39;19M")),
            ("mouse SGR soltado", format!("{E}[<0;39;19m")),
            ("mouse SGR botón derecho", format!("{E}[<2;3;4M")),
            ("posición en la fila 1 con columna de dos cifras", format!("{E}[1;12R")),
            ("posición en la fila 1 con columna 9", format!("{E}[1;9R")),
            ("posición en la fila 2", format!("{E}[2;3R")),
            ("mouse X10", format!("{E}[M !!")),
            ("color por OSC con BEL", format!("{E}]10;rgb:e8e8/eaea/eded\x07")),
            ("color por OSC con ST", format!("{E}]11;rgb:0b0b/0d0d/1010{E}\\")),
            ("DECRQSS", format!("{E}P1$r0m{E}\\")),
        ]
    }

    #[test]
    fn lo_que_el_xterm_del_celu_contesta_solo_se_saca_sin_importar_donde_venga() {
        let todas = automaticas();
        for (nombre, sec) in &todas {
            assert_eq!(sin_automaticas(sec), "", "{nombre}");
            assert_eq!(sin_automaticas(&format!("ls{sec}\r")), "ls\r", "{nombre} entre teclas");
            assert_eq!(sin_automaticas(&format!("{sec}{sec}")), "", "{nombre} repetida");
        }
        let junto: String = todas.iter().map(|(_, s)| s.as_str()).collect();
        assert_eq!(sin_automaticas(&format!("{junto}x")), "x");
    }

    #[test]
    fn las_teclas_de_verdad_pasan_tal_cual() {
        let teclas = [
            "hola".to_string(), "ñandú é".into(), "\r".into(), "\x7f".into(), "\x03".into(), E.into(), "\t".into(), format!("{E}[Z"), format!("{E}[A"), format!("{E}[B"), format!("{E}[C"), format!("{E}[D"),
            format!("{E}[H"), format!("{E}[F"), format!("{E}[1;5C"), format!("{E}[3~"), format!("{E}[5~"), format!("{E}OP"), format!("{E}[15~"), format!("{E}f"), format!("{E}[u"), format!("{E}[27;5;13~"), "😀".into(),
            "ESC[I sin ESC".into(),
        ];
        for t in &teclas {
            assert_eq!(&sin_automaticas(t), t, "{t:?}");
        }
        let junto = teclas.concat();
        assert_eq!(sin_automaticas(&junto), junto);
    }

    #[test]
    fn un_pegado_entre_corchetes_no_se_toca_por_dentro() {
        let pegado = format!("{E}[200~hola {E}[I {E}[24;80R chau{E}[201~");
        assert_eq!(sin_automaticas(&pegado), pegado);
        assert_eq!(sin_automaticas(&format!("{E}[I{pegado}{E}[O")), pegado);
        let abierto = format!("{E}[200~sin cierre {E}[I");
        assert_eq!(sin_automaticas(&abierto), abierto);
    }

    #[test]
    fn sin_automaticas_solo_quita_nunca_agrega_ni_reordena() {
        let entradas = ["".to_string(), "a".into(), format!("a{E}[Ib{E}[<0;1;1Mc{E}[24;80R"), format!("{E}["), format!("{E}[24;"), format!("{E}]10;sin cerrar"), format!("{E}[200~{E}[I{E}[201~{E}[O")];
        for e in &entradas {
            let r = sin_automaticas(e);
            let mut resto = e.chars();
            for ch in r.chars() {
                assert!(resto.any(|x| x == ch), "{r:?} sale de {e:?}");
            }
            assert!(r.len() <= e.len());
        }
        assert_eq!(sin_automaticas(&format!("{E}[24;")), format!("{E}[24;"), "una secuencia a medias no se toca");
    }

    #[test]
    fn sin_automaticas_es_idempotente_al_sacar_una_secuencia_no_queda_otra_armada_con_los_restos() {
        assert_eq!(sin_automaticas(&format!("{E}[{E}[II")), "");
        assert_eq!(sin_automaticas(&format!("{E}[<{E}[O0;1;1M")), "");
        let entradas = ["".to_string(), "hola".into(), format!("{E}[{E}[II"), format!("{E}[2{E}[I4;80R"), format!("{E}[{E}[{E}[III"), format!("a{E}]1{E}[O0;?\x07b"), format!("{E}[200~{E}[I{E}[201~")];
        for e in &entradas {
            let r = sin_automaticas(e);
            assert_eq!(sin_automaticas(&r), r, "{e:?}");
        }
    }

    #[test]
    fn lo_que_se_podria_confundir_con_una_respuesta_pero_lo_tipea_el_usuario_pasa() {
        for modificador in 2..=8 {
            let t = format!("{E}[1;{modificador}R");
            assert_eq!(sin_automaticas(&t), t, "F3 con modificador {modificador}");
        }
        for rueda in [format!("{E}[<64;3;4M"), format!("{E}[<65;30;4M")] {
            assert_eq!(sin_automaticas(&rueda), rueda);
        }
        assert_eq!(sin_automaticas(&format!("{E}[<640;3;4M")), "", "640 no es la rueda");
        assert_eq!(sin_automaticas(&format!("{E}[?1;2R")), "", "con ? es una posición");
    }

    #[test]
    fn esc_y_corchete_i_juntos_no_se_distinguen_de_un_reporte_de_foco() {
        assert_eq!(sin_automaticas(&format!("{E}[I")), "");
        assert_eq!(sin_automaticas(E), E);
        assert_eq!(sin_automaticas("[I"), "[I");
    }

    #[test]
    fn el_mouse_x10_cuenta_unidades_utf16_como_javascript() {
        // Un emoji son dos unidades: ESC[M + emoji + una letra son tres unidades y se saca.
        assert_eq!(sin_automaticas(&format!("{E}[M😀x")), "");
        assert_eq!(sin_automaticas(&format!("{E}[M😀xy")), "y");
    }

    #[test]
    fn sin_automaticas_coincide_con_el_typescript() {
        let f: Value = serde_json::from_str(include_str!("fixtures/ts.json")).unwrap();
        let casos = f["sin_automaticas"].as_array().unwrap();
        assert!(casos.len() > 600);
        for par in casos {
            let (entrada, esperado) = (par[0].as_str().unwrap(), par[1].as_str().unwrap());
            assert_eq!(sin_automaticas(entrada), esperado, "{entrada:?}");
        }
    }

    const MAX_PAGINA: usize = 262_144;

    /// Lo que el celu recibe de verdad: la respuesta sellada con el mismo JSON que arma la feature.
    fn sellada(s: &Salida) -> usize {
        let claves = derivar_claves(&clave_de(7)).unwrap();
        let r = RespuestaTerminal::de(s.clone(), true, 80, 24);
        sellar_respuesta(&claves, &[1u8; 16], &serde_json::to_string(&r).unwrap(), &[1u8; 16]).unwrap().len()
    }

    fn ansi(seq: u64, n: usize) -> PtyChunk {
        PtyChunk { seq, data: (0..n).map(|i| format!("\x1b[3{}mx", (i % 7) + 1)).collect() }
    }

    #[test]
    fn el_peso_es_el_que_ocupa_en_el_json_esc_6_comilla_y_barra_2_tilde_2_caja_3_emoji_4() {
        for t in ["abc", "\x1b[0m", "dijo \"hola\" y \\ \r\n\t", "ñandú café", "─│╭╯", "😀👍", "\u{1}\u{7f}", ""] {
            assert_eq!(peso_json(t), serde_json::to_string(&json!(t)).unwrap().len() - 2, "{t:?}");
        }
    }

    #[test]
    fn el_peso_coincide_con_el_typescript() {
        let f: Value = serde_json::from_str(include_str!("fixtures/ts.json")).unwrap();
        for par in f["peso_json"].as_array().unwrap() {
            assert_eq!(peso_json(par[0].as_str().unwrap()) as u64, par[1].as_u64().unwrap(), "{}", par[0]);
        }
    }

    #[test]
    fn la_foto_inicial_de_una_terminal_llena_de_colores_entra_sellada_en_lo_que_acepta_la_pagina() {
        let v = visor_de((1..=10).map(|s| ansi(s, 3000)).collect());
        assert!(v.tam > 100_000);
        let completa = Salida { reinicio: true, datos: v.chunks.iter().map(|c| c.data.as_str()).collect(), hasta: 10, mas: false };
        assert!(sellada(&completa) > MAX_PAGINA, "sin el tope, esta foto no la abre la página");
        let r = salida_desde(&v, -1, MAX_DATOS_PESO);
        assert!(r.reinicio);
        assert_eq!(r.hasta, 10);
        assert!(peso_json(&r.datos) <= MAX_DATOS_PESO);
        assert!(sellada(&r) < 200_000, "{}", sellada(&r));
        assert!(r.datos.ends_with(&ansi(10, 3000).data), "lo último que pasó está");
    }

    #[test]
    fn la_foto_es_la_cola_se_corta_entre_trozos_nunca_a_la_mitad_de_uno() {
        let v = visor_de((1..=4).map(|s| cd(s, &s.to_string().repeat(40))).collect());
        let r = salida_desde(&v, -1, 100);
        assert_eq!(r.datos, format!("{}{}", "3".repeat(40), "4".repeat(40)));
        assert_eq!(r.hasta, 4);
    }

    #[test]
    fn un_trozo_gigante_solo_se_manda_truncado_a_su_final() {
        let v = visor_de(vec![cd(1, &format!("{}FIN", "a".repeat(300)))]);
        let r = salida_desde(&v, -1, 100);
        assert_eq!(r.datos.chars().count(), 100);
        assert!(r.datos.ends_with("FIN"));
        let w = visor_de(vec![cd(1, "x"), cd(2, &format!("{}FIN", "b".repeat(300)))]);
        let i = salida_desde(&w, 1, 100);
        assert!(!i.reinicio);
        assert_eq!(i.hasta, 2);
        assert!(i.datos.ends_with("FIN") && peso_json(&i.datos) <= 100);
        assert_eq!(peso_json(&salida_desde(&visor_de(vec![cd(1, &"😀".repeat(100))]), -1, 21).datos), 20, "un emoji no se parte");
    }

    #[test]
    fn las_respuestas_comunes_siguen_de_donde_quedo_la_anterior_sin_huecos_ni_repetidos() {
        let chunks: Vec<PtyChunk> = (0..40).map(|i| cd(i + 1, &format!("<{}>{}", i + 1, "ñ".repeat(if i % 7 == 0 { 90 } else { 10 })))).collect();
        let v = visor_de(chunks.clone());
        let (mut desde, mut juntado, mut vueltas) = (0i64, String::new(), 0);
        loop {
            let r = salida_desde(&v, desde, 200);
            assert!(!r.reinicio);
            juntado.push_str(&r.datos);
            assert!(r.hasta as i64 > desde || !r.mas);
            desde = r.hasta as i64;
            vueltas += 1;
            if !r.mas {
                break;
            }
            assert!(vueltas < 100);
        }
        assert_eq!(juntado, chunks.iter().map(|c| c.data.as_str()).collect::<String>());
        assert!(vueltas > 3);
        assert_eq!(desde, 40);
        assert_eq!(salida_desde(&v, 40, 200), salida(false, "", 40, false));
    }

    #[test]
    fn lo_que_llega_en_vivo_mientras_el_celu_va_por_partes_se_suma_sin_perder_nada() {
        let mut v = visor_de((1..=3).map(|s| cd(s, &s.to_string().repeat(30))).collect());
        let a = salida_desde(&v, 0, 70);
        assert_eq!((a.hasta, a.mas), (2, true));
        sumar_salida(&mut v, &[cd(4, &"4".repeat(30))]);
        let b = salida_desde(&v, a.hasta as i64, 70);
        let c = salida_desde(&v, b.hasta as i64, 70);
        assert_eq!(format!("{}{}{}", a.datos, b.datos, c.datos), ["1", "2", "3", "4"].iter().map(|d| d.repeat(30)).collect::<String>());
        assert!(!c.mas);
    }

    #[test]
    fn un_desde_fuera_de_rango_o_sin_salida_no_rompe_nada() {
        let vacio = nuevo_visor(0);
        assert_eq!(salida_desde(&vacio, -1, MAX_DATOS_PESO), salida(true, "", 0, false));
        assert_eq!(salida_desde(&vacio, 0, MAX_DATOS_PESO), salida(false, "", 0, false));
        let v = visor_de(vec![c(10), c(11)]);
        assert!(salida_desde(&v, 99, MAX_DATOS_PESO).reinicio);
        assert_eq!(salida_desde(&v, 99, MAX_DATOS_PESO).hasta, 11);
        assert!(salida_desde(&v, 1, MAX_DATOS_PESO).reinicio);
    }

    #[test]
    fn en_el_peor_caso_del_visor_la_respuesta_sellada_queda_bajo_el_limite() {
        let peor = visor_de(vec![cd(1, &"\x1b".repeat(MAX_VISOR_CHARS))]);
        assert!(sellada(&salida_desde(&peor, -1, MAX_DATOS_PESO)) < 200_000);
        let cajas = visor_de(vec![cd(1, &"─".repeat(MAX_VISOR_CHARS))]);
        assert!(sellada(&salida_desde(&cajas, -1, MAX_DATOS_PESO)) < 200_000);
        let incremental = visor_de(vec![cd(1, "a"), ansi(2, 20_000), ansi(3, 20_000)]);
        assert!(sellada(&salida_desde(&incremental, 1, MAX_DATOS_PESO)) < 200_000);
    }

    #[test]
    fn el_mirar_queda_abierto_solo_si_no_hay_nada_nuevo_la_terminal_vive_y_no_es_la_primera_pantalla() {
        let mirar = PedidoTerminal { espera: Some(20000), ..PedidoTerminal::mirar("ws", 5) };
        assert!(debe_esperar(&mirar, false, "", true));
        assert!(!debe_esperar(&mirar, false, "hola", true), "hay salida: se responde ya");
        assert!(!debe_esperar(&mirar, true, "", true), "reinicio: se responde ya");
        assert!(!debe_esperar(&mirar, false, "", false), "cerrada: se avisa ya");
        assert!(!debe_esperar(&PedidoTerminal { desde: -1, ..mirar.clone() }, false, "", true), "primera vez");
        assert!(!debe_esperar(&PedidoTerminal::mirar("ws", 5), false, "", true), "sin espera: como antes");
        assert!(!debe_esperar(&PedidoTerminal { espera: Some(0), ..PedidoTerminal::mirar("ws", 5) }, false, "", true));
        assert!(!debe_esperar(&PedidoTerminal { solo_escribir: true, escribir: Some("a".into()), ..mirar }, false, "", true));
    }

    #[test]
    fn sin_salida_sigue_desde_donde_estaba_el_celu() {
        assert_eq!(sin_salida(&PedidoTerminal::mirar("ws", 12)), salida(false, "", 12, false));
    }
}
