# Chat del equipo en Sloth

Sloth tiene un chat para personas: equipos con nombre, descripción y foto, chat grupal por equipo y mensajes directos. Funciona sobre **tu propio proyecto de Supabase**, que es gratis. Sloth no tiene servidor propio y no ve tus mensajes.

Esto lo hace **una sola persona del equipo, una vez**. No hace falta saber SQL. Son unos 15 minutos. Después, cada compañero solo inicia sesión con GitHub.

## Lo que necesitás

- Una cuenta de GitHub.
- Una cuenta de Supabase (podés crearla con GitHub).
- Sloth instalado.

## Antes de empezar: qué clave copiar

> **Seguridad, lo más importante.**
>
> - Copiá solo la clave **Publishable** (a veces figura como **anon** o **anon public**). Empieza con `sb_publishable_…` o con `eyJ…`.
> - **Nunca** copies la clave **service_role** (a veces figura como **secret**). Empieza con `sb_secret_…`. Sloth la rechaza si la pegás.

¿Por qué? La clave publishable está hecha para ser pública: la base de datos protege los datos con reglas de acceso (RLS) que instala el paso 3. La service_role, en cambio, se salta todas esas reglas. Quien la tenga puede leer y borrar todo. No va en Sloth, ni en `.sloth/team.json`, ni en ningún repo, ni en un chat.

## 1. Crear el proyecto de Supabase

1. Entrá a <https://supabase.com> y creá una cuenta.
2. Tocá **New project**.
3. Elegí un nombre (por ejemplo `chat-equipo`).
4. Elegí una contraseña de base de datos y guardala en tu gestor de contraseñas. Sloth no la usa.
5. Elegí la región más cercana a tu equipo.
6. Tocá **Create new project** y esperá 1 o 2 minutos.
7. Cuando termine, andá a **Project Settings → API** (en algunas versiones, **Data API**).
8. Anotá la **Project URL**. Tiene esta forma: `https://<ref>.supabase.co`.
9. Anotá la clave **Publishable** (o **anon public**). Ya sabés cuál: la que no dice secret ni service_role.

## 2. Pegar el SQL

Un solo archivo arma todo: [`supabase/setup.sql`](../supabase/setup.sql).

1. Abrí `supabase/setup.sql` en GitHub, en el repo de Sloth.
2. Tocá **Raw**.
3. Seleccioná todo (`Ctrl+A`) y copiá (`Ctrl+C`).
4. En Supabase, andá a **SQL Editor → New query**.
5. Pegá todo y tocá **Run**.
6. Tiene que decir **Success. No rows returned**. Eso es lo esperado.

Es seguro repetirlo. Si algo se cortó a la mitad, volvé a pegarlo entero.

Si da un error, copiá el texto completo y abrí un issue en el repo. No toques nada más.

## 3. Activar GitHub como proveedor de login

Primero creás una app en GitHub y después se la contás a Supabase.

**En GitHub:**

1. Andá a **Settings → Developer settings → OAuth Apps → New OAuth App**. Si querés que la app sea de una organización, hacelo desde la organización.
2. **Application name**: `Chat del equipo`.
3. **Homepage URL**: `https://github.com/Toomasmg/sloth`. Puede ser cualquier URL: solo se muestra en la pantalla de permisos.
4. **Authorization callback URL**: `https://<ref>.supabase.co/auth/v1/callback`. Es la Project URL más `/auth/v1/callback`.
5. Tocá **Register application**.
6. Tocá **Generate a new client secret**.
7. Copiá el **Client ID** y el **Client secret**. Este secreto va solo en Supabase.

**En Supabase:**

