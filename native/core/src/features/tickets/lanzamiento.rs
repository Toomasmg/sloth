//! Cómo lanzar `exe args` sin shell. Un `.cmd` o `.bat` de npm en Windows solo corre por cmd.exe: la línea se arma acá, con
//! argumentos fijos y la ruta entre comillas (las de afuera las quita `/s`). Las comillas de un argumento se escapan con `\"`
//! para que el programa las reciba tal cual (el JSON de `enabled_tools`). Con una ruta o un argumento que cmd podría leer como
//! sintaxis, no se lanza. Equivale a src/main/features/tickets/lanzamiento.ts.
use super::errores::{ErrorTickets, Res};
use super::texto::re;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lanzamiento {
    pub file: String,
    pub args: Vec<String>,
    /// true: los argumentos ya son la línea de comandos entera y no hay que volver a entrecomillarlos.
    pub verbatim: bool,
}

pub fn lanzamiento_de(exe: &str, args: &[String], es_windows: bool) -> Res<Lanzamiento> {
    if !es_windows || !re(r"(?i)\.(cmd|bat)$").is_match(exe) {
        return Ok(Lanzamiento { file: exe.into(), args: args.to_vec(), verbatim: false });
    }
    // cmd lee estos caracteres como sintaxis aun entre comillas: una ruta así no se ejecuta.
    if exe.chars().any(|c| "%\"&^!<>|\r\n".contains(c)) || !re(r"^(?:[A-Za-z]:\\|\\\\[^\\])").is_match(exe) {
        return Err(ErrorTickets::otro("La ruta de Codex tiene caracteres que cmd.exe no acepta. Instalalo en una carpeta sin símbolos raros en el nombre."));
    }
    // Lo único que llevan los argumentos de `codex exec` de Sloth (opciones, nombres validados, JSON de herramientas). Sin
    // espacios ni nada que cmd lea como sintaxis.
    let seguro = re(r#"^[A-Za-z0-9_.=\-\[\],"]+$"#);
    if args.iter().any(|a| !seguro.is_match(a)) {
        return Err(ErrorTickets::otro("No se lanza Codex por cmd.exe: un argumento trae caracteres que cmd.exe leería como comandos."));
    }
    let linea = args.iter().map(|a| a.replace('"', "\\\"")).collect::<Vec<_>>().join(" ");
    let resto = if linea.is_empty() { String::new() } else { format!(" {linea}") };
    Ok(Lanzamiento { file: "cmd.exe".into(), args: vec!["/d".into(), "/s".into(), "/c".into(), format!("\"\"{exe}\"{resto}\"")], verbatim: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::tickets::conectores::conector_por_id;
    use crate::features::tickets::motor_codex::MOTOR_CODEX;
    use crate::features::tickets::motor_tickets::{MotorTickets, PedidoMotor, TareaMotor};

    fn argv() -> Vec<String> {
        ["exec", "--json", "-c", "approval_policy=\"never\"", "-c", "mcp_servers.gruv.enabled_tools=[\"a\",\"b\"]", "-"].iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn un_exe_o_cualquier_ejecutable_fuera_de_windows_va_tal_cual_y_sin_verbatim() {
        assert_eq!(lanzamiento_de("C:\\bin\\codex.exe", &argv(), true).unwrap(), Lanzamiento { file: "C:\\bin\\codex.exe".into(), args: argv(), verbatim: false });
        assert_eq!(lanzamiento_de("/usr/bin/codex", &argv(), false).unwrap(), Lanzamiento { file: "/usr/bin/codex".into(), args: argv(), verbatim: false });
        assert!(!lanzamiento_de("/usr/bin/codex.cmd", &argv(), false).unwrap().verbatim);
    }

    #[test]
    fn un_cmd_de_windows_corre_por_cmd_exe_verbatim_con_la_ruta_entre_comillas_y_las_comillas_escapadas() {
        let l = lanzamiento_de("C:\\Users\\Yo Mismo\\AppData\\Roaming\\npm\\codex.cmd", &argv(), true).unwrap();
        assert_eq!((l.file.as_str(), l.verbatim), ("cmd.exe", true));
        assert_eq!(
            l.args,
            vec![
                "/d".to_string(),
                "/s".into(),
                "/c".into(),
                "\"\"C:\\Users\\Yo Mismo\\AppData\\Roaming\\npm\\codex.cmd\" exec --json -c approval_policy=\\\"never\\\" -c mcp_servers.gruv.enabled_tools=[\\\"a\\\",\\\"b\\\"] -\"".into()
            ]
        );
        assert_eq!(lanzamiento_de("C:\\npm\\CODEX.BAT", &[], true).unwrap().args[3], "\"\"C:\\npm\\CODEX.BAT\"\"");
        assert!(lanzamiento_de("\\\\servidor\\npm\\codex.cmd", &["-".to_string()], true).unwrap().verbatim);
    }

    #[test]
    fn una_ruta_de_cmd_con_caracteres_que_cmd_lee_como_sintaxis_o_que_no_es_absoluta_no_se_lanza() {
        for exe in ["C:\\a&b\\codex.cmd", "C:\\a%PATH%\\codex.cmd", "C:\\a\"b\\codex.cmd", "C:\\a^b\\codex.cmd", "C:\\a!b\\codex.cmd", "C:\\a\nb\\codex.cmd", "C:\\a<b\\codex.cmd", "C:\\a|b\\codex.cmd", "C:\\a>b\\codex.cmd", "codex.cmd", "..\\codex.cmd", "\\codex.cmd"] {
            assert!(lanzamiento_de(exe, &argv(), true).unwrap_err().mensaje().contains("ruta de Codex"), "{exe:?}");
        }
    }

    #[test]
    fn un_argumento_con_algo_que_cmd_lee_como_comando_no_se_lanza_por_cmd_exe() {
        for peligroso in ["a&calc", "a|b", "a>b", "a<b", "a^b", "%PATH%", "!x!", "a b", "a;b", "a'b", "a(b)", "a\nb", "", "a`b"] {
            let e = lanzamiento_de("C:\\npm\\codex.cmd", &["exec".to_string(), peligroso.to_string()], true).unwrap_err().mensaje();
            assert!(e.contains("argumento"), "{peligroso:?}");
        }
        // Con un .exe ningún argumento pasa por cmd: no se filtra nada.
        assert_eq!(lanzamiento_de("C:\\bin\\codex.exe", &["a&b".to_string(), "x y".to_string()], true).unwrap().args, vec!["a&b".to_string(), "x y".to_string()]);
    }

    #[test]
    fn el_argv_real_de_codex_siempre_es_lanzable_por_cmd_exe() {
        let mut p = PedidoMotor::nuevo(TareaMotor::Detalle, "m");
        p.def = conector_por_id("gruv").unwrap().mcp();
        p.servidores_cuenta = Some(vec!["gruv".into(), "otro-1".into(), "otro_2".into()]);
        p.servidor_elegido = Some("gruv".into());
        let args = MOTOR_CODEX.argv(&p).unwrap();
        assert!(lanzamiento_de("C:\\npm\\codex.cmd", &args, true).is_ok());
    }
}
