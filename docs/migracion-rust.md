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
- **Perfil y estado (Rust es el dueño):** ver «Frontera del estado» más abajo.

Conectado: `git` (26 canales), `help` (2), `report` (4), `team-config` (11), `prs` (9), `chat` (42), `history` (9),
`templates` (10), `worktrees` (7), `dictado` (2), `export-import` (10), `onboarding` (6), `tickets` (20),
`team` (4) y el núcleo
(`src-tauri/src/handlers_estado.rs`): `state:get`, `permission:pending`, `daemon:info`, `daemon:shutdown`, `accounts:add`,
`accounts:setShareSetup`, `accounts:remove`, `accounts:statuses`, `workspaces:add|remove|update|reveal`, `ui:openPanes`,
`dialog:pickFolder`, `pty:start|write|resize|kill|cuentaOcupada|running|resumeOnce`, `clipboard:read|write`,
`feat:settings:get|set|reset|pickProjectsDir`, `feat:diagnostico:texto|crashPrevio|errorRenderer`
(`src-tauri/src/handlers/diagnostico.rs`) y `feat:sleep:wake` (`handlers/sleep.rs`). Estas dos son del núcleo porque viven
de su estado: ver `FUNCIONES_DEL_NUCLEO`.

- `sleep`: lo decide `nucleo/dormir.rs`, que el núcleo alimenta con cada hook, escritura, salida de terminal y la
  rehidratación del daemon. Un hilo revisa cada minuto (`SLOTH_SLEEP_AFTER_MS` para probar) y cierra la terminal de los
  inactivos. El comando de un espacio dormido es `claude --continue` antes de preguntarle al apoyo (`nucleo:comando`).
  Los dormidos se ven «Dormido» desde el primer `state:get`.

- `diagnostico`: el texto sale del log en memoria de Rust, de la marca de cierre inesperado (`logs/sesion.json`, que Rust
  toma al arrancar y deja limpia en `al_salir`; `MarcaDeSesion` en `nucleo/arranque.rs`) y de los ajustes del núcleo. Las
  funciones activas son las de Rust más las que el apoyo registró (las manda con `rust.nucleo listo`). En lugar de
  Electron, Node y Chrome muestra la versión de WebView2. `errorRenderer` escribe en el log de Rust.

- `chat`: config y login (`principal`), datos y Realtime (`datos`) y el lado main del MCP (`mcp_main`), con la sesión cifrada
  como en Electron. Si una cuenta tiene terminales abiertas se pregunta con `pty:cuentaOcupada`; `cuentaPreparada`,
  `cuentaBorrada` y `terminalCerrada` se los avisa el núcleo directo (`AlHook::al_evento`). Los avisos a la persona se
  muestran con la función `avisos` del proceso de apoyo (evento nativo `aviso`). «celular» sigue en Node y usa la sesión del
  chat para su canal remoto: Rust le avisa URL, clave pública y usuario (`chat:sesion`, nunca tokens) y el cliente de Node
  pide el token con `rust.chat token` en cada uso; así hay un solo dueño del refresh token. El aviso del sistema de un mensaje
  no abre la conversación al hacer clic: el aviso de Tauri en Windows no avisa el clic. El TS de chat
  (`src/main/features/chat*.ts`) queda como respaldo, igual que el de git: Electron lo sigue usando.

- `help`: el changelog lo genera `src-tauri/build.rs` desde `src/shared/changelog.ts` (`scripts/changelog-json.mjs`, con
  Node) y entra con `include_str!`; no hay copia a mano.
- `report`: la línea del daemon sale de `daemon:info` (1,5 s como mucho). La captura de la ventana no existe en Tauri
  todavía: `capture` responde un error claro.
- `prs`: abrir la rama de un PR puede crear un espacio; lo hace el núcleo, pedido por el router
  (`Entorno::pedir("workspaces:add")`, mismas validaciones que «Nuevo espacio»).
- `tickets`: el `Entorno` de `servicio.rs` está en `handlers/tickets.rs` (cuentas y espacios de `Entorno::estado`, consumo
  de 5 h con `usage::EscanerUso`). Corre `claude -p`, `codex exec` y `gh` con `claude_run::ProcesoRun` y el entorno de la
  cuenta (`proveedores_fs::env_cuenta`, `ptys_core::entorno_limpio`). «Empezar» pide `workspaces:add` al núcleo.
  La UI pide su estado una sola vez al arrancar: el núcleo le avisa `AlHook::al_perfil` apenas arranca
  (el perfil se carga antes de registrar las funciones).
- `team`: lee en memoria lo que trae Tickets (`Tickets::para_equipo`) y se entera de cada cambio (`Tickets::al_cambiar`).
- Las funciones de Rust leen cuentas y espacios de la copia en memoria del núcleo (`Entorno::estado`).
- `history`: borrar manda el `.jsonl` a la Papelera (crate `trash`) y retomar crea el espacio con `workspaces:add`. Pregunta
  al núcleo si una terminal está viva (`pty:running`), pide que la próxima arranque con `claude --resume <id>`
  (`pty:resumeOnce`) y la reinicia con
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
- `export-import`: arma y lee el `.sloth` con `export_import*` y `export_crypto` (cifrado compatible con Node). Los ajustes
  saneados salen de `feat:settings:get`; plantillas, reglas y equipo se leen de sus archivos sin escribirlos. Importar pide
  al dueño `accounts:add` (y `accounts:setShareSetup` si el archivo lo apaga), `workspaces:remove` y `workspaces:add`;
  plantillas, ajustes y reglas los sigue guardando la UI con sus canales.

