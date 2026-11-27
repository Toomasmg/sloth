//! Recorre un TOML sin evaluarlo: cadenas básicas y literales (de una línea y multilínea, con sus escapes), arrays,
//! tablas en línea, cabeceras y comentarios. Ante cualquier cosa que no cierra devuelve `Err`: quien lo usa para editar
//! un archivo del usuario tiene que tratar la duda como «no escribir». Equivale a src/main/toml-escaner.ts.
//!
//! Los offsets son de bytes (en el TS eran unidades UTF-16): sirven igual para cortar el texto original.
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tipo {
    Clave,
    Tabla,
    TablaArray,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sentencia {
    pub tipo: Tipo,
    /// Camino de la clave (relativo a su tabla) o de la cabecera. Sin comillas ni escapes.
    pub ruta: Vec<String>,
    /// Cabecera bajo la que está una clave; vacío en la raíz.
    pub tabla: Vec<String>,
    /// Offsets en el texto: de la primera letra a donde termina el valor (sin el comentario del final).
    pub desde: usize,
    pub hasta: usize,
    pub linea_ini: usize,
    pub linea_fin: usize,
}

const PROFUNDIDAD_MAX: usize = 64;

pub fn analizar(texto: &str) -> Result<Vec<Sentencia>, String> {
    Escaner::nuevo(texto).recorrer()
}

fn es_digito(b: u8) -> bool {
    b.is_ascii_digit()
}

fn es_clave_bare(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

fn es_bare(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'-' | b'.' | b':')
}

fn digitos(b: &[u8], i: usize, cuantos: usize) -> bool {
    b.len() >= i + cuantos && b[i..i + cuantos].iter().all(|&c| es_digito(c))
}

/// `d(_?d)*` desde `i`; devuelve dónde termina.
fn corrida(b: &[u8], mut i: usize, es: fn(u8) -> bool) -> Option<usize> {
    if !b.get(i).is_some_and(|&c| es(c)) {
        return None;
    }
    i += 1;
    loop {
        match (b.get(i), b.get(i + 1)) {
            (Some(&c), _) if es(c) => i += 1,
            (Some(b'_'), Some(&c)) if es(c) => i += 2,
            _ => return Some(i),
        }
    }
}

/// `:SS` con fracción opcional; devuelve dónde termina (o `i` si no hay).
fn segundos(b: &[u8], i: usize) -> usize {
    if b.get(i) != Some(&b':') || !digitos(b, i + 1, 2) {
        return i;
    }
    let j = i + 3;
    if b.get(j) == Some(&b'.') && b.get(j + 1).is_some_and(|&c| es_digito(c)) {
        let mut k = j + 1;
        while b.get(k).is_some_and(|&c| es_digito(c)) {
            k += 1;
        }
        return k;
    }
    j
}

/// Fecha, fecha con hora u hora sola: lo que TOML deja escribir sin comillas. Devuelve dónde termina.
fn fecha(b: &[u8], i: usize) -> Option<usize> {
    if digitos(b, i, 4) && b.get(i + 4) == Some(&b'-') && digitos(b, i + 5, 2) && b.get(i + 7) == Some(&b'-') && digitos(b, i + 8, 2) {
        let mut j = i + 10;
        if matches!(b.get(j), Some(b'T' | b't' | b' ')) && digitos(b, j + 1, 2) && b.get(j + 3) == Some(&b':') && digitos(b, j + 4, 2) {
            j = segundos(b, j + 6);
            if matches!(b.get(j), Some(b'Z' | b'z')) {
                j += 1;
            } else if matches!(b.get(j), Some(b'+' | b'-')) && digitos(b, j + 1, 2) && b.get(j + 3) == Some(&b':') && digitos(b, j + 4, 2) {
                j += 6;
            }
        }
        return Some(j);
    }
    if digitos(b, i, 2) && b.get(i + 2) == Some(&b':') && digitos(b, i + 3, 2) {
        return Some(segundos(b, i + 5));
    }
    None
}

fn es_hex(b: u8) -> bool {
    b.is_ascii_hexdigit()
}
fn es_octal(b: u8) -> bool {
    (b'0'..=b'7').contains(&b)
}
fn es_binario(b: u8) -> bool {
    b == b'0' || b == b'1'
}

/// Un valor sin comillas que no es fecha: booleano, inf/nan, entero (con prefijo 0x, 0o, 0b) o flotante.
fn valor_bare(s: &[u8]) -> bool {
    if s == b"true" || s == b"false" {
        return true;
    }
    let sin_signo = match s.first() {
        Some(b'+' | b'-') => &s[1..],
        _ => s,
    };
    if sin_signo == b"inf" || sin_signo == b"nan" {
        return true;
    }
    for (prefijo, es) in [(&b"0x"[..], es_hex as fn(u8) -> bool), (b"0o", es_octal), (b"0b", es_binario)] {
        if s.starts_with(prefijo) && corrida(s, 2, es) == Some(s.len()) {
            return true;
        }
    }
    let mut i = 0;
    if matches!(s.first(), Some(b'+' | b'-')) {
        i = 1;
    }
    match s.get(i) {
        Some(b'0') => i += 1,
        Some(b'1'..=b'9') => match corrida(s, i, es_digito) {
            Some(j) => i = j,
            None => return false,
        },
        _ => return false,
    }
    if s.get(i) == Some(&b'.') {
        match corrida(s, i + 1, es_digito) {
            Some(j) => i = j,
            None => return false,
        }
    }
    if matches!(s.get(i), Some(b'e' | b'E')) {
        let mut j = i + 1;
        if matches!(s.get(j), Some(b'+' | b'-')) {
            j += 1;
        }
        match corrida(s, j, es_digito) {
            Some(k) => i = k,
            None => return false,
        }
    }
    i == s.len()
}

fn escape_simple(c: u8) -> Option<char> {
    Some(match c {
        b'b' => '\u{8}',
        b't' => '\t',
        b'n' => '\n',
        b'f' => '\u{c}',
        b'r' => '\r',
        b'e' => '\u{1b}',
        b'"' => '"',
        b'\\' => '\\',
        _ => return None,
    })
}

struct Escaner<'a> {
    t: &'a [u8],
    n: usize,
    i: usize,
    inicios: Vec<usize>,
}

