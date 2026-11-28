//! Los pedidos de «mirar» que quedan abiertos hasta que la terminal tenga salida nueva (hasta 25 s). Equivale a
//! `celular-espera.ts`. El estado es una máquina pura con la hora como dato (`NucleoEsperas`), así se prueba sin dormir;
//! `Esperas` la envuelve con un `Condvar` para que un hilo del servidor se quede esperando de verdad.
use super::ahora_ms;
use super::terminal_core::ESPERA_MAX_MS;
use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MotivoEspera {
    Dato,
    Vencio,
    Soltada,
    Cancelada,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inicio {
    /// No hay cupo (global o de esa terminal).
    SinCupo,
    /// Ya está resuelta: la señal de cancelar estaba levantada.
    Resuelta(MotivoEspera),
    Abierta(u64),
}

struct Abierta {
    ticket: u64,
    id: String,
    clave: String,
    vence_en: i64,
    coalescencia_en: Option<i64>,
}

pub struct NucleoEsperas {
    max_global: usize,
    max_por_terminal: usize,
    coalescencia_ms: i64,
    siguiente: u64,
    // En orden de alta, como un `Map` de JavaScript.
    abiertas: Vec<Abierta>,
    resueltas: HashMap<u64, MotivoEspera>,
}

impl NucleoEsperas {
    pub fn nuevo(max_global: usize, max_por_terminal: usize, coalescencia_ms: i64) -> Self {
        NucleoEsperas { max_global, max_por_terminal, coalescencia_ms, siguiente: 0, abiertas: Vec::new(), resueltas: HashMap::new() }
    }

    fn terminar(&mut self, ticket: u64, motivo: MotivoEspera) {
        if let Some(i) = self.abiertas.iter().position(|a| a.ticket == ticket) {
            self.abiertas.remove(i);
            self.resueltas.insert(ticket, motivo);
        }
    }

    /// Se resuelve con aviso (tras la coalescencia), al vencer `ms`, si otro pedido del mismo `dueno` o `soltar` la suelta,
    /// o si se cancela. Dos celus en la misma terminal no se sueltan entre sí: cada uno es un `dueno`.
    pub fn esperar(&mut self, id: &str, ms: f64, dueno: &str, ahora: i64, cancelada: bool) -> Inicio {
        if cancelada {
            return Inicio::Resuelta(MotivoEspera::Cancelada);
        }
        let clave = format!("{id}\0{dueno}");
        let previa = self.abiertas.iter().find(|a| a.clave == clave).map(|a| a.ticket);
        if previa.is_none() && (self.abiertas.len() >= self.max_global || self.abiertas.iter().filter(|a| a.id == id).count() >= self.max_por_terminal) {
            return Inicio::SinCupo;
        }
        if let Some(t) = previa {
            self.terminar(t, MotivoEspera::Soltada);
        }
        let ms = if ms.is_finite() { ms.clamp(0.0, ESPERA_MAX_MS as f64) as i64 } else { 0 };
        self.siguiente += 1;
        self.abiertas.push(Abierta { ticket: self.siguiente, id: id.into(), clave, vence_en: ahora + ms, coalescencia_en: None });
        Inicio::Abierta(self.siguiente)
    }

    /// Hay salida nueva: las esperas de esa terminal se resuelven pasada la coalescencia, contada desde el primer aviso.
    pub fn avisar(&mut self, id: &str, ahora: i64) {
        let coal = self.coalescencia_ms;
        for a in self.abiertas.iter_mut().filter(|a| a.id == id && a.coalescencia_en.is_none()) {
            a.coalescencia_en = Some(ahora + coal);
        }
    }

    pub fn soltar(&mut self, id: &str) {
        let tickets: Vec<u64> = self.abiertas.iter().filter(|a| a.id == id).map(|a| a.ticket).collect();
        for t in tickets {
            self.terminar(t, MotivoEspera::Soltada);
        }
    }

    pub fn soltar_todas(&mut self) {
        let tickets: Vec<u64> = self.abiertas.iter().map(|a| a.ticket).collect();
        for t in tickets {
            self.terminar(t, MotivoEspera::Soltada);
        }
    }

    pub fn cancelar(&mut self, ticket: u64) {
        self.terminar(ticket, MotivoEspera::Cancelada);
    }

    /// Resuelve lo que ya venció o se juntó.
    pub fn avanzar(&mut self, ahora: i64) {
        let listas: Vec<(u64, MotivoEspera)> = self
            .abiertas
            .iter()
            .filter_map(|a| match a.coalescencia_en {
                Some(c) if c <= ahora && c <= a.vence_en => Some((a.ticket, MotivoEspera::Dato)),
                _ if a.vence_en <= ahora => Some((a.ticket, MotivoEspera::Vencio)),
                _ => None,
            })
            .collect();
        for (t, m) in listas {
            self.terminar(t, m);
        }
    }

    /// Cómo terminó, si ya terminó (se lee una sola vez).
    pub fn tomar(&mut self, ticket: u64) -> Option<MotivoEspera> {
        self.resueltas.remove(&ticket)
    }

    pub fn activas(&self) -> usize {
        self.abiertas.len()
    }

    /// La próxima hora en que algo cambia sin que nadie avise.
    pub fn proximo(&self) -> Option<i64> {
        self.abiertas.iter().map(|a| a.coalescencia_en.map_or(a.vence_en, |c| c.min(a.vence_en))).min()
    }
}

/// Lo de arriba con el reloj de verdad y un hilo que se queda esperando.
pub struct Esperas {
    nucleo: Mutex<NucleoEsperas>,
    despertar: Condvar,
}

/// Cuánto como mucho se duerme sin mirar si el celu cortó la conexión.
const REVISAR_CORTE_MS: i64 = 100;

impl Esperas {
    pub fn nuevas(max_global: usize, max_por_terminal: usize, coalescencia_ms: i64) -> Self {
        Esperas { nucleo: Mutex::new(NucleoEsperas::nuevo(max_global, max_por_terminal, coalescencia_ms)), despertar: Condvar::new() }
    }

    fn nucleo(&self) -> std::sync::MutexGuard<'_, NucleoEsperas> {
        self.nucleo.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn abrir(&self, id: &str, ms: f64, dueno: &str, cancelada: bool) -> Inicio {
        self.nucleo().esperar(id, ms, dueno, ahora_ms(), cancelada)
    }

    /// Bloquea hasta que la espera termine. `cancelada` se mira seguido: salta si el celu cortó la conexión.
    pub fn bloquear(&self, ticket: u64, cancelada: &dyn Fn() -> bool) -> MotivoEspera {
        let mut n = self.nucleo();
        loop {
            n.avanzar(ahora_ms());
            if let Some(m) = n.tomar(ticket) {
                return m;
            }
            if cancelada() {
                n.cancelar(ticket);
                continue;
            }
            let ahora = ahora_ms();
            let falta = n.proximo().map_or(REVISAR_CORTE_MS, |p| (p - ahora).clamp(1, REVISAR_CORTE_MS));
            n = self.despertar.wait_timeout(n, Duration::from_millis(falta as u64)).unwrap_or_else(|e| e.into_inner()).0;
        }
    }

    pub fn avisar(&self, id: &str) {
        self.nucleo().avisar(id, ahora_ms());
        self.despertar.notify_all();
    }

    pub fn soltar(&self, id: &str) {
        self.nucleo().soltar(id);
        self.despertar.notify_all();
    }

    pub fn soltar_todas(&self) {
        self.nucleo().soltar_todas();
        self.despertar.notify_all();
    }

    pub fn activas(&self) -> usize {
        self.nucleo().activas()
    }
}

impl Default for Esperas {
    fn default() -> Self {
        Self::nuevas(6, 2, 8)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use MotivoEspera::*;

    fn nucleo() -> NucleoEsperas {
        NucleoEsperas::nuevo(6, 2, 8)
    }

    fn abrir(n: &mut NucleoEsperas, id: &str, ms: f64, dueno: &str, ahora: i64) -> u64 {
        match n.esperar(id, ms, dueno, ahora, false) {
            Inicio::Abierta(t) => t,
            otro => panic!("había cupo: {otro:?}"),
        }
    }

    #[test]
    fn vence_a_los_ms_y_no_deja_nada_abierto() {
        let mut n = nucleo();
        let t = abrir(&mut n, "a", 30.0, "", 0);
        n.avanzar(29);
        assert_eq!(n.tomar(t), None);
        n.avanzar(30);
        assert_eq!(n.tomar(t), Some(Vencio));
        assert_eq!(n.activas(), 0);
    }

    #[test]
    fn varios_avisos_seguidos_resuelven_dato_una_sola_vez_contado_desde_el_primero() {
        let mut n = NucleoEsperas::nuevo(6, 2, 40);
        let t = abrir(&mut n, "a", 5000.0, "", 0);
        for i in 0..5 {
            n.avisar("a", i * 3);
        }
        n.avanzar(39);
        assert_eq!(n.tomar(t), None, "contado desde el primer aviso: faltan 40 ms desde 0");
        n.avanzar(40);
        assert_eq!(n.tomar(t), Some(Dato));
        assert_eq!(n.tomar(t), None, "se resuelve una sola vez");
        assert_eq!(n.activas(), 0);
    }

    #[test]
    fn avisar_sin_nadie_esperando_no_acumula_nada_la_espera_siguiente_no_sale_sola() {
        let mut n = NucleoEsperas::nuevo(6, 2, 2);
        n.avisar("a", 0);
        n.avisar("a", 0);
        assert_eq!(n.activas(), 0);
        let t = abrir(&mut n, "a", 40.0, "", 1);
        n.avanzar(20);
        assert_eq!(n.tomar(t), None);
        n.avanzar(41);
        assert_eq!(n.tomar(t), Some(Vencio));
    }

    #[test]
    fn un_aviso_a_otra_terminal_no_despierta_a_esta() {
        let mut n = NucleoEsperas::nuevo(6, 2, 2);
        let t = abrir(&mut n, "a", 40.0, "", 0);
        n.avisar("b", 0);
        n.avanzar(10);
        assert_eq!(n.tomar(t), None);
        n.avanzar(40);
        assert_eq!(n.tomar(t), Some(Vencio));
    }

    #[test]
    fn la_segunda_espera_del_mismo_id_suelta_a_la_primera_y_toma_su_lugar_sin_gastar_cupo() {
        let mut n = NucleoEsperas::nuevo(1, 2, 8);
        let primera = abrir(&mut n, "a", 5000.0, "", 0);
        let segunda = abrir(&mut n, "a", 5000.0, "", 0);
        assert_eq!(n.tomar(primera), Some(Soltada));
        assert_eq!(n.activas(), 1);
        n.soltar("a");
        assert_eq!(n.tomar(segunda), Some(Soltada));
        assert_eq!(n.activas(), 0);
    }

    #[test]
    fn tope_global_la_que_no_entra_no_deja_rastro_al_liberar_un_lugar_vuelve_a_entrar() {
        let mut n = nucleo();
        let abiertas: Vec<u64> = ["a", "b", "c", "d", "e", "f"].iter().map(|id| abrir(&mut n, id, 5000.0, "", 0)).collect();
        assert_eq!(n.esperar("g", 5000.0, "", 0, false), Inicio::SinCupo);
        assert_eq!(n.activas(), 6);
        n.soltar("c");
        assert_eq!(n.tomar(abiertas[2]), Some(Soltada));
        let g = abrir(&mut n, "g", 5000.0, "", 0);
        assert_eq!(n.activas(), 6);
        n.soltar_todas();
        for t in abiertas.iter().chain([&g]) {
            let esperado = Some(Soltada);
            let real = n.tomar(*t);
            if *t != abiertas[2] {
                assert_eq!(real, esperado);
            }
        }
        assert_eq!(n.activas(), 0);
    }

    #[test]
    fn soltar_de_un_id_que_no_espera_no_hace_nada_soltar_todas_suelta_a_todas() {
        let mut n = nucleo();
        n.soltar("nadie");
        let ts: Vec<u64> = ["a", "b", "c"].iter().map(|id| abrir(&mut n, id, 5000.0, "", 0)).collect();
        n.soltar_todas();
        assert_eq!(ts.iter().map(|t| n.tomar(*t)).collect::<Vec<_>>(), [Some(Soltada), Some(Soltada), Some(Soltada)]);
        assert_eq!(n.activas(), 0);
        n.soltar_todas();
    }

    #[test]
    fn cancelar_la_senal_cancela_la_espera_abierta() {
        let mut n = nucleo();
        let t = abrir(&mut n, "a", 5000.0, "", 0);
        n.cancelar(t);
        assert_eq!(n.tomar(t), Some(Cancelada));
        assert_eq!(n.activas(), 0);
    }

    #[test]
    fn con_la_senal_ya_cancelada_resuelve_cancelada_sin_tomar_cupo_ni_soltar_a_la_anterior() {
        let mut n = NucleoEsperas::nuevo(1, 2, 8);
        let viva = abrir(&mut n, "a", 5000.0, "", 0);
        assert_eq!(n.esperar("a", 5000.0, "", 0, true), Inicio::Resuelta(Cancelada));
        assert_eq!(n.esperar("b", 5000.0, "", 0, true), Inicio::Resuelta(Cancelada));
        assert_eq!(n.activas(), 1);
        n.soltar("a");
        assert_eq!(n.tomar(viva), Some(Soltada));
    }

    #[test]
    fn red_que_cae_con_el_pedido_abierto_cancelar_con_un_aviso_pendiente_no_resuelve_dos_veces() {
        let mut n = NucleoEsperas::nuevo(6, 2, 15);
        let t = abrir(&mut n, "a", 5000.0, "", 0);
        n.avisar("a", 0);
        n.cancelar(t);
        assert_eq!(n.tomar(t), Some(Cancelada));
        n.avanzar(40);
        assert_eq!(n.tomar(t), None);
        assert_eq!(n.activas(), 0);
        n.avisar("a", 40);
        assert_eq!(n.activas(), 0);
    }

    #[test]
    fn cancelar_despues_de_resolver_no_toca_a_la_espera_siguiente_del_mismo_id() {
        let mut n = NucleoEsperas::nuevo(6, 2, 1);
        let t = abrir(&mut n, "a", 5000.0, "", 0);
        n.avisar("a", 0);
        n.avanzar(1);
        assert_eq!(n.tomar(t), Some(Dato));
        let otra = abrir(&mut n, "a", 5000.0, "", 2);
        n.cancelar(t);
        assert_eq!(n.activas(), 1);
        n.soltar("a");
        assert_eq!(n.tomar(otra), Some(Soltada));
    }

    #[test]
    fn ms_raros_se_acotan_negativo_o_nan_vence_ya_y_uno_enorme_es_una_espera_normal_que_se_puede_soltar() {
        let mut n = nucleo();
        for ms in [-5.0, f64::NAN] {
            let t = abrir(&mut n, "a", ms, "", 100);
            n.avanzar(100);
            assert_eq!(n.tomar(t), Some(Vencio), "{ms}");
        }
        let larga = abrir(&mut n, "a", 1e9, "", 0);
        n.avanzar(ESPERA_MAX_MS as i64 - 1);
        assert_eq!(n.tomar(larga), None);
        n.avanzar(ESPERA_MAX_MS as i64);
        assert_eq!(n.tomar(larga), Some(Vencio), "el tope de 25 s también corta la enorme");
        let otra = abrir(&mut n, "a", 1e9, "", 0);
        n.soltar("a");
        assert_eq!(n.tomar(otra), Some(Soltada));
        assert_eq!(n.activas(), 0);
    }

    #[test]
    fn dos_celus_en_la_misma_terminal_esperan_los_dos_y_un_aviso_despierta_a_ambos_el_tercero_no_entra() {
        let mut n = NucleoEsperas::nuevo(6, 2, 2);
        let a = abrir(&mut n, "ws", 5000.0, "celu-a", 0);
        let b = abrir(&mut n, "ws", 5000.0, "celu-b", 0);
        assert_eq!(n.activas(), 2);
        assert_eq!(n.esperar("ws", 5000.0, "celu-c", 0, false), Inicio::SinCupo);
        let otra = abrir(&mut n, "otra", 5000.0, "celu-c", 0);
        n.avisar("ws", 0);
        n.avanzar(2);
        assert_eq!((n.tomar(a), n.tomar(b)), (Some(Dato), Some(Dato)));
        assert_eq!(n.activas(), 1, "la de otra terminal sigue");
        n.soltar_todas();
        assert_eq!(n.tomar(otra), Some(Soltada));
        assert_eq!(n.activas(), 0);
    }

    #[test]
    fn un_celu_que_vuelve_a_pedir_suelta_solo_a_su_propia_espera_no_a_la_del_otro() {
        let mut n = nucleo();
        let a1 = abrir(&mut n, "ws", 5000.0, "celu-a", 0);
        let b = abrir(&mut n, "ws", 5000.0, "celu-b", 0);
        let a2 = abrir(&mut n, "ws", 5000.0, "celu-a", 0);
        assert_eq!(n.tomar(a1), Some(Soltada));
        assert_eq!(n.activas(), 2);
        n.soltar("ws");
        assert_eq!((n.tomar(a2), n.tomar(b)), (Some(Soltada), Some(Soltada)));
        assert_eq!(n.activas(), 0);
    }

    #[test]
    fn el_tope_por_terminal_no_le_quita_cupo_a_las_demas_ni_deja_rastro_al_rechazar() {
        let mut n = NucleoEsperas::nuevo(3, 1, 8);
        let a = abrir(&mut n, "a", 5000.0, "", 0);
        assert_eq!(n.esperar("a", 5000.0, "otro", 0, false), Inicio::SinCupo);
        let b = abrir(&mut n, "b", 5000.0, "", 0);
        let c = abrir(&mut n, "c", 5000.0, "", 0);
        assert_eq!(n.esperar("d", 5000.0, "", 0, false), Inicio::SinCupo);
        assert_eq!(n.activas(), 3);
        n.soltar_todas();
        for t in [a, b, c] {
            assert_eq!(n.tomar(t), Some(Soltada));
        }
        assert_eq!(n.activas(), 0);
    }

    #[test]
    fn proximo_dice_cuando_hay_que_volver_a_mirar() {
        let mut n = nucleo();
        assert_eq!(n.proximo(), None);
        abrir(&mut n, "a", 1000.0, "", 0);
        assert_eq!(n.proximo(), Some(1000));
        n.avisar("a", 100);
        assert_eq!(n.proximo(), Some(108));
    }

    #[test]
    fn la_envoltura_con_hilos_suelta_a_quien_espera_y_corta_con_la_senal() {
        let e = std::sync::Arc::new(Esperas::default());
        let Inicio::Abierta(t) = e.abrir("a", 5000.0, "", false) else { panic!("había cupo") };
        let e2 = e.clone();
        let h = std::thread::spawn(move || e2.bloquear(t, &|| false));
        while e.activas() == 0 {
            std::thread::yield_now();
        }
        e.soltar("a");
        assert_eq!(h.join().unwrap(), Soltada);
        let Inicio::Abierta(t) = e.abrir("a", 5000.0, "", false) else { panic!("había cupo") };
        assert_eq!(e.bloquear(t, &|| true), Cancelada);
        let Inicio::Abierta(t) = e.abrir("a", 0.0, "", false) else { panic!("había cupo") };
        assert_eq!(e.bloquear(t, &|| false), Vencio);
        assert_eq!(e.activas(), 0);
    }
}
