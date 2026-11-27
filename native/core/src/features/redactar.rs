//! Quita secretos y datos personales de un texto antes de copiarlo o guardarlo. Equivale a src/main/diag/redactar.ts.
//! Los patrones llevan lookaround, por eso `fancy-regex`; `\w`, `\s` y `\d` de JavaScript son ASCII y acá se escriben como clases.
use fancy_regex::{Captures, Regex, RegexBuilder};
use std::sync::OnceLock;

pub struct ContextoRedaccion<'a> {
    pub home: &'a str,
    pub user_data: &'a str,
}

const CLAVES: &str = "token|secret|password|passwd|pwd|pass(?![a-z])|session[_-]?(?:id|key|secret)|_key|tema|api[_-]?key|authorization|cookie|credential|private[_-]?key|access[_-]?key|topic|clave|secreto";
/// Los blancos de `\s` de JavaScript, para usar dentro de una clase.
const WS: &str = r"\t\n\r\x0b\x0c \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const W: &str = "A-Za-z0-9_";

fn compilar(p: &str) -> Regex {
    RegexBuilder::new(p)
        .backtrack_limit(usize::MAX)
        .delegate_size_limit(256 << 20)
        .delegate_dfa_size_limit(256 << 20)
        .build()
        .unwrap_or_else(|e| panic!("patrón inválido {p}: {e}"))
}

struct Patrones {
    pares: Regex,
    inicio_clave: Regex,
    fin_clave: Regex,
    tokens: Vec<Regex>,
    bearer: Regex,
    basic: Regex,
    credenciales_url: Regex,
    token_como_usuario: Regex,
    clave_celu: Regex,
    largo_opaco: Regex,
    email: Regex,
    ruta_windows: Regex,
    ruta_unix: Regex,
}

