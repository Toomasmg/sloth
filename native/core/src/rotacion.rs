//! Qué archivos borrar y mover para rotar un log por tamaño. Equivale a src/main/diag/rotacion.ts.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Movimiento {
    pub de: String,
    pub a: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PlanRotacion {
    pub rotar: bool,
    pub mover: Vec<Movimiento>,
    pub borrar: Vec<String>,
}

/// El número de `<base>.<n>.log` con n ≥ 1 y sin ceros a la izquierda; cualquier otro nombre es ajeno.
fn numero_de_rotado(archivo: &str, base: &str) -> Option<u64> {
    let n = archivo.strip_prefix(base)?.strip_prefix('.')?.strip_suffix(".log")?;
    if n.is_empty() || n.starts_with('0') || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    n.parse().ok()
}

pub fn plan_rotacion(tamano_actual: u64, max: u64, existentes: &[String], base: &str, mantener: u64) -> PlanRotacion {
    if tamano_actual == 0 || tamano_actual < max {
        return PlanRotacion::default();
    }
    let nombre = |n: u64| format!("{base}.{n}.log");
    let mut numeros: Vec<u64> = existentes.iter().filter_map(|f| numero_de_rotado(f, base)).collect();
    numeros.sort_unstable_by(|a, b| b.cmp(a));
    let mut borrar: Vec<String> = numeros.iter().filter(|&&n| n >= mantener).map(|&n| nombre(n)).collect();
    if mantener < 1 {
        borrar.push(format!("{base}.log"));
        return PlanRotacion { rotar: true, mover: vec![], borrar };
    }
    let mut mover: Vec<Movimiento> =
        numeros.iter().filter(|&&n| n < mantener).map(|&n| Movimiento { de: nombre(n), a: nombre(n + 1) }).collect();
    mover.push(Movimiento { de: format!("{base}.log"), a: nombre(1) });
    PlanRotacion { rotar: true, mover, borrar }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lista(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
    fn mv(de: &str, a: &str) -> Movimiento {
        Movimiento { de: de.into(), a: a.into() }
    }

    #[test]
    fn bajo_el_maximo_no_rota() {
        assert_eq!(plan_rotacion(99, 100, &lista(&["sloth.log", "sloth.1.log"]), "sloth", 3), PlanRotacion::default());
    }

    #[test]
    fn un_log_vacio_no_rota_aunque_el_maximo_sea_0() {
        assert!(!plan_rotacion(0, 0, &[], "sloth", 3).rotar);
    }

    #[test]
    fn en_el_maximo_sin_rotados_solo_pasa_el_log_a_el_1() {
        let p = plan_rotacion(100, 100, &lista(&["sloth.log"]), "sloth", 3);
        assert_eq!(p, PlanRotacion { rotar: true, mover: vec![mv("sloth.log", "sloth.1.log")], borrar: vec![] });
    }

    #[test]
    fn con_dos_rotados_los_corre_del_mas_viejo_al_mas_nuevo() {
        let p = plan_rotacion(150, 100, &lista(&["sloth.log", "sloth.1.log", "sloth.2.log"]), "sloth", 3);
        assert_eq!(p.mover, vec![mv("sloth.2.log", "sloth.3.log"), mv("sloth.1.log", "sloth.2.log"), mv("sloth.log", "sloth.1.log")]);
        assert!(p.borrar.is_empty());
    }

    #[test]
    fn con_mantener_rotados_borra_el_mas_viejo_antes_de_mover() {
        let p = plan_rotacion(100, 100, &lista(&["sloth.3.log", "sloth.log", "sloth.1.log", "sloth.2.log"]), "sloth", 3);
        assert_eq!(p.borrar, lista(&["sloth.3.log"]));
        assert_eq!(p.mover, vec![mv("sloth.2.log", "sloth.3.log"), mv("sloth.1.log", "sloth.2.log"), mv("sloth.log", "sloth.1.log")]);
    }

    #[test]
    fn borra_tambien_los_rotados_que_sobran_de_una_configuracion_anterior() {
        let p = plan_rotacion(100, 100, &lista(&["sloth.5.log", "sloth.4.log", "sloth.1.log"]), "sloth", 3);
        assert_eq!(p.borrar, lista(&["sloth.5.log", "sloth.4.log"]));
        assert_eq!(p.mover, vec![mv("sloth.1.log", "sloth.2.log"), mv("sloth.log", "sloth.1.log")]);
    }

    #[test]
    fn los_nombres_ajenos_no_se_tocan() {
        let mut existentes = lista(&["sesion.json", "sloth.1.log.bak", "otro.1.log", "sloth.01.log", "sloth.x.log", "sloth.0.log", "xsloth.1.log"]);
        existentes.push("sloth.1.log".into());
        let p = plan_rotacion(100, 100, &existentes, "sloth", 3);
        assert_eq!(p.mover, vec![mv("sloth.1.log", "sloth.2.log"), mv("sloth.log", "sloth.1.log")]);
        assert!(p.borrar.is_empty());
    }

    #[test]
    fn un_base_con_puntos_no_se_confunde_con_una_expresion_regular() {
        let p = plan_rotacion(100, 100, &lista(&["aXb.1.log", "a.b.1.log"]), "a.b", 3);
        assert_eq!(p.mover, vec![mv("a.b.1.log", "a.b.2.log"), mv("a.b.log", "a.b.1.log")]);
    }

    #[test]
    fn sin_rotados_que_conservar_se_borra_el_log_actual() {
        let p = plan_rotacion(100, 100, &lista(&["sloth.1.log"]), "sloth", 0);
        assert_eq!(p, PlanRotacion { rotar: true, mover: vec![], borrar: lista(&["sloth.1.log", "sloth.log"]) });
    }
}
