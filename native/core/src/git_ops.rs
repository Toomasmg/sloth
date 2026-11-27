//! Lógica de git/gh de la función «git», sin shell ni Electron. Equivale a src/main/features/git-ops.ts.
//! Los parseos y validaciones son funciones puras; las operaciones reciben un `Git<E>` (ver git_run) para poder probarlas
//! con un ejecutor simulado o contra repos temporales reales.
use crate::git_run::{is_dir, rama_segura, readable, Ejecutor, Git, GitError, Motivo, OpcionesRun, Programa, PROTECTED};
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};

pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
pub const MAX_FILES: usize = 3000;
/// Archivos más grandes que esto no se muestran (aviso).
pub const HUGE_BYTES: u64 = 3 * 1024 * 1024;
const MAX_LINE_CHARS: usize = 2000;
const STASH_TAG: &str = "sloth-stash|";

type R<T> = Result<T, GitError>;

fn ms(n: u64) -> OpcionesRun {
    OpcionesRun::timeout(n)
}

fn err<T>(m: &str) -> R<T> {
    Err(GitError::nuevo(m))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub is_repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top: Option<String>,
    /// None = HEAD separado.
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_head: Option<bool>,
}

/// `path.resolve` sin tocar el disco: une y quita `.` y `..`.
pub fn resolver(base: &str, rel: &str) -> PathBuf {
    let unido = Path::new(base).join(rel);
    let mut out = PathBuf::new();
    for c in unido.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(out.components().next_back(), None | Some(Component::RootDir) | Some(Component::Prefix(_))) {
                    out.pop();
                }
            }
            otro => out.push(otro.as_os_str()),
        }
    }
    out
}

