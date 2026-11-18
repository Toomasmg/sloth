# Privacidad en Sloth

Esto es una descripción técnica de qué hace la app con tus datos. No es un contrato ni una promesa legal.

## En pocas palabras

- Sloth guarda todo en tu PC, en su carpeta de datos.
- No manda telemetría, estadísticas de uso ni diagnósticos. No hay ningún servicio de análisis en el código.
- Lo único que sale de tu PC es lo que activás vos: el chat, el celu, ntfy, y lo que consulta GitHub (actualizaciones, `gh`).
- Los agentes (Claude, Codex, Copilot) corren en tu PC con tus propias cuentas. Sloth no guarda sus contraseñas ni tokens.
- Podés borrar todo: al final está cómo.

## Qué guarda Sloth y dónde

La carpeta de datos es la que Electron llama `userData` de la app «Sloth». En Windows es `%APPDATA%\Sloth`. Si arrancás con la variable `SLOTH_USER_DATA`, se usa esa carpeta.

- **Perfiles**: `perfiles.json` y `perfiles\<perfil>\`. Cada perfil tiene su `sloth-state.json` (cuentas y espacios) y su carpeta `features\` con un JSON por función (ajustes, plantillas, permisos, celu, chat, historial, etc.).
- **Cuentas de los agentes**: `accounts\<id>\`. Cada cuenta es la carpeta de configuración de su agente (`CLAUDE_CONFIG_DIR` o `CODEX_HOME`): ahí guarda sus cosas el propio agente, incluido su login.
- **Sesión del chat**: `chat-session.bin`, cifrada con el almacén seguro del sistema. Si el sistema no tiene cifrado disponible, no se guarda y la sesión dura lo que la app.
- **Datos que Sloth guarda sin cifrar** en esos JSON: la URL y la clave pública (anon) de tu Supabase, la clave del celu por Wi-Fi, el secreto del celu «desde cualquier red», y el tema y el token de ntfy si los cargaste.
- **Registros locales**: `logs\sloth.log`, con rotación y tope de tamaño. Antes de escribirlos se tapan tu carpeta personal, las rutas de usuario y lo que parece un token. No se envían.
- **Diagnóstico**: «Copiar diagnóstico» arma un texto (versiones, funciones activas, últimos errores, todo redactado) y lo deja en tu portapapeles. No se manda a ningún lado.
- **Respaldos**: antes de reescribir un JSON, Sloth deja copias `<archivo>.bak-<fecha>` al lado (guarda las últimas 5 por archivo). Al pasar a perfiles se hizo una copia en `respaldos\pre-perfiles-<fecha>`, y un perfil que borrás se mueve a `respaldos\perfil-<id>-<fecha>`, no se elimina.
- **Modelo de dictado**: `whisper\`, descargado la primera vez que dictás (ver abajo).

## Qué sale de tu PC, y solo si lo activás

- **Chat de equipo**: habla con el proyecto de Supabase que cargaste vos (URL y clave en Configuración > Equipo y chat). Ahí van tus mensajes, reacciones, fotos de equipo y tu perfil de GitHub (login, nombre y foto). Para entrar usa el login de GitHub en tu navegador. Para ver las fotos de perfil, la interfaz pide imágenes a `avatars.githubusercontent.com`.
- **Celu por Wi-Fi**: un servidor HTTP en tu red local, apagado por defecto. Los pedidos y respuestas van sellados (AES-256-CTR y HMAC-SHA256) con una clave que va en el `#` del enlace del QR. Es HTTP, no HTTPS: lo que no está sellado (la propia página) viaja en claro dentro de tu red. La página del celu pide fuentes a Google Fonts desde el navegador del teléfono.
- **Celu «desde cualquier red»**: la PC y el celu intercambian mensajes por un canal privado de tu mismo Supabase. Lo que se manda (estado de las sesiones, cuentas, límites, pedidos de permiso y tus decisiones) va cifrado con AES-256-GCM. La clave sale de un secreto que viaja en el `#` del enlace del QR. La página del celu se baja de `toomasmg.github.io/sloth/celu/`.
- **ntfy**: si lo prendés, cada aviso (terminó, te necesita, pide permiso) se manda a `https://ntfy.sh/` o al servidor que pongas, bajo el tema que configures. Lleva el nombre del espacio y un texto corto: lo que pasó o el mensaje del agente. Sloth no lo cifra por su cuenta: va por https hasta el servidor.
- **GitHub**: Sloth consulta las actualizaciones y las notas de cada versión en los releases de su repositorio. `gh` (GitHub CLI, con tu sesión) se usa para PRs, estado del equipo y la foto del perfil. «Reportar un problema» abre en tu navegador un issue prellenado: solo se publica si lo enviás vos.
- **Dictado**: la primera vez baja un modelo de voz desde `huggingface.co` y su CDN, y verifica el SHA-256. El audio se procesa en tu PC.
- **Agentes**: Claude, Codex y Copilot corren como procesos locales con tus cuentas. Lo que ellos mandan a sus proveedores lo rigen las políticas de esos proveedores, no Sloth. Si le das a una cuenta de Claude acceso al chat, lo que lea del chat lo procesa su proveedor.

