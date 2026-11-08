import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { SHORTCUTS, shortcutKeys, type Shortcut } from '../../shortcuts'
import { SearchIcon } from '../../icons/SlothIcons'
import { openSettings } from '../settings/bus'
import { openReport } from '../report/bus'
import { PageShell } from './PageShell'
import { marks, matchesAll, wordsOf } from './text'
import './ayuda.css'

/** Ícono de trazo con el path del artboard. */
function PathIcon({ d, size, sw = 1.8 }: { d: string; size: number; sw?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

/** Primeros pasos (texto y íconos del artboard «Ayuda»). */
const CARDS: { id: string; title: string; sum: string; icon: string; steps: string[] }[] = [
  {
    id: 'espacio',
    title: 'Crear un espacio',
    sum: 'Un espacio junta una carpeta del proyecto, una cuenta de Claude y una terminal.',
    icon: 'M4 7a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 7v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17zM7.5 10l2.5 2.5-2.5 2.5M12.5 15h4',
    steps: [
      'Tocá «Nuevo espacio» en la barra lateral o apretá Ctrl N.',
      'Elegí la carpeta del proyecto, por ejemplo la carpeta front de Cosmos-Ai.',
      'Elegí la cuenta de Claude con la que va a trabajar.',
      'Ponele un nombre corto y confirmá. La terminal abre ya en esa carpeta.'
    ]
  },
  {
    id: 'cuentas',
    title: 'Usar varias cuentas',
    sum: 'Cada cuenta tiene su sesión y sus propios espacios.',
    icon: 'M8.5 9a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0M5 19.5c1.2-3 3.9-4.5 7-4.5s5.8 1.5 7 4.5',
    steps: [
      'En Configuración › Cuentas, tocá «Agregar cuenta» y ponele un nombre.',
      'Tocá «Iniciar sesión». Se abre el navegador para entrar con esa cuenta de Claude.',
      'En la barra lateral, cada cuenta muestra sus espacios debajo.',
      'Para pasar un espacio a otra cuenta, usá «Mover a…» en su menú.'
    ]
  },
  {
    id: 'permisos',
    title: 'Pedidos de permiso',
    sum: 'Claude pide permiso antes de correr comandos que lo necesitan.',
    icon: 'M12 3.5l7 3v5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9v-5z',
    steps: [
      'Cuando Claude quiere correr un comando, aparece un recuadro naranja con ese comando.',
      '«Permitir una vez» deja correr ese comando solamente.',
      '«Permitir siempre aquí» lo deja permitido para ese espacio.',
      '«Rechazar» le avisa a Claude que pruebe otra cosa.',
      'Si no contestás, el espacio queda como «Pide permiso» en la barra lateral.'
    ]
  },
  {
    id: 'ramas',
    title: 'Ramas aparte',
    sum: 'Cada espacio trabaja en su propia rama, así varios cambios no se pisan.',
    icon: 'M7 4v16M7 15c0-4 3-5.5 7-6M14 9c1.5-2.5 4-3.5 6.5-3.5-.3 2.6-1.8 4.6-4.4 5.2-1 .2-1.6-.6-2.1-1.7z',
    steps: [
      'La rama de cada espacio aparece debajo de su nombre, por ejemplo feat/filtros.',
      'Para empezar una rama nueva, pedile a Claude en ese espacio: «creá la rama fix/horas».',
      'Tocá el ícono de cambios del panel para ver qué tocó Claude en esa rama.',
      'Antes de mergear, revisá los cambios. Cuando el espacio ya no hace falta, cerralo.'
    ]
  },
  {
    id: 'chat',
    title: 'Chat del equipo',
    sum: 'Hablá con tu equipo sin salir de Sloth.',
    icon: 'M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v6.5a3 3 0 0 1-3 3h-6l-4.5 3.5v-3.5A3 3 0 0 1 4 13.5z',
    steps: [
      'Abrilo con Ctrl Shift M o con el ícono de Equipo arriba a la derecha.',
      'En #general y #deploys ves lo que se habla. Para hablar con alguien, usá mensajes directos.',
      'Para escribirle rápido a una persona, apretá Ctrl K, escribí @ y el nombre.',
      'Si tenés «No molestar» activo, no te avisa, pero los mensajes quedan esperando.'
    ]
  }
]

/** Preguntas frecuentes (texto del artboard «Ayuda»). */
const FAQS: { id: string; q: string; a: string }[] = [
  {
    id: 'bloqueo',
    q: '¿Puede Anthropic bloquearme por usar Sloth?',
    a: 'Sloth usa Claude Code tal cual, con tus propias cuentas y sin compartirlas. Igual, el uso de tus cuentas sigue sujeto a las condiciones de Anthropic. Si tenés dudas sobre tu caso, consultalo directamente con Anthropic.'
  },
  {
    id: 'contrasenas',
    q: '¿Sloth lee mis contraseñas?',
    a: 'No. Sloth no pide, no guarda y no lee contraseñas ni tokens. El inicio de sesión pasa por el navegador.'
  },
  {
    id: 'ventana',
    q: '¿Qué pasa si cierro la ventana?',
    a: 'Las terminales siguen corriendo en segundo plano, si dejaste activada la opción «Dejar las terminales vivas al cerrar la ventana» (Configuración › General). Al volver a abrir Sloth, los espacios vuelven si tenés activado «Reabrir los espacios de la última vez».'
  },
  {
    id: 'mover',
    q: '¿Cómo muevo un espacio a otra cuenta?',
    a: 'Abrí el menú del espacio (los tres puntos) y tocá «Mover a…» con la otra cuenta. También lo encontrás en la paleta (Ctrl K). La terminal se reinicia con la cuenta nueva, así que guardá antes lo que estés haciendo.'
  },
  {
    id: 'actualizar',
    q: '¿Cómo actualizo?',
    a: 'Sloth busca actualizaciones solo. Para revisar ya mismo, andá a Configuración › Actualizaciones y tocá «Buscar ahora». Si querés probar novedades antes, elegí el canal Beta. El Estable es el recomendado.'
  }
]

/** Grupos de atajos: la clave es el grupo de SHORTCUTS; la etiqueta es la del artboard. */
const GROUPS: { key: string; label: string }[] = [
  { key: 'General', label: 'General' },
  { key: 'Paneles', label: 'Espacios y paneles' },
  { key: 'Terminal', label: 'Terminal' },
  { key: 'Chat', label: 'Chat' }
]
const SECTIONS = [
  { id: 'ay-primeros', label: 'Primeros pasos' },
  { id: 'ay-atajos', label: 'Atajos de teclado' },
  { id: 'ay-faq', label: 'Preguntas frecuentes' },
  { id: 'ay-mas', label: 'Más ayuda' }
] as const

/** Combinaciones de un atajo como texto: «Ctrl+K», o varias separadas por « o ». */
const comboText = (s: Shortcut): string => shortcutKeys(s).map((c) => c.join('+')).join(' o ')

export function AyudaPage({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [active, setActive] = useState<string>(SECTIONS[0].id)
  const [note, setNote] = useState('')
  const noteTimer = useRef<number | undefined>(undefined)
  const words = useMemo(() => wordsOf(q), [q])
  const hasQ = q.trim().length > 0

  useEffect(() => () => window.clearTimeout(noteTimer.current), [])

  const say = (m: string): void => {
    setNote(m)
    window.clearTimeout(noteTimer.current)
    noteTimer.current = window.setTimeout(() => setNote(''), 2400)
  }

  const cards = CARDS.filter((c) => matchesAll(`${c.title} ${c.sum} ${c.steps.join(' ')}`, words))
  const faqs = FAQS.filter((f) => matchesAll(`${f.q} ${f.a}`, words))
  const groups = GROUPS.map((g) => ({
    name: g.label,
    rows: SHORTCUTS.filter((s) => (s.group ?? 'General') === g.key).filter((s) => matchesAll(`${g.label} ${s.what} ${comboText(s)}`, words))
  })).filter((g) => g.rows.length > 0)
  const nShortcuts = groups.reduce((n, g) => n + g.rows.length, 0)
  const total = cards.length + nShortcuts + faqs.length
  const noResults = hasQ && total === 0

  const countLabel = !hasQ
    ? ''
    : total === 0
      ? `Ningún resultado para «${q.trim()}»`
      : `${total} ${total === 1 ? 'resultado' : 'resultados'} para «${q.trim()}»`

  const go = (id: string): void => {
    setActive(id)
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const copy = (text: string): void => {
    window.sloth.clipboardWrite(text)
    say(`Copiado «${text}»`)
  }

  const hl = (text: string): React.ReactNode =>
    marks(text, words).map((p, i) =>
      p.hit ? (
        <mark key={i} className="ay-mark">
          {p.t}
        </mark>
      ) : (
        <Fragment key={i}>{p.t}</Fragment>
      )
    )

  return (
    <PageShell labelId="ay-title" title="Ayuda y atajos" onClose={onClose}>
      <div className="ay-wrap">
        <header className="ay-head">
          <h1 id="ay-title">Ayuda y atajos</h1>
          <p>Cómo se usa Sloth, qué hace cada tecla y las dudas más comunes.</p>
        </header>

        <div className="ay-search-box">
          <label className="ay-search">
            <SearchIcon size={16} />
            <input
              type="search"
              autoComplete="off"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar: atajo, cuenta, permiso, actualizar…"
              aria-label="Buscar en la ayuda"
            />
            {hasQ && (
              <button type="button" className="ay-btn ay-btn-secondary ay-btn-sm" onClick={() => setQ('')}>
                Limpiar
              </button>
            )}
          </label>
          <p role="status" className="ay-count">
            {countLabel}
          </p>
        </div>

        {noResults && (
          <div className="ay-empty">
            <span className="ay-empty-title">Nada coincide con «{q.trim()}»</span>
            <span className="ay-empty-text">Probá con otra palabra, por ejemplo «permiso», «cuenta» o «Ctrl K». Si el tema no aparece acá, contanos.</span>
            <div className="ay-empty-actions">
              <button type="button" className="ay-btn ay-btn-secondary" onClick={() => setQ('')}>
                Limpiar búsqueda
              </button>
              <button
                type="button"
                className="ay-btn ay-btn-primary"
                onClick={() => {
                  onClose()
                  openReport()
                }}
              >
                Reportar un problema
              </button>
            </div>
          </div>
        )}

        <div className="ay-layout">
          <nav className="ay-nav" aria-label="Índice de la ayuda">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className="ay-nav-item"
                aria-current={active === s.id ? 'location' : undefined}
                onClick={() => go(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="ay-main">
            {cards.length > 0 && (
              <section id="ay-primeros" className="ay-sec" aria-labelledby="ay-h-primeros">
                <h2 id="ay-h-primeros">Primeros pasos</h2>
                <div className="ay-cards">
                  {cards.map((c) => {
                    const on = !!open[c.id]
                    return (
                      <div key={c.id} className="ay-card">
                        <button
                          type="button"
                          className="ay-card-btn"
                          aria-expanded={on}
                          onClick={() => setOpen((o) => ({ ...o, [c.id]: !on }))}
                        >
                          <span className="ay-card-ico">
                            <PathIcon d={c.icon} size={15} />
                          </span>
                          <span className="ay-card-text">
                            <span className="ay-card-title">{hl(c.title)}</span>
                            <span className="ay-card-sum">{hl(c.sum)}</span>
                          </span>
                          <svg
                            className={`ay-chev ${on ? 'on' : ''}`}
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                        </button>
                        {on && (
                          <ol className="ay-steps">
                            {c.steps.map((s) => (
                              <li key={s}>{hl(s)}</li>
                            ))}
                          </ol>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
            )}

            {groups.length > 0 && (
              <section id="ay-atajos" className="ay-sec" aria-labelledby="ay-h-atajos">
                <div className="ay-sec-head">
                  <h2 id="ay-h-atajos">Atajos de teclado</h2>
                  <button
                    type="button"
                    className="ay-btn ay-btn-secondary"
                    onClick={() => {
                      onClose()
                      openSettings('atajos')
                    }}
                  >
                    Cambiar atajos
                  </button>
                </div>
                <div className="ay-card-box">
                  {groups.map((g) => (
                    <div key={g.name} className="ay-group">
                      <div className="ay-group-name">{g.name}</div>
                      {g.rows.map((r) => (
                        <div key={r.what} className="ay-key-row">
                          <span className="ay-key-what">{hl(r.what)}</span>
                          <span className="ay-keys">
                            {shortcutKeys(r).map((combo, i) => (
                              <Fragment key={i}>
                                {i > 0 && <span className="ay-or">o</span>}
                                {combo.map((k, j) => (
                                  <Fragment key={j}>
                                    {j > 0 && <span className="ay-plus" aria-hidden="true">+</span>}
                                    <kbd>{k}</kbd>
                                  </Fragment>
                                ))}
                              </Fragment>
                            ))}
                          </span>
                          <button
                            type="button"
                            className="ay-btn ay-btn-copy"
                            onClick={() => copy(comboText(r))}
                            aria-label={`Copiar el atajo de ${r.what}`}
                          >
                            Copiar
                          </button>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
                <p className="ay-note">Para cambiar uno, tocá su tecla en Configuración y apretá la combinación nueva.</p>
              </section>
            )}

            {faqs.length > 0 && (
              <section id="ay-faq" className="ay-sec" aria-labelledby="ay-h-faq">
                <h2 id="ay-h-faq">Preguntas frecuentes</h2>
                <div className="ay-card-box">
                  {faqs.map((f) => {
                    const on = !!open[f.id]
                    return (
                      <div key={f.id} className="ay-faq">
                        <button
                          type="button"
                          className="ay-faq-btn"
                          aria-expanded={on}
                          onClick={() => setOpen((o) => ({ ...o, [f.id]: !on }))}
                        >
                          <span className="ay-faq-q">{hl(f.q)}</span>
                          <svg
                            className={`ay-chev ${on ? 'on' : ''}`}
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                        </button>
                        {on && <div className="ay-faq-a">{hl(f.a)}</div>}
                      </div>
                    )
                  })}
                </div>
              </section>
            )}

            <section id="ay-mas" className="ay-sec" aria-labelledby="ay-h-mas">
              <h2 id="ay-h-mas">¿Necesitás más ayuda?</h2>
              <div className="ay-more">
                <div className="ay-more-text">
                  <span className="ay-more-title">Si algo no funciona, contanos qué pasó</span>
                  <span className="ay-more-hint">Se abre GitHub con el reporte listo para enviar, y podés adjuntar la información del sistema.</span>
                </div>
                <div className="ay-more-actions">
                  <button
                    type="button"
                    className="ay-btn ay-btn-primary"
                    onClick={() => {
                      onClose()
                      openReport()
                    }}
                  >
                    Reportar un problema
                  </button>
                  <a className="ay-btn ay-btn-secondary" href="https://github.com/Toomasmg/sloth" target="_blank" rel="noopener noreferrer">
                    Repositorio en GitHub
                  </a>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      {note && (
        <div className="ay-toast" role="status">
          <PathIcon d="M5 12.5l4.5 4.5L19 7.5" size={15} sw={2.2} />
          <span>{note}</span>
        </div>
      )}
    </PageShell>
  )
}
