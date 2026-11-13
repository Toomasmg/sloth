import type { ErrorDictado, TipoErrorDictado } from '../shared/dictado'

/**
 * Dictado con el motor de voz de Windows (el mismo de Win+H) pero sin su ventana: un PowerShell
 * escucha frase por frase con SpeechRecognizer.RecognizeAsync y avisa por stdout en JSON, una línea
 * por evento. PowerShell 5.1 no se puede suscribir a eventos de WinRT, por eso no se usa la sesión
 * continua. Para cortar, main crea el archivo de $env:SLOTH_DICTADO_STOP: se espera a que termine la
 * frase en curso. No se usa stdin porque, si está conectado, PowerShell no corre el script hasta que
 * se cierra.
 */
export const DICTADO_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
function Say($o) { [Console]::Out.WriteLine((ConvertTo-Json $o -Compress)); [Console]::Out.Flush() }
function Code($ex) { while ($ex.InnerException) { $ex = $ex.InnerException }; '0x{0:X8}' -f $ex.HResult }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.SpeechRecognition.SpeechRecognizer, Windows.Media.SpeechRecognition, ContentType = WindowsRuntime]
  $null = [Windows.Foundation.IAsyncAction, Windows.Foundation, ContentType = WindowsRuntime]
  $ext = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
  $asOp = $ext | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' } | Select-Object -First 1
  $asAct = $ext | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
  $r = New-Object Windows.Media.SpeechRecognition.SpeechRecognizer
  $r.Timeouts.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(1200)
  $t = $asOp.MakeGenericMethod([Windows.Media.SpeechRecognition.SpeechRecognitionCompilationResult]).Invoke($null, @($r.CompileConstraintsAsync()))
  $t.Wait(-1) | Out-Null
  if ($t.Result.Status -ne 'Success') { Say @{ e = 'error'; code = [string]$t.Result.Status }; exit 1 }
  $asR = $asOp.MakeGenericMethod([Windows.Media.SpeechRecognition.SpeechRecognitionResult])
} catch { Say @{ e = 'error'; code = (Code $_.Exception) }; exit 1 }
$stopFile = $env:SLOTH_DICTADO_STOP
$stop = $false
Say @{ e = 'escuchando' }
while ($true) {
  try { $op = $r.RecognizeAsync(); $task = $asR.Invoke($null, @($op)) } catch { Say @{ e = 'error'; code = (Code $_.Exception) }; exit 1 }
  $waited = 0
  while (-not $task.IsCompleted) {
    if (-not $stop -and (-not $stopFile -or (Test-Path -LiteralPath $stopFile))) {
      $stop = $true
      Say @{ e = 'transcribiendo' }
      try { $null = $asAct.Invoke($null, @($r.StopRecognitionAsync())) } catch { }
    }
    Start-Sleep -Milliseconds 50
    if ($stop) { $waited += 50; if ($waited -gt 4000) { $op.Cancel(); break } }
  }
  if ($task.IsCanceled) { break }
  if ($task.IsFaulted) { Say @{ e = 'error'; code = (Code $task.Exception) }; exit 1 }
  $res = $task.Result
  $st = [string]$res.Status
  if ($res.Text) { Say @{ e = 'texto'; t = $res.Text } }
  if (@('Success', 'TimeoutExceeded', 'PauseLimitExceeded', 'UserCanceled') -notcontains $st) { Say @{ e = 'error'; code = $st }; exit 1 }
  if ($stop) { break }
}
Say @{ e = 'fin' }
`

/** Argumentos de powershell.exe: el script va codificado (UTF-16LE en base64), sin archivos sueltos. */
export function dictadoArgs(script: string = DICTADO_SCRIPT): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

export type LineaDictado =
  | { e: 'escuchando' }
  | { e: 'transcribiendo' }
  | { e: 'texto'; t: string }
  | { e: 'error'; code: string }
  | { e: 'fin' }

const MAX_TEXTO = 4000

/** Interpreta una línea del script. Lo que no es un evento conocido se ignora (null). */
export function parseLinea(line: string): LineaDictado | null {
  let o: unknown
  try {
    o = JSON.parse(line.trim())
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const { e, t, code } = o as Record<string, unknown>
  if (e === 'escuchando' || e === 'transcribiendo' || e === 'fin') return { e }
  if (e === 'texto' && typeof t === 'string') {
    const texto = limpiarTexto(t)
    return texto ? { e, t: texto } : null
  }
  if (e === 'error') return { e, code: typeof code === 'string' ? code.slice(0, 64) : 'desconocido' }
  return null
}

/** El texto va a la terminal: sin caracteres de control (un \r mandaría el mensaje) ni espacios de más. */
export function limpiarTexto(t: string): string {
  return t.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXTO)
}

const MENSAJES: Record<TipoErrorDictado, string> = {
  privacidad: 'Para dictar, activá «Reconocimiento de voz en línea» en la Configuración de Windows.',
  microfono: 'No hay acceso al micrófono. Revisá que esté conectado y que Windows deje usarlo a las apps de escritorio.',
  idioma: 'Windows no tiene el reconocimiento de voz para tu idioma. Instalalo en Configuración › Hora e idioma › Voz.',
  red: 'Sin conexión: el dictado de Windows necesita internet.',
  sistema: 'El dictado por ahora funciona solo en Windows 10 u 11.',
  otro: 'No se pudo dictar.'
}

/** Pantallas de Configuración de Windows que arreglan cada error (lista cerrada: es lo único que se abre). */
export const AJUSTES_DICTADO: Partial<Record<TipoErrorDictado, string>> = {
  privacidad: 'ms-settings:privacy-speech',
  microfono: 'ms-settings:privacy-microphone',
  idioma: 'ms-settings:speech'
}

/** Código del script (HRESULT o estado del resultado) → error para la UI. */
export function errorDictado(code: string): ErrorDictado {
  const c = code.toUpperCase()
  const tipo: TipoErrorDictado =
    c === '0X80045509' ? 'privacidad'
      : c === '0X80070005' || c === 'MICROPHONEUNAVAILABLE' || c === 'AUDIOQUALITYFAILURE' ? 'microfono'
        : c === 'TOPICLANGUAGENOTSUPPORTED' || c === 'GRAMMARLANGUAGEMISMATCH' ? 'idioma'
          : c === 'NETWORKFAILURE' ? 'red'
            : c === 'SISTEMA' ? 'sistema'
              : 'otro'
  const mensaje = tipo === 'otro' ? `${MENSAJES.otro} (${code.slice(0, 32)})` : MENSAJES[tipo]
  return { tipo, mensaje, ajustes: tipo in AJUSTES_DICTADO }
}
