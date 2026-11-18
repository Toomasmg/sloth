# Línea base de rendimiento de listas

Banco: `npm run perf` (compila y corre `perf/listas.spec.ts` sobre `out/`, con datos sintéticos y carpetas `SLOTH_USER_DATA` temporales). Deja `perf/reporte.md` y `perf/reporte.json` (ignorados por git). `PERF_CV=1 npx playwright test -c perf/playwright.config.ts` repite todo con `content-visibility:auto` inyectado y escribe `perf/reporte-cv.*`. No corre en `npm test` ni en la CI.

Máquina: AMD Ryzen 5 4600H, 12 hilos, 15 GB, Windows 11 (10.0.26300), 2026-11-18. Una corrida; el primer render y el re-render tienen ruido de decenas a cientos de ms entre corridas, así que las metas se apoyan en los nodos del DOM y en órdenes de magnitud.

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

## Tablero después de E-3 (tarjeta en memo, ventana virtual con más de 100 tarjetas)

| N tarjetas | `.f-tickets-row` | nodos totales | primer render (ms) | desde el aviso (ms) | LoAF en el scroll | frame p95 (ms) |
|---|---|---|---|---|---|---|
| 50 | 50 (base 50) | 672 (base 672) | 399 (base 387 a 404) | 363 (base 361) | 2 (368 ms) | 215 (arranque en frío, como en la base) |
| 500 | 12 (base 500) | 217 (base 6072) | 362 (base 559 a 768) | 221 (base 377) | 2 (268 ms) | 18.6 |
| 2000 | 12 (base 2000) | 217 (base 24072) | 740 (corridas: 739, 783, 899, 1004, 1376; base 1874 a 2378) | 108 (base 1163) | 2 (311 ms; otras corridas 300, 429, 591; base 1328 a 1810) | 17.4 |

La columna «desde el aviso» es lo que tarda la UI desde que le llega `feat:tickets:changed` hasta pintar la primera tarjeta; el «primer render» del banco suma además lo que tarda el propio banco en mandar las 2000 tarjetas por CDP (unos 600 a 700 ms que el código no controla), por eso la meta de 600 ms se juzga con la primera. Con N <= 100 el DOM es idéntico al de antes (50: 672 nodos antes y después) y las capturas de `e2e/` no cambian. El scroll del banco baja de a 800 px por cuadro hasta el final, así que su duración depende de la altura total y no mejora.
