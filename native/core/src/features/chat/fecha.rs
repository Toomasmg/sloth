//! Fechas ISO de Postgres ↔ milisegundos desde 1970 (lo que hacen `Date.parse` y `toISOString` en el TypeScript).

fn dias_desde_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn bisiesto(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn dias_del_mes(y: i64, m: i64) -> i64 {
    match m {
        2 if bisiesto(y) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn num(s: &str, largo: usize) -> Option<i64> {
    (s.len() == largo && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()
}

/// Acepta `AAAA-MM-DD` y `AAAA-MM-DD[T ]HH:MM[:SS[.fff…]]` con `Z`, `±HH:MM`, `±HHMM` o `±HH`. Sin zona cuenta como UTC
/// (Postgres siempre la manda). Cualquier otra cosa da `None`.
pub fn parsear_ms(s: &str) -> Option<i64> {
    let s = super::trim_js(s);
    if !s.is_ascii() || s.len() < 10 {
        return None;
    }
    let (fecha, resto) = s.split_at(10);
    let mut p = fecha.split('-');
    let (y, m, d) = (num(p.next()?, 4)?, num(p.next()?, 2)?, num(p.next()?, 2)?);
    if p.next().is_some() || !(1..=12).contains(&m) || d < 1 || d > dias_del_mes(y, m) {
        return None;
    }
    let base = dias_desde_civil(y, m, d) * 86_400_000;
    if resto.is_empty() {
        return Some(base);
    }
    let resto = resto.strip_prefix('T').or_else(|| resto.strip_prefix(' '))?;
    let fin_hora = resto.find(|c: char| matches!(c, 'Z' | 'z' | '+' | '-')).unwrap_or(resto.len());
    let (hora, zona) = resto.split_at(fin_hora);
    let (hms, frac) = match hora.split_once('.') {
        Some((a, b)) if !b.is_empty() && b.bytes().all(|c| c.is_ascii_digit()) => (a, b),
        Some(_) => return None,
        None => (hora, ""),
    };
    let mut h = hms.split(':');
    let hh = num(h.next()?, 2)?;
    let mm = num(h.next()?, 2)?;
    let ss = match h.next() {
        Some(x) => num(x, 2)?,
        None => 0,
    };
    if h.next().is_some() || mm > 59 || ss > 59 || hh > 24 || (hh == 24 && (mm > 0 || ss > 0 || frac.bytes().any(|c| c != b'0'))) {
        return None;
    }
    let ms: i64 = format!("{:0<3}", &frac[..frac.len().min(3)]).parse().ok()?;
    let desfase = match zona {
        "" | "Z" | "z" => 0,
        z => {
            let signo = if z.starts_with('-') { -1 } else { 1 };
            let r = &z[1..];
            let (oh, om) = match r.split_once(':') {
                Some((a, b)) => (num(a, 2)?, num(b, 2)?),
                None if r.len() == 4 => (num(&r[..2], 2)?, num(&r[2..], 2)?),
                None => (num(r, 2)?, 0),
            };
            if oh > 23 || om > 59 {
                return None;
            }
            signo * (oh * 60 + om) * 60_000
        }
    };
    Some(base + ((hh * 60 + mm) * 60 + ss) * 1000 + ms - desfase)
}

/// `new Date(ms).toISOString()`.
pub fn iso_de_ms(ms: i64) -> String {
    let dias = ms.div_euclid(86_400_000);
    let del_dia = ms.rem_euclid(86_400_000);
    let (y, m, d) = super::super::civil_de_dias(dias);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        del_dia / 3_600_000,
        del_dia / 60_000 % 60,
        del_dia / 1000 % 60,
        del_dia % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fechas_de_postgres() {
        assert_eq!(parsear_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parsear_ms("2026-11-12T10:05:00+00:00"), Some(1_794_477_900_000));
        assert_eq!(parsear_ms("2026-11-12T10:00:00.123456+00:00"), Some(1_794_477_600_123));
        assert_eq!(parsear_ms("2026-11-12 07:05:00-03"), Some(1_794_477_900_000));
        assert_eq!(parsear_ms("2026-11-12T11:05:00+0100"), Some(1_794_477_900_000));
        assert_eq!(parsear_ms("2026-11-12"), Some(1_794_441_600_000));
    }

    #[test]
    fn lo_que_no_es_fecha_da_none() {
        for malo in ["ayer", "", "2026-13-01", "2026-02-30", "2026-11-12T25:00:00Z", "2026-11-12T10:61:00Z", "2026-11-12T10:00:00.Z", "12/11/2026"] {
            assert_eq!(parsear_ms(malo), None, "{malo}");
        }
    }

    #[test]
    fn ida_y_vuelta_con_iso() {
        assert_eq!(iso_de_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_de_ms(1_794_477_900_123), "2026-11-12T10:05:00.123Z");
        assert_eq!(parsear_ms(&iso_de_ms(1_794_477_900_123)), Some(1_794_477_900_123));
    }
}
