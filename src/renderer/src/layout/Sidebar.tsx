import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { Account, AccountStatus, AgentStatus, Workspace } from '../../../shared/types'
import { openSettings } from '../features/settings/bus'
import { colorHex } from '../features/templates/catalog'
import { STATE_LABEL, shortPath } from '../format'
import { BranchIcon, ChevronDownIcon, PermissionIcon, PlusIcon, SearchIcon, WaitingIcon, WorkingIcon } from '../icons/SlothIcons'
import { comboLabel } from '../shortcuts'
import { StateIcon } from '../StateIcon'
import { IconButton, Tag } from '../ui'
import { resumenCuenta } from './cuenta-resumen'
import { RenameInput } from './RenameInput'
import { armarModelo, leerPlegadas, normalizarFiltro } from './sidebar-model'
import { accionNav, claveCuenta, claveEspacio, idDeCuenta, itemActivo, itemsNav } from './sidebar-nav'
import { readStorage, writeStorage } from './storage'
import './sidebar.css'

const COLLAPSED_KEY = 'sloth.sidebar.collapsed'

export interface SidebarProps {
  accounts: readonly Account[]
  workspaces: readonly Workspace[]
  statuses: Readonly<Record<string, AccountStatus>>
  agents: Readonly<Record<string, AgentStatus>>
  /** Plan de cada cuenta tal como lo escribió el usuario en Configuración. */
  plans: Readonly<Record<string, string>>
  openIds: readonly string[]
  focusedId: string | null
  /** Espacio que se está renombrando en la fila (el renombre desde el panel no entra acá). */
  editingId: string | null
  permisos(wsId: string): number
  colorOf(accountId: string): string
  onOpen(wsId: string): void
  onStartRename(wsId: string): void
  onRenameDone(ws: Workspace, next: string | null): void
  onMenu(ws: Workspace, x: number, y: number): void
  /** Sin cuenta, abre «nuevo espacio» en general; con cuenta, ya elegida. */
  onNewWorkspace(accountId?: string): void
}