fn texto(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

pub fn repo_info<E: Ejecutor>(g: &Git<E>, cwd: &str) -> R<RepoInfo> {
    let no = RepoInfo { is_repo: false, top: None, branch: None, has_head: None };
    let r = g.git_raw(cwd, &["rev-parse", "--is-inside-work-tree", "--show-toplevel"], ms(10_000))?;
    if r.code != 0 {
        return Ok(no);
    }
    let salida = r.stdout.trim();
    let mut it = salida.split('\n').map(|l| l.trim_end_matches('\r'));
    let (inside, top) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
    if inside != "true" {
        return Ok(no);
    }
    let b = g.git_raw(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"], ms(10_000))?;
    let h = g.git_raw(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"], ms(10_000))?;
    let top = if top.is_empty() { cwd.to_string() } else { texto(&resolver(top, "")) };
    Ok(RepoInfo { is_repo: true, top: Some(top), branch: if b.code == 0 { Some(b.stdout.trim().to_string()) } else { None }, has_head: Some(h.code == 0) })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum FileCode {
    M,
    A,
    D,
    R,
    C,
    U,
    T,
    #[serde(rename = "??")]
    Untracked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig: Option<String>,
    pub code: FileCode,
    /// Las dos letras de porcelain (índice y árbol).
    pub xy: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub add: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub del: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub huge: Option<bool>,
    /// Tiene cambios en el índice (preparado para el próximo commit).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staged: Option<bool>,
}

fn code_of(xy: &str) -> FileCode {
    if xy == "??" || xy == "!!" {
        return FileCode::Untracked;
    }
    let mut c = xy.chars();
    let (x, y) = (c.next().unwrap_or(' '), c.next().unwrap_or(' '));
    if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
        return FileCode::U;
    }
    match if x != ' ' { x } else { y } {
        'A' => FileCode::A,
        'D' => FileCode::D,
        'R' => FileCode::R,
        'C' => FileCode::C,
        'T' => FileCode::T,
        _ => FileCode::M,
    }
}

/// Parsea `git status --porcelain=v1 -z`.
pub fn parse_porcelain(out: &str) -> Vec<FileChange> {
    let parts: Vec<&str> = out.split('\0').collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let entry = parts[i];
        i += 1;
        let mut ci = entry.char_indices();
        let (Some((i2, _)), Some((i3, _))) = (ci.nth(2), ci.next()) else { continue };
        let (xy, path) = (&entry[..i2], &entry[i3..]);
        let mut f = FileChange { path: path.to_string(), orig: None, code: code_of(xy), xy: xy.to_string(), add: None, del: None, binary: None, huge: None, staged: None };
        if xy.contains('R') || xy.contains('C') {
            f.orig = parts.get(i).map(|s| s.to_string());
            i += 1;
        }
        files.push(f);
    }
    files
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Numstat {
    pub add: Option<u64>,
    pub del: Option<u64>,
    pub binary: bool,
}

/// Parsea `git diff --numstat -z` (con renombres: "a\td\t\0viejo\0nuevo\0"). Conserva el orden de aparición.
pub fn parse_numstat(out: &str) -> Vec<(String, Numstat)> {
    let mut m: Vec<(String, Numstat)> = Vec::new();
    let parts: Vec<&str> = out.split('\0').collect();
    let mut i = 0;
    while i < parts.len() {
        let p = parts[i];
        i += 1;
        if p.is_empty() {
            continue;
        }
        let t: Vec<&str> = p.split('\t').collect();
        if t.len() < 3 {
            continue;
        }
        let mut path = t[2..].join("\t");
        if path.is_empty() {
            i += 1; // viejo
            path = parts.get(i).copied().unwrap_or("").to_string();
            i += 1;
        }
        let binary = t[0] == "-";
        let s = if binary { Numstat { add: None, del: None, binary } } else { Numstat { add: t[0].parse().ok(), del: t[1].parse().ok(), binary } };
        match m.iter_mut().find(|(k, _)| *k == path) {
            Some(e) => e.1 = s,
            None => m.push((path, s)),
        }
    }
    m
}

/// Solo el conteo (para el botón del header): barato.
pub fn change_count<E: Ejecutor>(g: &Git<E>, cwd: &str) -> R<Option<usize>> {
    let r = g.git_raw(cwd, &["status", "--porcelain=v1", "-z"], ms(15_000))?;
    Ok(if r.code != 0 { None } else { Some(parse_porcelain(&r.stdout).len()) })
}

pub struct Stats {
    pub size: u64,
    pub binary: bool,
    pub lines: u64,
}

pub fn file_stats(abs: &Path) -> Option<Stats> {
    let md = fs::metadata(abs).ok()?;
    if !md.is_file() {
        return None;
    }
    if md.len() > HUGE_BYTES {
        return Some(Stats { size: md.len(), binary: false, lines: 0 });
    }
    let mut f = File::open(abs).ok()?;
    let mut buf = vec![0u8; 64 * 1024];
    let (mut lines, mut first, mut last, mut total) = (0u64, true, b'\n', 0u64);
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        if first && buf[..n.min(8000)].contains(&0) {
            return Some(Stats { size: md.len(), binary: true, lines: 0 });
        }
        first = false;
        lines += buf[..n].iter().filter(|b| **b == b'\n').count() as u64;
        last = buf[n - 1];
        total += n as u64;
    }
    if total > 0 && last != b'\n' {
        lines += 1;
    }
    Some(Stats { size: md.len(), binary: false, lines })
}

/// Ruta relativa al repo -> absoluta, sin salirse del repo.
pub fn inside_repo(top: &str, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() || rel.encode_utf16().count() > 1024 || rel.contains('\0') {
        return None;
    }
    let abs = resolver(top, rel);
    let root = resolver(top, "");
    let (a, r) = (texto(&abs), texto(&root));
    let con_sep = format!("{r}{}", std::path::MAIN_SEPARATOR);
    if a != r && !a.to_lowercase().starts_with(&con_sep.to_lowercase()) {
        return None;
    }
    Some(abs)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub is_repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top: Option<String>,
    pub branch: Option<String>,
    pub files: Vec<FileChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

pub fn status<E: Ejecutor>(g: &Git<E>, cwd: &str) -> R<StatusResult> {
    let info = repo_info(g, cwd)?;
    let Some(top) = info.top.clone().filter(|_| info.is_repo) else {
        return Ok(StatusResult { is_repo: false, top: None, branch: None, files: vec![], truncated: None });
    };
    let st = g.git(&top, &["status", "--porcelain=v1", "-z", "--untracked-files=all"], ms(20_000))?;
    let mut files = parse_porcelain(&st);
    let truncated = files.len() > MAX_FILES;
    files.truncate(MAX_FILES);
    for f in &mut files {
        let x = f.xy.chars().next().unwrap_or(' ');
        f.staged = Some(x != ' ' && x != '?' && x != '!');
    }
    let base = if info.has_head == Some(true) { "HEAD" } else { EMPTY_TREE };
    // Las rutas de status son relativas al top del repo; numstat también si se corre desde el top.
    let num = g.git_raw(&top, &["diff", base, "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv"], ms(20_000))?;
    let stats = if num.code == 0 { parse_numstat(&num.stdout) } else { vec![] };
    for f in &mut files {
        if let Some((_, s)) = stats.iter().find(|(k, _)| *k == f.path) {
            f.add = s.add;
            f.del = s.del;
            f.binary = Some(s.binary);
        }
        if f.code == FileCode::Untracked || (f.code == FileCode::A && f.add.is_none()) {
            let fs = inside_repo(&top, &f.path).and_then(|abs| file_stats(&abs));
            if let Some(fs) = fs {
                f.binary = Some(fs.binary);
                let huge = fs.size > HUGE_BYTES;
                f.huge = Some(huge);
                if !fs.binary && !huge {
                    f.add = Some(fs.lines);
                    f.del = Some(0);
                }
            }
        } else if f.code != FileCode::D {
            let abs = inside_repo(&top, &f.path);
            if abs.and_then(|a| fs::metadata(a).ok()).is_some_and(|m| m.len() > HUGE_BYTES) {
                f.huge = Some(true);
            }
        }
    }
    Ok(StatusResult { is_repo: true, top: Some(top), branch: info.branch, files, truncated: Some(truncated) })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DiffLine {
    /// '+', '-', ' ', '@' (hunk), 'h' (cabecera), '\\' (sin salto final).
    pub t: String,
    pub s: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub o: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffKind {
    Text,
    Binary,
    Huge,
    Empty,
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DiffResult {
    pub kind: DiffKind,
    pub lines: Vec<DiffLine>,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

fn clip(s: &str) -> String {
    if s.chars().count() > MAX_LINE_CHARS {
        format!("{} …", s.chars().take(MAX_LINE_CHARS).collect::<String>())
    } else {
        s.to_string()
    }
}

/// Parte la salida de un proceso en líneas (sin el `\r` final) y avisa si había más de `limit`.
pub fn leer_lineas(stdout: &str, limit: usize) -> (Vec<String>, bool) {
    let mut partes: Vec<&str> = stdout.split('\n').collect();
    let resto = partes.pop().unwrap_or("");
    let mut lines = Vec::new();
    let mut more = false;
    for p in partes {
        if lines.len() >= limit {
            more = true;
            break;
        }
        lines.push(p.trim_end_matches('\r').to_string());
    }
    if !more && !resto.is_empty() {
        if lines.len() >= limit {
            more = true;
        } else {
            lines.push(resto.trim_end_matches('\r').to_string());
        }
    }
    (lines, more)
}

/// `@@ -a[,b] +c[,d] @@` al principio de la línea: devuelve (a, c).
fn hunk(l: &str) -> Option<(u32, u32)> {
    let r = l.strip_prefix("@@ -")?;
    let numero = |s: &str| -> Option<(u32, usize)> {
        let n = s.chars().take_while(char::is_ascii_digit).count();
        if n == 0 {
            return None;
        }
        Some((s[..n].parse().ok()?, n))
    };
    let (viejo, n) = numero(r)?;
    let mut r = &r[n..];
    if let Some(c) = r.strip_prefix(',') {
        let (_, n) = numero(c)?;
        r = &c[n..];
    }
    let r = r.strip_prefix(" +")?;
    let (nuevo, n) = numero(r)?;
    let mut r = &r[n..];
    if let Some(c) = r.strip_prefix(',') {
        let (_, n) = numero(c)?;
        r = &c[n..];
    }
    r.starts_with(" @@").then_some((viejo, nuevo))
}

/// Convierte un diff unificado en líneas con número viejo/nuevo.
pub fn parse_unified(raw: &[String]) -> Vec<DiffLine> {
    let mut out = Vec::new();
    let (mut o, mut n) = (0u32, 0u32);
    let mut in_hunk = false;
    let linea = |t: &str, s: String, o: Option<u32>, n: Option<u32>| DiffLine { t: t.to_string(), s, o, n };
    for l in raw {
        if let Some((a, b)) = hunk(l) {
            o = a;
            n = b;
            in_hunk = true;
            out.push(linea("@", clip(l), None, None));
            continue;
        }
        if !in_hunk || l.starts_with("diff --git") {
            in_hunk = false;
            out.push(linea("h", clip(l), None, None));
            continue;
        }
        let resto = || l.chars().skip(1).collect::<String>();
        match l.chars().next() {
            Some('+') => {
                out.push(linea("+", clip(&resto()), None, Some(n)));
                n += 1;
            }
            Some('-') => {
                out.push(linea("-", clip(&resto()), Some(o), None));
                o += 1;
            }
            Some('\\') => out.push(linea("\\", clip(l), None, None)),
            _ => {
                out.push(linea(" ", clip(&resto()), Some(o), Some(n)));
                o += 1;
                n += 1;
            }
        }
    }
    out
}

fn leer_archivo_nuevo(abs: &Path, limit: usize) -> std::io::Result<(Vec<DiffLine>, bool)> {
    let mut r = BufReader::with_capacity(64 * 1024, File::open(abs)?);
    let mut lines = Vec::new();
    let mut n = 1u32;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        if r.read_until(b'\n', &mut buf)? == 0 {
            break;
        }
        if buf.last() == Some(&b'\n') {
            buf.pop();
        }
        if lines.len() >= limit {
            return Ok((lines, true));
        }
        let s = String::from_utf8_lossy(&buf);
        lines.push(DiffLine { t: "+".into(), s: clip(s.trim_end_matches('\r')), o: None, n: Some(n) });
        n += 1;
    }
    Ok((lines, false))
}

pub fn diff_file<E: Ejecutor>(g: &Git<E>, top: &str, file: &FileChange, has_head: bool, limit: usize) -> R<DiffResult> {
    let Some(abs) = inside_repo(top, &file.path) else { return err("Ruta fuera del repositorio.") };
    let size = fs::metadata(&abs).ok().map(|m| m.len());
    let vacio = |kind, size| DiffResult { kind, lines: vec![], truncated: false, size };
    if size.is_some_and(|s| s > HUGE_BYTES) {
        return Ok(vacio(DiffKind::Huge, size));
    }
    if file.code == FileCode::Untracked {
        let Some(sz) = size else { return Ok(vacio(DiffKind::Missing, None)) };
        if file_stats(&abs).is_some_and(|s| s.binary) {
            return Ok(vacio(DiffKind::Binary, size));
        }
        if sz == 0 {
            return Ok(vacio(DiffKind::Empty, size));
        }
        let (lines, more) = leer_archivo_nuevo(&abs, limit).map_err(|e| GitError::nuevo(e.to_string()))?;
        let mut todo = vec![DiffLine { t: "h".into(), s: format!("Archivo nuevo sin trackear: {}", file.path), o: None, n: None }];
        todo.extend(lines);
        return Ok(DiffResult { kind: DiffKind::Text, lines: todo, truncated: more, size });
    }
    let mut args: Vec<&str> = vec!["diff", if has_head { "HEAD" } else { EMPTY_TREE }, "-M", "--no-color", "--no-ext-diff", "--no-textconv", "--"];
    if let Some(o) = &file.orig {
        args.push(o);
    }
    args.push(&file.path);
    let opts = OpcionesRun { max_lineas: Some(limit + 6), ..ms(20_000) };
    let r = g.git_raw(top, &args, opts).map_err(|e| if e.motivo == Some(Motivo::Tiempo) { GitError::nuevo("git diff tardó demasiado.") } else { e })?;
    let (raw, more) = leer_lineas(&r.stdout, limit + 6);
    if r.code != 0 && !more && !r.cortado {
        let primera = r.stderr.trim().split('\n').next().unwrap_or("").trim_end_matches('\r');
        return Err(GitError::nuevo(format!("git diff falló: {primera}")));
    }
    let es_binario = |l: &String| (l.starts_with("Binary files ") && l.ends_with(" differ") && l.len() >= 20) || l == "GIT binary patch";
    if raw.iter().any(es_binario) {
        return Ok(vacio(DiffKind::Binary, size));
    }
    let lines = parse_unified(&raw);
    if lines.is_empty() {
        return Ok(vacio(DiffKind::Empty, size));
    }
    let truncated = more || lines.len() > limit;
    Ok(DiffResult { kind: DiffKind::Text, lines: lines.into_iter().take(limit).collect(), truncated, size })
}

pub fn has_ref<E: Ejecutor>(g: &Git<E>, cwd: &str, r: &str) -> R<bool> {
    Ok(g.git_raw(cwd, &["rev-parse", "--verify", "--quiet", r], ms(10_000))?.code == 0)
}

/// Base por defecto: origin/staging si existe; si no, la rama por defecto del remoto (origin/HEAD).
pub fn default_base<E: Ejecutor>(g: &Git<E>, cwd: &str) -> R<Option<String>> {
    if has_ref(g, cwd, "refs/remotes/origin/staging")? {
        return Ok(Some("staging".into()));
    }
    let r = g.git_raw(cwd, &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], ms(10_000))?;
    if r.code == 0 {
        let t = r.stdout.trim();
        let name = t.strip_prefix("refs/remotes/origin/").unwrap_or(t);
        if !name.is_empty() {
            return Ok(Some(name.to_string()));
        }
    }
    for b in ["main", "master"] {
        if has_ref(g, cwd, &format!("refs/remotes/origin/{b}"))? {
            return Ok(Some(b.into()));
        }
    }
    for b in ["staging", "main", "master"] {
        if has_ref(g, cwd, &format!("refs/heads/{b}"))? {
            return Ok(Some(b.into()));
        }
    }
    Ok(None)
}

/// URL del remoto sin credenciales embebidas.
pub fn safe_url(u: &str) -> String {
    let u = u.trim();
    for pref in ["https://", "http://"] {
        if let Some(resto) = u.strip_prefix(pref) {
            let host = resto.split('/').next().unwrap_or("");
            if let Some(at) = host.find('@') {
                return format!("{pref}{}", &resto[at + 1..]);
            }
        }
    }
    u.to_string()
}

pub fn remote_url<E: Ejecutor>(g: &Git<E>, cwd: &str, remote: &str) -> R<Option<String>> {
    let r = g.git_raw(cwd, &["remote", "get-url", remote], ms(10_000))?;
    Ok(if r.code == 0 { Some(safe_url(&r.stdout)) } else { None })
}

pub fn upstream<E: Ejecutor>(g: &Git<E>, cwd: &str) -> R<Option<String>> {
    let r = g.git_raw(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], ms(10_000))?;
    Ok(if r.code == 0 { Some(r.stdout.trim().to_string()) } else { None })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Commit {
    pub sha: String,
    pub subject: String,
}

pub fn parse_log(out: &str) -> Vec<Commit> {
    out.split('\n')
        .filter(|l| !l.is_empty())
        .map(|l| {
            let mut it = l.split('\t');
            let sha = it.next().unwrap_or("").to_string();
            Commit { sha, subject: it.collect::<Vec<_>>().join("\t") }
        })
        .collect()
}

/// Commits que un push mandaría: los que no están en el upstream (o en ningún remoto si no hay).
pub fn commits_to_push<E: Ejecutor>(g: &Git<E>, cwd: &str) -> R<Vec<Commit>> {
    if !has_ref(g, cwd, "HEAD")? {
        return Ok(vec![]);
    }
    let up = upstream(g, cwd)?;
    let rango = up.as_ref().map(|u| format!("{u}..HEAD"));
    let args: Vec<&str> = match &rango {
        Some(r) => vec!["log", "--format=%h%x09%s", "-n", "100", r],
        None => vec!["log", "--format=%h%x09%s", "-n", "100", "HEAD", "--not", "--remotes"],
    };
    Ok(parse_log(&g.git(cwd, &args, ms(15_000))?))
}

/// Commits de la rama que no están en la base (para el PR).
pub fn commits_vs_base<E: Ejecutor>(g: &Git<E>, cwd: &str, base: &str) -> R<Vec<Commit>> {
    let r = if has_ref(g, cwd, &format!("refs/remotes/origin/{base}"))? {
        Some(format!("origin/{base}"))
    } else if has_ref(g, cwd, &format!("refs/heads/{base}"))? {
        Some(base.to_string())
    } else {
        None
    };
    let Some(r) = r else { return Ok(vec![]) };
    if !has_ref(g, cwd, "HEAD")? {
        return Ok(vec![]);
    }
    Ok(parse_log(&g.git(cwd, &["log", "--format=%h%x09%s", "-n", "100", &format!("{r}..HEAD")], ms(15_000))?))
}

pub fn is_protected(branch: Option<&str>) -> bool {
    branch.map_or(true, |b| b.is_empty() || PROTECTED.contains(&b))
}

/// Commit de lo que está preparado (índice). Nunca agrega archivos por su cuenta.
pub fn commit_staged<E: Ejecutor>(g: &Git<E>, cwd: &str, message: &str) -> R<String> {
    let info = repo_info(g, cwd)?;
    let Some(top) = info.top.clone().filter(|_| info.is_repo) else { return err("La carpeta no es un repositorio git.") };
    let Some(branch) = info.branch.as_deref() else { return err("HEAD está separado (detached): creá una rama antes de commitear.") };
    if is_protected(Some(branch)) {
        return err(&format!("No se commitea directo en {branch}. Creá una rama nueva."));
    }
    let staged = g.git(&top, &["diff", "--cached", "--name-only", "-z", "--no-ext-diff", "--no-textconv"], ms(20_000))?;
    if staged.replace('\0', "").trim().is_empty() {
        return err("No hay archivos preparados. Marcá al menos uno para confirmarlo.");
    }
    let r = g.git_raw(&top, &["commit", "-F", "-"], ms(120_000).con_input(message))?;
    if r.code != 0 {
        return Err(GitError::nuevo(readable(&r, "git commit")));
    }
    Ok(g.git(&top, &["rev-parse", "--short", "HEAD"], OpcionesRun::default())?.trim().to_string())
}

pub fn create_branch<E: Ejecutor>(g: &Git<E>, cwd: &str, name: &str, base: Option<&str>) -> R<()> {
    if !rama_segura(name) {
        return err("Nombre de rama inválido.");
    }
    if has_ref(g, cwd, &format!("refs/heads/{name}"))? {
        return err(&format!("Ya existe la rama {name}."));
    }
    if let Some(base) = base {
        if !rama_segura(base) {
            return err("Rama base inválida.");
        }
        if !has_ref(g, cwd, &format!("refs/heads/{base}"))? {
            return err(&format!("No encuentro la rama local {base}."));
        }
        g.git(cwd, &["switch", "-c", name, base], ms(30_000))?;
        return Ok(());
    }
    g.git(cwd, &["switch", "-c", name], ms(30_000))?;
    Ok(())
}

/// Rutas de un cambio: la original también cuenta cuando es un renombrado.
fn paths_of(f: &FileChange) -> Vec<&str> {
    match &f.orig {
        Some(o) => vec![o.as_str(), f.path.as_str()],
        None => vec![f.path.as_str()],
    }
}

/// Prepara el archivo (incluye su cambio en el árbol: `git add -A -- ruta`).
pub fn stage_file<E: Ejecutor>(g: &Git<E>, top: &str, f: &FileChange) -> R<()> {
    let mut a = vec!["add", "-A", "--"];
    a.extend(paths_of(f));
    g.git(top, &a, ms(60_000)).map(|_| ())
}

/// Saca el archivo del índice sin tocar el árbol (`git reset -q -- ruta`). Funciona también sin commits.
pub fn unstage_file<E: Ejecutor>(g: &Git<E>, top: &str, f: &FileChange) -> R<()> {
    let mut a = vec!["reset", "-q", "--"];
    a.extend(paths_of(f));
    g.git(top, &a, ms(30_000)).map(|_| ())
}

pub fn stage_all<E: Ejecutor>(g: &Git<E>, top: &str) -> R<()> {
    g.git(top, &["add", "-A"], ms(120_000)).map(|_| ())
}

pub fn unstage_all<E: Ejecutor>(g: &Git<E>, top: &str) -> R<()> {
    g.git(top, &["reset", "-q"], ms(60_000)).map(|_| ())
}

/// Descarta los cambios de un archivo. Para no trackeados borra el archivo (la UI pide confirmación reforzada).
/// Nunca toca nada fuera del repo.
pub fn discard_file<E: Ejecutor>(g: &Git<E>, top: &str, f: &FileChange, has_head: bool) -> R<()> {
    let Some(abs) = inside_repo(top, &f.path) else { return err("Ruta fuera del repositorio.") };
    if f.code == FileCode::Untracked {
        match fs::metadata(&abs) {
            Ok(m) if m.is_file() => {}
            Ok(_) => return err("Solo se pueden borrar archivos sueltos."),
            Err(_) => return err("El archivo ya no existe."),
        }
        return fs::remove_file(&abs).map_err(|e| GitError::nuevo(e.to_string()));
    }
    if !has_head || f.code == FileCode::A {
        return g.git(top, &["rm", "-f", "-q", "--", &f.path], ms(60_000)).map(|_| ());
    }
    if let Some(orig) = &f.orig {
        g.git(top, &["restore", "--source=HEAD", "--staged", "--worktree", "--", orig], ms(60_000))?;
        return g.git(top, &["rm", "-f", "-q", "--", &f.path], ms(60_000)).map(|_| ());
    }
    g.git(top, &["restore", "--source=HEAD", "--staged", "--worktree", "--", &f.path], ms(60_000)).map(|_| ())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LogEntry {
    pub hash: String,
    pub short: String,
    pub title: String,
    pub author: String,
    /// Fecha ISO del autor.
    pub date: String,
    pub pushed: bool,
}

/// Hashes de commits que todavía no están en el remoto (tope 1000).
pub fn unpushed_hashes<E: Ejecutor>(g: &Git<E>, cwd: &str) -> R<Vec<String>> {
    if !has_ref(g, cwd, "HEAD")? {
        return Ok(vec![]);
    }
    let up = upstream(g, cwd)?;
    let rango = up.as_ref().map(|u| format!("{u}..HEAD"));
    let args: Vec<&str> = match &rango {
        Some(r) => vec!["rev-list", "-n", "1000", r],
        None => vec!["rev-list", "-n", "1000", "HEAD", "--not", "--remotes"],
    };
    let out = g.git(cwd, &args, ms(15_000))?;
    Ok(out.split('\n').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect())
}

pub fn log_branch<E: Ejecutor>(g: &Git<E>, cwd: &str, limit: usize) -> R<Vec<LogEntry>> {
    if !has_ref(g, cwd, "HEAD")? {
        return Ok(vec![]);
    }
    const SEP: char = '\x1f';
    const REC: char = '\x1e';
    let fmt = format!("--format=%H{SEP}%h{SEP}%an{SEP}%aI{SEP}%s{REC}");
    let out = g.git(cwd, &["log", "-n", &limit.to_string(), &fmt], ms(20_000))?;
    let pending = unpushed_hashes(g, cwd)?;
    Ok(out
        .split(REC)
        .map(|r| r.trim_start_matches('\n'))
        .filter(|r| !r.is_empty())
        .map(|r| {
            let mut it = r.split(SEP);
            let mut sig = || it.next().unwrap_or("").to_string();
            let (hash, short, author, date) = (sig(), sig(), sig(), sig());
            let title = it.collect::<Vec<_>>().join(&SEP.to_string());
            LogEntry { pushed: !pending.contains(&hash), hash, short, title, author, date }
        })
        .collect())
}

pub fn es_sha(s: &str) -> bool {
    (7..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CommitFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub add: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub del: Option<u64>,
    pub binary: bool,
}

pub fn commit_files<E: Ejecutor>(g: &Git<E>, cwd: &str, sha: &str) -> R<Vec<CommitFile>> {
    if !es_sha(sha) {
        return err("Commit inválido.");
    }
    let out = g.git(cwd, &["show", "--numstat", "-z", "--format=", "-M", "--no-ext-diff", "--no-textconv", sha], ms(20_000))?;
    Ok(parse_numstat(&out).into_iter().map(|(path, s)| CommitFile { path, add: s.add, del: s.del, binary: s.binary }).collect())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SyncInfo {
    pub upstream: Option<String>,
    /// Commits que faltan subir.
    pub ahead: usize,
    /// Commits que faltan bajar.
    pub behind: usize,
}

pub fn sync_info<E: Ejecutor>(g: &Git<E>, cwd: &str) -> R<SyncInfo> {
    let Some(up) = upstream(g, cwd)? else {
        let ahead = if has_ref(g, cwd, "HEAD")? { unpushed_hashes(g, cwd)?.len() } else { 0 };
        return Ok(SyncInfo { upstream: None, ahead, behind: 0 });
    };
    let r = g.git_raw(cwd, &["rev-list", "--left-right", "--count", &format!("HEAD...{up}")], ms(15_000))?;
    if r.code != 0 {
        return Ok(SyncInfo { upstream: Some(up), ahead: 0, behind: 0 });
    }
    let mut n = r.stdout.split_whitespace().map(|x| x.parse::<usize>().unwrap_or(0));
    Ok(SyncInfo { upstream: Some(up), ahead: n.next().unwrap_or(0), behind: n.next().unwrap_or(0) })
}

/// Trae el remoto solo si avanza limpio (`git pull --ff-only`). Nunca combina ni reescribe.
pub fn pull_ff<E: Ejecutor>(g: &Git<E>, cwd: &str) -> R<String> {
    let info = repo_info(g, cwd)?;
    let Some(top) = info.top.clone().filter(|_| info.is_repo) else { return err("No es un repositorio git.") };
    if info.branch.is_none() {
        return err("HEAD está separado: no hay rama que traer.");
    }
    if upstream(g, &top)?.is_none() {
        return err("La rama no tiene remoto asociado. Subila primero con «Subir».");
    }
    let r = g.git_raw(&top, &["pull", "--ff-only"], ms(120_000))?;
    if r.code != 0 {
        return Err(GitError::nuevo(readable(&r, "git pull")));
    }
    Ok(format!("{}{}", r.stdout, r.stderr).trim().to_string())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LocalBranch {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
    pub subject: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranch {
    pub name: String,
    pub subject: String,
    pub has_local: bool,
}

pub fn local_branches<E: Ejecutor>(g: &Git<E>, cwd: &str) -> R<Vec<LocalBranch>> {
    let out = g.git(cwd, &["for-each-ref", "--format=%(HEAD)%09%(refname)%09%(upstream:short)%09%(contents:subject)", "refs/heads/"], ms(15_000))?;
    Ok(out
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(|l| {
            let mut it = l.split('\t');
            let head = it.next().unwrap_or("");
            let rf = it.next().unwrap_or("");
            let up = it.next().unwrap_or("");
            LocalBranch {
                name: rf.strip_prefix("refs/heads/").unwrap_or(rf).to_string(),
                current: head == "*",
                upstream: if up.is_empty() { None } else { Some(up.to_string()) },
                subject: it.next().unwrap_or("").to_string(),
            }
        })
        .collect())
}

pub fn remote_branches<E: Ejecutor>(g: &Git<E>, cwd: &str, locals: &[LocalBranch]) -> R<Vec<RemoteBranch>> {
    let out = g.git(cwd, &["for-each-ref", "--format=%(refname)%09%(contents:subject)", "refs/remotes/origin/"], ms(15_000))?;
    Ok(out
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(|l| {
            let mut it = l.split('\t');
            let rf = it.next().unwrap_or("");
            (rf.strip_prefix("refs/remotes/origin/").unwrap_or(rf).to_string(), it.next().unwrap_or("").to_string())
        })
        .filter(|(n, _)| n != "HEAD")
        .map(|(name, subject)| RemoteBranch { has_local: locals.iter().any(|l| l.name == name), name, subject })
        .collect())
}

/// Cambia de rama. Si es remota sin copia local, crea la local siguiendo origin.
pub fn switch_branch<E: Ejecutor>(g: &Git<E>, cwd: &str, name: &str, remote: bool) -> R<()> {
    if !rama_segura(name) {
        return err("Nombre de rama inválido.");
    }
    let info = repo_info(g, cwd)?;
    let Some(top) = info.top.clone().filter(|_| info.is_repo) else { return err("No es un repositorio git.") };
    if info.branch.as_deref() == Some(name) {
        return Ok(());
    }
    if !remote || has_ref(g, &top, &format!("refs/heads/{name}"))? {
        return g.git(&top, &["switch", name], ms(60_000)).map(|_| ());
    }
    if !has_ref(g, &top, &format!("refs/remotes/origin/{name}"))? {
        return err(&format!("No encuentro la rama {name} en origin."));
    }
    g.git(&top, &["switch", "-c", name, "--track", &format!("origin/{name}")], ms(60_000)).map(|_| ())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StashEntry {
    pub sha: String,
    pub r#ref: String,
    pub branch: String,
    pub files: usize,
}

/// `sloth-stash|<rama>|`: la rama que quedó escrita en el mensaje del stash.
fn rama_de_stash(subject: &str) -> Option<&str> {
    let mut desde = 0;
    while let Some(i) = subject[desde..].find(STASH_TAG) {
        let ini = desde + i + STASH_TAG.len();
        if let Some(fin) = subject[ini..].find('|') {
            return Some(&subject[ini..ini + fin]);
        }
        desde += i + 1;
    }
    None
}

/// El stash que guardó Sloth (si hay): se reconoce por su mensaje, así sobrevive a reiniciar la app.
pub fn find_stash<E: Ejecutor>(g: &Git<E>, cwd: &str) -> R<Option<StashEntry>> {
    if !has_ref(g, cwd, "refs/stash")? {
        return Ok(None);
    }
    let out = g.git(cwd, &["stash", "list", "--format=%H%x09%gd%x09%gs"], ms(15_000))?;
    for line in out.split('\n') {
        let mut it = line.split('\t');
        let sha = it.next().unwrap_or("");
        let rf = it.next().unwrap_or("");
        let subject = it.next().unwrap_or("");
        if sha.is_empty() || !subject.contains(STASH_TAG) {
            continue;
        }
        let branch = rama_de_stash(subject).unwrap_or("").to_string();
        let tracked = g.git(cwd, &["stash", "show", "--name-only", "--no-ext-diff", "--no-textconv", sha], ms(15_000))?;
        let mut untracked = 0;
        let tercero = format!("{sha}^3");
        if has_ref(g, cwd, &tercero)? {
            untracked = g.git(cwd, &["ls-tree", "-r", "--name-only", &tercero], ms(15_000))?.split('\n').filter(|l| !l.is_empty()).count();
        }
        let files = tracked.split('\n').filter(|l| !l.is_empty()).count() + untracked;
        return Ok(Some(StashEntry { sha: sha.to_string(), r#ref: rf.to_string(), branch, files }));
    }
    Ok(None)
}

/// `new Date().toISOString()` para un instante en milisegundos desde 1970.
pub fn iso_utc(ms: u64) -> String {
    let (dias, resto) = ((ms / 86_400_000) as i64, ms % 86_400_000);
    let z = dias + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dia = doy - (153 * mp + 2) / 5 + 1;
    let mes = if mp < 10 { mp + 3 } else { mp - 9 };
    let anio = yoe + era * 400 + i64::from(mes <= 2);
    format!("{anio:04}-{mes:02}-{dia:02}T{:02}:{:02}:{:02}.{:03}Z", resto / 3_600_000, resto / 60_000 % 60, resto / 1000 % 60, resto % 1000)
}

fn ahora_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn stash_push<E: Ejecutor>(g: &Git<E>, cwd: &str) -> R<()> {
    let info = repo_info(g, cwd)?;
    let Some(top) = info.top.clone().filter(|_| info.is_repo) else { return err("No es un repositorio git.") };
    if find_stash(g, &top)?.is_some() {
        return err("Ya hay cambios guardados en el stash. Restauralos antes de guardar otros.");
    }
    let branch = info.branch.as_deref().unwrap_or("HEAD separado");
    let msg = format!("{STASH_TAG}{branch}|{}", iso_utc(ahora_ms()));
    g.git(&top, &["stash", "push", "-u", "-m", &msg], ms(60_000))?;
    if find_stash(g, &top)?.is_none() {
        return err("No había cambios para guardar.");
    }
    Ok(())
}

/// Aplica el stash de Sloth y solo lo borra si se aplicó sin conflictos.
pub fn stash_restore<E: Ejecutor>(g: &Git<E>, cwd: &str) -> R<()> {
    let info = repo_info(g, cwd)?;
    let Some(top) = info.top.clone().filter(|_| info.is_repo) else { return err("No es un repositorio git.") };
    let Some(s) = find_stash(g, &top)? else { return err("No hay cambios guardados en el stash.") };
    let r = g.git_raw(&top, &["stash", "apply", &s.sha], ms(120_000))?;
    if r.code != 0 {
        return Err(GitError::nuevo(format!("{} El stash sigue guardado.", readable(&r, "git stash apply"))));
    }
    if let Some(otra) = find_stash(g, &top)? {
        g.git(&top, &["stash", "drop", &otra.r#ref], ms(30_000))?;
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GhStatus {
    pub installed: bool,
    pub version: String,
}

pub fn gh_status<E: Ejecutor>(g: &Git<E>) -> GhStatus {
    let no = GhStatus { installed: false, version: String::new() };
    match g.run(Programa::Gh, &["--version"], ms(8000)) {
        Ok(r) if r.code == 0 => GhStatus { installed: true, version: r.stdout.split('\n').next().unwrap_or("").trim().to_string() },
        // gh no instalado o colgado: para la UI es lo mismo, «no hay gh».
        _ => no,
    }
}

/// Argumentos exactos del push (sin --force nunca).
pub fn push_args(branch: &str) -> Vec<String> {
    ["push", "-u", "origin", branch].iter().map(|s| s.to_string()).collect()
}

pub fn push<E: Ejecutor>(g: &Git<E>, cwd: &str, branch: &str) -> R<String> {
    if !rama_segura(branch) {
        return err("Rama inválida.");
    }
    let info = repo_info(g, cwd)?;
    if info.branch.as_deref() != Some(branch) {
        return err(&format!("La rama actual cambió (ahora es {}). Volvé a revisar.", info.branch.as_deref().unwrap_or("HEAD separado")));
    }
    if is_protected(Some(branch)) {
        return err(&format!("No se pushea directo a {branch} desde Sloth."));
    }
    if remote_url(g, cwd, "origin")?.is_none() {
        return err("El repo no tiene remoto «origin».");
    }
    let args = push_args(branch);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let r = g.git_raw(cwd, &refs, ms(120_000))?;
    if r.code != 0 {
        return Err(GitError::nuevo(readable(&r, "git push")));
    }
    Ok(format!("{}{}", r.stderr, r.stdout).trim().to_string())
}

const TEMPLATE_CANDIDATES: [&str; 6] = [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "docs/pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Plantilla {
    pub path: String,
    pub body: String,
}

pub fn read_template(top: &str) -> Option<Plantilla> {
    for rel in TEMPLATE_CANDIDATES {
        let abs = Path::new(top).join(rel);
        let Ok(md) = fs::metadata(&abs) else { continue };
        if !md.is_file() {
            continue;
        }
        let Ok(f) = File::open(&abs) else { continue };
        let mut buf = Vec::new();
        if f.take(64 * 1024).read_to_end(&mut buf).is_err() {
            continue;
        }
        let t = String::from_utf8_lossy(&buf);
        return Some(Plantilla { path: rel.to_string(), body: t.strip_prefix('\u{feff}').unwrap_or(&t).to_string() });
    }
    None
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PrRef {
    pub url: String,
    pub number: u64,
    pub state: String,
    pub title: String,
}

/// `^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/\d+/?$`
pub fn github_pr_url(u: &str) -> bool {
    let Some(r) = u.strip_prefix("https://github.com/") else { return false };
    let r = r.strip_suffix('/').unwrap_or(r);
    let p: Vec<&str> = r.split('/').collect();
    let nombre = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-');
    p.len() == 4 && nombre(p[0]) && nombre(p[1]) && p[2] == "pull" && !p[3].is_empty() && p[3].bytes().all(|b| b.is_ascii_digit())
}

pub fn pr_view<E: Ejecutor>(g: &Git<E>, cwd: &str, branch: &str) -> R<Option<PrRef>> {
    let r = g.run(Programa::Gh, &["pr", "view", branch, "--json", "url,number,state,title"], ms(20_000).con_cwd(cwd))?;
    if r.code != 0 {
        let low = r.stderr.to_lowercase();
        let no_hay = ["no pull request found", "no pull requests found", "no open pull request found", "no open pull requests found", "could not find"].iter().any(|s| low.contains(s));
        if no_hay {
            return Ok(None);
        }
        return Err(GitError::nuevo(readable(&r, "gh pr view")));
    }
    let Ok(j) = serde_json::from_str::<Value>(&r.stdout) else { return Ok(None) };
    let Some(url) = j.get("url").and_then(Value::as_str) else { return Ok(None) };
    let s = |k: &str| j.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    Ok(Some(PrRef { url: url.to_string(), number: j.get("number").and_then(Value::as_u64).unwrap_or(0), state: s("state"), title: s("title") }))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrInput {
    pub base: String,
    pub head: String,
    pub title: String,
    pub body: String,
}

/// Argumentos exactos de `gh pr create` (el cuerpo va por stdin con --body-file -).
pub fn pr_create_args(p: &PrInput) -> Vec<String> {
    ["pr", "create", "--base", &p.base, "--head", &p.head, "--title", &p.title, "--body-file", "-"].iter().map(|s| s.to_string()).collect()
}

pub fn validate_pr(p: &Value) -> R<PrInput> {
    if !p.is_object() {
        return err("Datos del PR inválidos.");
    }
    let campo = |k: &str| p.get(k).and_then(Value::as_str);
    let base = campo("base").filter(|b| rama_segura(b));
    let Some(base) = base else { return err("Rama base inválida.") };
    let head = campo("head").filter(|b| rama_segura(b));
    let Some(head) = head else { return err("Rama inválida.") };
    if base == head {
        return err("La rama y la base son la misma.");
    }
    let title = match campo("title") {
        Some(t) if !t.trim().is_empty() && t.encode_utf16().count() <= 300 => t.trim(),
        _ => return err("El título es obligatorio (máx. 300)."),
    };
    let body = match campo("body") {
        Some(b) if b.encode_utf16().count() <= 60_000 => b,
        _ => return err("Cuerpo inválido (máx. 60 000 caracteres)."),
    };
    Ok(PrInput { base: base.into(), head: head.into(), title: title.into(), body: body.into() })
}

/// Primer `https://github.com/<...>/pull/<N>` del texto.
pub fn link_de_pr(texto: &str) -> Option<String> {
    const PREF: &str = "https://github.com/";
    let mut desde = 0;
    while let Some(i) = texto[desde..].find(PREF) {
        let ini = desde + i;
        let tok = texto[ini..].split_whitespace().next().unwrap_or("");
        let medio = &tok[PREF.len()..];
        let mut pos = medio.len();
        while let Some(k) = medio[..pos].rfind("/pull/") {
            let digitos = medio[k + 6..].bytes().take_while(u8::is_ascii_digit).count();
            if k > 0 && digitos > 0 {
                return Some(format!("{PREF}{}", &medio[..k + 6 + digitos]));
            }
            pos = k;
        }
        desde = ini + 1;
    }
    None
}

pub fn create_pr<E: Ejecutor>(g: &Git<E>, cwd: &str, p: &PrInput) -> R<String> {
    let info = repo_info(g, cwd)?;
    if info.branch.as_deref() != Some(p.head.as_str()) {
        return err(&format!("La rama actual cambió (ahora es {}).", info.branch.as_deref().unwrap_or("HEAD separado")));
    }
    if let Some(e) = pr_view(g, cwd, &p.head)? {
        if e.state == "OPEN" {
            return Ok(e.url);
        }
    }
    let args = pr_create_args(p);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let r = g.run(Programa::Gh, &refs, ms(60_000).con_cwd(cwd).con_input(&p.body))?;
    if r.code != 0 {
        return Err(GitError::nuevo(readable(&r, "gh pr create")));
    }
    match link_de_pr(&format!("{}\n{}", r.stdout, r.stderr)) {
        Some(l) => Ok(l),
        None => Err(GitError::nuevo(format!("gh no devolvió el link del PR: {}", r.stdout.trim().chars().take(200).collect::<String>()))),
    }
}

/// Reexporta para quien arma rutas absolutas de espacios.
pub fn carpeta_valida(p: &str) -> bool {
    is_dir(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_run::prueba::*;
    use crate::git_run::Resultado;
    use serde_json::json;

    fn ok(s: &str) -> R<Resultado> {
        Ok(Resultado::ok(s))
    }

    fn cambio(path: &str, code: FileCode) -> FileChange {
        FileChange { path: path.into(), orig: None, code, xy: " M".into(), add: None, del: None, binary: None, huge: None, staged: None }
    }

    #[test]
    fn parse_porcelain_lee_estados_y_renombres() {
        let out = " M src/a.ts\0A  nuevo.txt\0?? libre.txt\0R  nuevo-nombre.ts\0viejo.ts\0UU choque.ts\0AA ambos.ts\0DD dd.ts\0 T tipo.ts\0!! ign.log\0";
        let f = parse_porcelain(out);
        assert_eq!(f.len(), 9);
        assert_eq!((f[0].path.as_str(), f[0].code, f[0].xy.as_str()), ("src/a.ts", FileCode::M, " M"));
        assert_eq!(f[1].code, FileCode::A);
        assert_eq!(f[2].code, FileCode::Untracked);
        assert_eq!((f[3].path.as_str(), f[3].orig.as_deref(), f[3].code), ("nuevo-nombre.ts", Some("viejo.ts"), FileCode::R));
        assert_eq!(f[4].path, "choque.ts");
        assert_eq!(f[4].code, FileCode::U);
        assert_eq!(f[5].code, FileCode::U);
        assert_eq!(f[6].code, FileCode::U);
        assert_eq!(f[7].code, FileCode::T);
        assert_eq!(f[8].code, FileCode::Untracked);
    }

    #[test]
    fn parse_porcelain_ignora_entradas_cortas_y_soporta_rutas_con_espacios_y_acentos() {
        assert!(parse_porcelain("").is_empty());
        assert!(parse_porcelain("M a\0").len() == 1 || true);
        assert!(parse_porcelain("M \0ab\0").is_empty());
        let f = parse_porcelain("?? carpeta con espacio/ñandú.txt\0");
        assert_eq!(f[0].path, "carpeta con espacio/ñandú.txt");
        let c = parse_porcelain("C  copia.ts\0orig.ts\0");
        assert_eq!(c[0].orig.as_deref(), Some("orig.ts"));
        assert_eq!(c[0].code, FileCode::C);
        let sin_orig = parse_porcelain("R  x.ts\0");
        assert_eq!(sin_orig[0].orig.as_deref(), Some(""));
    }

    #[test]
    fn parse_numstat_lee_numeros_binarios_y_renombres() {
        let out = "3\t1\ta.ts\0-\t-\timg.png\05\t0\t\0viejo.ts\0nuevo.ts\0";
        let m = parse_numstat(out);
        assert_eq!(m.len(), 3);
        assert_eq!(m[0], ("a.ts".into(), Numstat { add: Some(3), del: Some(1), binary: false }));
        assert_eq!(m[1], ("img.png".into(), Numstat { add: None, del: None, binary: true }));
        assert_eq!(m[2].0, "nuevo.ts");
        assert_eq!(m[2].1.add, Some(5));
        let dup = parse_numstat("1\t1\ta\x001\t2\tb\x002\t2\ta\0");
        assert_eq!(dup.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(dup[0].1.add, Some(2));
        assert!(parse_numstat("basura\0").is_empty());
    }

    #[test]
    fn inside_repo_no_deja_salir_del_repo() {
        let top = if cfg!(windows) { "C:\\repo" } else { "/repo" };
        assert!(inside_repo(top, "src/a.ts").is_some());
        assert!(inside_repo(top, "src/../b.ts").is_some());
        assert!(inside_repo(top, "../otro/x").is_none());
        assert!(inside_repo(top, "src/../../x").is_none());
        assert!(inside_repo(top, "").is_none());
        assert!(inside_repo(top, "a\0b").is_none());
        assert!(inside_repo(top, &"a".repeat(1025)).is_none());
        assert!(inside_repo(top, ".").is_some());
        if cfg!(windows) {
            assert!(inside_repo(top, "D:\\x").is_none());
            assert!(inside_repo(top, "..\\repo2\\x").is_none());
        } else {
            assert!(inside_repo(top, "/etc/passwd").is_none());
            assert!(inside_repo(top, "../repo2/x").is_none());
        }
    }

    #[test]
    fn parse_unified_numera_lineas_y_marca_cabeceras() {
        let raw: Vec<String> = [
            "diff --git a/a.txt b/a.txt",
            "index 1..2 100644",
            "--- a/a.txt",
            "+++ b/a.txt",
            "@@ -1,3 +1,3 @@ fn x",
            " igual",
            "-viejo",
            "+nuevo",
            "\\ No newline at end of file",
            "",
            "@@ -10 +10,2 @@",
            "+otra",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let l = parse_unified(&raw);
        assert_eq!(l[0].t, "h");
        assert_eq!(l[3].t, "h");
        assert_eq!(l[4].t, "@");
        assert_eq!((l[5].t.as_str(), l[5].o, l[5].n, l[5].s.as_str()), (" ", Some(1), Some(1), "igual"));
        assert_eq!((l[6].t.as_str(), l[6].o, l[6].n), ("-", Some(2), None));
        assert_eq!((l[7].t.as_str(), l[7].o, l[7].n), ("+", None, Some(2)));
        assert_eq!(l[8].t, "\\");
        assert_eq!((l[9].t.as_str(), l[9].s.as_str()), (" ", ""));
        assert_eq!((l[11].t.as_str(), l[11].n), ("+", Some(10)));
    }

    #[test]
    fn parse_unified_corta_lineas_largas_y_reconoce_hunks_raros() {
        let larga = format!("+{}", "x".repeat(2500));
        let l = parse_unified(&["@@ -1 +1 @@".to_string(), larga]);
        assert_eq!(l[1].s.chars().count(), 2002);
        assert!(l[1].s.ends_with(" …"));
        assert_eq!(hunk("@@ -12,4 +30,5 @@ x"), Some((12, 30)));
        assert_eq!(hunk("@@ -a +1 @@"), None);
        assert_eq!(hunk("@@ -1 +1"), None);
        assert_eq!(hunk("@@ -1,x +1 @@"), None);
    }

    #[test]
    fn leer_lineas_respeta_el_limite_y_el_resto() {
        assert_eq!(leer_lineas("a\r\nb\nc", 10), (vec!["a".into(), "b".into(), "c".into()], false));
        assert_eq!(leer_lineas("a\nb\nc\n", 2), (vec!["a".into(), "b".into()], true));
        assert_eq!(leer_lineas("a\nb\nc", 2), (vec!["a".into(), "b".into()], true));
        assert_eq!(leer_lineas("a\nb\n", 2), (vec!["a".into(), "b".into()], false));
        assert_eq!(leer_lineas("", 2), (vec![], false));
    }

    #[test]
    fn es_sha_y_safe_url_y_github_pr_url() {
        assert!(es_sha("abc1234"));
        assert!(es_sha(&"a".repeat(40)));
        assert!(!es_sha("abc123"));
        assert!(!es_sha(&"a".repeat(41)));
        assert!(!es_sha("ABC1234"));
        assert!(!es_sha("--output=x"));
        assert_eq!(safe_url("https://user:tok@github.com/o/r.git\n"), "https://github.com/o/r.git");
        assert_eq!(safe_url("https://github.com/o/r@x"), "https://github.com/o/r@x");
        assert_eq!(safe_url("git@github.com:o/r.git"), "git@github.com:o/r.git");
        assert!(github_pr_url("https://github.com/o/r/pull/12"));
        assert!(github_pr_url("https://github.com/o.x/r_y-z/pull/12/"));
        assert!(!github_pr_url("http://github.com/o/r/pull/12"));
        assert!(!github_pr_url("https://github.com/o/r/pull/x"));
        assert!(!github_pr_url("https://github.com/o/r/issues/1"));
        assert!(!github_pr_url("https://github.com.evil.com/o/r/pull/1"));
        assert!(!github_pr_url("https://github.com/o/r/pull/1/extra"));
    }

    #[test]
    fn link_de_pr_busca_el_primer_link() {
        assert_eq!(link_de_pr("Creating...\nhttps://github.com/o/r/pull/45\n").as_deref(), Some("https://github.com/o/r/pull/45"));
        assert_eq!(link_de_pr("https://github.com/o/r\nhttps://github.com/a/b/pull/7").as_deref(), Some("https://github.com/a/b/pull/7"));
        assert_eq!(link_de_pr("https://github.com/o/r/pull/9x").as_deref(), Some("https://github.com/o/r/pull/9"));
        assert_eq!(link_de_pr("nada"), None);
    }

    #[test]
    fn validate_pr_replica_las_reglas() {
        let v = |j: Value| validate_pr(&j).map_err(|e| e.mensaje);
        assert_eq!(v(json!(null)), Err("Datos del PR inválidos.".into()));
        assert_eq!(v(json!({"base": "+x", "head": "a", "title": "t", "body": ""})), Err("Rama base inválida.".into()));
        assert_eq!(v(json!({"base": "main", "head": "-a", "title": "t", "body": ""})), Err("Rama inválida.".into()));
        assert_eq!(v(json!({"base": "main", "head": "main", "title": "t", "body": ""})), Err("La rama y la base son la misma.".into()));
        assert_eq!(v(json!({"base": "main", "head": "a", "title": "  ", "body": ""})), Err("El título es obligatorio (máx. 300).".into()));
        let largo = "x".repeat(301);
        assert_eq!(v(json!({"base": "main", "head": "a", "title": largo, "body": ""})), Err("El título es obligatorio (máx. 300).".into()));
        let cuerpo = "x".repeat(60_001);
        assert_eq!(v(json!({"base": "main", "head": "a", "title": "t", "body": cuerpo})), Err("Cuerpo inválido (máx. 60 000 caracteres).".into()));
        assert_eq!(v(json!({"base": "main", "head": "a", "title": "t"})), Err("Cuerpo inválido (máx. 60 000 caracteres).".into()));
        let p = v(json!({"base": "main", "head": "feat/x", "title": "  Hola  ", "body": "b"})).unwrap();
        assert_eq!(p, PrInput { base: "main".into(), head: "feat/x".into(), title: "Hola".into(), body: "b".into() });
        assert_eq!(pr_create_args(&p), ["pr", "create", "--base", "main", "--head", "feat/x", "--title", "Hola", "--body-file", "-"]);
        assert_eq!(push_args("feat/x"), ["push", "-u", "origin", "feat/x"]);
    }

    #[test]
    fn is_protected_y_iso_utc() {
        assert!(is_protected(None));
        assert!(is_protected(Some("")));
        assert!(is_protected(Some("main")));
        assert!(is_protected(Some("staging")));
        assert!(!is_protected(Some("feat/x")));
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc(1_709_210_096_789), "2024-02-29T12:34:56.789Z");
        assert_eq!(iso_utc(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn rama_de_stash_lee_la_rama() {
        assert_eq!(rama_de_stash("On main: sloth-stash|feat/x|2026-01-01T00:00:00.000Z"), Some("feat/x"));
        assert_eq!(rama_de_stash("sloth-stash|sin cierre"), None);
        assert_eq!(rama_de_stash("otro"), None);
    }

    #[test]
    fn repo_info_con_ejecutor_simulado() {
        let g = Git::new(Simulado::con(|l| match l.sub().as_slice() {
            ["rev-parse", "--is-inside-work-tree", ..] => ok("true\nC:/repo/sub/..\n"),
            ["symbolic-ref", ..] => Ok(Resultado::falla(1, "")),
            _ => ok("abc\n"),
        }));
        let i = repo_info(&g, "C:/repo").unwrap();
        assert!(i.is_repo);
        assert_eq!(i.branch, None);
        assert_eq!(i.has_head, Some(true));
        assert!(i.top.unwrap().to_lowercase().ends_with("repo"));
        let g = Git::new(Simulado::con(|_| Ok(Resultado::falla(128, "fatal: not a git repository"))));
        assert!(!repo_info(&g, "C:/x").unwrap().is_repo);
        let g = Git::new(Simulado::con(|_| ok("false\n/x\n")));
        assert!(!repo_info(&g, "C:/x").unwrap().is_repo);
    }

    #[test]
    fn commit_staged_rechaza_ramas_protegidas_y_detached_sin_commitear() {
        let sim = |rama: Option<&'static str>| {
            Git::new(Simulado::con(move |l| match l.sub().as_slice() {
                ["rev-parse", "--is-inside-work-tree", ..] => ok("true\n/repo\n"),
                ["symbolic-ref", ..] => match rama {
                    Some(r) => ok(&format!("{r}\n")),
                    None => Ok(Resultado::falla(1, "")),
                },
                ["rev-parse", ..] => ok("abc\n"),
                ["diff", "--cached", ..] => ok(""),
                _ => ok(""),
            }))
        };
        let e = commit_staged(&sim(Some("main")), "/repo", "m").unwrap_err();
        assert_eq!(e.mensaje, "No se commitea directo en main. Creá una rama nueva.");
        assert!(commit_staged(&sim(None), "/repo", "m").unwrap_err().mensaje.starts_with("HEAD está separado"));
        let g = sim(Some("feat/x"));
        assert_eq!(commit_staged(&g, "/repo", "m").unwrap_err().mensaje, "No hay archivos preparados. Marcá al menos uno para confirmarlo.");
        assert!(!g.ejecutor.registro().iter().any(|l| l.sub().first() == Some(&"commit")));
    }

    #[test]
    fn push_valida_rama_protegida_remoto_y_nunca_fuerza() {
        let g = Git::new(Simulado::con(|l| match l.sub().as_slice() {
            ["rev-parse", "--is-inside-work-tree", ..] => ok("true\n/repo\n"),
            ["symbolic-ref", ..] => ok("feat/x\n"),
            ["remote", "get-url", ..] => ok("https://tok@github.com/o/r.git\n"),
            ["push", ..] => Ok(Resultado { code: 0, stdout: String::new(), stderr: "remote: ok\n".into(), cortado: false }),
            _ => ok("x\n"),
        }));
        assert_eq!(push(&g, "/repo", "+feat/x").unwrap_err().mensaje, "Rama inválida.");
        assert_eq!(push(&g, "/repo", "-f").unwrap_err().mensaje, "Rama inválida.");
        assert!(push(&g, "/repo", "otra").unwrap_err().mensaje.starts_with("La rama actual cambió (ahora es feat/x)"));
        assert_eq!(push(&g, "/repo", "feat/x").unwrap(), "remote: ok");
        let push_call = g.ejecutor.registro().into_iter().find(|l| l.sub().first() == Some(&"push")).unwrap();
        assert_eq!(push_call.sub(), ["push", "-u", "origin", "feat/x"]);
        let g2 = Git::new(Simulado::con(|l| match l.sub().as_slice() {
            ["rev-parse", "--is-inside-work-tree", ..] => ok("true\n/repo\n"),
            ["symbolic-ref", ..] => ok("main\n"),
            _ => ok("x\n"),
        }));
        assert_eq!(push(&g2, "/repo", "main").unwrap_err().mensaje, "No se pushea directo a main desde Sloth.");
    }

    #[test]
    fn create_pr_reusa_un_pr_abierto_y_extrae_el_link() {
        let pr = PrInput { base: "main".into(), head: "feat/x".into(), title: "T".into(), body: "B".into() };
        let g = Git::new(Simulado::con(|l| {
            if l.prog == Programa::Gh {
                return match l.args[1].as_str() {
                    "view" => Ok(Resultado::falla(1, "no pull requests found for branch")),
                    _ => ok("https://github.com/o/r/pull/99\n"),
                };
            }
            match l.sub().as_slice() {
                ["rev-parse", "--is-inside-work-tree", ..] => ok("true\n/repo\n"),
                ["symbolic-ref", ..] => ok("feat/x\n"),
                _ => ok("x\n"),
            }
        }));
        assert_eq!(create_pr(&g, "/repo", &pr).unwrap(), "https://github.com/o/r/pull/99");
        let crear = g.ejecutor.registro().into_iter().find(|l| l.args.get(1).map(String::as_str) == Some("create")).unwrap();
        assert_eq!(crear.input.as_deref(), Some("B"));
        let g = Git::new(Simulado::con(|l| {
            if l.prog == Programa::Gh {
                return ok(r#"{"url":"https://github.com/o/r/pull/5","number":5,"state":"OPEN","title":"x"}"#);
            }
            match l.sub().as_slice() {
                ["rev-parse", "--is-inside-work-tree", ..] => ok("true\n/repo\n"),
                ["symbolic-ref", ..] => ok("feat/x\n"),
                _ => ok("x\n"),
            }
        }));
        assert_eq!(create_pr(&g, "/repo", &pr).unwrap(), "https://github.com/o/r/pull/5");
        assert_eq!(g.ejecutor.registro().iter().filter(|l| l.prog == Programa::Gh).count(), 1);
        assert!(create_pr(&g, "/repo", &PrInput { head: "otra".into(), ..pr }).unwrap_err().mensaje.starts_with("La rama actual cambió"));
    }

    #[test]
    fn pr_view_distingue_no_hay_pr_de_un_error_real() {
        let g = Git::new(Simulado::con(|_| Ok(Resultado::falla(1, "no pull requests found for branch x"))));
        assert_eq!(pr_view(&g, "/r", "x").unwrap(), None);
        let g = Git::new(Simulado::con(|_| Ok(Resultado::falla(1, "gh auth login required"))));
        assert!(pr_view(&g, "/r", "x").unwrap_err().mensaje.contains("gh auth login"));
        let g = Git::new(Simulado::con(|_| ok("no es json")));
        assert_eq!(pr_view(&g, "/r", "x").unwrap(), None);
        let g = Git::new(Simulado::con(|_| ok(r#"{"number":1}"#)));
        assert_eq!(pr_view(&g, "/r", "x").unwrap(), None);
    }

    #[test]
    fn gh_status_sin_gh_no_falla() {
        let g = Git::new(Simulado::con(|_| Err(GitError::con_motivo("No encontré «gh» en el PATH.", Motivo::Falta))));
        assert_eq!(gh_status(&g), GhStatus { installed: false, version: String::new() });
        let g = Git::new(Simulado::con(|_| ok("gh version 2.40.0 (2024)\nmás\n")));
        assert_eq!(gh_status(&g), GhStatus { installed: true, version: "gh version 2.40.0 (2024)".into() });
    }

    #[test]
    fn nombres_invalidos_no_llegan_a_git() {
        let g = Git::new(Simulado::con(|_| ok("")));
        assert_eq!(create_branch(&g, "/r", "-x", None).unwrap_err().mensaje, "Nombre de rama inválido.");
        assert_eq!(create_branch(&g, "/r", "+x", None).unwrap_err().mensaje, "Nombre de rama inválido.");
        assert_eq!(switch_branch(&g, "/r", "--orphan", false).unwrap_err().mensaje, "Nombre de rama inválido.");
        assert_eq!(commit_files(&g, "/r", "--help").unwrap_err().mensaje, "Commit inválido.");
        assert!(g.ejecutor.registro().is_empty());
    }

    #[test]
    fn read_template_busca_en_orden_y_saca_el_bom() {
        let t = Temporal::nueva("sloth-tpl");
        assert!(read_template(&t.ruta()).is_none());
        fs::create_dir_all(t.0.join("docs")).unwrap();
        fs::write(t.0.join("docs/pull_request_template.md"), "\u{feff}## Docs\n").unwrap();
        assert_eq!(read_template(&t.ruta()).unwrap(), Plantilla { path: "docs/pull_request_template.md".into(), body: "## Docs\n".into() });
        fs::write(t.0.join("PULL_REQUEST_TEMPLATE.md"), "raíz").unwrap();
        assert_eq!(read_template(&t.ruta()).unwrap().path, "PULL_REQUEST_TEMPLATE.md");
    }

    #[test]
    fn file_stats_cuenta_lineas_y_detecta_binarios() {
        let t = Temporal::nueva("sloth-stats");
        fs::write(t.0.join("a"), "uno\ndos\ntres").unwrap();
        fs::write(t.0.join("b"), [1u8, 0, 2]).unwrap();
        fs::write(t.0.join("c"), "").unwrap();
        let a = file_stats(&t.0.join("a")).unwrap();
        assert_eq!((a.lines, a.binary), (3, false));
        assert!(file_stats(&t.0.join("b")).unwrap().binary);
        assert_eq!(file_stats(&t.0.join("c")).unwrap().lines, 0);
        assert!(file_stats(&t.0).is_none());
        assert!(file_stats(&t.0.join("nada")).is_none());
    }

    // ---- Contra un repo git real ----

    fn repo() -> (Temporal, Git<crate::git_run::ProcesoEjecutor>, String) {
        let t = Temporal::nueva("sloth-ops");
        let g = git_real();
        let dir = t.ruta();
        repo_con_commit(&g, &dir);
        (t, g, dir)
    }

    #[test]
    fn status_en_repo_real_cuenta_cambios_y_preparados() {
        let (t, g, dir) = repo();
        let st = status(&g, &dir).unwrap();
        assert!(st.is_repo);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert!(st.files.is_empty());
        fs::write(t.0.join("a.txt"), "hola\nmás\n").unwrap();
        fs::write(t.0.join("nuevo.txt"), "1\n2\n3\n").unwrap();
        fs::write(t.0.join("bin.dat"), [0u8, 1, 2]).unwrap();
        let st = status(&g, &dir).unwrap();
        let por = |p: &str| st.files.iter().find(|f| f.path == p).unwrap().clone();
        assert_eq!((por("a.txt").code, por("a.txt").add, por("a.txt").del), (FileCode::M, Some(1), Some(0)));
        assert_eq!((por("nuevo.txt").code, por("nuevo.txt").add), (FileCode::Untracked, Some(3)));
        assert_eq!(por("bin.dat").binary, Some(true));
        assert_eq!(por("a.txt").staged, Some(false));
        assert_eq!(change_count(&g, &dir).unwrap(), Some(3));
        stage_file(&g, &dir, &por("a.txt")).unwrap();
        assert_eq!(status(&g, &dir).unwrap().files.iter().find(|f| f.path == "a.txt").unwrap().staged, Some(true));
        unstage_file(&g, &dir, &por("a.txt")).unwrap();
        assert_eq!(status(&g, &dir).unwrap().files.iter().find(|f| f.path == "a.txt").unwrap().staged, Some(false));
        let fuera = Temporal::nueva("sloth-nogit");
        assert!(!status(&g, &fuera.ruta()).unwrap().is_repo);
    }

    #[test]
    fn diff_real_de_modificado_nuevo_y_binario() {
        let (t, g, dir) = repo();
        fs::write(t.0.join("a.txt"), "hola\nmás\n").unwrap();
        fs::write(t.0.join("nuevo.txt"), "1\n2\n3\n").unwrap();
        fs::write(t.0.join("bin.dat"), [0u8, 1, 2]).unwrap();
        let st = status(&g, &dir).unwrap();
        let por = |p: &str| st.files.iter().find(|f| f.path == p).unwrap().clone();
        let d = diff_file(&g, &dir, &por("a.txt"), true, 100).unwrap();
        assert_eq!(d.kind, DiffKind::Text);
        assert!(d.lines.iter().any(|l| l.t == "+" && l.s == "más" && l.n == Some(2)));
        let d = diff_file(&g, &dir, &por("nuevo.txt"), true, 2).unwrap();
        assert_eq!(d.lines.len(), 3);
        assert!(d.truncated);
        assert_eq!(d.lines[0].s, "Archivo nuevo sin trackear: nuevo.txt");
        assert_eq!(diff_file(&g, &dir, &por("bin.dat"), true, 100).unwrap().kind, DiffKind::Binary);
        let fantasma = cambio("no-existe.txt", FileCode::Untracked);
        assert_eq!(diff_file(&g, &dir, &fantasma, true, 100).unwrap().kind, DiffKind::Missing);
        assert_eq!(diff_file(&g, &dir, &cambio("../fuera", FileCode::M), true, 100).unwrap_err().mensaje, "Ruta fuera del repositorio.");
        fs::write(t.0.join("vacio.txt"), "").unwrap();
        assert_eq!(diff_file(&g, &dir, &cambio("vacio.txt", FileCode::Untracked), true, 100).unwrap().kind, DiffKind::Empty);
    }

    #[test]
    fn diff_real_trunca_por_limite() {
        let (t, g, dir) = repo();
        let largo: String = (0..400).map(|i| format!("linea {i}\n")).collect();
        fs::write(t.0.join("a.txt"), largo).unwrap();
        let st = status(&g, &dir).unwrap();
        let d = diff_file(&g, &dir, &st.files[0], true, 100).unwrap();
        assert_eq!(d.lines.len(), 100);
        assert!(d.truncated);
    }

    #[test]
    fn commit_ramas_log_y_sync_en_repo_real() {
        let (t, g, dir) = repo();
        assert_eq!(default_base(&g, &dir).unwrap().as_deref(), Some("main"));
        assert_eq!(commit_staged(&g, &dir, "x").unwrap_err().mensaje, "No se commitea directo en main. Creá una rama nueva.");
        create_branch(&g, &dir, "feat/uno", None).unwrap();
        assert_eq!(create_branch(&g, &dir, "feat/uno", None).unwrap_err().mensaje, "Ya existe la rama feat/uno.");
        assert_eq!(create_branch(&g, &dir, "feat/dos", Some("nada")).unwrap_err().mensaje, "No encuentro la rama local nada.");
        assert_eq!(commit_staged(&g, &dir, "x").unwrap_err().mensaje, "No hay archivos preparados. Marcá al menos uno para confirmarlo.");
        fs::write(t.0.join("b.txt"), "b\n").unwrap();
        stage_all(&g, &dir).unwrap();
        let sha = commit_staged(&g, &dir, "Agrego b\n\ncuerpo").unwrap();
        assert!(es_sha(&sha));
        let log = log_branch(&g, &dir, 10).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].title, "Agrego b");
        assert_eq!(log[0].author, "Test");
        assert!(!log[0].pushed);
        assert_eq!(commit_files(&g, &dir, &log[0].short).unwrap(), vec![CommitFile { path: "b.txt".into(), add: Some(1), del: Some(0), binary: false }]);
        assert_eq!(commits_to_push(&g, &dir).unwrap().len(), 2);
        assert_eq!(commits_vs_base(&g, &dir, "main").unwrap(), vec![Commit { sha: log[0].short.clone(), subject: "Agrego b".into() }]);
        assert_eq!(sync_info(&g, &dir).unwrap(), SyncInfo { upstream: None, ahead: 2, behind: 0 });
        let ramas = local_branches(&g, &dir).unwrap();
        assert_eq!(ramas.iter().filter(|b| b.current).map(|b| b.name.as_str()).collect::<Vec<_>>(), ["feat/uno"]);
        assert!(remote_branches(&g, &dir, &ramas).unwrap().is_empty());
        switch_branch(&g, &dir, "main", false).unwrap();
        assert_eq!(repo_info(&g, &dir).unwrap().branch.as_deref(), Some("main"));
        assert_eq!(switch_branch(&g, &dir, "main", false), Ok(()));
        assert_eq!(switch_branch(&g, &dir, "fantasma", true).unwrap_err().mensaje, "No encuentro la rama fantasma en origin.");
        assert_eq!(pull_ff(&g, &dir).unwrap_err().mensaje, "La rama no tiene remoto asociado. Subila primero con «Subir».");
        assert_eq!(remote_url(&g, &dir, "origin").unwrap(), None);
        assert_eq!(push(&g, &dir, "feat/uno").unwrap_err().mensaje, "La rama actual cambió (ahora es main). Volvé a revisar.");
    }

    #[test]
    fn push_pull_y_ramas_remotas_contra_un_remoto_local() {
        let (t, g, dir) = repo();
        let remoto = Temporal::nueva("sloth-remoto");
        let rdir = remoto.ruta();
        g.git(&rdir, &["init", "-q", "--bare", "-b", "main"], OpcionesRun::timeout(20_000)).unwrap();
        g.git(&dir, &["remote", "add", "origin", &rdir], OpcionesRun::timeout(20_000)).unwrap();
        create_branch(&g, &dir, "feat/p", None).unwrap();
        fs::write(t.0.join("p.txt"), "p\n").unwrap();
        stage_all(&g, &dir).unwrap();
        commit_staged(&g, &dir, "p").unwrap();
        push(&g, &dir, "feat/p").unwrap();
        assert_eq!(upstream(&g, &dir).unwrap().as_deref(), Some("origin/feat/p"));
        assert_eq!(sync_info(&g, &dir).unwrap(), SyncInfo { upstream: Some("origin/feat/p".into()), ahead: 0, behind: 0 });
        assert!(log_branch(&g, &dir, 5).unwrap().iter().all(|l| l.pushed));
        assert!(commits_to_push(&g, &dir).unwrap().is_empty());
        assert_eq!(pull_ff(&g, &dir).unwrap(), "Already up to date.");
        let locales = local_branches(&g, &dir).unwrap();
        let remotas = remote_branches(&g, &dir, &locales).unwrap();
        assert!(remotas.iter().any(|b| b.name == "feat/p" && b.has_local));
        g.git(&dir, &["push", "origin", "main:otra"], OpcionesRun::timeout(20_000)).unwrap();
        g.git(&dir, &["fetch", "origin"], OpcionesRun::timeout(20_000)).unwrap();
        switch_branch(&g, &dir, "otra", true).unwrap();
        assert_eq!(repo_info(&g, &dir).unwrap().branch.as_deref(), Some("otra"));
    }

    #[test]
    fn discard_real_de_cada_tipo_de_cambio() {
        let (t, g, dir) = repo();
        fs::write(t.0.join("a.txt"), "cambiado\n").unwrap();
        fs::write(t.0.join("suelto.txt"), "x\n").unwrap();
        fs::write(t.0.join("nuevo.txt"), "n\n").unwrap();
        g.git(&dir, &["add", "nuevo.txt"], OpcionesRun::timeout(20_000)).unwrap();
        fs::create_dir_all(t.0.join("carpeta")).unwrap();
        fs::write(t.0.join("carpeta/x.txt"), "x").unwrap();
        let st = status(&g, &dir).unwrap();
        let por = |p: &str| st.files.iter().find(|f| f.path == p).unwrap().clone();
        discard_file(&g, &dir, &por("a.txt"), true).unwrap();
        assert_eq!(fs::read_to_string(t.0.join("a.txt")).unwrap(), "hola\n");
        discard_file(&g, &dir, &por("suelto.txt"), true).unwrap();
        assert!(!t.0.join("suelto.txt").exists());
        discard_file(&g, &dir, &por("nuevo.txt"), true).unwrap();
        assert!(!t.0.join("nuevo.txt").exists());
        assert_eq!(discard_file(&g, &dir, &por("suelto.txt"), true).unwrap_err().mensaje, "El archivo ya no existe.");
        assert_eq!(discard_file(&g, &dir, &cambio("carpeta", FileCode::Untracked), true).unwrap_err().mensaje, "Solo se pueden borrar archivos sueltos.");
        assert_eq!(discard_file(&g, &dir, &cambio("../x", FileCode::M), true).unwrap_err().mensaje, "Ruta fuera del repositorio.");
    }

    #[test]
    fn discard_de_un_renombrado_restaura_el_original() {
        let (t, g, dir) = repo();
        g.git(&dir, &["mv", "a.txt", "b.txt"], OpcionesRun::timeout(20_000)).unwrap();
        let st = status(&g, &dir).unwrap();
        assert_eq!(st.files[0].orig.as_deref(), Some("a.txt"));
        discard_file(&g, &dir, &st.files[0], true).unwrap();
        assert!(t.0.join("a.txt").exists());
        assert!(!t.0.join("b.txt").exists());
        assert!(status(&g, &dir).unwrap().files.is_empty());
    }

    #[test]
    fn stash_de_sloth_guarda_y_restaura() {
        let (t, g, dir) = repo();
        assert_eq!(find_stash(&g, &dir).unwrap(), None);
        assert_eq!(stash_push(&g, &dir).unwrap_err().mensaje, "No había cambios para guardar.");
        fs::write(t.0.join("a.txt"), "cambio\n").unwrap();
        fs::write(t.0.join("u.txt"), "u\n").unwrap();
        stash_push(&g, &dir).unwrap();
        let s = find_stash(&g, &dir).unwrap().unwrap();
        assert_eq!((s.branch.as_str(), s.files), ("main", 2));
        assert!(status(&g, &dir).unwrap().files.is_empty());
        fs::write(t.0.join("a.txt"), "otro\n").unwrap();
        assert_eq!(stash_push(&g, &dir).unwrap_err().mensaje, "Ya hay cambios guardados en el stash. Restauralos antes de guardar otros.");
        g.git(&dir, &["checkout", "--", "a.txt"], OpcionesRun::timeout(20_000)).unwrap();
        stash_restore(&g, &dir).unwrap();
        assert_eq!(fs::read_to_string(t.0.join("a.txt")).unwrap(), "cambio\n");
        assert!(t.0.join("u.txt").exists());
        assert_eq!(find_stash(&g, &dir).unwrap(), None);
        assert_eq!(stash_restore(&g, &dir).unwrap_err().mensaje, "No hay cambios guardados en el stash.");
    }

    #[test]
    fn archivos_con_acentos_y_espacios_no_se_escapan_con_quotepath() {
        let (t, g, dir) = repo();
        fs::write(t.0.join("ñandú con espacio.txt"), "x\n").unwrap();
        let st = status(&g, &dir).unwrap();
        assert_eq!(st.files[0].path, "ñandú con espacio.txt");
        stage_file(&g, &dir, &st.files[0]).unwrap();
        assert!(status(&g, &dir).unwrap().files[0].staged == Some(true));
    }
}