type R<T> = Result<T, String>;

impl<'a> Escaner<'a> {
    fn nuevo(texto: &'a str) -> Self {
        let t = texto.as_bytes();
        let mut inicios = vec![0];
        inicios.extend(t.iter().enumerate().filter(|(_, &c)| c == b'\n').map(|(k, _)| k + 1));
        Escaner { t, n: t.len(), i: if t.starts_with(&[0xef, 0xbb, 0xbf]) { 3 } else { 0 }, inicios }
    }

    fn linea_de(&self, off: usize) -> usize {
        self.inicios.partition_point(|&s| s <= off).saturating_sub(1)
    }

    // Sin el contenido del archivo: el motivo termina en un log que se comparte.
    fn falla<T>(&self, m: &str) -> R<T> {
        Err(format!("{m} (línea {})", self.linea_de(self.i.min(self.n)) + 1))
    }

    fn en(&self, k: usize) -> Option<u8> {
        self.t.get(k).copied()
    }

    fn empieza(&self, lit: &[u8]) -> bool {
        self.t[self.i.min(self.n)..].starts_with(lit)
    }

    fn espacios(&mut self) {
        while matches!(self.en(self.i), Some(b' ' | b'\t')) {
            self.i += 1;
        }
    }

    fn comentario(&mut self) {
        if self.en(self.i) != Some(b'#') {
            return;
        }
        while self.i < self.n && self.t[self.i] != b'\n' {
            self.i += 1;
        }
    }

