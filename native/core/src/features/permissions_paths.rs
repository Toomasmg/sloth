//! `dentro_del_repo` con el disco a la vista: además de la ruta escrita, la ruta real tiene que caer dentro del repo
//! real, sin pasar por un enlace o junction (un symlink colgante que apunta a Inicio se aprobaba como «notas.md»).
//! Equivale a src/main/features/permissions-paths.ts. El disco y la API de rutas entran por traits.
use super::permissions::dentro_del_repo;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorFs {
    /// ENOENT o ENOTDIR.
    NoExiste,
    Otro,
}

pub trait DiscoFs {
    fn real(&self, p: &str) -> Result<String, ErrorFs>;
    /// true si es un enlace simbólico o junction.
    fn lstat_es_enlace(&self, p: &str) -> Result<bool, ErrorFs>;
}

pub trait ApiRutas {
    fn resolver(&self, partes: &[&str]) -> String;
    fn dirname(&self, p: &str) -> String;
    fn basename(&self, p: &str) -> String;
    fn unir(&self, partes: &[&str]) -> String;
}

/// `path.win32` para rutas con letra de unidad, que es lo que usa Sloth en Windows.
pub struct Win32;

impl Win32 {
    fn normalizar(p: &str) -> String {
        let s = p.replace('/', "\\");
        let (raiz, resto) = match s.as_bytes() {
            [l, b':', b'\\', ..] if l.is_ascii_alphabetic() => (format!("{}:\\", &s[..1]), &s[3..]),
            _ => (String::new(), s.as_str()),
        };
        let mut out: Vec<&str> = vec![];
        for seg in resto.split('\\') {
            match seg {
                "" | "." => {}
                ".." => {
                    if out.last().is_some_and(|x| *x != "..") {
                        out.pop();
                    } else if raiz.is_empty() {
                        out.push("..");
                    }
                }
                s => out.push(s),
            }
        }
        format!("{raiz}{}", out.join("\\"))
    }
}

impl ApiRutas for Win32 {
    fn resolver(&self, partes: &[&str]) -> String {
        let mut acumulado = String::new();
        for p in partes.iter().rev() {
            acumulado = if acumulado.is_empty() { p.to_string() } else { format!("{p}\\{acumulado}") };
            if matches!(acumulado.as_bytes(), [l, b':', b'\\' | b'/', ..] if l.is_ascii_alphabetic()) {
                return Self::normalizar(&acumulado);
            }
        }
        Self::normalizar(&format!("C:\\{acumulado}"))
    }

    fn dirname(&self, p: &str) -> String {
        let n = Self::normalizar(p);
        if n.len() <= 3 {
            return n;
        }
        match n.rfind('\\') {
            Some(i) if i >= 3 => n[..i].to_string(),
            Some(_) => n[..3].to_string(),
            None => ".".into(),
        }
    }

    fn basename(&self, p: &str) -> String {
        Self::normalizar(p).rsplit('\\').next().unwrap_or("").to_string()
    }

    fn unir(&self, partes: &[&str]) -> String {
        Self::normalizar(&partes.iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join("\\"))
    }
}

