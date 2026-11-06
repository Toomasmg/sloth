# Configuración del equipo (`.sloth/team.json`)

Un archivo versionado **dentro del repo del equipo** que Sloth detecta solo. Sirve para que todos arranquen con las mismas plantillas de espacio, los mismos links y (si quieren) los mismos ajustes.

- **Dónde va:** `<repo>/.sloth/team.json`. Commitealo como cualquier otro archivo.
- **Cuándo se lee:** cuando abrís Sloth, cuando volvés a la ventana y cuando agregás un espacio de ese repo. No hay polling.
- **Qué hace Sloth con el archivo:** solo lo lee y lo valida. Nunca ejecuta nada que venga en él. Si pesa más de 256 KB o tiene algo raro, lo rechaza y te dice por qué.
- **Qué ves:**
  - En la barra lateral aparece la sección **Equipo**.
  - Si hay plantillas nuevas o cambiadas, aparece el chip «Hay plantillas nuevas del equipo». Al tocarlo ves qué cambia antes de importar.

## Formato

```json
{
  "formato": "sloth-team",
  "versión": 1,
  "equipo": "Cosmos-Ai",
  "plantillas": [
    {
      "name": "Ticket",
      "repoPath": ".",
      "cuenta": "sugerida",
      "namePattern": "{ticket}",
      "initialPrompt": "/ticket {ticket}",
      "autoStartClaude": true,
      "resume": true
    },
    {
      "name": "Front con worktree",
      "repoPath": "apps/web",
      "cuenta": "sugerida",
      "useWorktree": { "branchPattern": "feat/{ticketmin}" },
      "autoStartClaude": true,
      "resume": false
    }
  ],
  "ajustes": { "densidad": "compacta", "tamañoTerminal": 13 },
  "links": [
    { "nombre": "Gruv", "url": "https://…" },
    { "nombre": "Staging", "url": "https://…" },
    { "nombre": "Docs", "url": "https://…" }
  ]
}
```

| Clave | Obligatoria | Qué es |
|---|---|---|
| `formato` | sí | Siempre `"sloth-team"`. |
| `versión` | sí | Siempre `1`. |
| `equipo` | sí | Nombre que se muestra. Hasta 60 caracteres. |
| `plantillas` | no | Hasta 50. Usan el mismo formato que las plantillas de Sloth, con dos diferencias: ver la lista de abajo. |
| `ajustes` | no | Son solo una sugerencia: cada uno decide si la acepta. `densidad` puede ser `"compacta"` o `"cómoda"`. `tamañoTerminal` es un entero entre 11 y 18. |
| `links` | no | Hasta 12. Se abren en el navegador y solo se aceptan si empiezan con `https://`. |

Las dos diferencias de las plantillas del equipo:

- **`repoPath`** es relativo a la raíz del repo: `"."` o una subcarpeta como `"apps/web"`. No se aceptan rutas absolutas ni `..`.
- **`cuenta`** es siempre `"sugerida"`. Al usarla, Sloth elige la cuenta con sesión iniciada que menos usó en las últimas 5 horas.

Más reglas de las plantillas:

- Las variables son `{ticket}`, `{ticketmin}`, `{fecha}`, `{n}` y `{plantilla}`.
- La rama de `useWorktree` tiene que ser un nombre válido para git.

Reglas estrictas para todo el archivo:

- Las claves que Sloth no conoce son un error. Las que empiezan con `_` o `$` se ignoran, así que sirven para comentar: `"_nota": "…"`.
- No puede haber dos plantillas con el mismo nombre (sin importar mayúsculas).

## Importar y actualizar sin duplicar

- **La identidad de cada plantilla del equipo es su `name`.** Sloth recuerda qué plantilla tuya corresponde a cada una, en `userData/features/team-config.json`.
- **Si el equipo cambia una plantilla, se actualiza la tuya.** Queda el mismo id y se conserva su contador `{n}`. No se crea otra.
- **Si ya tenías una plantilla idéntica, se adopta.** Pasa a contar como del equipo, sin crear una copia.
- **Si tenías una plantilla distinta con el mismo nombre, no se pisa.** La del equipo se guarda como «Nombre (equipo)».
- **Si el equipo saca una plantilla, la tuya queda.** Sloth te avisa, pero no la borra.
- **«Ahora no» oculta el aviso hasta el próximo cambio del archivo.** El hash solo mira las plantillas: cambiar links o ajustes no dispara el aviso de plantillas nuevas.

Para importar, tenés tres caminos:

- El chip de la sección **Equipo**.
- `Ctrl+K` → «Importar/actualizar plantillas del equipo».
- El paso «Repo» del asistente de bienvenida.

## Exportar tu configuración como la del equipo

Usá `Ctrl+K` → «Exportar mi configuración como configuración del equipo», o el ícono de exportar en la sección **Equipo**. Elegís estas cosas:

- El repo.
- El nombre del equipo.
- Qué plantillas van. Solo aparecen las que apuntan a ese repo o a una subcarpeta.
- Los links.
- Si querés recomendar tus ajustes actuales.

Antes de guardar, Sloth te muestra el contenido exacto. Recién con tu confirmación escribe `<repo>/.sloth/team.json`. Si ya había uno, lo reemplaza y te avisa antes.

El archivo no lleva datos personales:

- No lleva cuentas: todas las plantillas quedan con `"sugerida"`.
- No lleva rutas absolutas: quedan relativas al repo.
- No lleva ids, contadores ni fechas.
- Las plantillas cuyo prompt tiene una ruta absoluta o un correo quedan afuera, y Sloth te dice cuáles.

Después lo commiteás vos: `git add .sloth/team.json`.
