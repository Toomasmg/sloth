//! Corre una función sobre cada elemento con hasta `n` a la vez, en el orden de la lista. Equivale a
//! src/main/features/tickets/concurrencia.ts.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// Devuelve el primer error; las demás tareas siguen hasta vaciar la cola (como las promesas de Node, que no se cancelan).
pub fn de_a<T: Sync, E: Send>(xs: &[T], n: usize, f: &(dyn Fn(&T) -> Result<(), E> + Sync)) -> Result<(), E> {
    let siguiente = AtomicUsize::new(0);
    let primero: Mutex<Option<E>> = Mutex::new(None);
    let hilos = n.max(1).min(xs.len());
    std::thread::scope(|s| {
        for _ in 0..hilos {
            s.spawn(|| loop {
                let i = siguiente.fetch_add(1, Ordering::SeqCst);
                let Some(x) = xs.get(i) else { return };
                if let Err(e) = f(x) {
                    let mut p = primero.lock().unwrap_or_else(|e| e.into_inner());
                    if p.is_none() {
                        *p = Some(e);
                    }
                }
            });
        }
    });
    match primero.into_inner().unwrap_or_else(|e| e.into_inner()) {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::time::{Duration, Instant};

    #[test]
    fn no_pasa_de_n_a_la_vez_y_corre_todos() {
        let en_curso = AtomicUsize::new(0);
        let maximo = AtomicUsize::new(0);
        let llegaron = AtomicUsize::new(0);
        let simultaneos = AtomicBool::new(false);
        let hechos = Mutex::new(Vec::new());
        let r: Result<(), ()> = de_a(&[1, 2, 3, 4, 5, 6, 7], 3, &|x| {
            let ahora = en_curso.fetch_add(1, Ordering::SeqCst) + 1;
            maximo.fetch_max(ahora, Ordering::SeqCst);
            // Los tres primeros esperan a verse entre sí: sin depender de cuánto tarda cada uno.
            if llegaron.fetch_add(1, Ordering::SeqCst) < 3 {
                let limite = Instant::now() + Duration::from_secs(20);
                while llegaron.load(Ordering::SeqCst) < 3 && Instant::now() < limite {
                    std::thread::yield_now();
                }
                if llegaron.load(Ordering::SeqCst) >= 3 {
                    simultaneos.store(true, Ordering::SeqCst);
                }
            }
            hechos.lock().unwrap().push(*x);
            en_curso.fetch_sub(1, Ordering::SeqCst);
            Ok(())
        });
        assert!(r.is_ok());
        assert!(simultaneos.load(Ordering::SeqCst));
        assert!(maximo.load(Ordering::SeqCst) <= 3);
        let mut h = hechos.into_inner().unwrap();
        h.sort();
        assert_eq!(h, vec![1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn con_lista_vacia_o_n_menor_a_1_no_se_cuelga() {
        let r: Result<(), ()> = de_a::<u8, ()>(&[], 3, &|_| panic!("no debería correr"));
        assert!(r.is_ok());
        let hechos = Mutex::new(Vec::new());
        let r: Result<(), ()> = de_a(&["a", "b"], 0, &|x| {
            hechos.lock().unwrap().push(x.to_string());
            Ok(())
        });
        assert!(r.is_ok());
        assert_eq!(hechos.into_inner().unwrap(), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn rechaza_si_una_tarea_falla() {
        let r = de_a(&[1, 2], 2, &|x| if *x == 2 { Err("mal") } else { Ok(()) });
        assert_eq!(r, Err("mal"));
    }
}
