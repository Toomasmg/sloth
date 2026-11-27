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