1. Andá a **Authentication → Sign In / Providers**.
2. Abrí **GitHub**, activalo y pegá el Client ID y el Client secret. Guardá.
3. Desactivá el proveedor **Email**. El chat usa solo GitHub, y así nadie se crea una cuenta con un usuario inventado.
4. Andá a **Authentication → URL Configuration**.
5. En **Site URL** poné `http://127.0.0.1:53682/auth/callback`.
6. En **Redirect URLs** agregá estas tres. Son los puertos que prueba Sloth para recibir el login:
   - `http://127.0.0.1:53682/auth/callback`
   - `http://127.0.0.1:53683/auth/callback`
   - `http://127.0.0.1:53684/auth/callback`

¿Por qué `127.0.0.1`? Al iniciar sesión, Sloth abre tu navegador. Al terminar, GitHub y Supabase te devuelven a un mini servidor que Sloth levanta solo en tu PC y solo durante el login. Sloth nunca ve tu contraseña de GitHub.

## 4. Conectar Sloth

Elegí una de las dos formas.

**A. Para vos solo**

1. En Sloth, abrí **Configuración (Ctrl+,) → Equipo y chat**.
2. Pegá la **URL del proyecto de Supabase**.
3. Pegá la **Clave publicable**.
4. Tocá **Guardar**.
5. Tocá **Conectar con GitHub** y aceptá en el navegador.
6. Tocá **Probar conexión**.

**B. Para todo el equipo**

Agregá esto al `.sloth/team.json` del repo y commitealo:

```json
{
  "chat": {
    "supabaseUrl": "https://<ref>.supabase.co",
    "anonKey": "sb_publishable_..."
  }
}
```

Cuando un compañero abre Sloth con ese repo, la app le muestra el dominio y le pregunta si quiere usar ese chat. Solo lo usa si acepta. Si ya tiene otro chat configurado a mano, gana el suyo.

### Qué dice «Probar conexión»

Cada línea es un chequeo. Si alguno falla, la tabla dice qué hacer.

| Chequeo | Si falla, qué hacer |
|---|---|
| Servidor | Si dice «Host propio», es un aviso: Sloth le manda la clave pública a ese servidor. Confirmá que es el tuyo. |
| Conexión | La URL está mal escrita, la clave es otra o el proyecto está pausado. Revisá la Project URL y la clave publishable y, si hace falta, tocá **Restore project** en Supabase. |
| Login con GitHub | Falta el paso 3. Activá GitHub en **Authentication → Sign In / Providers** y sumá la Redirect URL. |
| Tablas del chat | Falta el SQL del paso 2. Volvé a pegar `supabase/setup.sql` entero y esperá un minuto. |
| Funciones del chat | Lo mismo: volvé a pegar `supabase/setup.sql` entero. Si dice «Seguridad», la clave pública pudo ejecutar una función que no debería: pegalo de nuevo. |
| Versión del esquema | Si falta la migración 0009 o tu esquema es más viejo, volvé a pegar `supabase/setup.sql` entero. Pasa tras actualizar Sloth. Si es más nuevo, actualizá Sloth. |

El chequeo usa solo la clave pública, no escribe nada en tu proyecto y no guarda ni muestra la clave.

## 5. Invitar a tu equipo

1. Abrí el **Chat** (botón en la barra de arriba).
2. Tocá **Nuevo equipo** y elegí nombre, descripción y foto. La foto se recorta en cuadrado y se achica; puede pesar hasta 512 KB.
3. Dentro del equipo, tocá **Invitar**. Solo lo ven el owner y los admins. Hay tres maneras:
   - **Usuario de GitHub**: escribí el usuario sin `@` y tocá **Invitar**. La invitación le aparece cuando inicia sesión.
   - **Código**: tocá **Copiar** y pasale el código. La otra persona entra desde **Chat → Entrar con código**. Con **Cambiar código**, el código viejo deja de andar.
   - **Invitación completa**: tocá **Copiar invitación completa** y mandala. Trae el servidor y el código: quien no tiene el chat configurado la pega en **Unirme con una invitación** y entra en un solo paso.
