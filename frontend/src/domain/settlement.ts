import type { EntryRow } from '@/data/types'

import {
  currentMonthKey,
  formatMonthKey,
  isMonthKey,
  monthKeyFromDateText,
  periodMonthKey,
  type MonthKey,
} from './period'

/**
 * 结算域统一取数：列表、导出、月度汇总的归属月份都从这里出。
 * 详见 period.ts 顶部的口径说明。
 */

export const PERIOD_FIELD = '结算周期'
export const ENERGY_FIELD = '上网电量'
export const AMOUNT_FIELD = '结算金额'
export const PRICE_FIELD = '结算电价'
export const METER_DATE_FIELD = '抄表日期'
export const METER_SOURCE_FIELD = '来源计量点'
export const INVOICE_STATE_FIELD = '开票状态'
/** 归属月份（YYYY-MM），由结算周期解析后回填，属于派生留档字段。 */
export const ATTRIBUTION_FIELD = '归属月份'
/** 已开票单据按当时归属留档：一旦锁定，后续不再随周期文字重算。 */
export const ATTRIBUTION_LOCKED_FIELD = '归属锁定'

export const STATUS_PENDING = '待核算'
export const STATUS_AUDITING = '核算中'
export const STATUS_CONFIRMED = '已确认'
export const STATUS_INVOICED = '已开票'

export const ACTION_START_AUDIT = '发起核算'
export const ACTION_CONFIRM = '确认结算'
export const ACTION_INVOICE = '登记开票'

/** 已开票：结算状态已开票，或开票状态栏明确登记为已开票（兼容存量单）。 */
export function isInvoiced(row: EntryRow): boolean {
  return String(row.status) === STATUS_INVOICED || String(row[INVOICE_STATE_FIELD] ?? '') === STATUS_INVOICED
}

/**
 * 归属月份唯一解析入口。
 * @param row 结算单
 * @returns 归属月份 YYYY-MM；已开票单优先读冻结快照，其余一律按结算周期文字现算。
 */
export function resolveAttributionMonth(row: EntryRow): MonthKey | null {
  if (isInvoiced(row)) {
    const locked = row[ATTRIBUTION_FIELD]
    return isMonthKey(locked) ? locked : null
  }
  return periodMonthKey(String(row[PERIOD_FIELD] ?? ''))
}

/** 列表/导出统一走这里：给每张结算单补上归属月份与中文展示栏，不改原行。 */
export function withAttribution(rows: EntryRow[]): EntryRow[] {
  return rows.map((row) => {
    const month = resolveAttributionMonth(row)
    return {
      ...row,
      [ATTRIBUTION_FIELD]: month ?? '未归属',
      归属周期: month ? formatMonthKey(month) : '未归属',
    }
  })
}

export type MonthlyTotal = {
  month: MonthKey
  label: string
  count: number
  energy: number
  amount: number
}

/** 月度汇总：只按归属月份分组合计，不再拿上网电量非零的月份倒推。 */
export function monthlySummary(rows: EntryRow[]): MonthlyTotal[] {
  const buckets = new Map<MonthKey, MonthlyTotal>()
  for (const row of rows) {
    const month = resolveAttributionMonth(row)
    if (!month) continue
    const bucket =
      buckets.get(month) ??
      ({ month, label: formatMonthKey(month), count: 0, energy: 0, amount: 0 } satisfies MonthlyTotal)
    bucket.count += 1
    bucket.energy += toNumber(row[ENERGY_FIELD])
    bucket.amount += toNumber(row[AMOUNT_FIELD])
    buckets.set(month, bucket)
  }
  return [...buckets.values()].sort((a, b) => a.month.localeCompare(b.month))
}

/** 待核算清单：确认计量的结果同步到这里，发起核算后即移出。 */
export function pendingChecklist(rows: EntryRow[]): EntryRow[] {
  return withAttribution(rows.filter((row) => String(row.status) === STATUS_PENDING))
}

