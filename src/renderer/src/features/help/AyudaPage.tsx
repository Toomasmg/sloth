import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { SHORTCUTS, type Shortcut } from '../../shortcuts'
import { AccountIcon, BranchIcon, ChatIcon, FolderIcon, PermissionIcon, ReportIcon, SearchIcon } from '../../icons/SlothIcons'
import { openSettings } from '../settings/bus'
import { openReport } from '../report/bus'
import { PageShell } from './PageShell'
import { marks, matchesAll, wordsOf } from './text'
import './ayuda.css'

/** Primeros pasos: lo que hace la app de verdad (etiquetas tal cual aparecen en Sloth). */
const CARDS: { id: string; title: string; sum: string; icon: React.ReactNode; steps: string[] }[] = [
  {
    id: 'espacio',
    title: 'Crear un espacio',
    sum: 'Un espacio junta una carpeta del proyecto, una cuenta de Claude y una terminal.',
    icon: <FolderIcon size={15} />,
    steps: [
      'Tocá «Nuevo espacio» en la barra lateral o buscalo en la paleta (Ctrl K).',
      'Elegí la carpeta del proyecto. También podés arrastrarla a la ventana.',
      'Elegí la cuenta de Claude con la que va a trabajar.',
      'Ponele un nombre corto y confirmá. La terminal abre en esa carpeta.'
    ]
  },
  {
    id: 'cuentas',
    title: 'Usar varias cuentas',
    sum: 'Cada cuenta tiene su sesión y sus propios espacios.',
    icon: <AccountIcon size={15} />,
    steps: [
      'En Configuración, sección Cuentas, agregá una cuenta y ponele un nombre.',
      'Abrí su terminal desde la barra lateral. Si todavía no entraste, tocá «Iniciar sesión».',
      'Para pasar un espacio a otra cuenta, usá «Mover a otra cuenta» en la cabecera del panel.'
    ]
  },
  {
    id: 'permisos',
    title: 'Pedidos de permiso',
    sum: 'Claude pide permiso antes de hacer cosas que lo necesitan, como correr un comando.',
    icon: <PermissionIcon size={15} />,
    steps: [
      'Cuando Claude necesita permiso, aparece una tarjeta con el detalle de lo que quiere hacer.',
      'Aprobar lo deja seguir. «Aprobar siempre» lo deja permitido para ese espacio.',
      '«Rechazar» le avisa a Claude que pruebe otra cosa. Podés escribir un motivo.',
      'Si no contestás a tiempo, el pedido vence y el espacio queda esperando.'
    ]
  },
  {
    id: 'ramas',
    title: 'Ramas aparte',
    sum: 'Un espacio puede trabajar en su propia rama, así varios cambios no se pisan.',
    icon: <BranchIcon size={15} />,
    steps: [
      'Al crear el espacio podés elegir una rama. Sloth prepara una copia de trabajo para esa rama.',
      'La rama de cada espacio aparece debajo de su nombre.',
      'Antes de mergear, revisá los cambios desde el panel de Git del espacio.'
    ]
  },
  {
    id: 'chat',
    title: 'Chat del equipo',
    sum: 'Hablá con tu equipo sin salir de Sloth.',
    icon: <ChatIcon size={15} />,
    steps: [
      'Abrilo con el botón Chat de la barra de título.',
      'Los canales y los mensajes directos están en el mismo panel.',
      'Si tenés «No molestar» activo, no te avisa, pero los mensajes quedan esperando.'
    ]
  }
]

