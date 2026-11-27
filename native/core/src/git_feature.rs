//! La función «git» sin Electron: valida lo que llega de la UI y arma las respuestas. Equivale a src/main/features/git.ts.
//! Lo que toca la app (espacios, avisos a la UI, abrir el navegador) entra por `ContextoGit`; todo lo demás es de git_ops.
use crate::avisos::Avisos;
use crate::git_ops::*;
use crate::git_run::{is_dir, norm_path, rama_segura, Ejecutor, Git, GitError};
use crate::persistencia::{escribir_json_atomico, es_objeto, leer_json, OpcionesLectura};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

type R<T> = Result<T, GitError>;

pub trait ContextoGit: Send + Sync {
    /// La carpeta de trabajo de un espacio, si el espacio existe.
    fn cwd_de_espacio(&self, id: &str) -> Option<String>;
    /// Avisa a la UI que el repo de ese espacio pudo cambiar (evento `changed`).
    fn avisar_cambio(&self, id: &str);
    /// Anota en la actividad que se abrió un PR (`#N`).
    fn registrar_pr(&self, numero: &str);
    fn abrir_externo(&self, url: &str) -> Result<(), String>;
    fn registrar_error(&self, mensaje: &str);
}

fn err<T>(m: &str) -> R<T> {
    Err(GitError::nuevo(m))
}

/// `text()` del original: cadena no vacía de hasta `max` unidades.
fn texto<'a>(v: &'a Value, max: usize, what: &str) -> R<&'a str> {
    match v.as_str() {
        Some(s) if !s.is_empty() && s.encode_utf16().count() <= max => Ok(s),
        _ => Err(GitError::nuevo(format!("{what} inválido."))),
    }
}

fn nombre_de(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// Libera el espacio ocupado al soltarse, pase lo que pase.
struct Ocupado<'a> {
    set: &'a Mutex<HashSet<String>>,
    id: String,
}

impl Drop for Ocupado<'_> {
    fn drop(&mut self) {
        self.set.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.id);
    }
}

pub struct GitFeature<E: Ejecutor, C: ContextoGit> {
    pub git: Git<E>,
    ctx: C,
    archivo: PathBuf,
    /// Base elegida por repo (clave: ruta normalizada del top).
    bases: Mutex<BTreeMap<String, String>>,
    ocupados: Mutex<HashSet<String>>,
}

impl<E: Ejecutor, C: ContextoGit> GitFeature<E, C> {
    /// `archivo` es `git.json` dentro de la carpeta de features del perfil.
    pub fn new(git: Git<E>, ctx: C, archivo: PathBuf) -> Self {
        let validar = |v: &Value| es_objeto(v).then(|| v.clone());
        let defecto = || Value::Object(Map::new());
        let leido = leer_json(&archivo, &OpcionesLectura::nuevas(&validar, &defecto), Avisos::global());
        let bases = leido
            .valor
            .get("bases")
            .and_then(Value::as_object)
            .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
            .unwrap_or_default();
        GitFeature { git, ctx, archivo, bases: Mutex::new(bases), ocupados: Mutex::new(HashSet::new()) }
    }

    fn persistir(&self) {
        let bases = self.bases.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Err(e) = escribir_json_atomico(&self.archivo, &json!({ "bases": bases })) {
            self.ctx.registrar_error(&format!("no se pudo guardar git.json: {e}"));
        }
    }

    /// Claude terminó un turno (hook Stop): puede haber cambiado archivos.
    pub fn al_hook(&self, evento: &str, ws: Option<&str>) {
        if let ("Stop", Some(ws)) = (evento, ws) {
            self.ctx.avisar_cambio(ws);
        }
    }

    fn cwd_de(&self, ws_id: &Value) -> R<String> {
        let id = match ws_id.as_str() {
            Some(s) if s.encode_utf16().count() <= 100 => s,
            _ => return err("Espacio inválido."),
        };
        let Some(cwd) = self.ctx.cwd_de_espacio(id) else { return err("El espacio ya no existe.") };
        if !is_dir(&cwd) {
            return Err(GitError::nuevo(format!("No existe la carpeta {cwd}.")));
        }
        Ok(cwd)
    }

