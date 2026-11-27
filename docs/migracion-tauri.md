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
Hacerlo en una PC o VM de prueba antes de publicar una release. El canal beta no existe: el updater de Tauri solo mira
el `latest.json` estable.

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

### Brechas conocidas (se cierran en los hitos 2 y 3)

- Colores de la barra de título según el tema (hoy la barra es la del renderer) y `setOverlayIcon`.
- Menú de aplicación y atajos globales: el shim los ignora.
- `safeStorage`: no disponible, la sesión del chat no se guarda entre reinicios. Hay que leer el formato de
  os_crypt (clave en `Local State` protegida con DPAPI) para conservar lo ya guardado.
- Arrastrar carpetas a la UI: `pathForFile` devuelve vacío (usar el evento de arrastre de Tauri).
- `clipboard.read()` de imágenes, `shell.trashItem`, `nativeImage`, `protocol`, `session` (CSP y permisos de micrófono).
- Updater: `electron-updater` está reemplazado por un shim que avisa; falta el updater de Tauri.
- Instancia única, paquete NSIS y que el instalador traiga Node: hoy se usa el `node` del PATH.
- Tests e2e de Playwright siguen contra Electron.