export type MeterAlignment = 'matched' | 'cross-month' | 'unknown'

/**
 * 抄表日期对齐校验：抄表日期所在月必须落在归属月份上。
 * 只做提示，不改变归属（归属仍以结算周期为准）。
 */
export function checkMeterAlignment(row: EntryRow): MeterAlignment {
  const month = resolveAttributionMonth(row)
  const meterMonth = monthKeyFromDateText(String(row[METER_DATE_FIELD] ?? ''))
  if (!month || !meterMonth) return 'unknown'
  return month === meterMonth ? 'matched' : 'cross-month'
}

/** 关口表本期电量：（本期读数 − 上期读数）× 倍率。 */
export function meterEnergy(row: EntryRow): number {
  const current = toNumber(row['本期读数'])
  const previous = toNumber(row['上期读数'])
  const rate = toNumber(row['倍率'])
  if (Number.isNaN(current) || Number.isNaN(previous) || Number.isNaN(rate)) return Number.NaN
  return round2((current - previous) * rate)
}

/** 确认计量前置校验：读数、倍率、抄表日期必须齐备且能算出电量。 */
export function meterConfirmIssue(row: EntryRow): string | null {
  const date = String(row[METER_DATE_FIELD] ?? '').trim()
  if (!monthKeyFromDateText(date)) {
    return '抄表日期缺失或无法识别，确认计量前请先补齐'
  }
  for (const field of ['本期读数', '上期读数', '倍率']) {
    const raw = row[field]
    if (raw === undefined || raw === '' || Number.isNaN(toNumber(raw))) {
      return `${field}缺失或不是数字，确认计量前请先补齐`
    }
  }
  if (Number.isNaN(meterEnergy(row)) || meterEnergy(row) < 0) {
    return '本期读数小于上期读数，电量为负，确认计量前请先核对'
  }
  return null
}

/**
 * 存量数据一次性迁移（读入本地数据时执行，幂等）：
 * - 已开票单：按当时数据解一次归属并冻结留档，之后永不重算；
 * - 未开票存量单：按新规则（结算周期）重算一次归属并回填；
 * - 已确认的计量结果：同步到待核算清单（已存在同源同月单则不重复生成）。
 */
export function reconcileDomain(all: Record<string, EntryRow[]>): {
  data: Record<string, EntryRow[]>
  changed: boolean
} {
  const next: Record<string, EntryRow[]> = { ...all }
  let changed = false

  const settlements = (all['settlement'] ?? []).map(clone)
  for (const row of settlements) {
    if (row[ATTRIBUTION_FIELD] !== undefined) continue // 已回填过，不做第二次
    const parsed = isInvoiced(row)
      ? periodMonthKey(String(row[PERIOD_FIELD] ?? '')) ?? monthKeyFromDateText(String(row[METER_DATE_FIELD] ?? ''))
      : periodMonthKey(String(row[PERIOD_FIELD] ?? ''))
    // 无法识别时留空，resolveAttributionMonth 会按「未归属」处理（isMonthKey 校验）。
    row[ATTRIBUTION_FIELD] = parsed ?? ''
    row[ATTRIBUTION_LOCKED_FIELD] = isInvoiced(row)
    changed = true
  }

  const synced = syncConfirmedMeters(settlements, (all['meter'] ?? []).map(clone))
  if (synced.changed || changed) next['settlement'] = synced.settlements
  return { data: next, changed: changed || synced.changed }
}

/**
 * 把一张刚确认的关口表同步进待核算清单。
 * 同源（来源计量点）同归属月且尚未开票的待核算单直接更新电量；
 * 同源同月已进入核算/确认/开票的单子说明该电量已被承接，不再重复生成；
 * 否则生成一张新的待核算单。
 */