    fn blancos(&mut self) {
        while let Some(c) = self.en(self.i) {
            match c {
                b' ' | b'\t' | b'\r' | b'\n' => self.i += 1,
                b'#' => self.comentario(),
                _ => break,
            }
        }
    }

    fn fin_de_linea(&mut self) -> R<()> {
        self.espacios();
        self.comentario();
        if self.i >= self.n {
            return Ok(());
        }
        if self.t[self.i] == b'\n' {
            self.i += 1;
        } else if self.t[self.i] == b'\r' && self.en(self.i + 1) == Some(b'\n') {
            self.i += 2;
        } else {
            return self.falla("hay texto después del valor");
        }
        Ok(())
    }

    fn escape(&mut self, multi: bool, out: &mut Vec<u8>) -> R<()> {
        let Some(e) = self.en(self.i + 1) else { return self.falla("escape sin terminar") };
        if let Some(c) = escape_simple(e) {
            self.i += 2;
            let mut buf = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            return Ok(());
        }
        if e == b'u' || e == b'U' {
            let largo = if e == b'u' { 4 } else { 8 };
            let ini = (self.i + 2).min(self.n);
            let hex = &self.t[ini..(ini + largo).min(self.n)];
            if hex.len() != largo || !hex.iter().all(|&c| es_hex(c)) {
                return self.falla("escape unicode inválido");
            }
            let cp = std::str::from_utf8(hex).ok().and_then(|h| u32::from_str_radix(h, 16).ok());
            let Some(cp) = cp.filter(|&c| c <= 0x10ffff) else { return self.falla("escape unicode inválido") };
            // Un sustituto suelto no es un carácter de Rust: el escáner lo acepta igual que el original y lo cambia por U+FFFD.
            let c = char::from_u32(cp).unwrap_or('\u{fffd}');
            let mut buf = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            self.i += 2 + largo;
            return Ok(());
        }
        if multi {
            // Una barra al final de la línea se come el salto y los blancos que siguen.
            let mut j = self.i + 1;
            while matches!(self.en(j), Some(b' ' | b'\t')) {
                j += 1;
            }
            if self.en(j) == Some(b'\n') || (self.en(j) == Some(b'\r') && self.en(j + 1) == Some(b'\n')) {
                while matches!(self.en(j), Some(b' ' | b'\t' | b'\r' | b'\n')) {
                    j += 1;
                }
                self.i = j;
                return Ok(());
            }
        }
        self.falla("escape desconocido")
    }

