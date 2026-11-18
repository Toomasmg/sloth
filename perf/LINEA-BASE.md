# Línea base de rendimiento de listas

Banco: `npm run perf` (compila y corre `perf/listas.spec.ts` sobre `out/`, con datos sintéticos y carpetas `SLOTH_USER_DATA` temporales). Deja `perf/reporte.md` y `perf/reporte.json` (ignorados por git). `PERF_CV=1 npx playwright test -c perf/playwright.config.ts` repite todo con `content-visibility:auto` inyectado y escribe `perf/reporte-cv.*`. No corre en `npm test` ni en la CI.

Máquina: AMD Ryzen 5 4600H, 12 hilos, 15 GB, Windows 11 (10.0.26300), 2026-11-18. Las tablas de la base («código actual») son de una sola corrida. Los tiempos varían mucho entre corridas y entre sesiones (el primer render del tablero de 2000 tarjetas dio de 343 a 1376 ms con el mismo código), así que desde E-4 los resultados se informan con mediana y rango de al menos 5 corridas, y las comparaciones entre sesiones distintas no son confiables. Los nodos del DOM, en cambio, son exactos.

## Chat (código actual, commit 2b2f229)

| N enviados | nodos `[data-mid]` | nodos totales | primer render (ms) | scroll (ms) | frame p95 (ms) | re-render (ms, mediana) | mutaciones/s en reposo |
|---|---|---|---|---|---|---|---|
| 200 | 200 | 1872 | 665 | 431 | 49.9 | 52 | 2.6 |
| 2000 | 300 | 2813 | 540 | 525 | 17.9 | 72 | 1.0 |
| 10000 | 300 | 2843 | 379 | 530 | 17.5 | 99 | 0.6 |

Hallazgo: el store del chat recorta la caché a `MAX_CACHED = 300` por conversación (`store.ts`), así que hoy el DOM nunca pasa de 300 mensajes (~9,5 nodos por mensaje). Con N=2000 y 10000 se miden 300. El costo real de hoy es el re-render completo de esos 300 (52 a 99 ms por evento, el mismo costo que tendría el tick de expiración de 60 s), no la cantidad de nodos con N enorme. Virtualizar solo tiene sentido si se sube `MAX_CACHED` o se pagina más historial.

## Tablero (código actual)

| N tarjetas | `.f-tickets-row` | nodos totales | primer render (ms) | scroll (ms) | frame p95 (ms) | LoAF en el scroll | mutaciones/s en reposo |
|---|---|---|---|---|---|---|---|
| 50 | 50 | 672 | 387 | 338 | 230 (arranque en frío) | 2 (366 ms) | 0.8 |
| 500 | 500 | 6072 | 768 | 1158 | 26.9 | 2 (284 ms) | 0.4 |
| 2000 | 2000 | 24072 | 2378 | 4111 | 17.4 | 3 (1810 ms) | 0.8 |

Hoy se dibujan todas las tarjetas: 12 nodos por tarjeta, 24072 nodos con 2000.

## `content-visibility:auto` (referencia)

Inyectado sobre `.f-chat-scroll > ul > li` y `.f-tickets-rows > li` con `contain-intrinsic-size: auto 70px`.

- Nodos: idénticos a la base (200/300/300 en chat; 50/500/2000 en tablero). No baja nodos ni fibras de React, como se esperaba.
- Chat: primer render 845/418/280 ms (base 665/540/379), re-render 51/4/66 ms (base 52/72/99): dentro del ruido, sin mejora sostenida.
- Tablero 2000: primer render 1130 ms (base 2378), pero el scroll empeora: 8323 ms contra 4111 ms, frame p95 41 ms contra 17 ms, 2.8 mutaciones/s. Estimar alturas de a 70 px hace trabajar al layout al scrollear.
- Conclusión: no alcanza. Se descarta como solución; la ventana virtual es lo que baja nodos.

## Metas (fijadas con lo medido)

Chat, caché de 300 mensajes (el tope actual) y N=10000 enviados:
- `[data-mid]` en el DOM < 100 (base 300) y nodos totales < 1000 (base 2843).
- Re-render por evento (typing o tick de expiración) < 25 ms (base 99 ms).
- Mutaciones en reposo ≤ 1/s (base 0.6 a 2.6, ya bajo; que no suba) y el tick de expiración deja de re-renderizar la lista.
- Primer render no peor que la base (379 a 845 ms con ruido).
- Con N <= 150 el render es idéntico al actual.

Tablero, N=2000:
- Tarjetas en el DOM < 150 (base 2000) y nodos totales < 2500 (base 24072).
- Primer render < 600 ms (menos de 25 % de 2378).
- Scroll completo sin LoAF acumulado mayor a 400 ms (base 1810 ms) y frame p95 <= 20 ms.
- Con N <= 100 el render es idéntico al actual.

## Chat después de E-2 (memo de MessageItem, reloj único, expiración con un solo timeout)

| N enviados | nodos `[data-mid]` | nodos totales | primer render (ms) | re-render por evento (ms, mediana) |
|---|---|---|---|---|
| 200 | 200 | 1872 | 516 | 15 (base 52) |
| 2000 | 300 | 2813 | 401 | 16 (base 72) |
| 10000 | 300 | 2843 | 373 | 13 (base 99) |

Otra corrida dio 9 ms en los tres casos. Sin el memo (solo el reloj) el re-render quedó en 65/106/98 ms: lo que baja el costo es el memo, y el reloj evita que el tick de expiración renderice la conversación entera.