const FAQS: { id: string; q: string; a: string }[] = [
  {
    id: 'bloqueo',
    q: '¿Puede Anthropic bloquearme por usar Sloth?',
    a: 'Sloth usa Claude Code con tus propias cuentas y no las comparte. No detecta límites ni cambia de cuenta sola. Igual, el uso de tus cuentas sigue las condiciones de Anthropic. Si tenés dudas sobre tu caso, consultalo directamente con Anthropic.'
  },
  {
    id: 'contrasenas',
    q: '¿Sloth lee mis contraseñas?',
    a: 'No. Sloth no pide, no guarda y no lee contraseñas ni tokens. El inicio de sesión pasa por el navegador.'
  },
  {
    id: 'historial',
    q: '¿Cómo retomo una conversación de antes?',
    a: 'Abrí el historial (Ctrl Shift F), elegí la conversación y tocá «Retomar». Sloth abre el espacio de esa carpeta con Claude en esa conversación.'
  },
  {
    id: 'quitar',
    q: '¿Quitar una conversación de la lista borra algo?',
    a: 'No. «Quitar de la lista» solo la oculta en Sloth. Los archivos de Claude no se tocan, y podés volver a mostrarla desde el historial.'
  },
  {
    id: 'ventana',
    q: '¿Qué pasa si cierro la ventana?',
    a: 'Claude sigue trabajando en segundo plano. Al volver a abrir Sloth, cada panel se reconecta donde estaba.'
  },
  {
    id: 'mover',
    q: '¿Cómo muevo un espacio a otra cuenta?',
    a: 'Usá «Mover a otra cuenta» en la cabecera del panel. Antes de moverlo, guardá lo que estés haciendo en la terminal.'
  },
  {
    id: 'actualizar',
    q: '¿Cómo actualizo?',
    a: 'Sloth busca actualizaciones sola. Para revisar ya, buscá «Buscar actualizaciones» en la paleta (Ctrl K).'
  }
]

const GROUPS = ['General', 'Paneles', 'Terminal'] as const
const SECTIONS = [
  { id: 'ay-primeros', label: 'Primeros pasos' },
  { id: 'ay-atajos', label: 'Atajos de teclado' },
  { id: 'ay-faq', label: 'Preguntas frecuentes' },
  { id: 'ay-mas', label: 'Más ayuda' }
] as const

/** Combinaciones de un atajo como texto: «Ctrl+K», o varias separadas por « o ». */
const comboText = (s: Shortcut): string => s.keys.map((c) => c.join('+')).join(' o ')

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
    name: g,
    rows: SHORTCUTS.filter((s) => (s.group ?? 'General') === g).filter((s) => matchesAll(`${g} ${s.what} ${comboText(s)}`, words))
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
              <button type="button" className="btn sm ghost" onClick={() => setQ('')}>
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
            <span className="hint">Probá con otra palabra, por ejemplo «permiso», «cuenta» o «Ctrl K». Si el tema no aparece acá, contanos.</span>
            <div className="ay-empty-actions">
              <button type="button" className="btn sm" onClick={() => setQ('')}>
                Limpiar búsqueda
              </button>
              <button
                type="button"
                className="btn sm primary"
                onClick={() => {
                  onClose()
                  openReport()
                }}
              >
                <ReportIcon size={14} />
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
                          <span className="ay-card-ico">{c.icon}</span>
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
                    className="btn sm"
                    onClick={() => {
                      onClose()
                      openSettings('atajos')
                    }}
                  >
                    Cambiar atajos
                  </button>
                </div>
                <div className="group">
                  {groups.map((g) => (
                    <div key={g.name} className="ay-group">
                      <div className="ay-group-name">{g.name}</div>
                      {g.rows.map((r) => (
                        <div key={r.what} className="group-row ay-key-row">
                          <span className="ay-key-what">{hl(r.what)}</span>
                          <span className="ay-keys">
                            {r.keys.map((combo, i) => (
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
                            className="btn sm ghost"
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
                <p className="hint">Para cambiar uno, buscalo en Configuración › Atajos de teclado y apretá la combinación nueva.</p>
              </section>
            )}

            {faqs.length > 0 && (
              <section id="ay-faq" className="ay-sec" aria-labelledby="ay-h-faq">
                <h2 id="ay-h-faq">Preguntas frecuentes</h2>
                <div className="group">
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
              <div className="ay-more group-row">
                <div className="ay-more-text">
                  <span className="ay-more-title">Si algo no funciona, contanos qué pasó</span>
                  <span className="hint">Se abre un issue en GitHub con lo que nos cuentes. Podés adjuntar la información del sistema.</span>
                </div>
                <div className="ay-more-actions">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => {
                      onClose()
                      openReport()
                    }}
                  >
                    <ReportIcon size={14} />
                    Reportar un problema
                  </button>
                  <a className="btn" href="https://github.com/Toomasmg/sloth" target="_blank" rel="noopener noreferrer">
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
          {note}
        </div>
      )}
    </PageShell>
  )
}