    fn exclusivo(&self, ws_id: &str) -> R<Ocupado<'_>> {
        let mut o = self.ocupados.lock().unwrap_or_else(|e| e.into_inner());
        if !o.insert(ws_id.to_string()) {
            return err("Ya hay una operación de git en curso en este espacio.");
        }
        Ok(Ocupado { set: &self.ocupados, id: ws_id.to_string() })
    }

    fn base_for(&self, cwd: &str, top: &str) -> R<Option<String>> {
        if let Some(b) = self.bases.lock().unwrap_or_else(|e| e.into_inner()).get(&norm_path(top)) {
            if !b.is_empty() {
                return Ok(Some(b.clone()));
            }
        }
        default_base(&self.git, cwd)
    }

    /// Un archivo del status: nunca se opera sobre rutas arbitrarias.
    fn file_of(&self, cwd: &str, path: &Value) -> R<(String, FileChange, bool)> {
        let p = texto(path, 1024, "Archivo")?;
        let st = status(&self.git, cwd)?;
        let file = st.files.iter().find(|f| f.path == p).cloned();
        let (Some(file), Some(top)) = (file, st.top) else { return err("Ese archivo ya no tiene cambios.") };
        let info = repo_info(&self.git, cwd)?;
        Ok((top, file, info.has_head == Some(true)))
    }

    fn top_of(&self, cwd: &str) -> R<String> {
        let info = repo_info(&self.git, cwd)?;
        match info.top {
            Some(t) if info.is_repo => Ok(t),
            _ => err("No es un repositorio git."),
        }
    }

    /// Operación que cambia el repo: se serializa por espacio y, si sale bien, avisa a la UI.
    fn mutando<T>(&self, ws_id: &Value, f: impl FnOnce(&str) -> R<T>) -> R<T> {
        let cwd = self.cwd_de(ws_id)?;
        let id = ws_id.as_str().unwrap_or_default();
        let out = {
            let _g = self.exclusivo(id)?;
            f(&cwd)?
        };
        self.ctx.avisar_cambio(id);
        Ok(out)
    }

    pub fn count(&self, ws_id: &Value) -> R<Option<usize>> {
        let Ok(cwd) = self.cwd_de(ws_id) else { return Ok(None) };
        change_count(&self.git, &cwd)
    }

    pub fn status(&self, ws_id: &Value) -> R<Value> {
        let cwd = self.cwd_de(ws_id)?;
        let st = status(&self.git, &cwd)?;
        let mut v = serde_json::to_value(&st).map_err(|e| GitError::nuevo(e.to_string()))?;
        let o = v.as_object_mut().ok_or_else(|| GitError::nuevo("Estado inválido."))?;
        if !st.is_repo {
            o.insert("base".into(), Value::Null);
            o.insert("protected".into(), Value::Bool(false));
            return Ok(v);
        }
        let base = self.base_for(&cwd, st.top.as_deref().unwrap_or(&cwd))?;
        o.insert("base".into(), json!(base));
        o.insert("protected".into(), Value::Bool(is_protected(st.branch.as_deref())));
        Ok(v)
    }

    pub fn diff(&self, ws_id: &Value, path: &Value, limit: &Value) -> R<DiffResult> {
        let cwd = self.cwd_de(ws_id)?;
        let (top, file, has_head) = self.file_of(&cwd, path)?;
        let lim = match limit.as_f64() {
            Some(n) if n.is_finite() => n.floor().clamp(100.0, 20_000.0) as usize,
            _ => 2000,
        };
        diff_file(&self.git, &top, &file, has_head, lim)
    }

    pub fn set_base(&self, ws_id: &Value, base: &Value) -> R<Value> {
        let cwd = self.cwd_de(ws_id)?;
        let Some(base) = base.as_str().filter(|b| rama_segura(b)) else { return err("Nombre de base inválido.") };
        let info = repo_info(&self.git, &cwd)?;
        let Some(top) = info.top else { return err("No es un repositorio git.") };
        self.bases.lock().unwrap_or_else(|e| e.into_inner()).insert(norm_path(&top), base.to_string());
        self.persistir();
        let exists = has_ref(&self.git, &cwd, &format!("refs/remotes/origin/{base}"))? || has_ref(&self.git, &cwd, &format!("refs/heads/{base}"))?;
        Ok(json!({ "base": base, "exists": exists }))
    }

    pub fn stage(&self, ws_id: &Value, path: &Value) -> R<bool> {
        self.mutando(ws_id, |cwd| {
            let (top, file, _) = self.file_of(cwd, path)?;
            stage_file(&self.git, &top, &file).map(|_| true)
        })
    }

    pub fn unstage(&self, ws_id: &Value, path: &Value) -> R<bool> {
        self.mutando(ws_id, |cwd| {
            let (top, file, _) = self.file_of(cwd, path)?;
            unstage_file(&self.git, &top, &file).map(|_| true)
        })
    }

    pub fn stage_all(&self, ws_id: &Value) -> R<bool> {
        self.mutando(ws_id, |cwd| stage_all(&self.git, &self.top_of(cwd)?).map(|_| true))
    }

    pub fn unstage_all(&self, ws_id: &Value) -> R<bool> {
        self.mutando(ws_id, |cwd| unstage_all(&self.git, &self.top_of(cwd)?).map(|_| true))
    }

    /// Descarta los cambios de un archivo. Los no trackeados piden el nombre exacto (confirmación reforzada).
    pub fn discard(&self, ws_id: &Value, path: &Value, confirm_name: &Value) -> R<bool> {
        self.mutando(ws_id, |cwd| {
            let (top, file, has_head) = self.file_of(cwd, path)?;
            if file.code == FileCode::Untracked && confirm_name.as_str() != Some(nombre_de(&file.path)) {
                return err("Escribí el nombre del archivo para confirmar.");
            }
            discard_file(&self.git, &top, &file, has_head).map(|_| true)
        })
    }

    pub fn commit(&self, ws_id: &Value, message: &Value) -> R<String> {
        self.mutando(ws_id, |cwd| {
            let Some(m) = message.as_str().filter(|m| !m.trim().is_empty()) else { return err("El mensaje del commit es obligatorio.") };
            if m.encode_utf16().count() > 10_000 {
                return err("Mensaje demasiado largo.");
            }
            commit_staged(&self.git, cwd, m.trim())
        })
    }

    pub fn create_branch(&self, ws_id: &Value, name: &Value, base: &Value) -> R<String> {
        self.mutando(ws_id, |cwd| {
            let Some(n) = name.as_str() else { return err("Nombre de rama inválido.") };
            let n = n.trim();
            create_branch(&self.git, cwd, n, base.as_str())?;
            Ok(n.to_string())
        })
    }

    pub fn log(&self, ws_id: &Value) -> R<Vec<LogEntry>> {
        let cwd = self.cwd_de(ws_id)?;
        if !repo_info(&self.git, &cwd)?.is_repo {
            return Ok(vec![]);
        }
        log_branch(&self.git, &cwd, 300)
    }

    pub fn commit_files(&self, ws_id: &Value, sha: &Value) -> R<Vec<CommitFile>> {
        let cwd = self.cwd_de(ws_id)?;
        commit_files(&self.git, &cwd, texto(sha, 60, "Commit")?)
    }

    pub fn sync(&self, ws_id: &Value) -> R<Value> {
        let cwd = self.cwd_de(ws_id)?;
        let info = repo_info(&self.git, &cwd)?;
        if !info.is_repo {
            return Ok(Value::Null);
        }
        let s = sync_info(&self.git, &cwd)?;
        Ok(json!({ "branch": info.branch, "upstream": s.upstream, "ahead": s.ahead, "behind": s.behind }))
    }

    /// Subir: git push -u origin <rama actual>. Sin --force nunca.
    pub fn push(&self, ws_id: &Value, branch: &Value) -> R<String> {
        self.mutando(ws_id, |cwd| {
            let Some(b) = branch.as_str() else { return err("Rama inválida.") };
            push(&self.git, cwd, b)
        })
    }

    /// Traer: solo avance limpio (--ff-only).
    pub fn pull(&self, ws_id: &Value) -> R<String> {
        self.mutando(ws_id, |cwd| pull_ff(&self.git, cwd))
    }

    pub fn branches(&self, ws_id: &Value) -> R<Value> {
        let cwd = self.cwd_de(ws_id)?;
        if !repo_info(&self.git, &cwd)?.is_repo {
            return Ok(json!({ "local": [], "remote": [] }));
        }
        let local = local_branches(&self.git, &cwd)?;
        let remote = remote_branches(&self.git, &cwd, &local)?;
        Ok(json!({ "local": local, "remote": remote }))
    }

    pub fn switch(&self, ws_id: &Value, name: &Value, remote: &Value) -> R<bool> {
        self.mutando(ws_id, |cwd| switch_branch(&self.git, cwd, texto(name, 200, "Rama")?, remote.as_bool() == Some(true)).map(|_| true))
    }

    pub fn stash_info(&self, ws_id: &Value) -> R<Option<Value>> {
        let top = self.top_of(&self.cwd_de(ws_id)?)?;
        Ok(find_stash(&self.git, &top)?.map(|s| json!({ "branch": s.branch, "files": s.files })))
    }

    pub fn stash_push(&self, ws_id: &Value) -> R<bool> {
        self.mutando(ws_id, |cwd| stash_push(&self.git, cwd).map(|_| true))
    }

    pub fn stash_restore(&self, ws_id: &Value) -> R<bool> {
        self.mutando(ws_id, |cwd| stash_restore(&self.git, cwd).map(|_| true))
    }

    pub fn gh(&self) -> GhStatus {
        gh_status(&self.git)
    }

    /// Datos para armar el PR: rama, base, si está pusheada, commits, plantilla y PR existente.
    pub fn pr_prepare(&self, ws_id: &Value, base_arg: &Value) -> R<Value> {
        let cwd = self.cwd_de(ws_id)?;
        let info = repo_info(&self.git, &cwd)?;
        let Some(top) = info.top.clone().filter(|_| info.is_repo) else { return err("No es un repositorio git.") };
        let branch = info.branch.clone();
        let (pr_res, resto) = std::thread::scope(|s| {
            // gh va en paralelo porque es lo lento (red); un fallo suyo no tumba lo de git.
            let pr = s.spawn(|| match branch.as_deref().filter(|b| !is_protected(Some(b))) {
                Some(b) => match pr_view(&self.git, &cwd, b) {
                    Ok(pr) => (pr, None),
                    Err(e) => (None, Some(e.mensaje)),
                },
                None => (None, None),
            });
            let resto = (|| -> R<_> {
                let base = match base_arg.as_str().filter(|b| crate::git_run::valid_branch_name(b)) {
                    Some(b) => Some(b.to_string()),
                    None => self.base_for(&cwd, &top)?,
                };
                Ok((base, upstream(&self.git, &cwd)?, commits_to_push(&self.git, &cwd)?))
            })();
            (pr.join().unwrap_or((None, Some("gh se cortó de golpe.".to_string()))), resto)
        });
        let (base, up, unpushed) = resto?;
        let commits = match &base {
            Some(b) => commits_vs_base(&self.git, &cwd, b)?,
            None => vec![],
        };
        let (existing, gh_error) = pr_res;
        let titulo = if commits.len() == 1 {
            commits[0].subject.clone()
        } else {
            commits.last().map(|c| c.subject.clone()).unwrap_or_else(|| branch.clone().unwrap_or_default())
        };
        Ok(json!({
            "branch": branch,
            "base": base,
            "protected": is_protected(branch.as_deref()),
            "pushed": up.is_some() && unpushed.is_empty(),
            "upstream": up,
            "unpushed": unpushed.len(),
            "commits": commits,
            "existing": existing,
            "ghError": gh_error,
            "template": read_template(&top),
            "defaultTitle": titulo,
        }))
    }

    /// Comando exacto que se va a correr (para mostrarlo en la confirmación).
    pub fn pr_command(&self, input: &Value) -> R<Vec<String>> {
        let p = validate_pr(input)?;
        Ok(std::iter::once("gh".to_string()).chain(pr_create_args(&p)).collect())
    }

    pub fn create_pr(&self, ws_id: &Value, input: &Value) -> R<String> {
        let cwd = self.cwd_de(ws_id)?;
        let p = validate_pr(input)?;
        if is_protected(Some(&p.head)) {
            return Err(GitError::nuevo(format!("No se abre un PR desde {}.", p.head)));
        }
        let _g = self.exclusivo(ws_id.as_str().unwrap_or_default())?;
        let url = create_pr(&self.git, &cwd, &p)?;
        if let Some(n) = url.split("/pull/").nth(1).map(|r| r.chars().take_while(char::is_ascii_digit).collect::<String>()).filter(|n| !n.is_empty()) {
            self.ctx.registrar_pr(&format!("#{n}"));
        }
        Ok(url)
    }

    pub fn open_url(&self, url: &Value) -> R<bool> {
        let Some(u) = url.as_str().filter(|u| u.encode_utf16().count() <= 500 && github_pr_url(u)) else {
            return err("Solo se abren links https://github.com/…/pull/N.");
        };
        self.ctx.abrir_externo(u).map_err(GitError::nuevo)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_run::prueba::*;
    use crate::git_run::{ProcesoEjecutor, Resultado};
    use std::collections::HashMap;
    use std::fs;
    use std::sync::Arc;

    #[derive(Default)]
    struct Mock {
        espacios: Mutex<HashMap<String, String>>,
        cambios: Mutex<Vec<String>>,
        prs: Mutex<Vec<String>>,
        abiertos: Mutex<Vec<String>>,
        errores: Mutex<Vec<String>>,
    }

    impl ContextoGit for Arc<Mock> {
        fn cwd_de_espacio(&self, id: &str) -> Option<String> {
            self.espacios.lock().unwrap().get(id).cloned()
        }
        fn avisar_cambio(&self, id: &str) {
            self.cambios.lock().unwrap().push(id.into());
        }
        fn registrar_pr(&self, n: &str) {
            self.prs.lock().unwrap().push(n.into());
        }
        fn abrir_externo(&self, url: &str) -> Result<(), String> {
            self.abiertos.lock().unwrap().push(url.into());
            Ok(())
        }
        fn registrar_error(&self, m: &str) {
            self.errores.lock().unwrap().push(m.into());
        }
    }

    fn con_repo() -> (Temporal, Arc<Mock>, GitFeature<ProcesoEjecutor, Arc<Mock>>, Value) {
        let t = Temporal::nueva("sloth-gitfeat");
        let dir = t.0.join("repo");
        fs::create_dir_all(&dir).unwrap();
        let g = git_real();
        repo_con_commit(&g, &dir.to_string_lossy());
        let m = Arc::new(Mock::default());
        m.espacios.lock().unwrap().insert("ws1".into(), dir.to_string_lossy().into_owned());
        let f = GitFeature::new(g, m.clone(), t.0.join("git.json"));
        (t, m, f, json!("ws1"))
    }

    #[test]
    fn el_espacio_se_valida_antes_de_tocar_git() {
        let t = Temporal::nueva("sloth-gitfeat2");
        let m = Arc::new(Mock::default());
        m.espacios.lock().unwrap().insert("roto".into(), t.0.join("no-existe").to_string_lossy().into_owned());
        let sim = Simulado::con(|_| Ok(Resultado::ok("")));
        let f = GitFeature::new(Git::new(sim), m.clone(), t.0.join("git.json"));
        assert_eq!(f.status(&json!(5)).unwrap_err().mensaje, "Espacio inválido.");
        assert_eq!(f.status(&json!("x".repeat(101))).unwrap_err().mensaje, "Espacio inválido.");
        assert_eq!(f.status(&json!("nadie")).unwrap_err().mensaje, "El espacio ya no existe.");
        assert!(f.status(&json!("roto")).unwrap_err().mensaje.starts_with("No existe la carpeta "));
        assert_eq!(f.count(&json!("roto")).unwrap(), None);
        assert!(f.git.ejecutor.registro().is_empty());
        assert!(m.cambios.lock().unwrap().is_empty());
    }

    #[test]
    fn status_agrega_base_y_protegida_y_set_base_persiste() {
        let (t, m, f, ws) = con_repo();
        let st = f.status(&ws).unwrap();
        assert_eq!(st["isRepo"], true);
        assert_eq!(st["branch"], "main");
        assert_eq!(st["base"], "main");
        assert_eq!(st["protected"], true);
        assert_eq!(st["truncated"], false);
        assert_eq!(f.set_base(&ws, &json!("-x")).unwrap_err().mensaje, "Nombre de base inválido.");
        assert_eq!(f.set_base(&ws, &json!("+x")).unwrap_err().mensaje, "Nombre de base inválido.");
        assert_eq!(f.set_base(&ws, &json!(3)).unwrap_err().mensaje, "Nombre de base inválido.");
        assert_eq!(f.set_base(&ws, &json!("develop")).unwrap(), json!({"base": "develop", "exists": false}));
        assert_eq!(f.status(&ws).unwrap()["base"], "develop");
        let g2 = GitFeature::new(git_real(), m.clone(), t.0.join("git.json"));
        assert_eq!(g2.status(&ws).unwrap()["base"], "develop");
        assert!(m.errores.lock().unwrap().is_empty());
    }

    #[test]
    fn las_operaciones_que_cambian_avisan_y_las_que_fallan_no() {
        let (t, m, f, ws) = con_repo();
        assert_eq!(f.create_branch(&ws, &json!("  feat/x  "), &Value::Null).unwrap(), "feat/x");
        assert_eq!(m.cambios.lock().unwrap().len(), 1);
        fs::write(t.0.join("repo/n.txt"), "n\n").unwrap();
        assert!(f.stage(&ws, &json!("n.txt")).unwrap());
        assert_eq!(f.stage(&ws, &json!("nada.txt")).unwrap_err().mensaje, "Ese archivo ya no tiene cambios.");
        assert_eq!(f.stage(&ws, &json!("")).unwrap_err().mensaje, "Archivo inválido.");
        assert_eq!(m.cambios.lock().unwrap().len(), 2);
        assert_eq!(f.commit(&ws, &json!("   ")).unwrap_err().mensaje, "El mensaje del commit es obligatorio.");
        assert_eq!(f.commit(&ws, &json!("x".repeat(10_001))).unwrap_err().mensaje, "Mensaje demasiado largo.");
        assert!(es_sha(&f.commit(&ws, &json!(" Agrego n ")).unwrap()));
        assert_eq!(f.log(&ws).unwrap()[0].title, "Agrego n");
        assert_eq!(f.commit_files(&ws, &json!("--help")).unwrap_err().mensaje, "Commit inválido.");
        assert_eq!(f.sync(&ws).unwrap()["ahead"], 2);
        assert_eq!(f.push(&ws, &json!(5)).unwrap_err().mensaje, "Rama inválida.");
        assert_eq!(f.switch(&ws, &json!(""), &Value::Null).unwrap_err().mensaje, "Rama inválido.");
        assert_eq!(f.branches(&ws).unwrap()["local"].as_array().unwrap().len(), 2);
        assert_eq!(f.stash_info(&ws).unwrap(), None);
        f.al_hook("Stop", Some("ws1"));
        f.al_hook("Otro", Some("ws1"));
        f.al_hook("Stop", None);
        let n = m.cambios.lock().unwrap().len();
        assert_eq!(m.cambios.lock().unwrap().last().map(String::as_str), Some("ws1"));
        assert_eq!(n, 4);
    }

    #[test]
    fn descartar_un_archivo_nuevo_pide_el_nombre_exacto() {
        let (t, _m, f, ws) = con_repo();
        fs::create_dir_all(t.0.join("repo/sub")).unwrap();
        fs::write(t.0.join("repo/sub/nuevo.txt"), "x").unwrap();
        assert_eq!(f.discard(&ws, &json!("sub/nuevo.txt"), &json!("otro")).unwrap_err().mensaje, "Escribí el nombre del archivo para confirmar.");
        assert!(t.0.join("repo/sub/nuevo.txt").exists());
        assert!(f.discard(&ws, &json!("sub/nuevo.txt"), &json!("nuevo.txt")).unwrap());
        assert!(!t.0.join("repo/sub/nuevo.txt").exists());
    }

    #[test]
    fn diff_acota_el_limite() {
        let (t, _m, f, ws) = con_repo();
        let largo: String = (0..500).map(|i| format!("l{i}\n")).collect();
        fs::write(t.0.join("repo/a.txt"), largo).unwrap();
        assert_eq!(f.diff(&ws, &json!("a.txt"), &json!(5)).unwrap().lines.len(), 100);
        assert!(f.diff(&ws, &json!("a.txt"), &json!("x")).unwrap().lines.len() > 400);
        assert_eq!(f.diff(&ws, &json!("a.txt"), &json!(150.9)).unwrap().lines.len(), 150);
    }

    #[test]
    fn una_operacion_en_curso_bloquea_a_la_segunda_del_mismo_espacio() {
        let (_t, _m, f, ws) = con_repo();
        let _g = f.exclusivo("ws1").unwrap();
        assert_eq!(f.stage_all(&ws).unwrap_err().mensaje, "Ya hay una operación de git en curso en este espacio.");
        assert_eq!(f.pull(&ws).unwrap_err().mensaje, "Ya hay una operación de git en curso en este espacio.");
        assert!(f.status(&ws).is_ok());
    }

    #[test]
    fn pr_prepare_arma_el_resumen_sin_gh() {
        let (t, _m, f, ws) = con_repo();
        f.create_branch(&ws, &json!("feat/pr"), &Value::Null).unwrap();
        fs::write(t.0.join("repo/p.txt"), "p\n").unwrap();
        f.stage_all(&ws).unwrap();
        f.commit(&ws, &json!("Primero")).unwrap();
        let p = f.pr_prepare(&ws, &Value::Null).unwrap();
        assert_eq!(p["branch"], "feat/pr");
        assert_eq!(p["base"], "main");
        assert_eq!(p["protected"], false);
        assert_eq!(p["pushed"], false);
        assert_eq!(p["unpushed"], 2);
        assert_eq!(p["defaultTitle"], "Primero");
        assert_eq!(p["commits"].as_array().unwrap().len(), 1);
        assert!(p["template"].is_null());
        let con_base = f.pr_prepare(&ws, &json!("-mala")).unwrap();
        assert_eq!(con_base["base"], "main");
    }

    #[test]
    fn pr_command_open_url_y_create_pr_validan() {
        let (_t, m, f, ws) = con_repo();
        let ok = json!({"base": "main", "head": "feat/x", "title": "T", "body": "B"});
        assert_eq!(f.pr_command(&ok).unwrap()[..3], ["gh", "pr", "create"]);
        assert_eq!(f.pr_command(&json!({"base": "main"})).unwrap_err().mensaje, "Rama inválida.");
        let desde_main = json!({"base": "develop", "head": "main", "title": "T", "body": "B"});
        assert_eq!(f.create_pr(&ws, &desde_main).unwrap_err().mensaje, "No se abre un PR desde main.");
        assert_eq!(f.open_url(&json!("https://evil.com/o/r/pull/1")).unwrap_err().mensaje, "Solo se abren links https://github.com/…/pull/N.");
        assert_eq!(f.open_url(&json!(1)).unwrap_err().mensaje, "Solo se abren links https://github.com/…/pull/N.");
        assert!(f.open_url(&json!("https://github.com/o/r/pull/3")).unwrap());
        assert_eq!(m.abiertos.lock().unwrap().as_slice(), ["https://github.com/o/r/pull/3"]);
    }
}