4. **Mensaje directo**: desde la lista de miembros, tocá **Escribirle**. Solo podés abrir un DM con gente con la que compartís un equipo.
5. **No leídos y avisos**: el botón Chat muestra cuántos mensajes tenés sin leer. Si Sloth no tiene el foco, te llega una notificación de Windows.

## 6. Actualizar el esquema tras una versión nueva de Sloth

Algunas versiones de Sloth traen cambios para la base. Cuando pase:

1. Abrí de nuevo `supabase/setup.sql` en GitHub (Raw) y copialo entero.
2. Pegalo en **SQL Editor → New query** y tocá **Run**.
3. Tocá **Probar conexión** en Sloth para confirmar.

Es seguro repetirlo. Las migraciones están pensadas para volver a correrse sobre un proyecto que ya anda.

## Celular desde cualquier red

En **Celular → Desde cualquier red**, Sloth publica la misma vista que en el Wi-Fi de casa, pero por el Supabase del chat. Hace falta tener sesión iniciada en el chat. Viene apagado. El SQL ya viene en `setup.sql` (migración 0006).

1. En **Auth → URL Configuration → Redirect URLs**, sumá `https://toomasmg.github.io/sloth/celu/**`: el celu entra con GitHub desde esa página.
2. En GitHub, **Settings → Pages → Source: GitHub Actions**. La página la publica el workflow «Celu web» (`.github/workflows/celu-web.yml`) cuando algo de `src/celu-web/` llega a `main`, o a mano con *Run workflow*. Solo lleva la clave publishable; nunca la service_role.
3. Escaneá el QR del panel con el celu y entrá con la **misma** cuenta de GitHub que en Sloth. Después, en Chrome (Android) usá «Instalar app»; en Samsung Internet, «Agregar página a → Pantalla de inicio». En iPhone usala desde Safari: la app de la pantalla de inicio tiene su propio almacenamiento y no ve el emparejamiento.

- **Qué ve el admin de Supabase:** nada útil. Todo va cifrado (AES-256-GCM) con una clave que sale del secreto del QR, y ese secreto viaja en el `#` del enlace, que el navegador no manda al servidor. Sí puede quedar en el historial del navegador (y sincronizarse con tu cuenta de Google) y, si usás «Copiar enlace», en el portapapeles: no lo compartas. Nunca se publica el contenido de las terminales ni los prompts: solo el estado de las sesiones, el uso y los pedidos de permiso.
- **Aprobar permisos desde afuera** tiene su propio interruptor, apagado, que solo se prende con «Aprobar desde el celu» prendido. Cada decisión vale para un pedido, vence al minuto y no se puede repetir.
- **Regenerar el código:** Sloth deja de publicar con la clave vieja y descarta las decisiones selladas con ella, así que los celus emparejados ya no ven ni aprueban nada. Con «Cerrar también la sesión de GitHub en los otros dispositivos» (prendido por defecto) además revoca las sesiones del chat de esa cuenta en todos lados menos en esta PC; el token que ya tenga el celu sigue valiendo hasta que vence (una hora como mucho), pero sin la clave no le sirve para el canal.
- **Qué guarda el celu:** la dirección del proyecto, la clave publishable y tu id en `localStorage`; la clave del canal, como `CryptoKey` no exportable en IndexedDB (el secreto del QR no se guarda), y la sesión de Supabase que deja supabase-js en `localStorage`.
- **El origen compartido:** `localStorage` e IndexedDB son por origen, no por carpeta, y `toomasmg.github.io` lo comparten todas las páginas de GitHub Pages de esa cuenta. Un script de cualquiera de ellas (o una dependencia comprometida) podría leer la sesión de Supabase, que es la misma del chat, y usar la clave mientras corre. Para un uso más amplio que el propio, servila desde un origen solo para ella: un dominio o subdominio propio en GitHub Pages, o Cloudflare Pages (`<proyecto>.pages.dev`), y sumá esa URL en Redirect URLs.
- **Costo:** Sloth publica solo mientras un celu tiene la página abierta (latido cada 15 s y cambios cada 2 s como mucho). Con 2 h por día son unos 80 k mensajes por mes por usuario; el plan gratis trae 2 M.