export function syncConfirmedMeter(
  settlements: EntryRow[],
  meter: EntryRow,
): { settlements: EntryRow[]; created: EntryRow | null; matched: EntryRow | null } {
  const month = monthKeyFromDateText(String(meter[METER_DATE_FIELD] ?? ''))
  const energy = meterEnergy(meter)
  const source = String(meter['计量点编号'] ?? '')
  if (!month || Number.isNaN(energy) || !source) {
    return { settlements, created: null, matched: null }
  }

  const sameSourceMonth = (row: EntryRow): boolean =>
    String(row[METER_SOURCE_FIELD] ?? '') === source && resolveAttributionMonth(row) === month

  const index = settlements.findIndex(
    (row) =>
      !isInvoiced(row) &&
      String(row.status) !== STATUS_AUDITING &&
      String(row.status) !== STATUS_CONFIRMED &&
      sameSourceMonth(row),
  )
  if (index >= 0) {
    const matched = { ...settlements[index], [ENERGY_FIELD]: round2(energy) }
    const next = [...settlements]
    next[index] = matched
    return { settlements: next, created: null, matched }
  }

  // 同源同月已经有单子在核算中/已确认/已开票：计量结果承接过了，不重复进清单。
  if (settlements.some(sameSourceMonth)) {
    return { settlements, created: null, matched: null }
  }

  const created: EntryRow = {
    id: nextSettlementId(settlements),
    status: STATUS_PENDING,
    pending: true,
    abnormal: false,
    结算单号: nextSettlementNo(settlements),
    [PERIOD_FIELD]: formatMonthKey(month),
    [ENERGY_FIELD]: round2(energy),
    [PRICE_FIELD]: '',
    补贴金额: '',
    [AMOUNT_FIELD]: '',
    [INVOICE_STATE_FIELD]: '未开票',
    [METER_DATE_FIELD]: String(meter[METER_DATE_FIELD] ?? ''),
    [METER_SOURCE_FIELD]: source,
    [ATTRIBUTION_FIELD]: month,
    [ATTRIBUTION_LOCKED_FIELD]: false,
  }
  return { settlements: [...settlements, created], created, matched: null }
}

function syncConfirmedMeters(
  settlements: EntryRow[],
  meters: EntryRow[],
): { settlements: EntryRow[]; changed: boolean } {
  let current = settlements
  let changed = false
  for (const meter of meters) {
    if (String(meter.status) !== '已确认') continue
    const result = syncConfirmedMeter(current, meter)
    if (result.created) {
      current = result.settlements
      changed = true
    } else if (result.matched) {
      const before = current.find((row) => Number(row.id) === Number(result.matched!.id))
      if (before && Number(before[ENERGY_FIELD]) !== Number(result.matched[ENERGY_FIELD])) {
        current = result.settlements
        changed = true
      }
    }
  }
  return { settlements: current, changed }
}

export function currentMonthStats(rows: EntryRow[]): MonthlyTotal & { unattributed: number } {
  const month = currentMonthKey()
  const inMonth = rows.filter((row) => resolveAttributionMonth(row) === month)
  return {
    month,
    label: formatMonthKey(month),
    count: inMonth.length,
    energy: round2(inMonth.reduce((sum, row) => sum + toNumber(row[ENERGY_FIELD]), 0)),
    amount: round2(inMonth.reduce((sum, row) => sum + toNumber(row[AMOUNT_FIELD]), 0)),
    unattributed: rows.filter((row) => resolveAttributionMonth(row) === null).length,
  }
}

export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (value === undefined || value === null) return Number.NaN
  const cleaned = String(value).replace(/[,，\s]/g, '')
  if (cleaned === '') return Number.NaN
  const num = Number(cleaned)
  return Number.isFinite(num) ? num : Number.NaN
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function formatNumber(value: unknown): string {
  const num = toNumber(value)
  if (Number.isNaN(num)) return '—'
  return String(round2(num))
}

function nextSettlementId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextSettlementNo(rows: EntryRow[]): string {
  const serial = nextSettlementId(rows)
  return `SETT-${String(serial).padStart(4, '0')}`
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