Por qué el resto sigue en el proceso de apoyo:

- `accounts:agentes`, `accounts:usage`, `accounts:limitesCodex`, `accounts:setLimitesExperimentales`,
  `accounts:setAvisoDeTurno`: dependen de piezas de Codex y del escáner de uso que todavía no están en `native/core`
  (`codex-limites`, `codex-notify`, `usage` armado). Cuando cambian una cuenta lo piden a Rust por el store espejo.
- `move-account`: cambia la cuenta de un espacio (`store.updateWorkspace(accountId)`) y no hay canal del dueño para eso
  (`workspaces:update` solo cambia nombre e ícono); además escribe el resumen en la terminal al primer `SessionStart`.
  En Tauri funciona con el store espejo (el cambio va a Rust por `rust.store`); para pasar a Rust le falta el pegado del
  resumen, que necesita los hooks que ya tiene el núcleo.
- `rendimiento`: vive de eventos del proceso de apoyo que Rust no recibe: cambios de ajustes (`onSettingsChanged`), salida de
  las terminales sin daemon (`onPtyData`), reconexión del daemon y la energía (`powerMonitor`). Ptys y ajustes ya son del núcleo; falta mover la energía.
- `permissions`, `broadcast`: el port de `native/core` es de piezas puras sin la función completa armada (falta el contexto con su
  estado y E/S); se conectan de a una en PRs siguientes.

El TS de `git` (`src/main/features/git.ts`, `git-ops`, `git-run`) queda como respaldo: Electron lo sigue usando y worktrees,
prs y otros lo importan. Se borra cuando Electron se retire.

## Frontera del estado (Rust dueño, apoyo con copia)

En la cáscara de Tauri hay un solo dueño de `sloth-state.json`, `features/settings.json`, las terminales y el estado
de los agentes: `src-tauri/src/nucleo` (`Nucleo`). Electron no cambia (no hay puente nativo).

- **Arranque:** Rust elige la carpeta de datos (`%APPDATA%\Sloth` o `SLOTH_USER_DATA`), inicia el logger
  (`logs/sloth.log`), trae la carpeta de AntiRea si hace falta, prepara los perfiles con sus migraciones
  (`perfiles_fs`), carga el store (`sloth_core::store`, con respaldo antes de migrar y solo lectura si es de una versión
  futura) y la Configuración. Con los perfiles bloqueados muestra el error y sale sin tocar nada. Después lanza el apoyo
  con `SLOTH_PERFIL_RUST` (perfil, carpeta e índice): `perfil.ts` usa eso y no repite la
  migración. El apoyo espera la primera copia antes de arrancar su main (`whenReady` del shim).
- **Copia de solo lectura:** Rust empuja por el protocolo del apoyo (`native-event`) `rust.estado` (store completo,
  solo lectura, confiable) después de cada cambio, `rust.ajustes`, `rust.agentes`/`rust.agente`, `rust.pty` (data,
  exit, hook, permission, permission-resolved, write, tam, start, sesiones, ajenas, info) y `rust.avisos`. Del lado del
  apoyo: `Store` en modo espejo, `currentSettings()` de la copia, `TerminalRemota` con la forma del backend del daemon
  (`src/main/nucleo-rust.ts`, lógica pura en `espejo-rust.ts`).
- **Escrituras del apoyo:** el store espejo aplica el cambio en su copia (quien llama lo lee enseguida) y lo pide a Rust
  (`rust.store`: addAccount, updateAccount, updateWorkspace con los campos a quitar, removeAccount, addWorkspace,
  removeWorkspace, setOpenPanes); Rust valida, guarda y contesta con otra copia. `patchSettings` va por `rust.ajustes`.
  Terminales, agentes y lo demás por `rust.nucleo` (start, write, resize, kill, list, answer, setAgent, addWorkspace,
  removeWorkspace, prepareAccount, cerrarAjenas, cambioDePerfil, cerrar, log). `write`, `resize` y `log` se atienden en
  el orden en que llegan.
- **Lo que Rust le pregunta al apoyo** (canales `nucleo:*`, que la interfaz no puede invocar): el comando de un espacio
  cuando una función lo reemplaza (`nucleo:comando`, retomar tras mover de cuenta) y el aviso antes de borrar una cuenta
  (`nucleo:cuentaBorrada`). Al preparar una cuenta Rust instala hooks y setup compartido y avisa `rust.cuentaPreparada`:
  el apoyo pone el aviso de turno de Codex y corre las funciones que escuchan.
- **Logger:** el archivo, el log en memoria y la marca de sesión son de Rust. El apoyo manda cada línea a Rust.
- **Terminales:** Rust se conecta al daemon de Rust (`native/daemon`) con E/S superpuesta (tokio), lo lanza suelto si no
  está y reconecta con `daemon_cliente`. No hay terminales en proceso ni daemon de Node: si el daemon no arranca,
  `pty:start` devuelve el error. Con `SLOTH_INPROCESS=1` (pruebas) el daemon se apaga al salir, como pasaba con las
  terminales en proceso de Electron. Al cerrar decide con `decidir_cierre_terminales` («Terminales vivas», cambio de
  perfil, terminales de otros perfiles).
- **Sigue en el apoyo y escribe en userData sin ser estado:** los scripts de hooks (`writeHookScript`) y los archivos
  de cada función que no pasó. `perfiles.json` lo reescribe la función `perfiles`
  (crear, renombrar, cambiar); Rust solo lo lee y migra al arrancar.