    fn texto(&self, bytes: Vec<u8>) -> String {
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// Cuenta las comillas seguidas en `i` y valida que sobren a lo sumo 2 al cerrar una multilínea.
    fn cierre_multilinea(&mut self, comilla: u8) -> R<usize> {
        let mut k = 0;
        while self.en(self.i + k) == Some(comilla) {
            k += 1;
        }
        if k > 5 {
            return self.falla("comillas de más al cerrar una cadena");
        }
        Ok(k)
    }

    fn cadena_basica(&mut self) -> R<String> {
        let mut out = Vec::new();
        if self.empieza(b"\"\"\"") {
            self.i += 3;
            loop {
                if self.i >= self.n {
                    return self.falla("cadena multilínea sin cerrar");
                }
                if self.empieza(b"\"\"\"") {
                    let k = self.cierre_multilinea(b'"')?;
                    out.extend(std::iter::repeat(b'"').take(k - 3));
                    self.i += k;
                    return Ok(self.texto(out));
                }
                if self.t[self.i] == b'\\' {
                    self.escape(true, &mut out)?;
                } else {
                    out.push(self.t[self.i]);
                    self.i += 1;
                }
            }
        }
        self.i += 1;
        loop {
            let Some(c) = self.en(self.i).filter(|&c| c != b'\n' && c != b'\r') else { return self.falla("cadena sin cerrar") };
            if c == b'"' {
                self.i += 1;
                return Ok(self.texto(out));
            }
            if c == b'\\' {
                self.escape(false, &mut out)?;
            } else {
                out.push(c);
                self.i += 1;
            }
        }
    }

    fn cadena_literal(&mut self) -> R<String> {
        if self.empieza(b"'''") {
            self.i += 3;
            let ini = self.i;
            loop {
                if self.i >= self.n {
                    return self.falla("cadena multilínea sin cerrar");
                }
                if self.empieza(b"'''") {
                    let k = self.cierre_multilinea(b'\'')?;
                    let out = self.texto(self.t[ini..self.i + (k - 3)].to_vec());
                    self.i += k;
                    return Ok(out);
                }
                self.i += 1;
            }
        }
        self.i += 1;
        let ini = self.i;
        loop {
            let Some(c) = self.en(self.i).filter(|&c| c != b'\n' && c != b'\r') else { return self.falla("cadena sin cerrar") };
            if c == b'\'' {
                let out = self.texto(self.t[ini..self.i].to_vec());
                self.i += 1;
                return Ok(out);
            }
            self.i += 1;
        }
    }

    fn clave(&mut self) -> R<String> {
        match self.en(self.i) {
            Some(b'"') => self.cadena_basica(),
            Some(b'\'') => self.cadena_literal(),
            _ => {
                let ini = self.i;
                while self.en(self.i).is_some_and(es_clave_bare) {
                    self.i += 1;
                }
                if self.i == ini {
                    return self.falla("clave inválida");
                }
                Ok(self.texto(self.t[ini..self.i].to_vec()))
            }
        }
    }

    fn ruta(&mut self) -> R<Vec<String>> {
        let mut partes = vec![self.clave()?];
        loop {
            self.espacios();
            if self.en(self.i) != Some(b'.') {
                return Ok(partes);
            }
            self.i += 1;
            self.espacios();
            partes.push(self.clave()?);
        }
    }

    fn bare(&mut self) -> R<()> {
        if let Some(fin) = fecha(self.t, self.i) {
            self.i = fin;
            return Ok(());
        }
        let ini = self.i;
        let mut j = ini;
        while self.en(j).is_some_and(es_bare) {
            j += 1;
        }
        if j == ini || !valor_bare(&self.t[ini..j]) {
            return self.falla("valor no reconocido");
        }
        self.i = j;
        Ok(())
    }

    fn valor(&mut self, prof: usize) -> R<()> {
        if prof > PROFUNDIDAD_MAX {
            return self.falla("demasiado anidado");
        }
        match self.en(self.i) {
            Some(b'"') => self.cadena_basica().map(|_| ()),
            Some(b'\'') => self.cadena_literal().map(|_| ()),
            Some(b'[') => {
                self.i += 1;
                loop {
                    self.blancos();
                    if self.en(self.i) == Some(b']') {
                        self.i += 1;
                        return Ok(());
                    }
                    self.valor(prof + 1)?;
                    self.blancos();
                    match self.en(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(());
                        }
                        _ => return self.falla("array mal cerrado"),
                    }
                }
            }
            Some(b'{') => {
                self.i += 1;
                self.blancos();
                if self.en(self.i) == Some(b'}') {
                    self.i += 1;
                    return Ok(());
                }
                loop {
                    self.ruta()?;
                    self.blancos();
                    if self.en(self.i) != Some(b'=') {
                        return self.falla("falta el = en una tabla en línea");
                    }
                    self.i += 1;
                    self.blancos();
                    self.valor(prof + 1)?;
                    self.blancos();
                    match self.en(self.i) {
                        Some(b',') => {
                            self.i += 1;
                            self.blancos();
                            if self.en(self.i) == Some(b'}') {
                                self.i += 1;
                                return Ok(());
                            }
                        }
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(());
                        }
                        _ => return self.falla("tabla en línea mal cerrada"),
                    }
                }
            }
            _ => self.bare(),
        }
    }

    fn recorrer(mut self) -> R<Vec<Sentencia>> {
        let mut sentencias = Vec::new();
        let mut tabla: Vec<String> = vec![];
        loop {
            self.blancos();
            if self.i >= self.n {
                return Ok(sentencias);
            }
            let desde = self.i;
            let (tipo, r, propia);
            if self.t[self.i] == b'[' {
                let doble = self.en(self.i + 1) == Some(b'[');
                tipo = if doble { Tipo::TablaArray } else { Tipo::Tabla };
                self.i += if doble { 2 } else { 1 };
                self.espacios();
                r = self.ruta()?;
                self.espacios();
                if self.en(self.i) != Some(b']') || (doble && self.en(self.i + 1) != Some(b']')) {
                    return self.falla("cabecera mal cerrada");
                }
                self.i += if doble { 2 } else { 1 };
                propia = vec![];
            } else {
                tipo = Tipo::Clave;
                r = self.ruta()?;
                self.espacios();
                if self.en(self.i) != Some(b'=') {
                    return self.falla("falta el =");
                }
                self.i += 1;
                self.espacios();
                self.valor(0)?;
                propia = tabla.clone();
            }
            let hasta = self.i;
            self.fin_de_linea()?;
            sentencias.push(Sentencia {
                tipo,
                ruta: r.clone(),
                tabla: propia,
                desde,
                hasta,
                linea_ini: self.linea_de(desde),
                linea_fin: self.linea_de(hasta - 1),
            });
            if tipo != Tipo::Clave {
                tabla = r;
            }
        }
    }
}