## Qué protege el SQL (RLS)

- Un equipo, sus miembros y sus mensajes los leen **solo sus miembros**. Un DM lo leen **solo sus dos participantes**.
- Nadie puede escribir en nombre de otro: el autor y la hora los pone la base de datos. Hay topes de mensajes por minuto por persona, y un mensaje puede tener hasta 4000 caracteres.
- Entrar a un equipo, abrir un DM y marcar como leído pasan solo por funciones que revisan permisos; no se puede insertar directo. El código de invitación lo ven solo los owners y los admins.
- El usuario de GitHub sale de la identidad que guarda Supabase al iniciar sesión, y el usuario no la puede editar. Por eso nadie puede hacerse pasar por `ana` para quedarse con su invitación.
- Las fotos van en un bucket **privado**. Las ven solo los miembros del equipo y las cambian solo los owners y los admins.
- Expulsar saca a la persona, borra sus invitaciones pendientes y cambia el código en una sola transacción.
- El canal del celu (`celu:<uid>`) lo leen y escriben **solo** su dueño y no abre los canales del chat.
- La única función que puede llamar quien no inició sesión es `chat_schema_version()`: devuelve un número y nada más. Sloth la usa para saber qué versión del esquema tiene tu proyecto.

El SQL tiene una prueba con PGlite (Postgres en WASM) con más de 140 casos de acceso permitido y prohibido. Para correrla: `npm i --no-save @electric-sql/pglite` y después `node supabase/tests/rls.test.mjs supabase/setup.sql`.

`setup.sql` se genera de las migraciones de `supabase/migrations/` con `node scripts/build-supabase-setup.mjs`. No se edita a mano. Está pensado para un proyecto nuevo: las migraciones 0001 a 0008 ya estaban aplicadas en proyectos existentes y no se tocaron. Si el tuyo ya andaba, pegar `setup.sql` entero también es seguro (las pruebas lo verifican sobre una base de prueba, también con las migraciones 0001 a 0008 y datos ya cargados).

Nota: el enlace de «Privacidad» en «Acerca de» apunta a `main` y da 404 hasta que esta versión llega a esa rama.

## Costos y consumo

- El plan gratis de Supabase alcanza de sobra para un equipo chico: 500 MB de base, 1 GB de storage y 200 conexiones realtime simultáneas.
- Sloth abre **una sola** conexión realtime, y solo mientras la app está abierta. Si cerrás Sloth, se corta. Si lo dejás en la bandeja, sigue conectado para avisarte.
- Ojo: Supabase **pausa** los proyectos gratis después de una semana sin uso. Si pasa, entrá al panel y tocá **Restore project**.

## Si algo falla

| Problema | Qué hacer |
|---|---|
| «redirect_to no permitido» o vuelve a la página de Supabase | Revisá las **Redirect URLs** del paso 3. Tienen que estar las tres. |
| El navegador dice que no puede conectarse a `127.0.0.1` | Sloth tiene que estar abierto mientras iniciás sesión. Probá de nuevo desde Sloth. |
| «Tu usuario no tiene perfil de GitHub» | Entraste con otro proveedor. Cerrá sesión y entrá con GitHub. |
| «Solo podés escribirle a gente de tus equipos» | Primero tienen que estar en un mismo equipo. |
| Sloth dice que pegaste la clave equivocada | Copiaste la service_role (`sb_secret_…`). Volvé a **Project Settings → API** y copiá la **Publishable**. Si la pegaste en algún lado, regenerala desde ese mismo panel. |
| El proyecto no responde | Puede estar pausado. Entrá al panel de Supabase y tocá **Restore project**. |
