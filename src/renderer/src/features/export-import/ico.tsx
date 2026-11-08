/** Ícono de trazo con el path del artboard «Exportar» (stroke currentColor). */
export function Ico({ d, size, sw = 1.8 }: { d: string; size: number; sw?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

export const P = {
  lock: 'M7 10.5V8a5 5 0 0 1 10 0v2.5M6 10.5h12v9.5H6z',
  folder: 'M4 7a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 7v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17zM7.5 10l2.5 2.5-2.5 2.5M12.5 15h4',
  chevDown: 'M6 9l6 6 6-6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  upload: 'M12 15V4M7.5 8.5L12 4l4.5 4.5M5 15v4.5h14V15',
  doc: 'M6.5 3.5h7.5l4 4v13h-11.5zM14 3.5v4h4',
  warn: 'M12 3.5l9 16H3zM12 10v4M12 17h.01'
} as const
