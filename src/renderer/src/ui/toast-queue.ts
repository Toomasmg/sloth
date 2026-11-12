export type ToastTone = 'info' | 'success' | 'warning' | 'danger'

export interface ToastItem {
  id: number
  tone: ToastTone
  message: string
  actionLabel?: string
  onAction?: () => void
  /** ms hasta que se va solo; 0 lo deja hasta que se cierre. */
  duration: number
}

export type ToastInput = Omit<ToastItem, 'id' | 'duration'> & { duration?: number }

export const MAX_TOASTS = 4
export const DEFAULT_DURATION = 5000
export const ERROR_DURATION = 8000

export function addToast(list: ToastItem[], input: ToastInput, id: number): ToastItem[] {
  const duration = input.duration ?? (input.tone === 'danger' ? ERROR_DURATION : DEFAULT_DURATION)
  const dup = list.find((t) => t.tone === input.tone && t.message === input.message)
  const rest = dup ? list.filter((t) => t !== dup) : list
  return [...rest, { ...input, id, duration }].slice(-MAX_TOASTS)
}

export function dismissToast(list: ToastItem[], id: number): ToastItem[] {
  return list.filter((t) => t.id !== id)
}
