import { test } from 'node:test'
import assert from 'node:assert/strict'
import gruv from '../main/features/tickets/conectores/gruv'
import { categoriaDe, type Categoria, type Estado } from './tickets'

/** estadoKind de renderer/src/features/tickets/parts.tsx en 0.6.4 (antes de las categorías), tal cual. */
function estadoKindViejo(k?: string): 'todo' | 'doing' | 'review' | 'error' {
  if (k === 'en_curso') return 'doing'
  if (k === 'en_revision' || k === 'en_qa' || k === 'pre_rtd') return 'review'
  if (k === 'bloqueado' || k === 'rechazado') return 'error'
  return 'todo'
}

const KIND: Record<Categoria, ReturnType<typeof estadoKindViejo>> = {
  pendiente: 'todo',
  en_curso: 'doing',
  revision: 'review',
  bloqueado: 'error',
  hecho: 'todo'
}

test('con los estados de Gruv, la categoría da el mismo color que estadoKind', () => {
  for (const k of ['en_curso', 'en_revision', 'en_qa', 'pre_rtd', 'bloqueado', 'rechazado', 'abierto', 'x', undefined]) {
    assert.equal(KIND[categoriaDe(k, [], gruv.estados)], estadoKindViejo(k), String(k))
  }
})

test('la primera lista que tiene la clave gana', () => {
  const propios: Estado[] = [{ clave: 'en_qa', nombre: 'QA', categoria: 'bloqueado' }]
  assert.equal(categoriaDe('en_qa', propios, gruv.estados), 'bloqueado')
  assert.equal(categoriaDe('en_qa', gruv.estados, propios), 'revision')
  assert.equal(categoriaDe('cerrado', gruv.estados), 'hecho')
  assert.equal(categoriaDe('x'), 'pendiente')
})
