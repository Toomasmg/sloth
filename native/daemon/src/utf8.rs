//! node-pty entrega strings: acá se decodifica la salida de la terminal sin cortar un carácter
//! multibyte que llegue partido entre dos lecturas.

#[derive(Default)]
pub struct Utf8Stream {
    resto: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        let mut todo = std::mem::take(&mut self.resto);
        todo.extend_from_slice(bytes);
        let mut out = String::with_capacity(todo.len());
        let mut rest: &[u8] = &todo;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let (ok, mal) = rest.split_at(e.valid_up_to());
                    out.push_str(std::str::from_utf8(ok).unwrap_or_default());
                    match e.error_len() {
                        None => {
                            self.resto = mal.to_vec();
                            break;
                        }
                        Some(n) => {
                            out.push('\u{FFFD}');
                            rest = &mal[n..];
                        }
                    }
                }
            }
        }
        out
    }

    /// Lo que quedó pendiente al terminar el flujo (un carácter incompleto) sale como reemplazo.
    pub fn terminar(&mut self) -> String {
        if self.resto.is_empty() {
            String::new()
        } else {
            self.resto.clear();
            '\u{FFFD}'.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn junta_un_caracter_partido() {
        let mut d = Utf8Stream::default();
        let n = "ñ".as_bytes();
        assert_eq!(d.push(&[b'a', n[0]]), "a");
        assert_eq!(d.push(&[n[1], b'b']), "ñb");
    }

    #[test]
    fn emoji_en_tres_partes() {
        let mut d = Utf8Stream::default();
        let e = "🦥".as_bytes();
        assert_eq!(d.push(&e[..1]), "");
        assert_eq!(d.push(&e[1..3]), "");
        assert_eq!(d.push(&e[3..]), "🦥");
    }

    #[test]
    fn byte_invalido_no_traba() {
        let mut d = Utf8Stream::default();
        assert_eq!(d.push(&[b'a', 0xFF, b'b']), "a\u{FFFD}b");
    }

    #[test]
    fn incompleto_al_final() {
        let mut d = Utf8Stream::default();
        d.push(&"ñ".as_bytes()[..1]);
        assert_eq!(d.terminar(), "\u{FFFD}");
        assert_eq!(d.terminar(), "");
    }
}
