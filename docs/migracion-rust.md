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
  `%APPDATA%\Sloth`, la de Electron; `SLOTH_USER_DATA` la cambia en pruebas. El `safeStorage` de Electron lo replica
  `sloth_core::features::chat::safestorage` (mismo `Local State`); por ahora lo usa el chat.
- **Una función a la vez:** cada archivo de `src-tauri/src/handlers/` registra sus canales `feat:<nombre>:<op>` y se anota
  en `FUNCIONES_EN_RUST`. La cáscara le pasa esa lista al proceso de apoyo (`SLOTH_RUST_FEATURES`) y este no registra la
  función (`src/main/rust-features.ts`); en Electron no hay lista y todo sigue igual.
- **Perfil y estado:** el proceso de apoyo sigue siendo el dueño de `sloth-state.json` y elige el perfil activo (con sus
  migraciones). Cuando termina de arrancar le avisa a Rust la carpeta del perfil (`rust.perfil`); hasta entonces los
  handlers de Rust responden «Sloth todavía está arrancando.». Rust lee el estado solo para consultar (sin migrar ni
  reescribir). Los hooks de Claude llegan a las funciones de Rust reenviados por el puente (`rust.hook`).

Conectado: `git` (26 canales), `help` (2), `report` (4), `team-config` (11), `prs` (9), `chat` (42), `history` (9), `templates` (10), `worktrees` (7) y `dictado` (2).

- `chat`: config y login (`principal`), datos y Realtime (`datos`) y el lado main del MCP (`mcp_main`), con la sesión cifrada
  como en Electron. Cuentas, espacios y `settings.json` se leen sin escribirlos. Lo que es de otro dueño va por el puente o
  el router, así anda con cualquier dueño del estado: si una cuenta tiene terminales abiertas se pregunta con
  `pty:cuentaOcupada`, y `cuentaPreparada`, `cuentaBorrada` y `terminalCerrada` llegan como `rust.evento` (quien sea dueño de
  cuentas y terminales los tiene que mandar). Los avisos a la persona se muestran con la función `avisos` del proceso de
  apoyo (evento nativo `aviso`). «celular» sigue en Node y usa la sesión del chat para su canal remoto: Rust le avisa URL,
  clave pública y usuario (`chat:sesion`, nunca tokens) y el cliente de Node pide el token con `rust.chat token` en cada uso;
  así hay un solo dueño del refresh token. El aviso del sistema de un mensaje no abre la conversación al hacer clic: el
  aviso de Tauri en Windows no avisa el clic. El TS de chat (`src/main/features/chat*.ts`) queda como respaldo, igual que
  el de git: Electron lo sigue usando.

- `help`: el changelog lo genera `src-tauri/build.rs` desde `src/shared/changelog.ts` (`scripts/changelog-json.mjs`, con
  Node) y entra con `include_str!`; no hay copia a mano.
- `report`: la línea del daemon se pide a `daemon:info` del proceso de apoyo (1,5 s como mucho). La captura de la ventana
  no existe en Tauri todavía (tampoco andaba por el proceso de apoyo): `capture` responde un error claro.
- `prs`: abrir la rama de un PR puede crear un espacio; eso lo hace el dueño del store, pedido por el router
  (`Entorno::pedir("workspaces:add")`, mismas validaciones que «Nuevo espacio»). Cuando el store pase a Rust, el pedido
  sigue andando sin cambios porque va por el router.
- Las funciones de Rust leen cuentas y espacios sin escribirlos (`Entorno::estado`).
- `history`: borrar manda el `.jsonl` a la Papelera (crate `trash`) y retomar crea el espacio con `workspaces:add`. Las
  terminales siguen siendo del proceso de apoyo: Rust pregunta si una está viva (`pty:running`), pide que la próxima
  arranque con `claude --resume <id>` (`pty:resumeOnce`, el reemplazo de `addClaudeCommandOverride`) y la reinicia con
  `pty:kill` más `ui:command` `restart-pane`, como `restartTerminal`. El modo liviano se lee de `feat:settings:get`.
- `templates`: `templates.json` lo escribe solo Rust (versionado y tmp + rename de `ArchivoPlantillas`). Crear un espacio
  desde una plantilla va por `workspaces:add`; la cuenta sugerida usa `accounts:usage` y `accounts:statuses` del dueño.
- `worktrees`: el contexto de `worktrees_feature` pide al dueño la baja de espacios (`workspaces:remove`), cerrar terminales
  (`pty:kill`), el modo solo lectura y la actividad de los agentes (`state:get`). El espacio de una rama nueva se da de alta
  con `workspaces:add` y la carpeta de la rama como repo (como «Abrir rama» de prs): con la rama, ese canal crearía otro
  worktree. Queda sin `branch` guardado; la rama se lee de git.
- `dictado`: whisper-cli corre con el ejecutor del núcleo (sin ventana, con el plazo de `timeout_ms`) desde
  `vendor/whisper` o los recursos instalados (`sidecar::raiz_de_la_app`). El modelo se baja con `asegurar_modelo` sobre
  ureq sin seguir redirecciones (el núcleo revisa el host de cada salto y el SHA-256). El WAV llega por el puente de Tauri
  como arreglo u objeto con índices (un `Uint8Array` pasado por JSON); el proceso de apoyo lo rechazaba.
  `dictadoPreciso` se lee de `feat:settings:get`.

Por qué el resto sigue en el proceso de apoyo:

- `state:get`, cuentas y espacios (`accounts:*`, `workspaces:*`): mutan el store y arman el estado con los agentes, que
  dependen de las terminales y del servidor de hooks. Pasan a Rust con ptys y hooks; antes habría dos dueños del
  `sloth-state.json`.
- `settings`: el main de Node la lee en memoria en ~12 módulos (tray, updater, sleep, chat...); si Rust la escribiera,
  esas copias quedarían viejas. Pasa junto con ellos.
- `move-account`: escriben o dependen del store (alta y baja de espacios, cuentas) o de
  las terminales.
- `team`: arma su vista con lo que trae el conector de Tickets (`ticketsParaEquipo` y `alCambiarTickets`, en memoria del
  proceso de apoyo). Pasa junto con `tickets`; antes haría falta un puente nuevo de ida y vuelta solo para esto.
- `diagnostico`: su texto sale del log en memoria del main de Node (`logger.recientes`, `logger.fallo`), de la marca de
  cierre inesperado que calcula ese proceso al arrancar y de los ajustes que tiene en memoria; `errorRenderer` escribe en ese
  mismo log. En Rust mostraría un log casi vacío. Pasa cuando el logger y el arranque sean de Rust.
- `sleep`, `rendimiento`, `onboarding`, `permissions`, `broadcast`, `export-import`: el port de `native/core` es de piezas puras sin la función completa armada (falta el contexto con su
  estado y E/S); se conectan de a una en PRs siguientes.

El TS de `git` (`src/main/features/git.ts`, `git-ops`, `git-run`) queda como respaldo: Electron lo sigue usando y worktrees,
prs y otros lo importan. Se borra cuando Electron se retire.