## Qué no hace

- No envía telemetría, estadísticas de uso, reportes de errores ni diagnósticos.
- No lee tus contraseñas ni abre las credenciales de los agentes (`.credentials.json` de Claude, `auth.json` de Codex).
- No guarda contraseñas ni tokens de los agentes. «Exportar configuración» nunca lleva credenciales, sesiones ni transcripts.
- El código de la interfaz no llama a servicios externos. Lo único remoto que muestra son los avatares de GitHub del chat.

<!-- DUDOSA: lo que Supabase guarda del lado del servidor (mensajes, logs, retención, copias) depende de tu proyecto y de su plan; el código no lo determina. -->
<!-- DUDOSA: lo que ntfy.sh guarda del lado del servidor y por cuánto tiempo, y quién puede leer un tema público; depende del servicio y del servidor que elijas. -->
<!-- DUDOSA: lo que GitHub (releases, Pages, API) registra de los pedidos; no depende de Sloth. -->
<!-- DUDOSA: de punta a punta del celu remoto. El código cifra el contenido, pero que el servidor no vea nada más (quién se conecta, cuándo, tamaños) y la solidez del esquema no se pueden confirmar leyendo el código. -->
<!-- DUDOSA: que el chat con Claude por MCP sea solo opt-in por cuenta (no verificado en la interfaz). -->

## Lo que depende del servicio que elijas

Qué guarda cada servicio de su lado, por cuánto tiempo y quién puede verlo depende de ese servicio, no de Sloth. Mirá la política de cada uno: [Supabase](https://supabase.com), [ntfy](https://ntfy.sh), [GitHub](https://github.com), [Hugging Face](https://huggingface.co) y la de tu proveedor de agente. Si usás un Supabase o un servidor de ntfy de otra persona, esa persona administra esos datos.

## Cómo borrar todo

1. Cerrá Sloth (también el ícono de la bandeja).
2. Borrá la carpeta de datos (en Windows, `%APPDATA%\Sloth`). Con eso se van perfiles, ajustes, la configuración del chat y del celu, registros, respaldos y el modelo de dictado.
3. Las cuentas de los agentes están dentro de esa carpeta (`accounts\`): al borrarla se pierden sus logins. «Quitar cuenta» en la app solo la saca de Sloth y deja su carpeta. Lo que los agentes guardan fuera (por ejemplo en `~\.claude` o en el almacén del sistema) no lo toca Sloth.
4. Solo un perfil: Configuración > Perfiles. Queda una copia en `respaldos\`, que borrás a mano si querés.
5. Solo el chat: Configuración > Equipo y chat, «Cerrar sesión» y «Borrar configuración». Lo que ya está en el Supabase lo borra quien administra ese proyecto.
6. Solo el celu: apagá sus interruptores en el panel Celular (Wi-Fi, «desde cualquier red» y ntfy) y regenerá las claves si querés que los enlaces viejos dejen de servir.
