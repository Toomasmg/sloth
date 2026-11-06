# Chat del equipo en Sloth (Supabase propio)

Desde la v0.5, Sloth tiene un chat para personas: equipos con nombre, descripción y foto, chat grupal por equipo y mensajes directos (por ejemplo, con Mateo). Funciona sobre **tu propio proyecto de Supabase**, que es gratis. Sloth no tiene servidor propio y no ve tus mensajes.

Esto lo hace **una sola persona del equipo, una vez**. Son unos 15 minutos. Después, cada compañero solo inicia sesión con GitHub.

> **Seguridad, lo más importante.** En Sloth se pega solo la **anon key** (también llamada *publishable key*): está hecha para ser pública y la protege la Row Level Security de la migración. La **service_role key** (o *secret key*) **nunca** va en Sloth, ni en `.sloth/team.json`, ni en ningún repo. Sloth la rechaza si la pegás por error.

## 1. Crear el proyecto de Supabase

1. Entrá a <https://supabase.com> y creá una cuenta. Podés entrar con GitHub.
2. Tocá **New project**. Elegí un nombre (por ejemplo `sloth-chat-cosmos`), una contraseña de base de datos (guardala en tu gestor de contraseñas: Sloth no la usa) y la región más cercana (por ejemplo *South America (São Paulo)*).
3. Esperá a que termine de crearse. Tarda 1 o 2 minutos.
4. Andá a **Project Settings → API** (o **Data API**) y anotá:
   - **Project URL**: `https://<ref>.supabase.co`
   - **anon public** (o **Publishable key**): empieza con `eyJ…` o con `sb_publishable_…`

## 2. Crear la GitHub OAuth App

1. En GitHub, andá a **Settings → Developer settings → OAuth Apps → New OAuth App**. Si querés que la app sea de la organización, hacelo en la organización: **Settings → Developer settings → OAuth Apps**.
2. Completá así:
   - **Application name**: `Sloth chat`
   - **Homepage URL**: `https://github.com/Toomasmg/sloth`
   - **Authorization callback URL**: `https://<ref>.supabase.co/auth/v1/callback`. Es la URL de tu proyecto más `/auth/v1/callback`.
3. Tocá **Register application**. Después tocá **Generate a new client secret** y copiá el **Client ID** y el **Client secret**. Este secreto va **solo** en Supabase, en el paso 3.

## 3. Habilitar GitHub en Supabase Auth

1. En Supabase, andá a **Authentication → Sign In / Providers**.
2. En **GitHub**, activalo y pegá el Client ID y el Client secret. Guardá.
3. Desactivá el proveedor **Email**: el chat usa solo GitHub, y así nadie se crea una cuenta con un usuario inventado.
4. Andá a **Authentication → URL Configuration**:
   - En **Site URL**, poné `http://127.0.0.1:53682/auth/callback`.
   - En **Redirect URLs**, agregá estas tres. Son los puertos que prueba Sloth para recibir el login:
     - `http://127.0.0.1:53682/auth/callback`
     - `http://127.0.0.1:53683/auth/callback`
     - `http://127.0.0.1:53684/auth/callback`

¿Por qué `127.0.0.1`? Cuando tocás «Iniciar sesión con GitHub», Sloth abre tu navegador normal. Al terminar, GitHub y Supabase te devuelven a un mini servidor que Sloth levanta **solo en tu PC** y solo durante el login. Sloth nunca ve tu contraseña de GitHub.

## 4. Correr la migración, con las tablas y la seguridad

1. En Supabase, andá a **SQL Editor → New query**.
2. Copiá todo el contenido de [`supabase/migrations/0001_chat.sql`](../supabase/migrations/0001_chat.sql) de este repo, pegalo y tocá **Run**. Tiene que terminar sin errores. Después hacé lo mismo con [`supabase/migrations/0002_hardening.sql`](../supabase/migrations/0002_hardening.sql), que cierra el acceso por API a las funciones internas (responde a los avisos del Security Advisor).
3. Comprobá que quedó bien:
   - En **Table Editor** tienen que aparecer `profiles`, `teams`, `team_members`, `team_invite_codes`, `team_invites`, `dm_threads` y `messages`. Todas tienen que tener el candado de RLS activado.
   - En **Storage** tiene que aparecer el bucket `team-photos`, **privado**.
   - En **Database → Publications → supabase_realtime** tiene que estar la tabla `messages`.