const SEP: char = '\0';

fn unir(r: &[String]) -> String {
    r.join(&SEP.to_string())
}

const REPETIDO: &str = "El config.toml tiene claves o tablas repetidas.";

fn prefijo_en(conjunto: &HashSet<String>, ruta: &[String], desde_largo: usize) -> bool {
    (desde_largo..ruta.len()).any(|k| conjunto.contains(&unir(&ruta[..k])))
}

/// Lo que TOML rechaza por repetido: dos veces la misma clave, o una clave y una tabla con el mismo camino. Sin nombres en el motivo.
pub fn problema_de_duplicados(sentencias: &[Sentencia]) -> Option<&'static str> {
    let mut claves = HashSet::new();
    let mut prefijos = HashSet::new();
    let mut tablas = HashSet::new();
    let mut arrays = HashSet::new();
    let mut implicitas = HashSet::new();
    for s in sentencias {
        if s.tipo == Tipo::Clave {
            let completa: Vec<String> = s.tabla.iter().chain(&s.ruta).cloned().collect();
            let k = unir(&completa);
            if claves.contains(&k) || tablas.contains(&k) || prefijos.contains(&k) || arrays.contains(&k) {
                return Some(REPETIDO);
            }
            if prefijo_en(&claves, &completa, 1) || prefijo_en(&tablas, &completa, s.tabla.len() + 1) {
                return Some(REPETIDO);
            }
            claves.insert(k);
            for l in s.tabla.len() + 1..completa.len() {
                prefijos.insert(unir(&completa[..l]));
            }
            continue;
        }
        let k = unir(&s.ruta);
        if claves.contains(&k) || prefijos.contains(&k) || prefijo_en(&claves, &s.ruta, 1) {
            return Some(REPETIDO);
        }
        if s.tipo == Tipo::Tabla {
            if tablas.contains(&k) || arrays.contains(&k) {
                return Some(REPETIDO);
            }
            tablas.insert(k);
        } else {
            if tablas.contains(&k) || (implicitas.contains(&k) && !arrays.contains(&k)) {
                return Some(REPETIDO);
            }
            let hijos = format!("{k}{SEP}");
            for c in [&mut claves, &mut prefijos, &mut tablas, &mut arrays, &mut implicitas] {
                c.retain(|x: &String| !x.starts_with(&hijos));
            }
            arrays.insert(k);
        }
        for l in 1..s.ruta.len() {
            implicitas.insert(unir(&s.ruta[..l]));
        }
    }
    None
}

#[cfg(test)]
mod tests;