export function Sidebar(p: SidebarProps): React.JSX.Element {
  const [plegadas, setPlegadas] = useState(() => leerPlegadas(readStorage(COLLAPSED_KEY)))
  const [consulta, setConsulta] = useState('')
  const [filtroAbierto, setFiltroAbierto] = useState(false)
  useEffect(() => writeStorage(COLLAPSED_KEY, JSON.stringify(plegadas)), [plegadas])
  const [activo, setActivo] = useState<string | null>(null)
  const listaRef = useRef<HTMLDivElement>(null)

  const filtro = normalizarFiltro(consulta)
  const modelo = useMemo(() => armarModelo(p.accounts, p.workspaces, filtro, plegadas), [p.accounts, p.workspaces, filtro, plegadas])
  const items = useMemo(() => itemsNav(modelo, filtro), [modelo, filtro])
  // Un solo elemento de la lista entra en el orden de Tab (roving tabindex): el último con foco o, al
  // llegar, el espacio enfocado. Las flechas mueven el resto; así recorrerlo no cuesta una parada por fila.
  const tabClave = itemActivo(items, activo, p.focusedId ? claveEspacio(p.focusedId) : null)

  const irA = (clave: string | null): void => {
    if (clave) listaRef.current?.querySelector<HTMLElement>(`[data-nav="${CSS.escape(clave)}"]`)?.focus()
  }
  const onKeyDownLista = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]')
    if (!el) return
    const accion = accionNav(items, el.dataset.nav ?? null, e.key)
    if (!accion) return
    e.preventDefault()
    if (accion.tipo === 'foco') irA(accion.clave)
    else if (accion.tipo !== 'nada') {
      const id = idDeCuenta(accion.clave)
      if (id) setPlegadas((c) => ({ ...c, [id]: accion.tipo === 'plegar' }))
    }
  }

  const fila = (ws: Workspace): React.JSX.Element => (
    <FilaEspacio
      key={ws.id}
      ws={ws}
      cuenta={p.accounts.find((a) => a.id === ws.accountId)?.label}
      agente={p.agents[ws.id]}
      abierto={p.openIds.includes(ws.id)}
      enfocado={p.focusedId === ws.id}
      editando={p.editingId === ws.id}
      permisos={p.permisos(ws.id)}
      tabStop={tabClave === claveEspacio(ws.id)}
      onFocusItem={setActivo}
      p={p}
    />
  )

  return (
    <aside className="sl-side" aria-label="Cuentas y espacios">
      <div className="sl-side-head">
        {/* El filtro ocupa el lugar del título: abrirlo no mueve la lista. */}
        {filtroAbierto ? (
          <input
            className="sl-filter"
            type="search"
            autoFocus
            value={consulta}
            onChange={(e) => setConsulta(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                irA(tabClave)
                return
              }
              if (e.key !== 'Escape') return
              e.preventDefault()
              e.stopPropagation()
              setConsulta('')
              setFiltroAbierto(false)
            }}
            placeholder="Nombre, rama o ticket"
            aria-label="Filtrar espacios por nombre, rama o ticket"
            spellCheck={false}
          />
        ) : (
          <h2 className="sl-side-title">
            Espacios
            <span className="sl-side-count">{p.workspaces.length}</span>
          </h2>
        )}
        <IconButton
          label="Buscar un espacio"
          icon={<SearchIcon size={15} />}
          size="sm"
          pressed={filtroAbierto}
          onClick={() => {
            if (filtroAbierto) setConsulta('')
            setFiltroAbierto(!filtroAbierto)
          }}
        />
      </div>

      <div className="sl-groups" ref={listaRef} onKeyDown={onKeyDownLista}>
        {p.accounts.length === 0 && (
          <section className="sl-acc-none" aria-label="Sin cuentas">
            <p className="sl-hint">Agregá una cuenta de Claude para crear tu primer espacio.</p>
            <button type="button" className="sl-newbtn is-cta" onClick={() => openSettings('cuentas')}>
              <PlusIcon size={15} />
              Agregar cuenta
            </button>
          </section>
        )}

        {modelo.grupos.map(({ cuenta: acc, todos, visibles, abierto }) => {
          const st = p.statuses[acc.id]
          const bodyId = `acc-body-${acc.id}`
          const plan = p.plans[acc.id]
          const loggedOut = st !== undefined && !st.loggedIn
          // El resumen cuenta todos los espacios de la cuenta (el filtro no lo cambia) y se ve también plegada.
          const sum = resumenCuenta(todos.map((w) => w.id), (id) => p.agents[id]?.state, p.permisos)
          const accLabel = [acc.label, loggedOut ? 'sin sesión: iniciá sesión' : plan ? `plan ${plan}` : '', sum.texto].filter(Boolean).join(', ')
          return (
            <section key={acc.id} className="sl-acc" data-account-id={acc.id} aria-label={`Cuenta ${acc.label}`} style={{ '--acc': p.colorOf(acc.id) } as CSSProperties}>
              <div className="sl-acc-head">
                <button
                  type="button"
                  className="sl-acc-toggle"
                  aria-expanded={abierto}
                  aria-controls={bodyId}
                  aria-label={accLabel}
                  data-nav={claveCuenta(acc.id)}
                  tabIndex={tabClave === claveCuenta(acc.id) ? 0 : -1}
                  onFocus={() => setActivo(claveCuenta(acc.id))}
                  title={[st?.email ? `${acc.label} · ${st.email}` : acc.label, loggedOut ? 'Sin sesión: iniciá sesión' : '', `${abierto ? 'Ocultar' : 'Mostrar'} sus espacios`].filter(Boolean).join('\n')}
                  onClick={() => setPlegadas((c) => ({ ...c, [acc.id]: abierto }))}
                >
                  <ChevronDownIcon size={14} className="sl-acc-chev" />
                  <span className={`sl-avatar${loggedOut ? ' is-off' : ''}`} aria-hidden="true">
                    {acc.label.slice(0, 1).toUpperCase()}
                  </span>
                  <span className={`sl-acc-id${loggedOut ? ' is-off' : ''}`}>
                    <span className="sl-acc-name">{acc.label}</span>
                    {loggedOut ? <span className="sl-acc-warn">Sin sesión</span> : plan && <span className={`sl-acc-plan${plan.trim().toLowerCase() === 'team' ? ' is-team' : ''}`}>{plan}</span>}
                  </span>
                  {sum.texto && (
                    <span className="sl-acc-sum" aria-hidden="true">
                      {sum.esperan > 0 && (
                        <span className="sl-acc-stat is-waiting">
                          <WaitingIcon size={12} />
                          {sum.esperan}
                        </span>
                      )}
                      {sum.trabajando > 0 && (
                        <span className="sl-acc-stat is-working">
                          <WorkingIcon size={12} />
                          {sum.trabajando}
                        </span>
                      )}
                    </span>
                  )}
                </button>
                <IconButton label={`Nuevo espacio en ${acc.label}`} icon={<PlusIcon size={14} />} size="sm" className="sl-acc-add" onClick={() => p.onNewWorkspace(acc.id)} />
              </div>
              {abierto && (
                <div id={bodyId}>
                  {visibles.length > 0 ? <ul className="sl-list">{visibles.map(fila)}</ul> : <p className="sl-acc-empty">Sin espacios. Usá el + de la cuenta para crear uno.</p>}
                </div>
              )}
            </section>
          )
        })}

        {modelo.huerfanos.length > 0 && (
          <section className="sl-acc" aria-label="Espacios de una cuenta borrada">
            <div className="sl-acc-head">
              <span className="sl-acc-toggle is-static">
                <span className="sl-acc-id">
                  <span className="sl-acc-name">Cuenta borrada</span>
                </span>
              </span>
            </div>
            <ul className="sl-list">{modelo.huerfanos.map(fila)}</ul>
          </section>
        )}

        {modelo.sinResultados && <p className="sl-hint">Ningún espacio coincide con «{consulta.trim()}».</p>}
      </div>

      <div className="sl-foot">
        <button type="button" className="sl-newbtn" onClick={() => (p.accounts.length ? p.onNewWorkspace() : openSettings('cuentas'))} title={p.accounts.length ? undefined : 'Primero agregá una cuenta de Claude'}>
          <PlusIcon size={14} />
          Nuevo espacio
          <kbd>{comboLabel('new')}</kbd>
        </button>
      </div>
    </aside>
  )
}

