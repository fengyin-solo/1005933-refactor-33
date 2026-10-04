import { SEED_ROWS } from './seed'
import { backfillPeriods, SETTLEMENT_KEY } from './settlement-period'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'pv-plant-ops:entries'
const SCHEMA_VERSION = 2
const SCHEMA_KEY = 'pv-plant-ops:schema-version'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 旧版本缓存归一化：只动结算单——给存量行补齐归属字段，并照统一规则重算一次。
 * 已开票行若没有留档快照，按其当前归属落一份「开票时归属期间」，之后不再重算。
 */
function migrateRows(rows: Record<string, EntryRow[]>): void {
  const legacy = rows[SETTLEMENT_KEY]
  if (!Array.isArray(legacy)) {
    rows[SETTLEMENT_KEY] = clone(SEED_ROWS[SETTLEMENT_KEY])
    return
  }
  const normalized = legacy.map((row) => {
    const next: EntryRow = { ...row }
    if (String(next['已提交核算'] ?? '') === '') {
      next['已提交核算'] = String(next.status) !== '待核算'
    }
    if (String(next['首次核算时间'] ?? '') === '' && next['已提交核算']) {
      next['首次核算时间'] = '迁移前已提交'
    }
    if (String(next.status) === '已开票' && !String(next['开票时归属期间'] ?? '').trim()) {
      // 当时按什么口径归属无从追溯，按当前可见数据快照一份留档。
      next['开票时归属期间'] = String(next['归属期间'] ?? '').trim()
    }
    return next
  })
  rows[SETTLEMENT_KEY] = backfillPeriods(normalized).rows
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    window.localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const version = Number(window.localStorage.getItem(SCHEMA_KEY) ?? '1')
    const merged = { ...fallback, ...parsed }
    if (version < SCHEMA_VERSION) {
      migrateRows(merged)
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
      window.localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION))
    }
    return merged
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    window.localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