Decisión: el chat no se virtualiza. Con el re-render por debajo de la meta de 25 ms y el DOM acotado a 300 mensajes por el tope `MAX_CACHED`, la ventana virtual agregaría riesgo (scroll anclado, mensajes en vivo mientras se mira historial, saltos a citas y búsqueda, selección, foco y lectores de pantalla) sin un beneficio medible. Las metas de `[data-mid]` < 100 y nodos < 1000 quedan sin aplicar al chat. Si se sube `MAX_CACHED` o se pagina más historial, se reevalúa con `lib/ventana-virtual.ts`, que ya existe con tests y lo usa el tablero en E-3.

## Resultados con la rama terminada (5 corridas de `npm run perf`, mediana y [mínimo-máximo])

Corridas de la sesión de E-4 con el código final (misma máquina). Los tiempos de esta sesión salieron mucho más bajos que los de E-2 y E-3 (primer render del chat 135 ms contra 373 a 516 ms): la PC estaba menos cargada o con otro estado térmico, no se pudo determinar por qué. Lo que sigue vale para esa sesión; no prueba que las metas de tiempo se cumplan siempre.

### Chat (sin ventana virtual: el DOM queda en 300 mensajes por `MAX_CACHED`)

| N enviados | `[data-mid]` | nodos totales | primer render (ms) | re-render por evento (ms) | frame p95 (ms) | mutaciones/s en reposo |
|---|---|---|---|---|---|---|
| 200 | 200 | 1872 | 185 [137-247] | 15.8 [13.5-16.9] | 17.2 [17.0-18.4] | 0.8 |
| 2000 | 300 | 2813 | 136 [129-204] | 15.1 [14.5-16.9] | 17.2 [17.0-17.3] | 0.8 |
| 10000 | 300 | 2843 | 137 [123-194] | 15.1 [13.9-16.2] | 17.1 [17.0-17.2] | 0.4 a 0.8 |

### Tablero

| N tarjetas | `.f-tickets-row` | nodos totales | primer render del banco (ms) | desde el aviso (ms, complementaria) | LoAF acumulado en el scroll (ms) | frame p95 (ms) |
|---|---|---|---|---|---|---|
| 50 | 50 (idéntico a la base) | 672 (idéntico) | 333 [324-342] | 321 [311-328] | 84 [72-109] | 86 [77-101] |
| 500 | 12 | 217 | 326 [308-342] | 245 [206-260] | 86 [77-178] | 18.0 [17.5-18.2] |
| 2000 | 12 | 217 | 358 [344-449] | 61 [56-73] | 103 [81-156] | 17.8 [17.5-17.9] |

El scroll completo del banco con 2000 tarjetas tarda 4024 ms [4004-4047], igual que la base (4111): baja de a 800 px por cuadro hasta el final, así que depende de la altura total y no mide nada de lo que mejoró.

### Corridas anteriores del tablero de 2000 (E-3, mismo código salvo los arreglos de E-4)

- Primer render del banco: 739, 783, 899, 1004 y 1376 ms (mediana 899, rango 739-1376). En E-3 se había puesto 740 en la tabla, que era la mejor.
- LoAF acumulado: 311, 300, 429 y 591 ms (de las otras cuatro corridas no quedó registro).
- «Desde el aviso»: 108 ms en la corrida que se publicó.

## Qué metas se cumplen

La meta de tiempo se fijó sobre el primer render del banco y sobre el LoAF, y no se cambió. Estado:

| Meta (tablero N=2000 salvo que diga chat) | Resultado | ¿Cumplida? |
|---|---|---|
| Tarjetas en el DOM < 150 | 12 | Sí |
| Nodos totales < 2500 | 217 | Sí |
| Primer render del banco < 600 ms | E-4: 344-449 ms (5 de 5 cumplen). E-3: 739-1376 ms (0 de 5 cumplen). | **No de forma estable**: falla en algunas corridas y sesiones |
| LoAF acumulado en el scroll <= 400 ms | E-4: 81-156 ms (5 de 5). E-3: 300, 311, 429, 591 ms (2 de 4 fallan). | **No de forma estable**: falla en algunas corridas |
| Frame p95 <= 20 ms | 17.5-17.9 ms | Sí |
| Mutaciones en reposo <= 1/s | 0.4 a 0.8 | Sí |
| Con N <= 100 el DOM es idéntico | 672 nodos antes y después con 50; capturas de `e2e/` sin cambios | Sí |
| Chat: re-render por evento < 25 ms | 13.5-16.9 ms en las 15 corridas | Sí |
| Chat: `[data-mid]` < 100 y nodos < 1000 | 300 y 2843 | **No aplicada**: el chat no se virtualiza (ver arriba) |
| Chat: primer render no peor que la base | 123-247 ms (base 379 a 845, medida en otra sesión) | Sí en esta sesión; la comparación entre sesiones no es confiable |
| Chat: el tick de expiración no re-renderiza la lista | Por diseño (un `setTimeout` por vigilia); el banco no lo mide | Sin medir |

## La métrica «desde el aviso» (complementaria)

«Desde el aviso» va del listener de `feat:tickets:changed` en el renderer hasta la primera tarjeta pintada. Se agregó en E-3 para separar lo que tarda el banco en mandar las 2000 tarjetas, pero no reemplaza a la métrica de la meta y no la hace cumplirse: **no incluye el IPC de main al renderer ni el structured clone de las tarjetas**, que sí están en el camino real del usuario. Lo único que queda afuera del código es el tramo de Playwright a main. Medirlo entero pide mandar `Date.now()` desde main en el payload, justo antes de `webContents.send`, y compararlo con el del primer pintado; no está hecho. Desde E-4 el banco toma como aviso solo el primero que trae las N tarjetas.

## Con más de 100 tarjetas

Ctrl+F del navegador, la selección y copia entre tarjetas y la impresión solo ven las unas 12 tarjetas dibujadas. El tablero tiene su propio buscador (id y título) para encontrar el resto.
