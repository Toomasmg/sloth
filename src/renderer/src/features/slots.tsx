import { Component, type ReactNode } from 'react'
import { FEATURE_UIS } from './registry'

/** Si una función rompe al dibujarse, se oculta sola y el resto de la app sigue andando. */
class Guard extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(error: unknown): void {
    console.error(`[función ${this.props.name}]`, error)
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

export function TitlebarSlot(): React.JSX.Element {
  return (
    <>
      {FEATURE_UIS.filter((f) => f.Titlebar).map((f) => {
        const C = f.Titlebar!
        return (
          <Guard key={f.name} name={f.name}>
            <C />
          </Guard>
        )
      })}
    </>
  )
}

export function SidebarSlot(): React.JSX.Element {
  return (
    <>
      {FEATURE_UIS.filter((f) => f.Sidebar).map((f) => {
        const C = f.Sidebar!
        return (
          <Guard key={f.name} name={f.name}>
            <C />
          </Guard>
        )
      })}
    </>
  )
}

export function PaneHeaderSlot({ paneId }: { paneId: string }): React.JSX.Element {
  return (
    <>
      {FEATURE_UIS.filter((f) => f.PaneHeader).map((f) => {
        const C = f.PaneHeader!
        return (
          <Guard key={f.name} name={f.name}>
            <C paneId={paneId} />
          </Guard>
        )
      })}
    </>
  )
}

export function PaneBannerSlot({ paneId }: { paneId: string }): React.JSX.Element {
  return (
    <>
      {FEATURE_UIS.filter((f) => f.PaneBanner).map((f) => {
        const C = f.PaneBanner!
        return (
          <Guard key={f.name} name={f.name}>
            <C paneId={paneId} />
          </Guard>
        )
      })}
    </>
  )
}

export function GlobalSlot(): React.JSX.Element {
  return (
    <>
      {FEATURE_UIS.filter((f) => f.Global).map((f) => {
        const C = f.Global!
        return (
          <Guard key={f.name} name={f.name}>
            <C />
          </Guard>
        )
      })}
    </>
  )
}
