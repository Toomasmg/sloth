//! Corta la grabación en partes mientras se habla, en las pausas, para transcribir cada una apenas termina. Equivale a
//! src/shared/partes-dictado.ts. Whisper trabaja en ventanas de 30 s: con partes de ese largo cada una es una sola
//! ventana con la pista de vocabulario, un error no arrastra al resto y al soltar queda poco por transcribir.
use super::dictado_core::rms;

/// Por debajo de esto una parte es silencio (o ruido): no vale la pena transcribirla.
pub const SILENCIO: f64 = 0.004;
/// Un cuadro es silencio si su nivel no llega a este piso o a varias veces el ruido de fondo.
const SILENCIO_CUADRO: f64 = 0.006;
const VECES_RUIDO: f64 = 2.5;
const MAX_RUIDO: f64 = 0.012;
/// Dónde buscar el momento más callado cuando la parte llega al máximo sin pausa (s).
const BUSCAR_CORTE_SEGUNDOS: f64 = 6.0;

#[derive(Debug, Clone, Copy)]
pub struct OpcionesCortador {
    pub rate: u32,
    /// Una parte no se corta antes de esto (s): con poco audio, Whisper se equivoca más y hasta cambia de idioma.
    pub min_segundos: f64,
    /// Ni pasa de esto (s): sin pausa, se corta en el momento más callado de los últimos segundos.
    pub max_segundos: f64,
    /// Silencio seguido que cuenta como pausa (s).
    pub pausa_segundos: f64,
}

impl OpcionesCortador {
    pub fn nuevas(rate: u32) -> Self {
        Self { rate, min_segundos: 15.0, max_segundos: 28.0, pausa_segundos: 0.7 }
    }
}

/// ¿Vale la pena transcribir este audio? Al menos 0,3 s y algo más que silencio.
pub fn tiene_voz(audio: &[f32], rate: u32) -> bool {
    audio.len() as f64 >= f64::from(rate) * 0.3 && rms(audio) >= SILENCIO
}

pub struct Cortador {
    rate: f64,
    rate_hz: u32,
    min: f64,
    max: f64,
    pausa: f64,
    cuadros: Vec<Vec<f32>>,
    niveles: Vec<f64>,
    muestras: usize,
    /// Ruido de fondo: baja con el cuadro más callado y sube de a poco si el ambiente cambia. Arranca bajo y tiene tope
    /// para que hablar sin parar no lo confunda con ruido.
    ruido: f64,
}

pub fn crear_cortador(o: OpcionesCortador) -> Cortador {
    let rate = f64::from(o.rate);
    Cortador {
        rate,
        rate_hz: o.rate,
        min: o.min_segundos * rate,
        max: o.max_segundos * rate,
        pausa: o.pausa_segundos * rate,
        cuadros: Vec::new(),
        niveles: Vec::new(),
        muestras: 0,
        ruido: SILENCIO_CUADRO / VECES_RUIDO,
    }
}

fn unir(cuadros: &[Vec<f32>]) -> Vec<f32> {
    cuadros.iter().flatten().copied().collect()
}

impl Cortador {
    fn silencioso(&self, nivel: f64) -> bool {
        nivel < SILENCIO_CUADRO.max(self.ruido * VECES_RUIDO)
    }

    /// Cierra la parte con los primeros `n` cuadros y deja el resto para la siguiente.
    fn cortar(&mut self, n: usize) -> Option<Vec<f32>> {
        let n = n.min(self.cuadros.len());
        let parte = unir(&self.cuadros[..n]);
        self.cuadros.drain(..n);
        self.niveles.drain(..n);
        self.muestras = self.cuadros.iter().map(Vec::len).sum();
        tiene_voz(&parte, self.rate_hz).then_some(parte)
    }

    /// Cuántas muestras de silencio seguido hay al final.
    fn silencio_final(&self) -> usize {
        let mut s = 0;
        for i in (0..self.niveles.len()).rev() {
            if !self.silencioso(self.niveles[i]) {
                break;
            }
            s += self.cuadros[i].len();
        }
        s
    }

    /// Suma un cuadro del micrófono; devuelve las partes que se cerraron con él.
    pub fn agregar(&mut self, cuadro: Vec<f32>) -> Vec<Vec<f32>> {
        let nivel = rms(&cuadro);
        self.ruido = if nivel < self.ruido { nivel } else { MAX_RUIDO.min(self.ruido * 1.05) };
        self.muestras += cuadro.len();
        self.cuadros.push(cuadro);
        self.niveles.push(nivel);
        let mut p = None;
        if self.muestras as f64 >= self.min && self.silencio_final() as f64 >= self.pausa {
            p = self.cortar(self.cuadros.len());
        } else if self.muestras as f64 >= self.max {
            // Sin pausa: el cuadro más callado de los últimos segundos, para no cortar una palabra al medio.
            let mut desde = self.cuadros.len();
            let mut s = 0.0;
            while desde > 1 && s < BUSCAR_CORTE_SEGUNDOS * self.rate {
                desde -= 1;
                s += self.cuadros[desde].len() as f64;
            }
            let mut corte = desde;
            for i in desde..self.niveles.len() {
                if self.niveles[i] < self.niveles[corte] {
                    corte = i;
                }
            }
            p = self.cortar((corte + 1).max(1));
        }
        p.into_iter().collect()
    }

