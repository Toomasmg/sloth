# Para Mateo: migración de Sloth a Rust (dónde quedamos y cómo seguir)

Mateo: esto es para que sigas la migración de Sloth a Rust sobre Tauri sin tener que reconstruir el contexto. Está
al 28/11/2026. El plan general y la frontera técnica están en [`migracion-rust.md`](migracion-rust.md) y
[`migracion-tauri.md`](migracion-tauri.md). Acá va el estado real, lo que está a medias y lo que falta, en orden.

## 1. El objetivo

Sloth entero en Rust sobre Tauri 2, **sin Node**. Electron sigue siendo la app que se publica hasta que la versión
Tauri esté completa y probada: nada de esto cambia la app instalada de nadie mientras no se haga una release de
Tauri.

Regla que pidió Tomy: código escalable, sin parches ni duplicados. Antes de escribir algo, buscá si ya existe en
`native/core` o en `src-tauri/src/handlers/comun.rs`.

## 2. Cómo está armado hoy

| Pieza | Qué es |
|---|---|
| `native/core` (crate `sloth-core`) | La lógica de todo `src/main` y de todas las features, en Rust puro, sin Tauri. ~2060 tests (`cargo test --lib`). Lo que toca el SO o la UI entra por traits (`Entorno`, `Contexto…`) que implementa la cáscara. |
| `native/daemon` | El daemon de terminales en Rust (protocolo v2). |
| `native/helper` | `sloth-hook.exe`: hooks, statusline, aviso de Codex y el servidor MCP del chat (`sloth-hook chat-mcp`). Reemplaza a los `.cjs` que se corrían con `node`. |
| `src-tauri` | La app Tauri. `router.rs`: `ipc_invoke` usa el handler Rust del canal si existe y, si no, lo reenvía al **proceso de apoyo** (Node). |
| `src/sidecar` | El proceso de apoyo: corre `src/main` (el TS de siempre) con un shim de `electron`. Es lo que se retira al final. |
| `src-tauri/src/handlers/` | Una función por archivo, conectada al router. La lista de las que atiende Rust es `FUNCIONES_EN_RUST` en `handlers/mod.rs`; de ahí sale `SLOTH_RUST_FEATURES`, que hace que el proceso de apoyo **no** registre esas funciones. |

Piezas que conviene conocer de la cáscara:

- `entorno.rs`: `Entorno::estado` lee el store (`sloth-state.json`) de solo consulta y `Entorno::pedir(canal, args)` le
  pide un cambio al dueño del store por el router (ej. `workspaces:add`). Así una función funciona tenga el store quien
  lo tenga.
- `plataforma.rs`: eventos a la UI, abrir URL o carpeta, diálogos, portapapeles, papelera, guardar como, etc.
- `handlers/comun.rs`: helpers compartidos (`ahora_ms`, `nuevo_uuid`, `texto`, `fecha_local`, `ui`, `espacios`).
- `AlHook` (en `handlers/mod.rs`): avisos a las funciones, como `al_hook` (hooks de Claude), `al_enfocar`
  (foco de la ventana), `al_perfil` (perfil listo) y `al_salir`.

## 3. Lo que ya está en `staging` (todo con CI verde)

**Núcleo en Rust (lógica pura):** estado y migraciones, perfiles, hooks, ajustes, cupo, proveedores (Claude, Codex,
Copilot), escáner de uso, setup compartido, logger, cliente del daemon y armado de ptys, git, worktrees, history,
todas las features chicas (sleep, rendimiento, help, templates, onboarding, move-account, diagnóstico, report,
permissions, broadcast), export-import (cifrado **byte-compatible** con el de Node), dictado (con el cortador de
partes), prs, team, team-config, tickets completo, chat completo (red, PostgREST, GoTrue, Realtime, sesión cifrada
compatible con `safeStorage` de Electron en Windows, invitaciones, MCP), celular completo (sellos, servidor HTTP,
página embebida idéntica byte a byte), y las piezas de cuentas (detección de agentes, límites y aviso de Codex).

**Funciones que ya atiende Rust en la app Tauri** (sin pasar por Node): `git`, `help`, `report`, `team-config`,
`prs`, `chat`, `history`, `templates`, `worktrees`, `dictado`, `export-import`, `onboarding`, `tickets` y `team`.

