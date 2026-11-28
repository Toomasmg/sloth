//! El último número de escritura hecho por cada página (sesión) en cada terminal. Una página que reintenta manda el mismo
//! número; uno ya visto no se vuelve a ejecutar. Un número mayor que el siguiente (se perdió una escritura que la página
//! decidió no reenviar) se hace igual. Acotado en cantidad y en edad. Equivale a `celular-escrituras.ts`.
use std::collections::VecDeque;
use std::sync::Mutex;

struct Marca {
    clave: String,
    n: i64,
    en: i64,
}

pub struct Escrituras {
    max: usize,
    vence_ms: i64,
    // En orden de alta: la más vieja primero, como un `Map` de JavaScript.
    marcas: Mutex<VecDeque<Marca>>,
}

impl Escrituras {
    pub fn nuevas(max: usize, vence_ms: i64) -> Self {
        Escrituras { max, vence_ms, marcas: Mutex::new(VecDeque::new()) }
    }

    /// true si esta escritura hay que hacerla; false si ya se hizo (la página reintentó porque la respuesta se perdió).
    pub fn nueva(&self, id: &str, sesion: &str, n: i64, ahora: i64) -> bool {
        let clave = format!("{id}|{sesion}");
        let mut marcas = self.marcas.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(i) = marcas.iter().position(|m| m.clave == clave) {
            let previa = &marcas[i];
            if ahora - previa.en <= self.vence_ms && n <= previa.n {
                return false;
            }
            marcas.remove(i);
        }
        if marcas.len() >= self.max {
            marcas.retain(|m| ahora - m.en <= self.vence_ms);
            if marcas.len() >= self.max {
                marcas.pop_front();
            }
        }
        marcas.push_back(Marca { clave, n, en: ahora });
        true
    }
}

impl Default for Escrituras {
    fn default() -> Self {
        Self::nuevas(64, 10 * 60_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_primera_vez_se_hace_y_el_reintento_con_el_mismo_numero_no() {
        let e = Escrituras::default();
        assert!(e.nueva("ws", "sesion-1", 1, 0));
        assert!(!e.nueva("ws", "sesion-1", 1, 10));
        assert!(!e.nueva("ws", "sesion-1", 1, 20));
        assert!(e.nueva("ws", "sesion-1", 2, 30));
        assert!(!e.nueva("ws", "sesion-1", 2, 40));
    }

    #[test]
    fn un_numero_viejo_tampoco_se_repite() {
        let e = Escrituras::default();
        assert!(e.nueva("ws", "s-1-1-1", 5, 0));
        assert!(!e.nueva("ws", "s-1-1-1", 3, 1));
        assert!(!e.nueva("ws", "s-1-1-1", 4, 2));
    }

    #[test]
    fn un_hueco_se_acepta() {
        let e = Escrituras::default();
        assert!(e.nueva("ws", "sesion-1", 1, 0));
        assert!(e.nueva("ws", "sesion-1", 4, 1));
        assert!(!e.nueva("ws", "sesion-1", 4, 2));
    }

    #[test]
    fn otra_pagina_o_otra_terminal_tienen_su_propia_cuenta() {
        let e = Escrituras::default();
        assert!(e.nueva("ws", "sesion-1", 9, 0));
        assert!(e.nueva("ws", "sesion-2", 1, 1));
        assert!(e.nueva("otra", "sesion-1", 9, 2));
        assert!(!e.nueva("ws", "sesion-1", 9, 3), "la primera sigue contada aunque otra escriba en la misma terminal");
        assert!(!e.nueva("ws", "sesion-2", 1, 4));
    }

    #[test]
    fn pasado_el_vencimiento_se_olvida() {
        let e = Escrituras::nuevas(64, 1000);
        assert!(e.nueva("ws", "sesion-1", 1, 0));
        assert!(e.nueva("ws", "sesion-1", 1, 1001));
        assert!(!e.nueva("ws", "sesion-1", 1, 1500));
    }

    #[test]
    fn con_el_tope_lleno_se_descarta_la_mas_vieja_y_entran_las_nuevas() {
        let e = Escrituras::nuevas(3, 10_000);
        for s in ["sesion-a", "sesion-b", "sesion-c"] {
            assert!(e.nueva("ws", s, 1, 0));
        }
        assert!(e.nueva("ws", "sesion-d", 1, 1));
        assert!(!e.nueva("ws", "sesion-b", 1, 2), "b sigue");
        assert!(e.nueva("ws", "sesion-a", 1, 3), "a se descartó");
    }

    #[test]
    fn mil_paginas_distintas_no_agrandan_el_mapa_y_la_ultima_sigue_protegida() {
        let e = Escrituras::nuevas(8, 600_000);
        for i in 0..1000 {
            assert!(e.nueva("ws", &format!("sesion-{i}"), 1, i));
        }
        assert!(!e.nueva("ws", "sesion-999", 1, 1000));
        assert!(e.marcas.lock().unwrap().len() <= 8);
    }
}