/// Ruta real de `target` dentro del repo cuya ruta real es `real_cwd`, aunque todavía no exista (un Write de un archivo
/// nuevo): el resto se suma al realpath del ancestro más cercano que existe. None si algún componente entre el repo y
/// el archivo es un enlace o un junction (aunque esté colgante) o si nunca se llega al repo.
pub fn ruta_real_dentro(target: &str, real_cwd: &str, fs: &dyn DiscoFs, p: &dyn ApiRutas) -> Option<String> {
    let mut cur = p.resolver(&[target]);
    let mut cola: Vec<String> = vec![];
    let mut encontrada: Option<String> = None;
    loop {
        let enlace = match fs.lstat_es_enlace(&cur) {
            Ok(e) => Some(e),
            Err(ErrorFs::NoExiste) => None,
            Err(ErrorFs::Otro) => return None,
        };
        if let Some(es_enlace) = enlace {
            // lstat la vio y realpath no llega: enlace colgante o algo ilegible. No se aprueba.
            let r = fs.real(&cur).ok()?;
            let con_cola = |r: &str| {
                let mut partes: Vec<&str> = vec![r];
                partes.extend(cola.iter().map(String::as_str));
                p.unir(&partes)
            };
            // El repo mismo puede estar abierto a través de un junction; uno adentro del repo, no.
            if r == real_cwd {
                return Some(encontrada.unwrap_or_else(|| con_cola(&r)));
            }
            if es_enlace {
                return None;
            }
            encontrada = encontrada.or_else(|| Some(con_cola(&r)));
        }
        let padre = p.dirname(&cur);
        if padre == cur {
            return None;
        }
        if enlace.is_none() {
            cola.insert(0, p.basename(&cur));
        }
        cur = padre;
    }
}

pub fn dentro_del_repo_real(archivo: &str, cwd: &str, fs: &dyn DiscoFs, p: &dyn ApiRutas) -> bool {
    if !dentro_del_repo(archivo, cwd) {
        return false;
    }
    let Ok(real_cwd) = fs.real(&p.resolver(&[cwd])) else { return false };
    ruta_real_dentro(&p.resolver(&[cwd, archivo]), &real_cwd, fs, p).is_some_and(|f| dentro_del_repo(&f, &real_cwd))
}

/// El disco de verdad, como `realpathSync.native` y `lstatSync` de Node.
pub struct DiscoReal;

fn error_fs(e: std::io::Error) -> ErrorFs {
    match e.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => ErrorFs::NoExiste,
        _ => ErrorFs::Otro,
    }
}

/// `canonicalize` de Windows devuelve `\\?\C:\...` (o `\\?\UNC\servidor\...`); realpath de Node, sin el prefijo.
fn sin_prefijo_largo(p: &str) -> String {
    if let Some(unc) = p.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    p.strip_prefix(r"\\?\").unwrap_or(p).to_string()
}

impl DiscoFs for DiscoReal {
    fn real(&self, p: &str) -> Result<String, ErrorFs> {
        std::fs::canonicalize(p).map(|r| sin_prefijo_largo(&r.to_string_lossy())).map_err(error_fs)
    }

    /// En Windows `is_symlink` también es true para los junctions, como `isSymbolicLink()` de Node.
    fn lstat_es_enlace(&self, p: &str) -> Result<bool, ErrorFs> {
        std::fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).map_err(error_fs)
    }
}

