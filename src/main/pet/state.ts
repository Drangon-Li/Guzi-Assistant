// 桌宠偏好持久化：JSON 存 userData/pet/prefs.json（与 AppSettings 解耦，桌宠是新增子系统）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { petUserDataDir } from './paths'
import type { ReactionAnimationOverrides } from './reaction-mapping'

export type PetScaleValue = number // 0.6 | 0.8 | 1 | 1.25 | 1.6

export interface PetPrefs {
  enabled: boolean
  scale: PetScaleValue
  paused: boolean
  reactionOverrides: ReactionAnimationOverrides
  /** 最近一次位置（扁平），以及按显示器键的位置（多显示器恢复）。 */
  position: { x: number; y: number } | null
  perMonitor: Record<string, { x: number; y: number }>
  crossDisplay: boolean
  gravity: boolean
}

const DEFAULTS: PetPrefs = {
  enabled: true,
  scale: 0.65,
  paused: false,
  reactionOverrides: {},
  position: null,
  perMonitor: {},
  crossDisplay: false,
  gravity: false
}

let cache: PetPrefs | null = null

function prefsFile(): string {
  return join(petUserDataDir(), 'prefs.json')
}

export function getPetPrefs(): PetPrefs {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(prefsFile(), 'utf8')) as Partial<PetPrefs>
    cache = { ...DEFAULTS, ...raw, reactionOverrides: { ...raw.reactionOverrides }, perMonitor: { ...raw.perMonitor } }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export function savePetPrefs(patch: Partial<PetPrefs>): PetPrefs {
  const next: PetPrefs = { ...getPetPrefs(), ...patch }
  cache = next
  try {
    const dir = petUserDataDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(prefsFile(), JSON.stringify(next))
  } catch {
    // 持久化失败不致命：内存缓存仍生效，下次再写。
  }
  return next
}