PRs principales, por si querés leer el detalle: #172 a #182 (núcleo), #188, #195, #197 (tickets), #189 (prs/team),
#190, #193, #194, #199 (chat), #191 (celular), #192 (cambios tuyos de dictado y ajustes), #198 (router y cáscara),
#200, #201, #202, #203 (funciones conectadas al router), #204 (cuentas).

## 4. Lo que quedó a medias (ramas pusheadas)

### `feat/estado-rust`: el bloque más importante

Rust pasa a ser el **único dueño** de `sloth-state.json` en Tauri: perfil, logger, store, ajustes, terminales con el
daemon de Rust, estado de agentes, hooks y permisos. Código en `src-tauri/src/nucleo/` y `handlers_estado.rs`. El
proceso de apoyo deja de cargar o escribir el store: trabaja con una copia que le empuja Rust y pide los cambios por
`rust.store`, `rust.ajustes` y `rust.nucleo`. La frontera está documentada en `docs/migracion-rust.md` de esa rama.

Pasan a Rust: `state:get`, `accounts:*`, `workspaces:*`, `pty:*`, `daemon:*`, `permission:pending`, `ui:openPanes`,
`dialog:pickFolder`, `clipboard:*`, `feat:settings:*`, y los canales que agregaron chat y medianas
(`pty:cuentaOcupada`, `pty:running`, `pty:resumeOnce`, eventos `rust.evento`).

**Estado:** PR **#205** abierto, rebasado sobre `staging` (ya trae #201 y #204). Worktree en la PC de Tomy:
`C:\Users\TOMY\Documents\Sloth-wt\estado-rs`.

- **Pruebas:**
  - `cargo test` de `src-tauri`: 139 de 139 (incluye el daemon real: `pty:start`, `write`, `kill`).
  - `sloth-core` en verde y `typecheck` sin errores.
  - `npm test`: solo fallan los 7 de `chat-auth`, que no pueden abrir un puerto en esa PC.
  - e2e de Tauri: 63 de 69. Fallan 5 capturas (sus referencias son de Electron) y `teclado › F6`, que también falla
    a veces en Electron.
  - Ya están arreglados `dormido` («Despertar» abre la terminal) y el Esc de «Nuevo espacio».
- **CI:** al momento de escribir esto pasaban `verificar`, `rust`, `rust-hooks` y `rust-linux`, y `tauri` seguía
  corriendo. Mergear solo con todo en verde.
- **Falta en este PR o en uno siguiente:** enchufar los cinco canales de cuentas que siguen en Node (ver sección 5,
  punto 2). Si el PR ya está en verde, conviene mergearlo como está y hacer las cuentas en un PR aparte.
- **Al mergear:** las funciones de Rust (chat, tickets, prs…) reciben `al_perfil` y los eventos de cuentas y
  terminales directo del núcleo. El mensaje `rust.perfil` del proceso de apoyo desaparece.

### `feat/updater-tray-rust`: actualizaciones y bandeja

Pasa `updater` y `tray` (bandeja del sistema, con su configuración) a Rust sobre `tauri_plugin_updater` y la bandeja
nativa de Tauri, respetando el canal estable o beta de los ajustes.

**Estado:** commit `WIP` (`d68462a`), sin PR. Worktree en la PC de Tomy: `D:/sloth-wt/updater-tray`.

- **Hecho y probado:**
  - En `native/core`: `features/updater.rs` (estado que ve la UI, canal beta/estable, «Más tarde», textos de
    error, `latest.json` beta desde la API de GitHub), `features/updater_notas.rs` y `features/tray.rs`
    (tooltip, menú, decisión de la X con sus diálogos, punto ámbar, `tray.json` versionado).
  - 48 tests en verde.
- **Escrito pero sin compilar:**
  - `src-tauri/src/handlers/updater.rs` y `tray.rs`.
  - `src-tauri/src/ventanas_win.rs`: TaskDialog con «No volver a preguntar» y el punto en la barra de tareas con
    `windows-sys`.
  - La X la decide la bandeja de Rust.
  - Se borró `src/sidecar/updater-shim.ts`.
  - `e2e/cierre.spec.ts` tiene una rama para Tauri.
