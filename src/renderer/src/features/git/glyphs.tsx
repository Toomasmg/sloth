// Íconos que el set de Sloth no trae (visto, aviso, cargando). Trazo y grilla 24 como SlothIcons.

export function CheckGlyph({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  )
}

export function WarnGlyph({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17.5v.01" />
    </svg>
  )
}

export function ArrowUpGlyph({ size = 13 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
      <path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14" />
    </svg>
  )
}

export function ArrowDownGlyph({ size = 13 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
      <path d="M12 5v11M7.5 11.5L12 16l4.5-4.5M5 19h14" />
    </svg>
  )
}

export function SpinGlyph({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" className="spin" style={{ flex: 'none' }}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}
