# Sacar Node: el main de Sloth en Rust

Objetivo: que Sloth no lleve Node. Hoy la cáscara de Tauri (`src-tauri`) lanza un proceso Node que corre el main
(`src/main`, ~26 mil líneas de TypeScript en 63 archivos y 80 de features, más ~4 mil de `src/shared`) con un
shim de `electron` (`src/sidecar`). Se pasa a Rust módulo a módulo en `native/core` (crate sin Tauri, con tests
propios) y la cáscara lo usa. Sloth anda y se puede publicar en cada paso; el proceso Node se retira cuando no
queda nada que correr ahí.

Tamaño real: ~26 mil líneas de main, ~4 mil de lógica compartida y ~17 mil de tests. Son meses de trabajo.
Cada módulo se porta con sus tests del TypeScript traducidos; donde hay fixtures (`src/main/fixtures`) los lee
también Rust, así las dos implementaciones se prueban contra el mismo archivo.

## Cómo conviven mientras tanto

- Rust es el dueño del estado. Las features que siguen en Node ven una copia de solo lectura del store (las
  features casi solo leen: ~120 lecturas contra 3 escrituras) y piden las escrituras y el daemon por llamadas
  asíncronas al núcleo de Rust.
- `ipc_invoke` busca primero un handler de Rust para el canal (`feat:<nombre>:<op>`); si no hay, reenvía al proceso
  de apoyo. Así cada feature pasa a Rust sin tocar a las demás.
- Al terminar: se quita `src/sidecar`, el shim de `electron`, el `node.exe` del instalador y `externalBin`.

## Orden

1. **Base (`native/core`)** — hecho: `versionado`, `persistencia` (JSON atómico, apartado de archivos dañados,
   respaldos), `avisos`, `store_core` y `store`. 58 tests.
1b. **Hooks sin Node** — hecho: `native/helper` es `sloth-hook.exe`, que reemplaza a los tres scripts que Claude Code y
   Codex ejecutaban con `node` (`sloth-hook.cjs`, la statusline y el aviso de Codex). `hooks.ts` lo copia a
   `userData/bin` y escribe sus comandos (con ruta 8.3 si hay espacios, porque PowerShell no ejecuta una ruta entre
   comillas seguida de argumentos). Una statusline envuelta con Node se migra sola. Si el ejecutable no está, se sigue
   con Node. Falta el servidor MCP del chat (`chat-mcp-script.ts`), que Claude también arranca con `node`.
2. **Núcleo de la app**: perfiles (`perfil`, `perfiles-core`, `perfiles-fs`), `setup`, `hooks` y servidor de hooks,
   cliente del daemon (protocolo v2 nativo), terminales (`ptys`), estado de agentes, `usage`, ventana
   (`window-state`), ajustes (`settings-model`, `settings`), y el equivalente de `index.ts` (registro de features,
   `state:get`, cuentas y espacios).
3. **Features chicas y aisladas**: sleep, rendimiento, help, avisos, diagnostico, onboarding, move-account,
   templates, report, permissions, broadcast.
4. **Features medianas**: history, git, worktrees, prs, team-config, team, perfiles, export-import, tickets, dictado.
5. **Features grandes**: chat (`chat`, `chat-data`, `chat-mcp`, `chat-auth`...), celular (servidor, remoto, terminal,
   página web), updater (ya resuelto en Rust: `updater.rs` pasa a ser el dueño), tray.
6. **Retiro de Node**: quitar el proceso de apoyo, el shim, `node.exe`, `build-sidecar` y dejar los e2e hablando con
   Rust (hoy usan `e2e:evaluate` del proceso de apoyo).

## Reglas del port

- Mismo formato en disco, byte a byte donde importe: JSON con 2 espacios, orden de claves (`preserve_order`),
  campos desconocidos conservados, nombres de archivo y `version`. Un usuario puede volver a una versión anterior.
- Mismos textos de aviso y de error (la UI y los tests de la UI los muestran).
- Cada archivo del TypeScript que se porta se borra en la misma rama, junto con su test, cuando su reemplazo en
  Rust ya está conectado.
- Lo que se escribe en `userData` sigue yendo con tmp + rename y respaldo.

## Router híbrido (`src-tauri`)

`ipc_invoke(canal, args)` pasa por `Router` (`src-tauri/src/router.rs`): si el canal tiene handler en Rust lo atiende
ahí (en un hilo aparte, sin trabar la ventana) y si no lo reenvía al proceso de apoyo, igual que antes. `src-tauri`
depende de `sloth-core` por path; con el mismo `CARGO_TARGET_DIR` las dependencias comunes se compilan una vez.

- **Plataforma:** `plataforma.rs` implementa `sloth_core::app_state::Plataforma` sobre Tauri (eventos a la UI por
  `sloth://event`, abrir enlace o carpeta, elegir carpeta, error, portapapeles, zoom, ventana). La carpeta de datos es
  `%APPDATA%\Sloth`, la de Electron; `SLOTH_USER_DATA` la cambia en pruebas. Sin `safeStorage` en Rust todavía: ningún
  handler lo necesita (chat y tickets lo van a pedir).
- **Una función a la vez:** cada archivo de `src-tauri/src/handlers/` registra sus canales `feat:<nombre>:<op>` y se anota
  en `FUNCIONES_EN_RUST`. La cáscara le pasa esa lista al proceso de apoyo (`SLOTH_RUST_FEATURES`) y este no registra la
  función (`src/main/rust-features.ts`); en Electron no hay lista y todo sigue igual.
- **Perfil y estado:** el proceso de apoyo sigue siendo el dueño de `sloth-state.json` y elige el perfil activo (con sus
  migraciones). Cuando termina de arrancar le avisa a Rust la carpeta del perfil (`rust.perfil`); hasta entonces los
  handlers de Rust responden «Sloth todavía está arrancando.». Rust lee el estado solo para consultar (sin migrar ni
  reescribir). Los hooks de Claude llegan a las funciones de Rust reenviados por el puente (`rust.hook`).

Conectado: `git` (26 canales). Por qué el resto sigue en el proceso de apoyo:

- `state:get`, cuentas y espacios (`accounts:*`, `workspaces:*`): mutan el store y arman el estado con los agentes, que
  dependen de las terminales y del servidor de hooks. Pasan a Rust con ptys y hooks; antes habría dos dueños del
  `sloth-state.json`.
- `settings`: el main de Node la lee en memoria en ~12 módulos (tray, updater, sleep, chat...); si Rust la escribiera,
  esas copias quedarían viejas. Pasa junto con ellos.
- `worktrees`, `history`, `templates`, `move-account`: escriben o dependen del store (alta y baja de espacios, cuentas) o de
  las terminales.
- `help`: necesita el changelog (`src/shared/changelog.ts`) como dato para Rust; falta definir de dónde sale sin duplicarlo.
- `sleep`, `rendimiento`, `onboarding`, `report`, `diagnostico`, `permissions`, `broadcast`, `export-import`, `dictado`,
  `prs`, `team`: el port de `native/core` es de piezas puras sin la función completa armada (falta el contexto con su
  estado y E/S); se conectan de a una en PRs siguientes.

El TS de `git` (`src/main/features/git.ts`, `git-ops`, `git-run`) queda como respaldo: Electron lo sigue usando y worktrees,
prs y otros lo importan. Se borra cuando Electron se retire.
