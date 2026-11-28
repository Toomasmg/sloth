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

/// El manifiesto con Common Controls v6 lo pone el linker en todo lo que arma (app y tests), no tauri-build, que solo lo
/// pone en el ejecutable: los tests de la bandeja y del updater usan `SetWindowSubclass` y `TaskDialogIndirect`, que sin
/// él no existen y el binario de tests no arranca (STATUS_ENTRYPOINT_NOT_FOUND).
fn manifiesto_de_windows() -> tauri_build::Attributes {
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !windows {
        return tauri_build::Attributes::new();
    }
    let manifiesto = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifiesto.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifiesto.display());
    // Un manifiesto que el linker no puede usar es un error, no un aviso.
    println!("cargo:rustc-link-arg=/WX");
    tauri_build::Attributes::new().windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
}

fn main() {
    changelog();
    tauri_build::try_build(manifiesto_de_windows()).expect("falló el build de Tauri")
}
