//! Recortes de texto medidos en unidades UTF-16, como `String.length` de JavaScript, para que los límites del log
//! den lo mismo que en src/main/diag/redactar.ts (`acotar`).

fn utf16(c: char) -> usize {
    c.len_utf16()
}

/// Los primeros `max` unidades UTF-16, sin partir un carácter de dos unidades.
pub fn recortar_utf16(texto: &str, max: usize) -> &str {
    let mut usadas = 0;
    for (i, c) in texto.char_indices() {
        if usadas + utf16(c) > max {
            return &texto[..i];
        }
        usadas += utf16(c);
    }
    texto
}

pub fn acotar(texto: &str, max: usize) -> String {
    let recorte = recortar_utf16(texto, max);
    if recorte.len() == texto.len() {
        return texto.to_string();
    }
    format!("{recorte}…[cortado]")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corta_y_avisa_y_no_parte_un_par_sustituto() {
        assert_eq!(acotar("hola", 10), "hola");
        assert_eq!(acotar("hola", 4), "hola");
        assert_eq!(acotar("abcdefgh", 3), "abc…[cortado]");
        assert_eq!(acotar("abcdefgh", 0), "…[cortado]");
        let emoji = "ab😀cd";
        assert_eq!(acotar(emoji, 3), "ab…[cortado]");
        assert_eq!(acotar(emoji, 4), "ab😀…[cortado]");
    }

    #[test]
    fn mide_en_unidades_utf16_no_en_bytes() {
        assert_eq!(acotar("ñandú", 5), "ñandú");
        assert_eq!(recortar_utf16("😀😀", 2), "😀");
    }
}