Si el editor da un error de permisos en `storage.objects` o en `auth.identities`, avisá en el repo con un issue y el texto del error. No hay que tocar nada más.

## 5. Conectar Sloth

Elegí una de las dos formas.

**A. Para vos solo:** en Sloth, andá a **Configuración (Ctrl+,) → Equipo y datos → Chat del equipo**. Pegá la **Project URL** y la **anon key** y tocá **Guardar**. Después tocá **Iniciar sesión con GitHub**.

**B. Para todo el equipo:** agregá esto al `.sloth/team.json` del repo y commitealo:

```json
{
  "chat": {
    "supabaseUrl": "https://<ref>.supabase.co",
    "anonKey": "eyJ...o sb_publishable_..."
  }
}
```

Cuando un compañero abre Sloth con ese repo, la app le pregunta si quiere usar el chat de ese proyecto. Le muestra el dominio y solo lo usa si acepta. Si tiene configurado otro chat a mano en Configuración, gana el suyo.

## 6. Usarlo

- **Crear un equipo:** abrí el **Chat** (botón en la barra de arriba) y tocá **Nuevo equipo**. Elegí nombre, descripción y foto. La foto se recorta en cuadrado y se achica antes de subirla; puede pesar hasta 512 KB.
- **Invitar:** hay dos maneras.
  - **Por usuario de GitHub** (por ejemplo `mateo`): la invitación le aparece cuando inicia sesión.
  - **Por código:** pasale el código del equipo. Lo ven solo los owners y los admins, y lo pueden cambiar cuando quieran; el código viejo deja de andar.
- **Mensaje directo:** desde la lista de miembros de un equipo, tocá **Escribirle**. Solo podés abrir un DM con gente con la que compartís un equipo.
- **No leídos y avisos:** el botón Chat muestra cuántos mensajes tenés sin leer. Si la ventana de Sloth no tiene el foco, te llega una notificación de Windows.

## Qué protege la migración (RLS)

- Un equipo, sus miembros y sus mensajes los leen **solo sus miembros**. Un DM lo leen **solo sus dos participantes**.
- Nadie puede escribir en nombre de otro: el autor y la hora los pone la base de datos. Hay un tope de 30 mensajes por minuto por persona, y un mensaje puede tener hasta 4000 caracteres.
- Entrar a un equipo, abrir un DM y marcar como leído pasan solo por funciones que revisan permisos; no se puede insertar directo. El código de invitación lo ven solo los owners y los admins.
- El usuario de GitHub sale de la identidad que guarda Supabase al iniciar sesión, y el usuario no la puede editar. Por eso nadie puede hacerse pasar por `mateo` para quedarse con su invitación.
- Las fotos van en un bucket **privado**. Las ven solo los miembros del equipo y las cambian solo los owners y los admins.

La migración tiene una prueba con PGlite (Postgres en WASM), con 40 casos de acceso permitido y prohibido: `npm i --no-save @electric-sql/pglite` y después `node supabase/tests/rls.test.mjs supabase/migrations/0001_chat.sql`.

## Costos y consumo

- El plan gratis de Supabase alcanza de sobra para un equipo chico: 500 MB de base, 1 GB de storage y 200 conexiones realtime simultáneas.
- Sloth abre **una sola** conexión realtime, y solo mientras la app está abierta. Si cerrás Sloth, se corta. Si lo dejás en la bandeja, sigue conectado para avisarte.
- Ojo: Supabase **pausa** los proyectos gratis después de una semana sin uso. Si pasa, entrá al panel y tocá **Restore project**.

## Si algo falla

| Problema | Qué hacer |
|---|---|
| «redirect_to no permitido» o vuelve a la página de Supabase | Revisá las **Redirect URLs** del paso 3.4. Tienen que estar las tres. |
| El navegador dice que no puede conectarse a `127.0.0.1` | Sloth tiene que estar abierto mientras iniciás sesión. Probá de nuevo desde Sloth. |
| «Tu usuario no tiene perfil de GitHub» | Entraste con otro proveedor. Cerrá sesión y entrá con GitHub. |
| «Solo podés escribirle a gente de tus equipos» | Primero tienen que estar en un mismo equipo. |
