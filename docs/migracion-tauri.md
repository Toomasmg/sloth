# Migración de Sloth a Tauri

Decisión: incremental. Tauri pone la ventana y lo nativo; la lógica actual del main (src/main, ~32k líneas
de TypeScript, 80 features, 161 handlers `feat:<nombre>:<op>`) sigue corriendo como un proceso Node de apoyo
y se pasa a Rust feature por feature. Sloth anda y se publica en cada hito.

## Cómo encajan las piezas

- **Rust (src-tauri):** ventana, bandeja, menú, updater, protocolos, portapapeles, diálogos, notificaciones,
  y el daemon de terminales (ya hecho en `native/daemon`).
- **Node de apoyo (sidecar):** el main actual sin `electron`. Habla con Rust por stdio con líneas JSON
  (mismo estilo del daemon): `invoke` desde la UI -> Rust -> sidecar -> respuesta, y eventos al revés.
- **Renderer:** React sin cambios de fondo. `window.sloth` se reimplementa sobre `invoke`/`listen` de Tauri
  (hoy solo se usan 6 llamadas distintas; los canales `feat:*` pasan por `isFeatChannel`).

## Hitos

1. **Cáscara:** ventana Tauri que carga el renderer actual, con el sidecar Node corriendo el main sin
   Electron. Shim de las APIs de electron que el main usa (`shell`, `dialog`, `clipboard`, `app`, `session`,
   `Notification`, `safeStorage`, `powerMonitor`, `screen`, `nativeImage`) que llaman a Rust por el puente.
2. **Nativo en Rust:** bandeja, menú, ventana (tamaño mínimo 900x560, estado), atajos, deep links y
   protocolos propios, notificaciones, portapapeles, diálogos.
3. **Updater y empaquetado:** instalador NSIS de Tauri, updater firmado, migración de userData desde la
   instalación Electron (misma carpeta, sin pérdida de datos), daemon `.exe` como recurso.
4. **Features a Rust**, de las simples a las complejas, cada una quitando su parte del sidecar: ajustes,
   historial, plantillas, ramas/git, PRs, tickets, permisos, broadcast, celular, chat, dictado.
5. **Apagar el sidecar** cuando no quede nada, y quitar Electron.

## Riesgos conocidos

- `protocol`/`session` de Electron (17 y 32 usos): hay que ver qué hace cada uno (CSP, esquema propio,
  proxy). WebView2 no tiene un equivalente directo de `session`.
- `safeStorage` (cifrado con DPAPI): reemplazo por `windows` crate o un keyring; no se puede perder lo guardado.
- e2e con Playwright sobre Electron: hay que moverlos a WebView2 (CDP) o a tauri-driver.
- Autoupdate: las instalaciones actuales de Electron deben poder actualizarse al build Tauri sin reinstalar.

## Entorno de build (esta PC)

Rust (MSVC) con Build Tools en `D:\VS\BuildTools`; `CARGO_HOME`/`RUSTUP_HOME` en `D:\rust`.

## Estado (hitos 1, 2 y 3 hechos; falta probar la migración sobre una instalación real)

Hito 3: `npm run release:tauri` arma el instalador NSIS firmado (28 MB, con Node, el proceso de apoyo, los daemons y
node-pty), `latest.json` para el updater de Tauri y `latest.yml` para que las instalaciones de Electron se actualicen
con electron-updater al mismo instalador (nombre `Sloth-Setup-<versión>.exe`). El instalador desinstala el Sloth de
Electron (clave `0169b5fe-...` en HKCU) sin tocar `%APPDATA%\Sloth` y se vuelve a abrir con `--force-run`.
La clave de firma está en `D:\sloth-keys\updater.key` (fuera del repo): hay que guardarla y pasarla en
`TAURI_SIGNING_PRIVATE_KEY` al publicar; la pública va en `tauri.conf.json`.

Probado: build del instalador y ejecutable de release con recursos en otra carpeta (UI embebida, node propio, daemon Rust).
No probado: instalar encima de una instalación de Electron, el relanzado y la actualización por el updater de Tauri.
Hacerlo en una PC o VM de prueba antes de publicar una release. El updater es de Rust (`src-tauri/src/handlers/updater.rs`)
y respeta el canal de los ajustes: estable con el `latest.json` del endpoint y beta con el de la última prerelease de GitHub.

Hito 2 (ventana y bandeja):

Hito 2: ventana sin marco con botones propios (`layout/WindowControls.tsx`) y arrastre por `-webkit-app-region`,
eventos de ventana (foco, mover, tamaño, maximizar) hacia el main con el rectángulo en DIP, cierre cancelable
(`close` -> confirmación o bandeja -> `before-quit` -> `app.exit`) y bandeja del sistema con menú dinámico.

## Detalle del hito 1

La ventana de Tauri carga el renderer y `window.sloth` funciona sobre `ipc_invoke` / `ipc_send` / `sloth://event`.
El main corre sin Electron en `out/sidecar/sloth-sidecar.cjs` (`npm run build:sidecar`, shim en `src/sidecar`).
Probado: arranca, responde `state:get` y la interfaz se pinta con los datos reales.

Se prueba a mano con `npx electron-vite build && npm run build:daemon && npm run build:sidecar` y
`npx tauri build --debug --no-bundle`; el ejecutable queda en `src-tauri/target/debug/sloth.exe`.

### Resuelto después del hito 3

- `safeStorage` compatible con Electron (`src/sidecar/safe-storage.ts`): clave AES en `Local State` protegida con DPAPI
  (vía PowerShell, una vez por arranque) y formato `v10`; lo que guardó Electron se sigue leyendo.
- Arrastrar archivos y carpetas: `tauri-archivos.ts` convierte el evento de Tauri en eventos DOM con `File` que
  recuerdan su ruta (`api.pathForFile`).
- Portapapeles con imagen (`clipboard.read`), papelera (`shell.trashItem`), color de fondo, tema del sistema,
  pantallas, batería (`powerMonitor`), inicio con Windows e instancia única.
- Micrófono del dictado: WebView2 lo concede sin preguntar (`permisos.rs`), como hacía `session` en Electron.
- Zoom con Ctrl + / - / 0 (`zoom-keys.ts` compartido con el main).
- e2e sobre Tauri: `SLOTH_E2E_RUNTIME=tauri npx playwright test ...` lanza `src-tauri/target/release/sloth.exe`
  (compilar con `node scripts/prepare-tauri.mjs && npx tauri build --no-bundle`) y se conecta por CDP. El proceso de
  apoyo ejecuta lo que los specs hacían con `app.evaluate` (solo con `SLOTH_E2E=1`). Las capturas de referencia son de
  Electron: los specs con `toHaveScreenshot` no se comparan hasta rehacerlas con autorización.
- CI: job `tauri` (daemon Rust con sus tests y `cargo check` de la cáscara).

### Brechas que quedan

- Menú de aplicación y clics en notificaciones (el plugin de Tauri no los da en escritorio).
- Bandeja (`src-tauri/src/handlers/tray.rs`, de Rust): se probó la decisión de la X y sus diálogos, no el ícono en la
  bandeja de Windows. El punto ámbar de la barra de tareas (`SetOverlayIcon`) y el diálogo con «No volver a preguntar»
  (`TaskDialogIndirect`) están en `ventanas_win.rs`.