    /// Lo que quedó sin cerrar, o None si es silencio.
    pub fn cerrar(&mut self) -> Option<Vec<f32>> {
        let parte = unir(&self.cuadros);
        self.cuadros.clear();
        self.niveles.clear();
        self.muestras = 0;
        tiene_voz(&parte, self.rate_hz).then_some(parte)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 16000;
    /// Lo que entrega el ScriptProcessor: 4096 muestras (256 ms).
    const CUADRO: usize = 4096;

    fn cuantos(segundos: f64) -> usize {
        (segundos * f64::from(RATE) / CUADRO as f64 + 0.5).floor() as usize
    }

    /// Cuadros de voz (una senoidal de nivel ~0,07).
    fn voz(segundos: f64) -> Vec<Vec<f32>> {
        (0..cuantos(segundos)).map(|_| (0..CUADRO).map(|i| (0.1 * (i as f64 / 5.0).sin()) as f32).collect()).collect()
    }

    /// Cuadros de silencio con un poco de ruido.
    fn silencio(segundos: f64, nivel: f32) -> Vec<Vec<f32>> {
        (0..cuantos(segundos)).map(|_| (0..CUADRO).map(|i| if i % 2 == 1 { nivel } else { -nivel }).collect()).collect()
    }

    fn pasar(cuadros: Vec<Vec<f32>>) -> (Vec<f64>, Option<f64>) {
        let mut c = crear_cortador(OpcionesCortador::nuevas(RATE));
        let partes: Vec<f64> = cuadros.into_iter().flat_map(|q| c.agregar(q)).map(|p| p.len() as f64 / f64::from(RATE)).collect();
        (partes, c.cerrar().map(|r| r.len() as f64 / f64::from(RATE)))
    }

    fn juntar(tramos: Vec<Vec<Vec<f32>>>) -> Vec<Vec<f32>> {
        tramos.into_iter().flatten().collect()
    }

    #[test]
    fn corta_en_las_pausas_y_deja_lo_ultimo_para_el_cierre() {
        let (partes, resto) = pasar(juntar(vec![voz(16.0), silencio(1.0, 0.001), voz(17.0), silencio(1.0, 0.001), voz(3.0)]));
        assert_eq!(partes.len(), 2);
        assert!(resto.is_some_and(|r| r > 2.5));
    }

    #[test]
    fn una_pausa_antes_de_los_15_s_no_corta_porque_con_poco_audio_whisper_se_equivoca_mas() {
        let (partes, resto) = pasar(juntar(vec![voz(6.0), silencio(1.0, 0.001), voz(5.0), silencio(1.0, 0.001), voz(2.0)]));
        assert_eq!(partes.len(), 0);
        assert!(resto.is_some());
    }

    #[test]
    fn sin_pausas_ninguna_parte_pasa_de_28_s() {
        let (partes, _) = pasar(voz(90.0));
        assert!(partes.len() >= 3);
        assert!(partes.iter().all(|s| *s <= 28.1), "{partes:?}");
    }

    #[test]
    fn sin_pausa_corta_en_el_momento_mas_callado_de_los_ultimos_segundos() {
        let (partes, _) = pasar(juntar(vec![voz(24.0), silencio(0.5, 0.001), voz(10.0)]));
        assert_eq!(partes.len(), 1);
        assert!(partes[0] > 24.0 && partes[0] < 25.5, "{partes:?}");
    }

    #[test]
    fn el_silencio_solo_no_se_manda_a_transcribir() {
        let (partes, resto) = pasar(juntar(vec![silencio(20.0, 0.001), silencio(20.0, 0.001)]));
        assert!(partes.is_empty());
        assert_eq!(resto, None);
    }

    #[test]
    fn con_ruido_de_fondo_alto_la_pausa_se_sigue_viendo() {
        let (partes, _) = pasar(juntar(vec![silencio(2.0, 0.01), voz(16.0), silencio(1.0, 0.01), voz(3.0)]));
        assert_eq!(partes.len(), 1);
    }

    #[test]
    fn tiene_voz_pide_al_menos_0_3_s_y_algo_mas_que_silencio() {
        let voz_corta: Vec<f32> = (0..(RATE as usize / 4)).map(|i| (0.1 * (i as f64 / 5.0).sin()) as f32).collect();
        let voz_larga: Vec<f32> = (0..(RATE as usize / 2)).map(|i| (0.1 * (i as f64 / 5.0).sin()) as f32).collect();
        assert!(!tiene_voz(&voz_corta, RATE));
        assert!(tiene_voz(&voz_larga, RATE));
        assert!(!tiene_voz(&vec![0.0; RATE as usize], RATE));
        assert!(!tiene_voz(&[], RATE));
    }
}
