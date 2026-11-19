# Privacidad en Sloth

Una descripción técnica y honesta de lo que Sloth hace con tus datos. No es un contrato ni una promesa legal.

## Lo esencial

- Todo lo tuyo vive en tu PC, dentro de la carpeta de datos de Sloth.
- Sloth no envía telemetría, estadísticas de uso ni diagnósticos: en el código no hay ningún servicio de análisis.
- Hay dos tipos de salidas. Lo que vos decidís activar (el chat, el celu, ntfy, el dictado y `gh`) solo sale si lo activás. Lo único que Sloth hace por su cuenta es buscar actualizaciones en los releases de GitHub, y eso no se puede apagar.
- Los agentes (Claude, Codex y Copilot) trabajan en tu PC con tus propias cuentas. Sloth no guarda sus contraseñas ni sus tokens.
- Cuando quieras, podés borrar todo: al final está cómo.

## Qué guarda Sloth y dónde

Los datos viven en la carpeta que Electron llama `userData` de la app «Sloth». En Windows es `%APPDATA%\Sloth`; si arrancás con la variable `SLOTH_USER_DATA`, se usa la carpeta que indiques.

- **Perfiles**: `perfiles.json` y `perfiles\<perfil>\`. Cada perfil tiene su propio `sloth-state.json` (cuentas y espacios) y su carpeta `features\`, con un JSON por función: ajustes, plantillas, permisos, celu, chat, historial y demás.
- **Cuentas de los agentes**: `accounts\<id>\`. Cada cuenta es la carpeta de configuración de su agente (`CLAUDE_CONFIG_DIR` o `CODEX_HOME`): ahí guarda sus cosas el propio agente, su inicio de sesión incluido.
- **Sesión del chat**: `chat-session.bin`, cifrada con el almacén seguro del sistema. Si el sistema no ofrece cifrado, no se guarda y la sesión dura lo que dure la app.
- **Lo que se guarda sin cifrar** en esos JSON: la URL y la clave pública (anon) de tu Supabase, la clave del celu por Wi-Fi, el secreto del celu «desde cualquier red» y, si los cargaste, el tema y el token de ntfy.
- **Registros locales**: `logs\sloth.log`, con rotación y tope de tamaño. Antes de escribirlos se tapan tu carpeta personal, las rutas de usuario y todo lo que parece un token. Nunca se envían.
- **Diagnóstico**: «Copiar diagnóstico» arma un texto (versiones, funciones activas y últimos errores, todo redactado) y lo deja en tu portapapeles. No va a ningún otro lado.
- **Respaldos**: antes de reescribir un JSON, Sloth deja una copia `<archivo>.bak-<fecha>` al lado y conserva las últimas 5 por archivo. Al pasar a perfiles se hizo una copia en `respaldos\pre-perfiles-<fecha>`, y un perfil que borrás se mueve a `respaldos\perfil-<id>-<fecha>` en lugar de eliminarse.
- **Modelo de dictado**: `whisper\`, que se descarga la primera vez que dictás (más abajo, los detalles).

## Lo que Sloth hace por su cuenta

- **Buscar actualizaciones**: en la app instalada, Sloth consulta los releases de su repositorio en GitHub unos 20 segundos después de abrirse y después cada 6 horas (cada 12 con el modo liviano de Configuración). Solo busca con la ventana visible, y también cuando tocás «Buscar actualizaciones». No hay un interruptor para apagarlo; sí podés elegir el canal (estable o beta), que cambia qué versiones se buscan. Para mostrar las notas de una versión, Sloth consulta además `api.github.com`, sin iniciar sesión. Esos pedidos no llevan identificadores propios de Sloth: el código no agrega ninguno. Como en cualquier pedido web, GitHub ve tu IP. Qué registra de ahí en adelante lo decide GitHub.

## Lo que sale de tu PC, solo si lo activás

- **Chat de equipo**: conversa con el proyecto de Supabase que cargaste vos (URL y clave en Configuración > Equipo y chat). Por ahí viajan tus mensajes, reacciones, fotos de equipo y tu perfil de GitHub (usuario, nombre y foto). Para entrar se usa el login de GitHub en tu navegador, y para mostrar las fotos de perfil la interfaz pide imágenes a `avatars.githubusercontent.com`.
- **Celu por Wi-Fi**: un servidor HTTP en tu red local, apagado de fábrica. Los pedidos y las respuestas van sellados (AES-256-CTR y HMAC-SHA256) con una clave que viaja en el `#` del enlace del QR. Es HTTP y no HTTPS: lo que no está sellado, la página misma, circula en claro dentro de tu red. La página del celu pide sus fuentes a Google Fonts desde el navegador del teléfono (ver también «desde cualquier red»). Si prendés «Abrir las terminales desde el celu» (apagado de fábrica), también viaja, sellada igual, la salida de la terminal de cada espacio que abras y lo que escribas desde el celu; con la clave del QR se puede correr cualquier comando en la PC. Esto no pasa nunca por «desde cualquier red».
- **Celu «desde cualquier red»**: la PC y el celu se intercambian mensajes por un canal privado de tu mismo Supabase. Lo que se envía (estado de las sesiones, cuentas, límites, pedidos de permiso y tus decisiones) va cifrado con AES-256-GCM, con una clave derivada de un secreto que viaja en el `#` del enlace del QR. La página del celu se descarga de `toomasmg.github.io/sloth/celu/` y, igual que la de Wi-Fi, pide sus fuentes a Google Fonts desde el navegador del teléfono.
- **ntfy**: si lo prendés, cada aviso (terminó, te necesita, pide permiso) se envía a `https://ntfy.sh/` o al servidor que indiques, bajo el tema que configures. Lleva el nombre del espacio y un texto breve: lo que pasó o el mensaje del agente. Sloth no lo cifra por su cuenta: viaja por https hasta el servidor.
- **GitHub (`gh`)**: la CLI de GitHub, con tu sesión, se usa para PRs, estado del equipo y la foto del perfil. «Reportar un problema» abre en tu navegador un issue ya redactado, y solo se publica si lo enviás vos.
- **Dictado**: la primera vez descarga un modelo de voz desde `huggingface.co` y su CDN, y verifica su SHA-256. El audio se procesa en tu PC.
- **Agentes**: Claude, Codex y Copilot corren como procesos locales con tus cuentas. Lo que ellos envían a sus proveedores lo rigen las políticas de esos proveedores, no Sloth. Si le das a una cuenta de Claude acceso al chat, lo que lea de él lo procesa su proveedor.

