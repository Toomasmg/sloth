import { Fragment } from 'react'
import { splitMentions } from '../../../../shared/chat-text'
import { useSettings } from '../settings/store'

/** Avatares solo de GitHub (la CSP también lo exige). */
const SAFE_AVATAR = /^https:\/\/avatars\.githubusercontent\.com\//
const SAFE_PHOTO = /^data:image\/(webp|png|jpeg);base64,/

/** Foto o avatar si son válidos; si no, la inicial. Siempre decorativo (el nombre va al lado). */
export function Av({ src, initial, size = 22 }: { src?: string; initial: string; size?: number }): React.JSX.Element {
  // Modo liviano: sin fotos, solo la inicial.
  const lite = useSettings().settings.lightMode
  if (!lite && src && (SAFE_AVATAR.test(src) || SAFE_PHOTO.test(src))) {
    return <img className="f-chat-av" src={src} alt="" width={size} height={size} loading="lazy" decoding="async" />
  }
  return (
    <span className="f-chat-av f-chat-av-init" style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }} aria-hidden="true">
      {(initial || '?').slice(0, 1).toUpperCase()}
    </span>
  )
}

const URL_RE = /https:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/g

/** Texto suelto con las menciones @login resaltadas (la del propio usuario con más fuerza). */
function Mentions({ text, meLogin, prefix }: { text: string; meLogin?: string; prefix: string }): React.JSX.Element {
  return (
    <>
      {splitMentions(text).map((p, i) =>
        p.kind === 'text' ? (
          <Fragment key={`${prefix}${i}`}>{p.text}</Fragment>
        ) : (
          <span key={`${prefix}${i}`} className={p.login.toLowerCase() === meLogin?.toLowerCase() ? 'f-chat-mention me' : 'f-chat-mention'}>
            @{p.login}
          </span>
        )
      )}
    </>
  )
}

/**
 * Cuerpo del mensaje como TEXTO (nunca HTML). Los https:// se vuelven links que abre el navegador y las
 * @menciones se resaltan; los links se buscan primero para no partir una URL con un «@» adentro.
 */
export function LinkedText({ text, meLogin }: { text: string; meLogin?: string }): React.JSX.Element {
  const out: React.ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(URL_RE)) {
    const at = m.index ?? 0
    if (at > last) out.push(<Mentions key={`t${i}`} prefix={`t${i}-`} text={text.slice(last, at)} meLogin={meLogin} />)
    out.push(
      <a key={`a${i}`} href={m[0]} target="_blank" rel="noopener noreferrer">
        {m[0]}
      </a>
    )
    last = at + m[0].length
    i++
  }
  if (last < text.length) out.push(<Mentions key={`t${i}`} prefix={`t${i}-`} text={text.slice(last)} meLogin={meLogin} />)
  return <>{out}</>
}

const dayKey = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** «Hoy», «Ayer», o la fecha. */
export function dayLabel(ms: number, now = Date.now()): string {
  const k = dayKey(ms)
  if (k === dayKey(now)) return 'Hoy'
  if (k === dayKey(now - 86_400_000)) return 'Ayer'
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('es-AR', sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' })
}

export function sameDay(a: number, b: number): boolean {
  return dayKey(a) === dayKey(b)
}

export const timeLabel = (ms: number): string => new Date(ms).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })

/** Host de una URL https (para mostrar, sin el path). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Nombre corto de una carpeta (última parte de la ruta). */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}
