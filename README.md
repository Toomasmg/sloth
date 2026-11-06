# Sloth

Varias cuentas de Claude Code a la vez, cada una en su PowerShell y su repo.

## Uso

```powershell
npm install
npm run dev               # desarrollo con recarga
npm run build; npm start  # versión compilada
npm run dist              # instalador .exe en dist/
```

1. **Cuentas**: escribí un nombre y agregala. Se abre Claude con esa cuenta para iniciar sesión
   (para la segunda cuenta usá una ventana de incógnito en el navegador, así no reusa la sesión).
2. **Espacios**: «Nuevo» (repo + cuenta, worktree opcional, prompt inicial) o «Ticket»
   (`TCK-1234` → abre Claude con `/ticket TCK-1234`).
3. Abrí varios espacios: se ven en grilla, cada uno con el color de su cuenta, su carpeta y su estado.

## Cómo funciona

- **Cuenta = carpeta propia** usada como `CLAUDE_CONFIG_DIR` (`%APPDATA%\Sloth\accounts\<id>\claude`):
  el login y el historial quedan separados.
- **Tu setup compartido** (switch por cuenta, activado por defecto): `skills`, `agents`, `commands`,
  `hooks`, `plugins` y `output-styles` de `~/.claude` se enlazan con junctions (lo que cambies se ve
  al instante en todas las cuentas); `settings.json`, `CLAUDE.md` y la statusline se copian en cada
  arranque; los MCP de `~/.claude.json` se agregan a la cuenta. Ojo: en una cuenta con setup
  compartido, los cambios de settings hechos desde esa cuenta se pisan al reabrir: editá `~/.claude`.
- **Entorno limpio**: cada terminal arranca sin `ANTHROPIC_API_KEY` ni variables de otra sesión de
  Claude, así nunca usa otra cuenta por accidente. Si la cuenta falta, la terminal no arranca.
- **Estado en vivo** (Listo / Trabajando / Te necesita / Terminó / Cerrado) por hooks de Claude Code
  que solo reportan dentro de Sloth, con un token por sesión, a `127.0.0.1`.
- **Uso por cuenta**: tokens de las últimas 5 h, hoy y 7 días, leídos de los transcripts de cada
  cuenta. Al crear un espacio se sugiere la cuenta con sesión que menos usaste en las últimas 5 h.
- **Retomar**: al reabrir un espacio se usa `claude --continue` si ya hubo una conversación en esa carpeta.
- **Terminales persistentes**: las PowerShell viven en un daemon (`node`, ~56 MB, 0 % de CPU en reposo)
  aparte de la ventana. Cerrás Sloth y los agentes siguen trabajando; al reabrir se reconecta con todo
  el historial. El daemon se apaga solo a los 30 s si no quedan terminales ni ventanas. Si no hay
  `node` en el PATH, las terminales corren dentro de la app («Modo simple»). Desde la barra de título:
  «Apagar todas las terminales».
- **Permisos desde la app**: cuando Claude va a pedir permiso (hook `PermissionRequest`), el panel
  muestra la tarjeta con Aprobar / Aprobar siempre / Rechazar / Responder en la terminal. Si no
  respondés en 2 minutos o la app está cerrada, Claude pregunta en la terminal como siempre.

## Liviano a propósito

- Sin workers de fondo, telemetría, navegador embebido ni plugins: solo ventana + daemon.
- Salida de las terminales agrupada cada 16 ms; nada de polling con la ventana oculta.
- Lectura de transcripts por bloques de 1 MB (memoria acotada aunque pesen cientos de MB).
- Chromium sin renderer de repuesto, media, traducción ni autocompletado; sin corrector ortográfico.
- **Modo liviano automático**: en PCs con ≤ 8 GB de RAM se apaga la GPU (≈ 90 MB menos).
  Forzar con la variable de entorno `SLOTH_GPU=1` (encendida) o `SLOTH_GPU=0` (apagada).
- Instalador de ~109 MB: solo español/inglés y solo los binarios de Windows x64.

Atajos: `Ctrl+Shift+C` / `Ctrl+Shift+V` copian y pegan; clic derecho copia la selección o pega.