## Lo que Sloth no hace

- No envía telemetría, estadísticas de uso, reportes de errores ni diagnósticos.
- No sale nada por su cuenta, salvo la búsqueda de actualizaciones que se describe arriba.
- No lee tus contraseñas ni abre las credenciales de los agentes (el `.credentials.json` de Claude, el `auth.json` de Codex).
- No guarda contraseñas ni tokens de los agentes. «Exportar configuración» nunca incluye credenciales, sesiones ni transcripciones.
- El código de la interfaz no llama a servicios externos. Lo único remoto que muestra son los avatares de GitHub del chat (si activaste el chat).

<!-- DUDOSA: lo que Supabase guarda del lado del servidor (mensajes, logs, retención, copias) depende de tu proyecto y de su plan; el código no lo determina. -->
<!-- DUDOSA: lo que ntfy.sh guarda del lado del servidor y por cuánto tiempo, y quién puede leer un tema público; depende del servicio y del servidor que elijas. -->
<!-- DUDOSA: lo que GitHub (releases, Pages, API) registra de los pedidos; no depende de Sloth. -->
<!-- DUDOSA: de punta a punta del celu remoto. El código cifra el contenido, pero que el servidor no vea nada más (quién se conecta, cuándo, tamaños) y la solidez del esquema no se pueden confirmar leyendo el código. -->
<!-- DUDOSA: que el chat con Claude por MCP sea solo opt-in por cuenta (no verificado en la interfaz). -->

## Lo que queda en manos de cada servicio

Qué conserva cada servicio de su lado, por cuánto tiempo y quién puede verlo es decisión de ese servicio y no de Sloth. Conviene leer la política de cada uno: [Supabase](https://supabase.com), [ntfy](https://ntfy.sh), [GitHub](https://github.com), [Hugging Face](https://huggingface.co) y la de tu proveedor de agente. Si usás un Supabase o un servidor de ntfy de otra persona, esa persona administra esos datos.

## Cómo borrar todo

1. Cerrá Sloth, también el ícono de la bandeja.
2. Borrá la carpeta de datos (en Windows, `%APPDATA%\Sloth`). Con eso se van los perfiles, los ajustes, la configuración del chat y del celu, los registros, los respaldos y el modelo de dictado.
3. Las cuentas de los agentes están dentro de esa carpeta (`accounts\`): al borrarla se pierden sus inicios de sesión. «Quitar cuenta» dentro de la app solo la saca de Sloth y deja su carpeta. Lo que los agentes guardan por su cuenta fuera de ella (por ejemplo en `~\.claude` o en el almacén del sistema) no lo toca Sloth.
4. Para quitar un solo perfil: Configuración > Perfiles. Queda una copia en `respaldos\`, que podés borrar a mano.
5. Para quitar solo el chat: Configuración > Equipo y chat, «Cerrar sesión» y «Borrar configuración». Lo que ya está en el Supabase lo borra quien administra ese proyecto.
6. Para quitar solo el celu: apagá sus interruptores en el panel Celular (Wi-Fi, «desde cualquier red» y ntfy) y regenerá las claves si querés que los enlaces anteriores dejen de servir.
