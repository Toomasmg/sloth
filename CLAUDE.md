# Sloth

App de escritorio (Electron + React + TypeScript, Windows primero) para usar varias cuentas de Claude Code, cada una en su terminal y su repo. Textos de la UI, comentarios y commits en español rioplatense (voseo).

## Estructura
- `src/main/`: proceso main. `index.ts` arma la ventana y registra las funciones. `store.ts` guarda cuentas y espacios. `ptys.ts` y `daemon-client.ts` manejan las terminales.
- `src/main/features/<nombre>.ts`: cada función del lado main. Se suma en `features/index.ts` (`FEATURES`). Registra canales con `ctx.handle('op', fn)`, que responde a `feat:<nombre>:<op>`, y avisa a la UI con `ctx.emit`. Los argumentos que llegan por IPC no vienen validados: validalos.
- `src/renderer/src/features/<nombre>/`: la parte visual de cada función. Se suma en `features/registry.ts` (`FEATURE_UIS`).
- `src/shared/`: tipos y lógica que usan main y renderer.
- `src/daemon/`: el daemon de terminales (lo arma `scripts/build-daemon.mjs`).
- `src/preload/index.ts`: el puente. Expone la API del núcleo (estado, cuentas, espacios) y, para las funciones, solo los canales que pasan `isFeatChannel` (`src/shared/features.ts`).
- `e2e/`: pruebas visuales con Playwright sobre el build de `out/`.

## Comandos
- `npm run typecheck`: tsc sin emitir.
- `npm test`: tests unitarios de módulos puros con `node --test`, usando el type stripping de Node (necesita Node ≥ 22.18).
- `npm run build`: electron-vite más el daemon.
- `npm run test:e2e`: build más Playwright. Nunca uses `test:e2e:update` para que un test pase: si cambia una captura, explicá por qué.
- `npm run dev`. Para una instancia de prueba al lado de la instalada: `SLOTH_USER_DATA=<carpeta> npm run dev`.

## Estilo
- Sin punto y coma, comillas simples y 2 espacios. Mirá el archivo vecino antes de escribir.
- Comentarios solo para explicar el porqué que no se ve en el código. Nada de separadores, pasos numerados ni JSDoc que repita la firma.
- Sin `any`, sin `console.log` y sin `catch {}` vacío que trague errores reales.
- Lo que se pueda testear va en un módulo puro, sin `electron` ni `child_process`, con su `*.test.ts` al lado. En esos módulos no van enums, namespaces ni parameter properties (el type stripping no los soporta), y los imports de tipos van con `import type`.
- Lo que se escribe en `userData` va con tmp más rename. Nunca se pisa un archivo del usuario sin respaldo.
- Los datos que vienen de afuera (tickets, nombres, comentarios) no van a un prompt ni a una terminal sin validar.

## Ramas y PR
- Las ramas salen de `origin/staging` y el PR va a `staging`. Nunca se trabaja sobre `main`.
- Antes del PR, rebase sobre `origin/staging`. La CI corre typecheck, test y build.
- La versión de `package.json` y `src/shared/changelog.ts` se tocan solo en la rama de release.
