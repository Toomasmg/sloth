use std::path::PathBuf;
use std::process::Command;

/// El changelog de «help» sale de src/shared/changelog.ts en cada build: no hay una copia a mano que se desactualice.
fn changelog() {
    let raiz = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("..");
    let script = raiz.join("scripts").join("changelog-json.mjs");
    let fuente = raiz.join("src").join("shared").join("changelog.ts");
    println!("cargo:rerun-if-changed={}", script.display());
    println!("cargo:rerun-if-changed={}", fuente.display());
    let salida = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("changelog.json");
    let estado = Command::new("node")
        .arg("--disable-warning=MODULE_TYPELESS_PACKAGE_JSON")
        .arg(&script)
        .arg(&salida)
        .status()
        .expect("hace falta node (>= 22.18) para generar el changelog de help");
    assert!(estado.success(), "scripts/changelog-json.mjs falló");
}

fn main() {
    changelog();
    tauri_build::build()
}
