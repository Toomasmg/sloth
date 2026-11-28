//! Conexiones simultáneas por cliente. Sin clave cualquiera de la red puede abrir sockets: con un tope global llenaría
//! los lugares y dejaría afuera al celu de verdad; por cliente, solo se llena a sí mismo. Equivale a `celular-conexiones.ts`.
use std::collections::HashMap;
use std::sync::Mutex;

pub struct Conexiones {
    max_por_ip: usize,
    abiertas: Mutex<HashMap<String, usize>>,
}

impl Conexiones {
    pub fn nuevas(max_por_ip: usize) -> Self {
        Conexiones { max_por_ip, abiertas: Mutex::new(HashMap::new()) }
    }

    /// true si ese cliente puede abrir otra conexión; false si ya tiene el máximo abierto.
    pub fn abrir(&self, ip: &str) -> bool {
        let mut a = self.abiertas.lock().unwrap_or_else(|e| e.into_inner());
        let n = a.get(ip).copied().unwrap_or(0);
        if n >= self.max_por_ip {
            return false;
        }
        a.insert(ip.to_string(), n + 1);
        true
    }

    /// Una por cada `abrir` que dio true; cerrar de más no deja cuentas negativas ni claves colgadas.
    pub fn cerrar(&self, ip: &str) {
        let mut a = self.abiertas.lock().unwrap_or_else(|e| e.into_inner());
        match a.get(ip).copied().unwrap_or(0) {
            0 | 1 => {
                a.remove(ip);
            }
            n => {
                a.insert(ip.to_string(), n - 1);
            }
        }
    }
}

impl Default for Conexiones {
    fn default() -> Self {
        Self::nuevas(16)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cada_cliente_tiene_su_tope_uno_que_lo_llena_no_le_saca_lugar_a_otro() {
        let c = Conexiones::nuevas(3);
        for _ in 0..3 {
            assert!(c.abrir("malo"));
        }
        assert!(!c.abrir("malo"));
        assert!(c.abrir("celu"));
        assert!(c.abrir("celu"));
    }

    #[test]
    fn al_cerrar_una_vuelve_el_lugar_y_cerrar_de_mas_no_regala_ninguno() {
        let c = Conexiones::nuevas(1);
        assert!(c.abrir("a"));
        assert!(!c.abrir("a"));
        c.cerrar("a");
        assert!(c.abrir("a"));
        c.cerrar("a");
        c.cerrar("a");
        c.cerrar("nunca-abrio");
        assert!(c.abrir("a"));
        assert!(!c.abrir("a"), "el cierre de más no regaló un lugar");
    }
}
