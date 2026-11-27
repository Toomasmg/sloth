//! Ciclo de vida del agente de un espacio, en un solo lugar. Equivale a src/main/agent-machine.ts.
//!
//!   (sin estado) ──start──▶ idle ◀──hook──▶ working / waiting / done
//!   cualquiera   ──exit───▶ exited ──start──▶ idle
//!   cualquiera   ──sleep──▶ sleeping ──wake o start──▶ idle
//!
//! Una terminal cerrada o dormida no cambia de estado por un hook (Claude manda Stop o SessionEnd mientras lo cierran), y
//! dormido gana sobre cerrado: la terminal de un espacio dormido se cerró a propósito.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EstadoAgente {
    Idle,
    Working,
    Waiting,
    Done,
    Exited,
    /// Sloth cerró su Claude por inactividad; al despertarlo retoma la conversación (`--continue`).
    Sleeping,
}

impl EstadoAgente {
    pub fn como_texto(self) -> &'static str {
        match self {
            EstadoAgente::Idle => "idle",
            EstadoAgente::Working => "working",
            EstadoAgente::Waiting => "waiting",
            EstadoAgente::Done => "done",
            EstadoAgente::Exited => "exited",
            EstadoAgente::Sleeping => "sleeping",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntradaAgente {
    Start,
    Exit,
    Sleep,
    Wake,
    Hook(EstadoAgente),
}

/// Estado siguiente, o None si esa entrada no cambia nada desde el estado actual.
pub fn siguiente_estado(prev: Option<EstadoAgente>, entrada: EntradaAgente) -> Option<EstadoAgente> {
    use EstadoAgente::*;
    match entrada {
        EntradaAgente::Hook(h) => (!matches!(prev, Some(Exited) | Some(Sleeping))).then_some(h),
        // Reconectarse a una terminal que seguía viva no pisa lo que Claude estaba haciendo.
        EntradaAgente::Start => matches!(prev, None | Some(Exited) | Some(Sleeping)).then_some(Idle),
        EntradaAgente::Exit => (prev != Some(Sleeping)).then_some(Exited),
        EntradaAgente::Sleep => Some(Sleeping),
        EntradaAgente::Wake => (prev == Some(Sleeping)).then_some(Idle),
    }
}

/// Quita lo que el emulador manda solo: `ESC [ … final` (CSI), `ESC ] … BEL|ESC \` (OSC) y `ESC O x` (SS3).
fn sin_secuencias_de_control(data: &str) -> String {
    let c: Vec<char> = data.chars().collect();
    let mut salida = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '\u{1b}' {
            match c.get(i + 1) {
                Some('[') => {
                    let mut j = i + 2;
                    while c.get(j).is_some_and(|x| ('\u{30}'..='\u{3f}').contains(x)) {
                        j += 1;
                    }
                    while c.get(j).is_some_and(|x| ('\u{20}'..='\u{2f}').contains(x)) {
                        j += 1;
                    }
                    if c.get(j).is_some_and(|x| ('\u{40}'..='\u{7e}').contains(x)) {
                        i = j + 1;
                        continue;
                    }
                }
                Some(']') => {
                    let mut j = i + 2;
                    while c.get(j).is_some_and(|x| *x != '\u{7}' && *x != '\u{1b}') {
                        j += 1;
                    }
                    if c.get(j) == Some(&'\u{7}') {
                        i = j + 1;
                        continue;
                    }
                    if c.get(j) == Some(&'\u{1b}') && c.get(j + 1) == Some(&'\\') {
                        i = j + 2;
                        continue;
                    }
                }
                Some('O') if c.get(i + 2).is_some_and(|x| *x != '\n') => {
                    i += 3;
                    continue;
                }
                _ => {}
            }
        }
        salida.push(c[i]);
        i += 1;
    }
    salida
}

/// Si lo que llegó a la terminal lo escribió una persona. El emulador también contesta consultas del programa y avisa de
/// foco o del mouse con secuencias de escape: eso no es entrada.
pub fn es_entrada_de_usuario(data: &str) -> bool {
    !sin_secuencias_de_control(data).is_empty()
}

/// Un agente sin hooks (Codex) solo manda «terminó»; nada lo devuelve a «working» al empezar otro turno y el espacio
/// quedaría en `done` para siempre. Lo único honesto que sabemos es que alguien escribió en su terminal: eso libera el
/// `done`, a `idle` (no se inventa `working`).
pub fn salida_de_done_sin_hooks(prev: Option<EstadoAgente>, tiene_hooks: bool, data: &str) -> bool {
    !tiene_hooks && prev == Some(EstadoAgente::Done) && es_entrada_de_usuario(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use EstadoAgente::*;

    const VIVOS: [EstadoAgente; 4] = [Idle, Working, Waiting, Done];

    fn con_ninguno() -> Vec<Option<EstadoAgente>> {
        std::iter::once(None).chain(VIVOS.iter().map(|e| Some(*e))).collect()
    }

    #[test]
    fn con_la_terminal_viva_cada_hook_lleva_a_su_estado() {
        for prev in con_ninguno() {
            for h in VIVOS {
                assert_eq!(siguiente_estado(prev, EntradaAgente::Hook(h)), Some(h));
            }
        }
    }

    #[test]
    fn un_hook_tardio_no_revive_un_espacio_cerrado_ni_uno_dormido() {
        for h in VIVOS {
            assert_eq!(siguiente_estado(Some(Exited), EntradaAgente::Hook(h)), None);
            assert_eq!(siguiente_estado(Some(Sleeping), EntradaAgente::Hook(h)), None);
        }
    }

    #[test]
    fn abrir_la_terminal_deja_el_espacio_listo_si_no_habia_estado_estaba_cerrado_o_dormido() {
        for prev in [None, Some(Exited), Some(Sleeping)] {
            assert_eq!(siguiente_estado(prev, EntradaAgente::Start), Some(Idle));
        }
        for prev in VIVOS {
            assert_eq!(siguiente_estado(Some(prev), EntradaAgente::Start), None);
        }
    }

    #[test]
    fn la_salida_cierra_el_espacio_salvo_que_este_dormido() {
        for prev in con_ninguno().into_iter().chain([Some(Exited)]) {
            assert_eq!(siguiente_estado(prev, EntradaAgente::Exit), Some(Exited));
        }
        assert_eq!(siguiente_estado(Some(Sleeping), EntradaAgente::Exit), None);
    }

    #[test]
    fn dormir_vale_desde_cualquier_estado_y_despertar_solo_desde_dormido() {
        for prev in con_ninguno().into_iter().chain([Some(Exited), Some(Sleeping)]) {
            assert_eq!(siguiente_estado(prev, EntradaAgente::Sleep), Some(Sleeping));
        }
        assert_eq!(siguiente_estado(Some(Sleeping), EntradaAgente::Wake), Some(Idle));
        for prev in con_ninguno().into_iter().chain([Some(Exited)]) {
            assert_eq!(siguiente_estado(prev, EntradaAgente::Wake), None);
        }
    }

    #[test]
    fn entrada_de_usuario_teclas_y_pegado_si_respuestas_del_emulador_foco_y_mouse_no() {
        for tecla in ["a", "\r", "hola\r", "\u{1b}", "\u{1b}[200~pegado\u{1b}[201~", "\u{3}"] {
            assert!(es_entrada_de_usuario(tecla), "{tecla:?}");
        }
        for ruido in ["", "\u{1b}[I", "\u{1b}[O", "\u{1b}[?1;2c", "\u{1b}[12;40R", "\u{1b}[<0;10;5M", "\u{1b}]10;rgb:0000/0000/0000\u{7}", "\u{1b}]11;rgb:ffff/ffff/ffff\u{1b}\\", "\u{1b}OA", "\u{1b}[A"] {
            assert!(!es_entrada_de_usuario(ruido), "{ruido:?}");
        }
    }

    #[test]
    fn sin_hooks_escribir_libera_el_done_con_hooks_o_en_otro_estado_no_hace_nada() {
        assert!(salida_de_done_sin_hooks(Some(Done), false, "\r"));
        assert!(!salida_de_done_sin_hooks(Some(Done), false, "\u{1b}[I"));
        assert!(!salida_de_done_sin_hooks(Some(Done), true, "\r"));
        for prev in [None, Some(Idle), Some(Working), Some(Waiting), Some(Exited), Some(Sleeping)] {
            assert!(!salida_de_done_sin_hooks(prev, false, "\r"), "{prev:?}");
        }
    }

    #[test]
    fn codex_stop_escribir_stop_vuelve_a_pasar_por_idle_y_done() {
        let mut estado = Some(Idle);
        let mut visto = Vec::new();
        let mut mover = |e: EntradaAgente, estado: &mut Option<EstadoAgente>| {
            if let Some(n) = siguiente_estado(*estado, e) {
                *estado = Some(n);
                visto.push(n);
            }
        };
        mover(EntradaAgente::Hook(Done), &mut estado);
        if salida_de_done_sin_hooks(estado, false, "otra cosa\r") {
            mover(EntradaAgente::Hook(Idle), &mut estado);
        }
        mover(EntradaAgente::Hook(Done), &mut estado);
        assert_eq!(visto, [Done, Idle, Done]);
    }
}
