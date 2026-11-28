//! Los canales de «permissions» (`feat:permissions:*`), como src/main/features/permissions.ts. El estado y los pedidos
//! los lleva el núcleo (`nucleo/permisos.rs`), que es el dueño de las terminales.
use super::arg;
use crate::nucleo::Nucleo;
use crate::router::Router;
use serde_json::Value;
use std::sync::Arc;

pub use crate::nucleo::permisos::NOMBRE;

pub fn registrar(router: &mut Router, nucleo: &Arc<Nucleo>) {
    macro_rules! canal {
        ($op:literal, |$n:ident, $a:ident| $cuerpo:expr) => {{
            let $n = nucleo.clone();
            router.registrar(concat!("feat:permissions:", $op), move |$a: Vec<Value>| {
                let $n: &Nucleo = &$n;
                let _ = &$a;
                $cuerpo
            });
        }};
    }
    canal!("list", |n, a| Ok(n.permisos.lista(n)));
    canal!("decide", |n, a| n.permisos.decidir_desde_ui(n, arg(&a, 0)).map(|_| Value::Null));
    canal!("rule:set", |n, a| n.permisos.fijar_regla(n, arg(&a, 0), arg(&a, 1)).map(|_| Value::Null));
    canal!("rule:remove", |n, a| n.permisos.quitar_regla(n, arg(&a, 0)).map(|_| Value::Null));
    canal!("addRules", |n, a| n.permisos.agregar_reglas(n, arg(&a, 0)));
    canal!("undo", |n, a| n.permisos.deshacer(n, arg(&a, 0)).map(|_| Value::Null));
    canal!("focus", |n, a| {
        n.permisos.enfocar(n, arg(&a, 0));
        Ok(Value::Null)
    });
}
