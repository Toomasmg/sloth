# AntiRea

Varias cuentas de Claude Code a la vez, cada una en su PowerShell y su repo.

## Uso

```powershell
npm install
npm run dev      # desarrollo con recarga
npm run build; npm start   # versión compilada
```

1. **Cuentas**: escribí un nombre y tocá «Agregar». Se abre Claude con esa cuenta; iniciá sesión
   (para la segunda cuenta usá una ventana de incógnito en el navegador, así no reusa la sesión).
2. **Espacios**: «+ Nuevo» → repo, nombre, cuenta. Opcional: un worktree en una rama propia.
3. Abrí varios espacios: se ven en grilla, cada uno con su cuenta, su carpeta y su estado.

## Cómo funciona

- Cada cuenta es una carpeta propia usada como `CLAUDE_CONFIG_DIR`
  (`%APPDATA%\AntiRea\accounts\<id>\claude`): login, settings e historial separados.
- Cada terminal arranca con un entorno limpio: sin `ANTHROPIC_API_KEY` ni variables de otra sesión
  de Claude, así nunca usa otra cuenta por accidente. Si la cuenta falta, la terminal no arranca.
- El estado (trabajando / te necesita / terminó) llega por hooks de Claude Code instalados en el
  `settings.json` de cada cuenta. Los hooks solo reportan dentro de AntiRea, con un token por sesión,
  a un servidor en `127.0.0.1`.
- Las terminales siguen corriendo aunque ocultes el panel; los paneles abiertos se recuerdan al reabrir.

Atajos: `Ctrl+Shift+C` / `Ctrl+Shift+V` copian y pegan; clic derecho copia la selección o pega.