/// `dentro_del_repo_real` contra el disco de verdad.
pub fn dentro_del_repo_en_disco(archivo: &str, cwd: &str) -> bool {
    dentro_del_repo_real(archivo, cwd, &DiscoReal, &Win32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn el_prefijo_largo_de_windows_se_saca_como_en_node() {
        assert_eq!(sin_prefijo_largo(r"\\?\C:\Users\ana"), r"C:\Users\ana");
        assert_eq!(sin_prefijo_largo(r"\\?\UNC\srv\carpeta\x"), r"\\srv\carpeta\x");
        assert_eq!(sin_prefijo_largo(r"C:\ya\corta"), r"C:\ya\corta");
    }

    #[cfg(windows)]
    #[test]
    fn en_disco_un_archivo_nuevo_del_repo_vale_y_uno_de_afuera_no() {
        let base = std::env::temp_dir().join(format!("sloth-permisos-disco-{}", std::process::id()));
        let repo = base.join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        let cwd = repo.to_string_lossy().to_string();
        assert!(dentro_del_repo_en_disco(r"src\nuevo.ts", &cwd), "todavía no existe, pero cae en el repo");
        assert!(dentro_del_repo_en_disco(&repo.join("src").join("a.ts").to_string_lossy(), &cwd));
        assert!(!dentro_del_repo_en_disco(&base.join("otro.ts").to_string_lossy(), &cwd));
        assert!(!dentro_del_repo_en_disco(r"C:\Windows\x.ts", &cwd));
        assert_eq!(DiscoReal.real(&base.join("no-existe").to_string_lossy()), Err(ErrorFs::NoExiste));
        let _ = std::fs::remove_dir_all(&base);
    }

    const REPO: &str = "C:\\Users\\ana\\repo";

    /// Disco falso: existen estas rutas (comparadas en minúsculas, como Windows; `real` devuelve la forma canónica) y
    /// `links` son enlaces o junctions; con destino None, colgantes.
    struct Falso {
        existen: HashMap<String, String>,
        links: Vec<(String, Option<String>)>,
        error: Option<ErrorFs>,
    }

    fn falso(existen: &[&str], links: &[(&str, Option<&str>)]) -> Falso {
        Falso {
            existen: existen.iter().map(|e| (e.to_lowercase(), e.to_string())).collect(),
            links: links.iter().map(|(a, b)| (a.to_string(), b.map(str::to_string))).collect(),
            error: None,
        }
    }

    impl Falso {
        fn enlace_de(&self, p: &str) -> Option<&(String, Option<String>)> {
            let k = p.to_lowercase();
            self.links.iter().find(|(from, _)| k == from.to_lowercase() || k.starts_with(&format!("{}\\", from.to_lowercase())))
        }
    }

    impl DiscoFs for Falso {
        fn real(&self, p: &str) -> Result<String, ErrorFs> {
            match self.enlace_de(p) {
                None => self.existen.get(&p.to_lowercase()).cloned().ok_or(ErrorFs::NoExiste),
                Some((from, to)) => match to {
                    None => Err(ErrorFs::NoExiste),
                    Some(t) => self.real(&format!("{t}{}", &p[from.len()..])),
                },
            }
        }

        fn lstat_es_enlace(&self, p: &str) -> Result<bool, ErrorFs> {
            if let Some(e) = self.error {
                return Err(e);
            }
            if self.enlace_de(p).is_some_and(|(from, _)| from.to_lowercase() == p.to_lowercase()) {
                return Ok(true);
            }
            self.real(p).map(|_| false)
        }
    }

    fn base() -> Vec<String> {
        ["C:\\", "C:\\Users", "C:\\Users\\ana", REPO].iter().map(|s| s.to_string()).chain([format!("{REPO}\\src"), format!("{REPO}\\.git"), format!("{REPO}\\.git\\hooks")]).collect()
    }

    fn con(extra: &[&str], links: &[(&str, Option<&str>)]) -> Falso {
        let b = base();
        let mut todo: Vec<&str> = b.iter().map(String::as_str).collect();
        todo.extend(extra);
        falso(&todo, links)
    }

    fn dentro(f: &str, fs: &Falso) -> bool {
        dentro_del_repo_real(f, REPO, fs, &Win32)
    }

    #[test]
    fn adentro_del_repo_si_aunque_sea_nuevo_relativo_o_cambien_las_mayusculas() {
        let d = con(&[], &[]);
        assert!(dentro(&format!("{REPO}\\README.md"), &d));
        assert!(dentro("c:\\users\\ANA\\Repo\\src\\nuevo\\a.ts", &d));
        assert!(dentro(&format!("{REPO}\\src\\..\\b.ts"), &d));
        assert!(dentro("src\\x.ts", &d));
    }

    #[test]
    fn afuera_del_repo_no() {
        let d = con(&[], &[]);
        for f in [format!("{REPO}\\..\\otro\\x.ts"), "C:\\Users\\ana\\.claude\\settings.json".into(), "D:\\repo\\x.ts".into(), REPO.into(), "C:\\Users\\ana\\repo-malo\\x.ts".into()] {
            assert!(!dentro(&f, &d), "{f}");
        }
    }

    #[test]
    fn un_junction_que_apunta_afuera_a_git_o_a_otra_carpeta_del_repo_no_cuenta() {
        let d = con(
            &["C:\\Windows"],
            &[(&format!("{REPO}\\afuera"), Some("C:\\Windows")), (&format!("{REPO}\\ganchos"), Some(&format!("{REPO}\\.git\\hooks"))), (&format!("{REPO}\\atajo"), Some(&format!("{REPO}\\src")))],
        );
        assert!(!dentro(&format!("{REPO}\\afuera\\x.dll"), &d));
        assert!(!dentro(&format!("{REPO}\\ganchos\\pre-commit"), &d));
        assert!(!dentro(&format!("{REPO}\\atajo\\x.ts"), &d));
    }

    #[test]
    fn un_enlace_colgante_no_aprueba_ni_como_archivo_ni_como_carpeta() {
        let d = con(&[], &[(&format!("{REPO}\\notas.md"), None), (&format!("{REPO}\\src\\gen"), None)]);
        assert!(dentro_del_repo(&format!("{REPO}\\notas.md"), REPO));
        assert!(!dentro(&format!("{REPO}\\notas.md"), &d));
        assert!(!dentro(&format!("{REPO}\\src\\gen\\nuevo\\a.ts"), &d));
        assert!(dentro(&format!("{REPO}\\src\\otro.md"), &d));
    }

    #[test]
    fn el_repo_abierto_a_traves_de_un_junction_si_vale() {
        let d = falso(&["C:\\", "C:\\D", "C:\\D\\repo", "C:\\D\\repo\\src", "C:\\Users", "C:\\Users\\ana"], &[(REPO, Some("C:\\D\\repo"))]);
        assert!(dentro(&format!("{REPO}\\src\\a.ts"), &d));
    }

    #[test]
    fn un_error_que_no_es_no_existe_no_aprueba() {
        let mut d = con(&[], &[]);
        d.error = Some(ErrorFs::Otro);
        assert_eq!(ruta_real_dentro(&format!("{REPO}\\x"), REPO, &d, &Win32), None);
        assert!(!dentro(&format!("{REPO}\\x"), &d));
    }

    #[test]
    fn la_regla_de_ediciones_usa_la_comprobacion_con_disco() {
        use crate::features::permissions::*;
        let pedido = |f: &str| {
            let mut input = Entrada::new();
            input.insert("file_path".into(), f.into());
            Pedido { id: "1".into(), ws: "w1".into(), tool: "Write".into(), input, at: 0.0, expires_at: 0.0 }
        };
        let r = regla_desde_pedido(&pedido(&format!("{REPO}\\a.md")), "r", 0.0);
        let d = con(&[], &[(&format!("{REPO}\\notas.md"), None)]);
        let real = |f: &str, c: &str| dentro_del_repo_real(f, c, &d, &Win32);
        assert!(buscar_regla(std::slice::from_ref(&r), &pedido(&format!("{REPO}\\b.md")), Some(REPO), &real).is_some());
        assert!(buscar_regla(std::slice::from_ref(&r), &pedido(&format!("{REPO}\\notas.md")), Some(REPO), &real).is_none());
    }

    #[test]
    fn la_api_win32_resuelve_como_node() {
        let w = Win32;
        assert_eq!(w.resolver(&["C:\\a\\b\\..\\c"]), "C:\\a\\c");
        assert_eq!(w.resolver(&["C:\\a", "x\\y.ts"]), "C:\\a\\x\\y.ts");
        assert_eq!(w.resolver(&["C:\\a", "D:\\z"]), "D:\\z");
        assert_eq!(w.dirname("C:\\a\\b"), "C:\\a");
        assert_eq!(w.dirname("C:\\a"), "C:\\");
        assert_eq!(w.dirname("C:\\"), "C:\\");
        assert_eq!(w.basename("C:\\a\\b.ts"), "b.ts");
        assert_eq!(w.unir(&["C:\\a", "b", "c"]), "C:\\a\\b\\c");
        assert_eq!(w.unir(&["C:\\a"]), "C:\\a");
    }
}
