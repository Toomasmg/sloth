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

## Estado (hito 1 hecho)

La ventana de Tauri carga el renderer y `window.sloth` funciona sobre `ipc_invoke` / `ipc_send` / `sloth://event`.
El main corre sin Electron en `out/sidecar/sloth-sidecar.cjs` (`npm run build:sidecar`, shim en `src/sidecar`).
Probado: arranca, responde `state:get` y la interfaz se pinta con los datos reales.

Se prueba a mano con `npx electron-vite build && npm run build:daemon && npm run build:sidecar` y
`npx tauri build --debug --no-bundle`; el ejecutable queda en `src-tauri/target/debug/sloth.exe`.

### Brechas conocidas (se cierran en los hitos 2 y 3)

- Barra de título propia y colores de ventana: hoy es la barra nativa.
- Eventos de ventana hacia el main (foco, mover, maximizar, cerrar con guardado de estado): faltan.
- Bandeja, menú y atajos globales: el shim los ignora.
- `safeStorage`: no disponible, la sesión del chat no se guarda entre reinicios. Hay que leer el formato de
  os_crypt (clave en `Local State` protegida con DPAPI) para conservar lo ya guardado.
- Arrastrar carpetas a la UI: `pathForFile` devuelve vacío (usar el evento de arrastre de Tauri).
- `clipboard.read()` de imágenes, `shell.trashItem`, `nativeImage`, `protocol`, `session` (CSP y permisos de micrófono).
- Updater: `electron-updater` está reemplazado por un shim que avisa; falta el updater de Tauri.
- Instancia única, paquete NSIS y que el instalador traiga Node: hoy se usa el `node` del PATH.
- Tests e2e de Playwright siguen contra Electron.