- **Falta, en este orden:**
  1. Compilar y correr `cargo test` de `src-tauri`; lo más probable que falle es `windows-sys`, la API de menú de
     Tauri y `tauri::test`.
  2. `cargo test` del núcleo completo, `npm test` y `npm run typecheck`.
  3. e2e de Tauri y de Electron de `cierre.spec.ts`.
  4. Revisar que «Ocultar en la bandeja» deje la ventana con `visible: false`.
  5. Actualizar los docs (el overlay y el canal beta dejan de ser brecha; queda el menú de aplicación).
  6. Sacar el «WIP:», rebasar sobre `staging`, abrir PR y esperar la CI.

```sh
cd <worktree de feat/updater-tray-rust>
node scripts/prepare-tauri.mjs     # sin esto el build de src-tauri falla: falta binaries\node-x86_64-pc-windows-msvc.exe
cargo test --manifest-path src-tauri/Cargo.toml handlers::
cargo test --manifest-path native/core/Cargo.toml && npm test && npm run typecheck
npx tauri build --no-bundle && SLOTH_TAURI_EXE=<target>/release/sloth.exe node scripts/e2e-tauri.mjs e2e/cierre.spec.ts
git checkout -- src-tauri/tauri.conf.json
```

Si al rebasar choca con `feat/estado-rust` (`lib.rs`, `handlers/mod.rs`, `nativo.rs`, `sidecar.rs`, el shim),
quedate con lo de ambos lados.

## 5. Lo que falta, en orden

1. **Mergear `feat/estado-rust`** (sección 4). Destraba casi todo lo demás.
2. **Conectar al router lo que sigue en Node** (cada una en `src-tauri/src/handlers/<nombre>.rs`, con el núcleo que ya
   está en `native/core`):
   - `celular`: usa terminales y agentes, va después del estado. Al pasarlo, sacar el puente provisorio que dejó
     chat en `src/main/features/chat.ts` para que celular use la sesión del chat.
   - `sleep`, `permissions` y `broadcast`: dependen de terminales y agentes.
   - `move-account`: falta un canal del dueño del estado para cambiar la cuenta de un espacio.
   - `rendimiento`: necesita los eventos de ajustes, salida de terminales, reconexión del daemon y energía.
   - `diagnostico`: lee el log en memoria; pasa cuando el logger sea de Rust (lo hace `feat/estado-rust`).
   - Si `feat/estado-rust` no los enchufó, los cinco canales de cuentas (`accounts:agentes`, `accounts:usage`,
     `accounts:limitesCodex`, `accounts:setLimitesExperimentales`, `accounts:setAvisoDeTurno`): la lógica ya
     está en `native/core` (`agentes.rs`, `codex_limites.rs`, `codex_notify.rs`, `cuentas.rs`, `usage.rs`).
     Cómo enchufar cada uno está en la descripción del PR #204.
3. **Retiro de Node**: sacar `src/sidecar`, el shim de `electron`, `node.exe` del instalador, `externalBin` y
   `scripts/build-sidecar.mjs`. Borrar el TypeScript de `src/main` que ya está en Rust (solo cuando su función
   está probada de punta a punta en Tauri). Pasar los e2e a hablar con Rust. El build sigue usando Node para el
   frontend (React/Vite) y para generar el changelog (`scripts/changelog-json.mjs`); eso no es dependencia en
   ejecución.
4. **Antes de publicar la versión Tauri**:
   - Probar la migración Electron → Tauri sobre una instalación real en otra PC o VM. El instalador desinstala el
     Sloth Electron y conserva `%APPDATA%\Sloth`. Nunca se probó sobre una instalación de verdad.
   - Verificar `safeStorage` contra un archivo real de Electron (el formato `v10` se probó con un vector armado a
     mano).
   - Regenerar las capturas de los e2e, con OK de Tomy. Las referencias actuales son de Electron y en Tauri difieren
     un 2-3 % por cómo dibuja WebView2.
   - Changelog y versión solo en la rama de release.
   - Respaldar la clave de firma del updater (`D:\sloth-keys\updater.key` en la PC de Tomy). No se commitea nunca.

## 6. Cómo trabajar

### Antes de arrancar: tus cambios en TypeScript también van a Rust

Mientras convivan las dos versiones, **cada cambio que hagas en `src/main` o `src/shared` tiene que estar también en
Rust** (o anotado como pendiente). Para no perder ninguno:

```sh
node scripts/deriva-rust.mjs            # lista el TS cambiado desde el último sync con Rust
node scripts/deriva-rust.mjs --avanzar  # cuando ya lo portaste: avanza la base (docs/migracion-rust-base.txt)
```

