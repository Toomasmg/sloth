import { isAbsolute, relative, resolve } from 'node:path'

export interface Perfil {
  id: string
  nombre: string
  creado: number
  ghLogin?: string
}

export interface IndicePerfiles {
  version: 1
  activo: string
  perfiles: Perfil[]
}

export const PERFIL_INICIAL_ID = 'principal'
export const NOMBRE_INICIAL = 'Mi perfil'
/** Entradas de la raíz de userData que pasan a ser del perfil. Todo lo demás es común a la app. */
export const ENTRADAS_DE_PERFIL: readonly string[] = ['sloth-state.json', 'features']

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
// El id es nombre de carpeta: Windows no deja crear estas aunque el resto del formato sea válido.
const RESERVADO_WINDOWS = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
// Cambian el sentido del texto o son invisibles: un nombre podría hacerse pasar por otro.
const ENGANOSO = /[​-‏‪-‮⁦-⁩﻿]/
const GH_LOGIN = /^[A-Za-z0-9-]{1,39}$/
const MAX_NOMBRE = 40

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const idPerfilValido = (id: unknown): id is string => typeof id === 'string' && ID.test(id) && !RESERVADO_WINDOWS.test(id)

export function nombrePerfilValido(n: unknown): string | null {
  if (typeof n !== 'string') return null
  const limpio = n.normalize('NFC').trim()
  if (!limpio || [...limpio].length > MAX_NOMBRE || CONTROL.test(limpio) || ENGANOSO.test(limpio)) return null
  return limpio
}

export function nombreLibre(nombre: string, perfiles: readonly Perfil[], ignorarId?: string): boolean {
  const k = nombre.normalize('NFC').trim().toLocaleLowerCase()
  return !perfiles.some((p) => p.id !== ignorarId && p.nombre.toLocaleLowerCase() === k)
}

export function nuevoIdPerfil(existentes: readonly string[], azar: () => string): string {
  for (;;) {
    const id = `p-${azar()}`
    if (idPerfilValido(id) && !existentes.includes(id)) return id
  }
}

export function validarMeta(raw: unknown): Perfil | null {
  if (!esObjeto(raw) || !idPerfilValido(raw.id)) return null
  const nombre = nombrePerfilValido(raw.nombre)
  if (!nombre || typeof raw.creado !== 'number' || !Number.isFinite(raw.creado) || raw.creado < 0) return null
  const p: Perfil = { id: raw.id, nombre, creado: raw.creado }
  if (raw.ghLogin !== undefined) {
    if (typeof raw.ghLogin !== 'string' || !GH_LOGIN.test(raw.ghLogin)) return null
    p.ghLogin = raw.ghLogin
  }
  return p
}

export function validarIndice(raw: unknown): IndicePerfiles | null {
  if (!esObjeto(raw) || raw.version !== 1 || !Array.isArray(raw.perfiles) || typeof raw.activo !== 'string') return null
  const perfiles: Perfil[] = []
  for (const x of raw.perfiles) {
    const p = validarMeta(x)
    if (!p || perfiles.some((o) => o.id === p.id)) return null
    perfiles.push(p)
  }
  if (!perfiles.some((p) => p.id === raw.activo)) return null
  return { version: 1, activo: raw.activo, perfiles }
}

export function reconstruirIndice(metas: readonly Perfil[], activoPrevio?: string): IndicePerfiles | null {
  const unicos: Perfil[] = []
  for (const m of [...metas].sort((a, b) => a.creado - b.creado || a.id.localeCompare(b.id))) {
    if (!unicos.some((u) => u.id === m.id)) unicos.push(m)
  }
  const primero = unicos[0]
  if (!primero) return null
  const activo = activoPrevio && unicos.some((p) => p.id === activoPrevio) ? activoPrevio : primero.id
  return { version: 1, activo, perfiles: unicos }
}

export function aCopiar(entradasRaiz: readonly string[]): string[] {
  return entradasRaiz.filter((e) => ENTRADAS_DE_PERFIL.includes(e))
}

export function dentroDe(base: string, destino: string): boolean {
  const r = relative(resolve(base), resolve(destino))
  return r !== '' && !isAbsolute(r) && r.split(/[\\/]/)[0] !== '..'
}
