// Imágenes que importa la interfaz: Vite devuelve la URL del archivo.
declare module '*.png' {
  const url: string
  export default url
}
declare module '*.webp' {
  const url: string
  export default url
}