Ejemplo de lo que pasó: tu `dictadoPreciso` y las partes de 15 a 28 s del dictado se agregaron después a Rust en
#192.

### Conectar una función nueva al router

1. Mirá su núcleo en `native/core` y el TS original en `src/main/features/<nombre>*.ts`.
2. Creá `src-tauri/src/handlers/<nombre>.rs`. Modelo: `prs.rs` o `tickets.rs`. Mismos canales `feat:<nombre>:<op>`,
   misma validación de argumentos (los args de IPC no vienen validados) y mismos textos que el TS.
3. Registrala en `registrar_todo` y sumala a `FUNCIONES_EN_RUST`.
4. No escribas `sloth-state.json` ni los ajustes desde la función: leelos con `Entorno::estado` y pedí los cambios con
   `Entorno::pedir`.
5. Si la UI pide su estado una sola vez al arrancar, implementá `AlHook::al_perfil` para mandarlo cuando el perfil
   esté listo. Si no, la pantalla puede quedar en «Cargando…»: le pasó a Tickets.

### Comandos

```sh
# Núcleo
cargo test --manifest-path native/core/Cargo.toml --lib     # ~4 min en debug
# Cáscara
cargo test --manifest-path src-tauri/Cargo.toml
# App Tauri: siempre con tauri build (un cargo build --release suelto no embebe la UI)
npx tauri build --no-bundle
git checkout -- src-tauri/tauri.conf.json   # el build le cambia la versión: no lo commitees
# e2e sobre Tauri
SLOTH_TAURI_EXE=<target>/release/sloth.exe node scripts/e2e-tauri.mjs e2e/<spec>.spec.ts
# e2e sobre Electron (solo los specs de lo que tocaste)
npm run build && npx playwright test e2e/<spec>.spec.ts
```

- Nunca `test:e2e:update` para que un test pase.
- En Tauri las capturas fallan por las referencias de Electron: lo que importa es que pasen los `toBeVisible` y el
  comportamiento.
- Si tocás `src/preload`, `src/renderer` o `src/main`, corré también los specs de Electron afectados: la CI no
  corre el e2e de Electron.

### CI

Jobs: `verificar` (typecheck, tests, build), `rust`, `rust-hooks`, `rust-linux` (compila el núcleo en Linux) y
`tauri`. Mergeá solo con todo en verde. Los PR van a `staging`, de a uno, con rebase. Los PR de la migración tocan
casi siempre `src-tauri/src/handlers/mod.rs`, `FUNCIONES_EN_RUST`, `src/main/index.ts` y `docs/migracion-rust.md`: al
rebasar, quedate con lo de ambos lados.

## 7. Cosas para tener en cuenta

- **Tests intermitentes conocidos**:
  - `chat-auth.test.ts` falla con `listen EACCES` en algunas PCs.
  - `celular-espera.test.ts` falla según la carga.
  - En Rust, `features::redactar::tests::texto_enorme_sin_forma_de_secreto_no_se_cuelga` mide tiempo de pared y
    puede fallar con la PC cargada.
  - Corridos todos juntos, algunos specs de Electron fallan de a uno distinto y al repetirlos pasan.
- **Brechas de Tauri sin resolver**:
  - El clic en el aviso del sistema no abre la conversación del chat, porque Tauri no avisa el clic en Windows.
  - «Reportar» no adjunta captura de la ventana.
  - En macOS y Linux no hay almacén de secretos, así que la sesión del chat no queda guardada entre reinicios.
  - El overlay de la barra de tareas y el menú de la app: ver `migracion-tauri.md` y lo que resuelva
    `feat/updater-tray-rust`.
- **Rama `fix/seguridad-urgente`**: tiene 14 commits subidos sin PR. Por título y por contenido, casi todos parecen
  ya estar en `staging`, pero no se verificó uno por uno. Revisala antes de borrarla.
- **El Sloth instalado también se llama `Sloth.exe`**: nunca mates procesos por nombre en pruebas; cerrá por PID solo
  lo que lanzaste.
- El daemon de Node de la versión 0.8.0 tira a veces una aserción de `node-pty` (`remove_pty_baton`) al cerrar una
  terminal. Si aparece, «Omitir» y no «Anular» (anular mata el daemon y corta las terminales). El daemon de Rust no
  usa `node-pty`.
