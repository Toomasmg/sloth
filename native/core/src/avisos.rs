//! Avisos a la persona sobre archivos dañados o en solo lectura. Equivale a src/main/avisos.ts: cada aviso se muestra
//! una sola vez (los repetidos se descartan) y la UI los retira con `tomar`.
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

type Oyente = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
pub struct Avisos {
    pendientes: Mutex<Vec<String>>,
    oyentes: Mutex<Vec<Oyente>>,
}

fn nombre(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string_lossy().into_owned())
}

impl Avisos {
    pub fn nuevo() -> Self {
        Self::default()
    }

    /// Los avisos de toda la app. Los tests usan instancias propias para no pisarse entre hilos.
    pub fn global() -> &'static Avisos {
        static G: OnceLock<Avisos> = OnceLock::new();
        G.get_or_init(Avisos::default)
    }

    pub fn avisar(&self, texto: String) {
        {
            let mut p = self.pendientes.lock().unwrap_or_else(|e| e.into_inner());
            if p.contains(&texto) {
                return;
            }
            p.push(texto);
        }
        let oyentes: Vec<Oyente> = self.oyentes.lock().unwrap_or_else(|e| e.into_inner()).clone();
        for f in oyentes {
            f();
        }
    }

    pub fn archivo_apartado(&self, original: &Path, apartado: &Path) {
        self.avisar(format!(
            "Encontré un archivo de configuración dañado ({}); lo guardé como {} y seguí con valores por defecto.",
            nombre(original),
            nombre(apartado)
        ));
    }

    pub fn solo_lectura(&self, archivo: &Path, motivo: &str) {
        self.avisar(format!(
            "{} {motivo}. Sigo con valores por defecto y no voy a guardar cambios en ese archivo hasta que reinicies Sloth (el archivo queda como está, en {}).",
            nombre(archivo),
            archivo.display()
        ));
    }

    pub fn version_futura(&self, archivo: &Path) {
        self.avisar(format!(
            "{} lo guardó una versión más nueva de Sloth: lo abrí en solo lectura y no lo voy a reescribir. Actualizá Sloth para poder guardar cambios.",
            nombre(archivo)
        ));
    }

    /// Devuelve los avisos pendientes y los olvida: cada uno se muestra una sola vez.
    pub fn tomar(&self) -> Vec<String> {
        std::mem::take(&mut *self.pendientes.lock().unwrap_or_else(|e| e.into_inner()))
    }

    pub fn al_avisar(&self, f: impl Fn() + Send + Sync + 'static) {
        self.oyentes.lock().unwrap_or_else(|e| e.into_inner()).push(Arc::new(f));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn un_aviso_repetido_se_muestra_una_vez() {
        let a = Avisos::nuevo();
        a.avisar("x".into());
        a.avisar("x".into());
        a.avisar("y".into());
        assert_eq!(a.tomar(), vec!["x", "y"]);
        assert!(a.tomar().is_empty());
        a.avisar("x".into());
        assert_eq!(a.tomar(), vec!["x"]);
    }

    #[test]
    fn avisa_a_los_oyentes_solo_con_avisos_nuevos() {
        let a = Avisos::nuevo();
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = n.clone();
        a.al_avisar(move || {
            n2.fetch_add(1, Ordering::SeqCst);
        });
        a.avisar("x".into());
        a.avisar("x".into());
        assert_eq!(n.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn los_textos_coinciden_con_los_del_main() {
        let a = Avisos::nuevo();
        a.archivo_apartado(Path::new("C:/d/settings.json"), Path::new("C:/d/settings.json.corrupt-1"));
        a.version_futura(Path::new("C:/d/git.json"));
        let t = a.tomar();
        assert_eq!(t[0], "Encontré un archivo de configuración dañado (settings.json); lo guardé como settings.json.corrupt-1 y seguí con valores por defecto.");
        assert!(t[1].starts_with("git.json lo guardó una versión más nueva de Sloth"));
    }
}