interface FilaProps {
  ws: Workspace
  cuenta: string | undefined
  agente: AgentStatus | undefined
  abierto: boolean
  enfocado: boolean
  editando: boolean
  permisos: number
  tabStop: boolean
  onFocusItem(clave: string): void
  p: SidebarProps
}

function FilaEspacio({ ws, cuenta, agente, abierto, enfocado, editando, permisos, tabStop, onFocusItem, p }: FilaProps): React.JSX.Element {
  // En reposo no hay glifo: solo se marca lo que pide mirar (trabaja, espera, terminó, permiso).
  const glyph = permisos > 1 ? <span className="sl-perm-n">{permisos}</span> : permisos > 0 ? <PermissionIcon size={14} className="ic ic-waiting" /> : agente && agente.state !== 'idle' ? <StateIcon state={agente.state} size={14} /> : null
  const where = ws.branch ?? shortPath(ws.cwd)
  const actual = enfocado && abierto
  return (
    <li
      className="sl-li"
      data-account-id={ws.accountId}
      onContextMenu={(e) => {
        e.preventDefault()
        p.onMenu(ws, e.clientX, e.clientY)
      }}
    >
      {editando ? (
        <div className="ws-edit">
          <RenameInput className="ws-rename" initial={ws.name} label={`Nuevo nombre del espacio ${ws.name}`} onDone={(next) => p.onRenameDone(ws, next)} />
        </div>
      ) : (
        <button
          type="button"
          className={`sl-row ${abierto ? 'open' : ''} ${actual ? 'focused' : ''}`}
          aria-current={actual ? 'true' : undefined}
          data-ws-btn={ws.id}
          data-nav={claveEspacio(ws.id)}
          tabIndex={tabStop ? 0 : -1}
          onFocus={() => onFocusItem(claveEspacio(ws.id))}
          onClick={() => p.onOpen(ws.id)}
          onDoubleClick={() => p.onStartRename(ws.id)}
          onKeyDown={(e) => {
            if (e.key === 'F2') {
              e.preventDefault()
              p.onStartRename(ws.id)
            } else if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
              e.preventDefault()
              const r = e.currentTarget.getBoundingClientRect()
              p.onMenu(ws, r.left + 24, r.bottom + 2)
            }
          }}
          aria-label={`${ws.icon ? `${ws.icon} ` : ''}${ws.name}, ${cuenta ?? 'cuenta borrada'}${ws.branch ? `, rama ${ws.branch}` : ''}, ${agente ? STATE_LABEL[agente.state] : 'sin abrir'}${abierto ? ', abierto' : ''}${permisos ? `, ${permisos === 1 ? 'permiso pendiente' : `${permisos} permisos pendientes`}` : ''}`}
          title={`${ws.name} · ${where}\nDoble clic o F2 para renombrar · clic derecho para más opciones`}
        >
          <span className={`sl-ico${ws.icon ? ' has-emoji' : ''}`} aria-hidden="true" style={ws.color ? ({ '--ws': colorHex(ws.color) } as CSSProperties) : undefined}>
            {ws.icon ?? null}
          </span>
          <span className="sl-name">{ws.name}</span>
          {ws.branch && (
            <span className="sl-branch" aria-hidden="true">
              <span className="sl-branch-in">
                <BranchIcon size={11} />
                <span className="sl-branch-text">{ws.branch}</span>
              </span>
            </span>
          )}
          {ws.ticket && <Tag title={ws.ticket}>{ws.ticket}</Tag>}
          <span className="sl-glyph" aria-hidden="true">
            {glyph}
          </span>
        </button>
      )}
    </li>
  )
}
