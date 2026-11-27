//! Equivale a src/main/poda.ts. La vista muestra solo lo que sigue existiendo; el archivo se poda solo si el store
//! cargó entero, porque con el store vacío por un fallo de lectura se borrarían datos sanos.

pub struct Podado<T> {
    pub vista: Vec<T>,
    pub guardar: Vec<T>,
}

pub fn podar_segun_store<T: Clone>(items: &[T], existe: impl Fn(&T) -> bool, confiable: bool) -> Podado<T> {
    let vista: Vec<T> = items.iter().filter(|x| existe(x)).cloned().collect();
    let guardar = if confiable { vista.clone() } else { items.to_vec() };
    Podado { vista, guardar }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn con_el_store_confiable_se_poda_el_archivo() {
        let p = podar_segun_store(&["a", "b", "c"], |x| *x != "b", true);
        assert_eq!(p.vista, vec!["a", "c"]);
        assert_eq!(p.guardar, vec!["a", "c"]);
    }

    #[test]
    fn con_el_store_incompleto_el_archivo_conserva_todo() {
        let p = podar_segun_store(&["a", "b", "c"], |x| *x != "b", false);
        assert_eq!(p.vista, vec!["a", "c"]);
        assert_eq!(p.guardar, vec!["a", "b", "c"]);
    }
}
