/** Corre `fn` sobre cada elemento con hasta `n` a la vez, en el orden de la lista. */
export async function deA<T>(xs: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  const cola = [...xs]
  const uno = async (): Promise<void> => {
    for (let x = cola.shift(); x !== undefined; x = cola.shift()) await fn(x)
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, n), cola.length) }, uno))
}
