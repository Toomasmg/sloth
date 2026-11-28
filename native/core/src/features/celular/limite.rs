//! Ventana deslizante por cliente; las claves que ya no piden se sueltan, y con `max_claves` se descarta la más vieja.
//! Un pedido rechazado no suma a la cuenta. Equivale a `celular-limite.ts`.
use std::collections::VecDeque;
use std::sync::Mutex;

pub struct Limite {
    max: usize,
    ventana_ms: i64,
    max_claves: usize,
    // En orden de alta, como un `Map` de JavaScript.
    instantes: Mutex<Vec<(String, VecDeque<i64>)>>,
}

impl Limite {
    pub fn nuevo(max: usize, ventana_ms: i64, max_claves: usize) -> Self {
        Limite { max, ventana_ms, max_claves, instantes: Mutex::new(Vec::new()) }
    }

    /// true si el cliente puede hacer otro pedido ahora.
    pub fn permitir(&self, clave: &str, ahora: i64) -> bool {
        let corte = ahora - self.ventana_ms;
        let soltar_vencidos = |lista: &mut VecDeque<i64>| {
            while lista.front().is_some_and(|t| *t <= corte) {
                lista.pop_front();
            }
        };
        let mut todas = self.instantes.lock().unwrap_or_else(|e| e.into_inner());
        let pos = match todas.iter().position(|(k, _)| k == clave) {
            Some(i) => {
                soltar_vencidos(&mut todas[i].1);
                i
            }
            None => {
                if todas.len() >= self.max_claves {
                    todas.retain_mut(|(_, lista)| {
                        soltar_vencidos(lista);
                        !lista.is_empty()
                    });
                    if todas.len() >= self.max_claves {
                        todas.remove(0);
                    }
                }
                todas.push((clave.to_string(), VecDeque::new()));
                todas.len() - 1
            }
        };
        let lista = &mut todas[pos].1;
        if lista.len() >= self.max {
            return false;
        }
        lista.push_back(ahora);
        true
    }
}

impl Default for Limite {
    fn default() -> Self {
        Self::nuevo(200, 5000, 256)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pasan_200_pedidos_en_la_ventana_y_el_201_no() {
        let l = Limite::default();
        for i in 0..200 {
            assert!(l.permitir("1.1.1.1", 1000 + i), "pedido {i}");
        }
        assert!(!l.permitir("1.1.1.1", 1500));
        assert!(!l.permitir("1.1.1.1", 1500));
    }

    #[test]
    fn pasada_la_ventana_vuelve_a_dejar_pasar_y_los_rechazados_no_estiran_el_castigo() {
        let l = Limite::nuevo(3, 1000, 256);
        for t in 0..3 {
            assert!(l.permitir("a", t));
        }
        for t in (3..900).step_by(100) {
            assert!(!l.permitir("a", t));
        }
        assert!(l.permitir("a", 1001), "salió el primero");
        assert!(l.permitir("a", 1001));
        assert!(l.permitir("a", 1002));
        assert!(!l.permitir("a", 1003));
        assert!(l.permitir("a", 5000));
    }

    #[test]
    fn cada_cliente_tiene_su_cuenta() {
        let l = Limite::nuevo(2, 1000, 256);
        assert!(l.permitir("malo", 0));
        assert!(l.permitir("malo", 0));
        assert!(!l.permitir("malo", 0));
        assert!(l.permitir("celu", 0));
        assert!(l.permitir("celu", 1));
    }

    #[test]
    fn las_claves_no_crecen_sin_tope_primero_se_sueltan_las_vencidas() {
        let l = Limite::nuevo(1, 1000, 4);
        for c in ["a", "b", "c", "d"] {
            assert!(l.permitir(c, 0));
        }
        assert!(l.permitir("e", 10), "sin vencidas: entra y echa a la más vieja");
        assert!(l.permitir("a", 10), "a fue descartada: arranca de cero");
        assert!(!l.permitir("d", 10), "d sigue contada");
        assert!(l.permitir("f", 5000), "todas vencieron: se podan y f entra");
        assert!(l.permitir("d", 5000), "d vencida, vuelve a pasar");
    }

    #[test]
    fn muchas_claves_distintas_no_rompen_nada_ni_agrandan_la_memoria_mas_alla_del_tope() {
        let l = Limite::nuevo(5, 1000, 8);
        for i in 0..10_000 {
            assert!(l.permitir(&format!("ip-{i}"), i));
        }
        assert!(l.permitir("ip-9999", 10_000));
        assert!(l.instantes.lock().unwrap().len() <= 8);
    }
}