fn patrones() -> &'static Patrones {
    static P: OnceLock<Patrones> = OnceLock::new();
    P.get_or_init(|| {
        // Todos los cuantificadores están acotados: un texto largo sin forma de secreto no puede disparar backtracking.
        let valor = [
            r#"\\"[^\n]{0,500}?\\""#.to_string(),
            r#""(?:[^"\\\n]|\\[^\n\r\u2028\u2029]){0,2000}""#.to_string(),
            "'[^'\\n]{0,2000}'".to_string(),
            format!("(?:Bearer|Basic)[{WS}]{{1,20}}[^{WS}]{{1,2000}}"),
            format!(r#"[\\"']{{0,2}}[^{WS}"',;&}}\\]{{1,2000}}"#),
        ]
        .join("|");
        let pares = format!(r#"(?i)((?:{CLAVES})[{W}.-]{{0,40}}\\?["']?[ \t]{{0,5}}[:=][ \t]{{0,5}})(?:{valor})"#);
        let tokens = [
            "sk-ant-[A-Za-z0-9_-]{10,}",
            "(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}",
            "gh[pousr]_[A-Za-z0-9]{20,}",
            "github_pat_[A-Za-z0-9_]{20,}",
            "sb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}",
            "xox[abprs]-[A-Za-z0-9-]{10,}",
            "AKIA[0-9A-Z]{16}",
            "AIza[0-9A-Za-z_-]{35}",
            "glpat-[A-Za-z0-9_-]{20,}",
            r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
            "sloth-[0-9a-f]{16,}",
        ];
        Patrones {
            pares: compilar(&pares),
            inicio_clave: compilar("-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----"),
            fin_clave: compilar("-----END [A-Z ]{0,40}PRIVATE KEY-----"),
            tokens: tokens.iter().map(|t| compilar(t)).collect(),
            bearer: compilar(&format!(r#"(?i)\bBearer[{WS}]{{1,20}}[^{WS}"'<>,;}}]{{1,2000}}"#)),
            basic: compilar(&format!(r"(?i)\bBasic[{WS}]{{1,20}}[A-Za-z0-9+/=]{{8,2000}}")),
            credenciales_url: compilar(&format!(r"(://)[^{WS}/:@]{{1,200}}:[^{WS}/@]{{1,200}}@")),
            token_como_usuario: compilar(&format!(r"(://)[^{WS}/:@]{{20,200}}@")),
            clave_celu: compilar(&format!(r#"([#?&]k=)[^{WS}&#"']{{1,500}}"#)),
            largo_opaco: compilar("(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}"),
            email: compilar(r"[A-Za-z0-9_.+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,10}\.[A-Za-z]{2,24}"),
            ruta_windows: compilar(&format!(r#"(?i)([A-Za-z]:[\\/]+users[\\/]+)[^\\/{WS}"'<>|:*?]+"#)),
            ruta_unix: compilar(&format!(r#"(/(?:home|Users)/)[^\\/{WS}"'<>|:*?]+"#)),
        }
    })
}

fn es_separador(c: char) -> bool {
    c == '\\' || c == '/'
}

/// Una ruta literal como patrón: los separadores `\` y `/` dan igual y no se distinguen mayúsculas. El fin con
/// lookahead evita que «C:\Users\Ana» se coma el prefijo de «C:\Users\Analia».
fn ruta_literal(ruta: &str) -> Option<Regex> {
    let partes: Vec<&str> = ruta.split(es_separador).filter(|p| !p.is_empty()).collect();
    if ruta.encode_utf16().count() < 3 || partes.is_empty() {
        return None;
    }
    let inicio = if ruta.starts_with(es_separador) { r"[\\/]+" } else { "" };
    let cuerpo: Vec<String> = partes.iter().map(|p| fancy_regex::escape(p).into_owned()).collect();
    Some(compilar(&format!(r"(?i){inicio}{}(?![A-Za-z0-9_.-])", cuerpo.join(r"[\\/]+"))))
}

fn quitar_bloques_clave(texto: &str) -> String {
    let p = patrones();
    let mut salida = String::new();
    let mut desde = 0;
    loop {
        let Ok(Some(ini)) = p.inicio_clave.find_from_pos(texto, desde) else {
            salida.push_str(&texto[desde..]);
            return salida;
        };
        salida.push_str(&texto[desde..ini.start()]);
        salida.push_str("[clave privada]");
        // Sin cierre (el texto vino cortado): se tapa todo lo que sigue.
        let Ok(Some(fin)) = p.fin_clave.find_from_pos(texto, ini.end()) else { return salida };
        desde = fin.end();
    }
}

/// Cadenas largas con mayúsculas, minúsculas y dígitos: tokens sueltos como el de la clave del celu. Un hash de git
/// (solo hex) o un nombre de rama con guiones no entran.
fn opaco(s: &str) -> bool {
    s.bytes().any(|b| b.is_ascii_lowercase()) && s.bytes().any(|b| b.is_ascii_uppercase()) && s.bytes().any(|b| b.is_ascii_digit())
}

fn reemplazar(re: &Regex, texto: &str, con: &str) -> String {
    re.replace_all(texto, con).into_owned()
}

pub fn redactar(texto: &str, ctx: &ContextoRedaccion) -> String {
    let p = patrones();
    let mut t = texto.to_string();
    if let Some(r) = ruta_literal(ctx.user_data) {
        t = reemplazar(&r, &t, "<userData>");
    }
    if let Some(r) = ruta_literal(ctx.home) {
        t = reemplazar(&r, &t, "~");
    }
    t = reemplazar(&p.ruta_windows, &t, "${1}<usuario>");
    t = reemplazar(&p.ruta_unix, &t, "${1}<usuario>");
    t = quitar_bloques_clave(&t);
    for re in &p.tokens {
        t = reemplazar(re, &t, "[token]");
    }
    t = reemplazar(&p.bearer, &t, "Bearer [token]");
    t = reemplazar(&p.basic, &t, "Basic [token]");
    t = reemplazar(&p.credenciales_url, &t, "${1}[redactado]@");
    t = reemplazar(&p.token_como_usuario, &t, "${1}[redactado]@");
    t = reemplazar(&p.clave_celu, &t, "${1}[redactado]");
    t = reemplazar(&p.pares, &t, "${1}[redactado]");
    t = reemplazar(&p.email, &t, "[email]");
    p.largo_opaco.replace_all(&t, |c: &Captures| if opaco(&c[0]) { "[token]".to_string() } else { c[0].to_string() }).into_owned()
}

/// Corta a `max` unidades UTF-16 y avisa; no parte un par sustituto.
pub fn acotar(texto: &str, max: usize) -> String {
    if texto.encode_utf16().count() <= max {
        return texto.to_string();
    }
    let mut unidades = 0;
    let corte: String = texto
        .chars()
        .take_while(|c| {
            unidades += c.len_utf16();
            unidades <= max
        })
        .collect();
    format!("{corte}…[cortado]")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    const CTX: ContextoRedaccion = ContextoRedaccion { home: "C:\\Users\\Maria", user_data: "C:\\Users\\Maria\\AppData\\Roaming\\Sloth" };

    // Se arman por partes para que ningún escáner de secretos del repo los tome por reales.
    fn ghp() -> String {
        format!("ghp_{}wxyz", "a1B2c3D4".repeat(4))
    }
    fn gh_pat() -> String {
        "github_pat_".to_string() + "11ABC0123456789" + "_xyzXYZ0123"
    }
    fn anthropic() -> String {
        "sk-ant-".to_string() + "api03-AbC123_xyz-0123456789abcdef"
    }
    fn jwt() -> &'static str {
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc_def-ghi"
    }
    const CLAVE_CELU: &str = "q7Zk3Vn0Rt5Yp2Lm8Xc4Hb6Jd9Fs1Gw-AaBbCcDdEe";

    fn sin_secreto(entrada: &str, secreto: &str, conserva: &[&str]) -> String {
        let salida = redactar(entrada, &CTX);
        assert!(!salida.contains(secreto), "se coló «{secreto}» en: {salida}");
        for c in conserva {
            assert!(salida.contains(c), "faltó «{c}» en: {salida}");
        }
        assert_eq!(redactar(&salida, &CTX), salida, "no es idempotente");
        salida
    }

    #[test]
    fn tokens_de_anthropic_y_openai() {
        let a = anthropic();
        sin_secreto(&format!("falló la llamada con {a} (401)"), &a, &["falló la llamada con", "(401)"]);
        let o = "sk-".to_string() + "proj1234567890abcdefghij";
        sin_secreto(&format!("OPENAI usó {o}."), &o, &["OPENAI usó"]);
    }

    #[test]
    fn tokens_de_github() {
        let g = ghp();
        sin_secreto(&format!("git push https://x@github.com con {g} listo"), &g, &["git push", "listo"]);
        let p = gh_pat();
        sin_secreto(&format!("token nuevo {p} guardado"), &p, &["guardado"]);
        for pre in ["gho_", "ghu_", "ghs_", "ghr_"] {
            let t = format!("{pre}{}", "Ab12".repeat(8));
            sin_secreto(&format!("usé {t} ayer"), &t, &["usé", "ayer"]);
        }
    }

    #[test]
    fn claves_de_supabase_slack_aws_y_jwt() {
        let sb = "sb_secret_".to_string() + "Zx9Qw8Er7Ty6Ui5";
        sin_secreto(&format!("SUPABASE_KEY {sb} y más"), &sb, &["y más"]);
        let sp = "sb_publishable_".to_string() + "Ab1Cd2Ef3Gh4Ij5";
        sin_secreto(&format!("anon {sp} y más"), &sp, &["y más"]);
        let slack = "xox".to_string() + "b-1234-5678-abcdef";
        sin_secreto(&format!("slack {slack} ok"), &slack, &["slack", "ok"]);
        let aws = "AKIA".to_string() + "IOSFODNN7EXAMPLE";
        sin_secreto(&format!("aws {aws} ok"), &aws, &["aws", "ok"]);
        let s = sin_secreto(&format!("sesión {} vencida", jwt()), jwt(), &["sesión", "vencida"]);
        assert!(!s.contains("eyJ"));
        sin_secreto(&format!("{{\"access\":\"{}\"}}", jwt()), jwt(), &[]);
    }

    #[test]
    fn bearer_basic_y_authorization() {
        sin_secreto("Authorization: Bearer abc.def", "abc.def", &["Authorization"]);
        sin_secreto("curl -H \"Authorization: Bearer abc.def\" https://api.example.com/x", "abc.def", &["https://api.example.com/x"]);
        sin_secreto("bearer tok_12345 y sigue", "tok_12345", &["y sigue"]);
        sin_secreto("Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA==", &["Authorization"]);
        sin_secreto("{\"headers\":{\"Authorization\":\"Bearer zzz.yyy.xxx\"}}", "zzz.yyy.xxx", &[]);
    }

    #[test]
    fn urls_con_credenciales() {
        let s = sin_secreto("clonando https://user:pa55@host.example/x.git ahora", "pa55", &["host.example/x.git", "ahora"]);
        assert!(!s.contains("user:"));
        sin_secreto("postgres://admin:s3cr3t-pw@db.interno:5432/app", "s3cr3t-pw", &["db.interno:5432/app"]);
    }

    #[test]
    fn pares_clave_valor_y_json() {
        sin_secreto("{\"apiKey\":\"abc123\"}", "abc123", &["apiKey"]);
        sin_secreto("{\"password\": \"con espacios y más\"}", "con espacios", &["password"]);
        sin_secreto("{'secret': 'hola mundo'}", "hola mundo", &["secret"]);
        sin_secreto("password=hunter2", "hunter2", &["password="]);
        sin_secreto("login falló password=hunter2 usuario=ana", "hunter2", &["login falló", "usuario=ana"]);
        sin_secreto("GITHUB_TOKEN=abcd1234efgh", "abcd1234efgh", &["GITHUB_TOKEN="]);
        sin_secreto("ANTHROPIC_API_KEY: valorSecreto77", "valorSecreto77", &["ANTHROPIC_API_KEY"]);
        sin_secreto("x-api-key: valorSecreto77", "valorSecreto77", &[]);
        sin_secreto("Cookie: sid=abc123xyz; theme=dark", "abc123xyz", &[]);
        sin_secreto("?access_token=tok99zz&page=2", "tok99zz", &["page=2"]);
        sin_secreto("client_secret = \"shh-no-contar\"", "shh-no-contar", &[]);
        sin_secreto("{\\\"password\\\":\\\"hunter2\\\"}", "hunter2", &[]);
        sin_secreto("password=\"sin cierre", "sin cierre", &[]);
        sin_secreto("clave: miClaveSecreta1", "miClaveSecreta1", &[]);
    }

    #[test]
    fn rutas_del_usuario_con_home_y_user_data() {
        let s = sin_secreto("Error en C:\\Users\\Maria\\Documents\\repo\\x.ts:10", "Maria", &["Documents\\repo\\x.ts:10"]);
        assert_eq!(s, "Error en ~\\Documents\\repo\\x.ts:10");
        assert_eq!(redactar("C:/Users/Maria/Documents/repo/x.ts", &CTX), "~/Documents/repo/x.ts");
        assert_eq!(redactar("c:\\users\\maria\\docs", &CTX), "~\\docs");
        assert_eq!(redactar("C:\\\\Users\\\\Maria\\\\docs", &CTX), "~\\\\docs");
        assert_eq!(redactar("C:\\Users\\Maria\\AppData\\Roaming\\Sloth\\logs\\sloth.log", &CTX), "<userData>\\logs\\sloth.log");
        assert_eq!(redactar("file:///C:/Users/Maria/AppData/Roaming/Sloth/x", &CTX), "file:///<userData>/x");
    }

    #[test]
    fn rutas_de_otros_usuarios_y_sistemas() {
        assert_eq!(redactar("C:\\Users\\Pedro\\x.ts", &CTX), "C:\\Users\\<usuario>\\x.ts");
        assert_eq!(redactar("C:/Users/Pedro/x.ts", &CTX), "C:/Users/<usuario>/x.ts");
        assert_eq!(redactar("/home/pepe/.config/sloth", &CTX), "/home/<usuario>/.config/sloth");
        assert_eq!(redactar("/Users/lola/Library/x", &CTX), "/Users/<usuario>/Library/x");
        assert_eq!(redactar("C:\\Users\\MariaLopez\\x", &CTX), "C:\\Users\\<usuario>\\x");
        sin_secreto("open /home/pepe/.config/sloth falló", "pepe", &["falló"]);
        let linux = ContextoRedaccion { home: "/home/pepe", user_data: "/home/pepe/.config/Sloth" };
        assert_eq!(redactar("leí /home/pepe/.config/Sloth/logs/a y /home/pepe/b", &linux), "leí <userData>/logs/a y ~/b");
        assert_eq!(redactar("/home/pepeluis/x", &linux), "/home/<usuario>/x");
    }

    #[test]
    fn contexto_vacio_o_corto_no_tapa_todo() {
        let vacio = ContextoRedaccion { home: "", user_data: "/" };
        assert_eq!(redactar("ruta /a/b/c y x", &vacio), "ruta /a/b/c y x");
    }

    #[test]
    fn emails() {
        sin_secreto("avisar a me@empresa.com mañana", "me@empresa.com", &["avisar a", "mañana"]);
        sin_secreto("de ana.perez+sloth@sub.dominio.com.ar", "ana.perez", &[]);
    }

    #[test]
    fn bloques_de_clave_privada() {
        let clave = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo", "4lgOEePzNm0tRgeLezV6ffAt0gun", "-----END RSA PRIVATE KEY-----"].join("\n");
        let s = sin_secreto(&format!("antes\n{clave}\ndespués"), "MIIEowIBAAKC", &["antes", "después", "[clave privada]"]);
        assert!(!s.contains("4lgOEePz") && !s.contains("BEGIN"));
        assert_eq!(redactar(&format!("{clave} intermedio {clave}"), &CTX), "[clave privada] intermedio [clave privada]");
        assert_eq!(redactar("x -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC", &CTX), "x [clave privada]");
        sin_secreto("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1", &[]);
    }

    #[test]
    fn clave_del_celu_y_topic_de_ntfy() {
        sin_secreto(&format!("abrí http://192.168.1.20:8765/#k={CLAVE_CELU} en el celu"), CLAVE_CELU, &["http://192.168.1.20:8765/#k=", "en el celu"]);
        sin_secreto(&format!("clave suelta {CLAVE_CELU} fin"), CLAVE_CELU, &["clave suelta", "fin"]);
        let topic = "sloth-0123456789abcdef01234567";
        sin_secreto(&format!("POST https://ntfy.sh/{topic} 200"), topic, &["POST https://ntfy.sh/", "200"]);
        sin_secreto("{\"topic\":\"mi-tema-privado\",\"title\":\"Terminó\"}", "mi-tema-privado", &["\"title\":\"Terminó\""]);
    }

    #[test]
    fn stack_con_rutas_y_secreto() {
        let a = anthropic();
        let stack = [format!("Error: 401 con {a}"), "    at llamar (C:\\Users\\Maria\\Documents\\Sloth\\src\\main\\x.ts:12:5)".to_string(), "    at async C:/Users/Maria/AppData/Roaming/Sloth/features/y.js:3:1".to_string()].join("\n");
        let s = sin_secreto(&stack, &a, &["Error: 401 con", "at llamar", "x.ts:12:5", "y.js:3:1"]);
        assert!(!s.contains("Maria"));
    }

    #[test]
    fn no_tapa_texto_normal() {
        for t in [
            "Sloth 0.6.28 arrancó",
            "commit e9d7265 en staging",
            "Merge pull request #85 from Toomasmg/sync/main-en-staging",
            "el token venció, pedí uno nuevo",
            "la palabra token sin valor",
            "Basic setup terminado",
            "Electron 33.0.0, Node 20.18.0 y Chrome 130.0.6723.44",
            "react@18.3.1 y @types/node@22.0.0",
            "versión 1.2.3-beta.4 (build 9981)",
            "task-manager-service-handler-extra-largo-x",
            "feat/diagnostico-etapa-1-redaccion-de-secretos-largos",
            "sha 5d68d2f0c1ab9e8d7f6a5b4c3d2e1f0a9b8c7d6e completo",
            "Error: ENOENT: no such file or directory",
            "Grupo A: 3 cuentas, 5 espacios",
            "a:b, c=d; x: y",
        ] {
            assert_eq!(redactar(t, &CTX), t);
        }
    }

    #[test]
    fn es_idempotente_con_todos_los_casos_juntos() {
        let todo = [
            anthropic(),
            ghp(),
            gh_pat(),
            "sb_secret_Zx9Qw8Er7Ty6Ui5".to_string(),
            "xoxb-1234-5678-abcdef".to_string(),
            "AKIAIOSFODNN7EXAMPLE".to_string(),
            jwt().to_string(),
            "Authorization: Bearer abc.def".to_string(),
            "https://user:pa55@host/x".to_string(),
            "{\"apiKey\":\"abc123\"}".to_string(),
            "password=hunter2".to_string(),
            "C:\\Users\\Maria\\Documents\\repo\\x.ts".to_string(),
            "/home/pepe/.config".to_string(),
            "me@empresa.com".to_string(),
            format!("http://10.0.0.2:8765/#k={CLAVE_CELU}"),
            "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----".to_string(),
        ]
        .join("\n");
        let una = redactar(&todo, &CTX);
        assert_eq!(redactar(&una, &CTX), una);
        for s in ["pa55", "hunter2", "abc123", "Maria", "pepe", "empresa.com", CLAVE_CELU] {
            assert!(!una.contains(s), "{s}");
        }
    }

    #[test]
    // En debug y con la suite en paralelo cada caso tarda segundos: el tope busca backtracking catastrófico, no velocidad.
    fn texto_enorme_sin_forma_de_secreto_no_se_cuelga() {
        let casos = [
            "a".repeat(100_000),
            "eyJ".repeat(33_000),
            "sk-".repeat(33_000),
            "Bearer ".repeat(14_000),
            "token".repeat(20_000),
            "a@".repeat(50_000),
            "-----BEGIN PRIVATE KEY-----".repeat(3_000),
            "a.".repeat(50_000),
            " ".repeat(100_000),
            "://".repeat(30_000),
            "password=".repeat(11_000),
            "C:\\Users\\".repeat(10_000),
            "\"".repeat(100_000),
        ];
        for c in &casos {
            let ini = Instant::now();
            redactar(c, &CTX);
            assert!(ini.elapsed().as_millis() < 30_000, "tardó {} ms con «{}»", ini.elapsed().as_millis(), &c[..c.len().min(12)]);
        }
        assert_eq!(redactar(&"a".repeat(100_000), &CTX).len(), 100_000);
    }

    #[test]
    fn acotar_corta_y_no_parte_un_par_sustituto() {
        assert_eq!(acotar("hola", 10), "hola");
        assert_eq!(acotar("hola", 4), "hola");
        assert_eq!(acotar("abcdefgh", 3), "abc…[cortado]");
        assert_eq!(acotar("abcdefgh", 0), "…[cortado]");
        assert_eq!(acotar("ab😀cd", 3), "ab…[cortado]");
        assert_eq!(acotar("ab😀cd", 4), "ab😀…[cortado]");
    }

    #[test]
    fn claves_de_google_y_gitlab() {
        let g = "AIza".to_string() + "Sy" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q";
        assert_eq!(g.len(), 39);
        sin_secreto(&format!("maps usó {g} ayer"), &g, &["maps usó", "ayer"]);
        let gl = "glpat-".to_string() + "Ab12Cd34Ef56Gh78Ij90";
        sin_secreto(&format!("clone con {gl} ok"), &gl, &["clone con", "ok"]);
    }

    #[test]
    fn pass_key_session_id_y_tema() {
        sin_secreto("pass=hunter2 listo", "hunter2", &["listo"]);
        sin_secreto("password=hunter3", "hunter3", &[]);
        sin_secreto("SUPABASE_KEY=abc123xyz y más", "abc123xyz", &["y más"]);
        sin_secreto("MI_TOKEN=zzz999 fin", "zzz999", &["fin"]);
        sin_secreto("session_id: s3cr3t7", "s3cr3t7", &[]);
        sin_secreto("{\"tema\":\"mi-canal-privado\"}", "mi-canal-privado", &[]);
    }

    #[test]
    fn no_se_pasa_de_rosca_con_palabras_parecidas() {
        for t in ["passed: 5 tests", "compass bypass listo", "la sesión: iniciada", "key: valor"] {
            assert_eq!(redactar(t, &CTX), t);
        }
    }

    #[test]
    fn token_como_usuario_en_una_url() {
        let t = "Zq8Xw7Ee6Rr5Tt4Yy3Uu2Ii1";
        sin_secreto(&format!("git clone https://{t}@github.com/a/b"), t, &["github.com/a/b"]);
        assert_eq!(redactar("https://ana@localhost/a/b", &CTX), "https://ana@localhost/a/b");
    }
}
