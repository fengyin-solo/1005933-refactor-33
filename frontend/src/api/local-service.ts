import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  attributionOf,
  backfillPeriods,
  buildSettlementFromMeter,
  enrichSettlementRows,
  findMeterSettlement,
  formatPeriod,
  meterEnergy,
  monthKeyOfDate,
  nextSettlementNo,
  resolveAttributionKey,
  METER_KEY,
  SETTLEMENT_KEY,
  summarizeByPeriod,
  toNumber,
  type BackfillResult,
  type MonthlyBucket,
  type SettlementView,
} from '@/data/settlement-period'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

function listRaw(key: string): EntryRow[] {
  return listRows(key)
}

/** 结算单统一从 enrichSettlementRows 出数：列表/导出/汇总的归属只有这一个口径。 */
export function listSettlementRows(filters: Record<string, string> = {}): SettlementView[] {
  return filterRows(enrichSettlementRows(listRaw(SETTLEMENT_KEY)), filters) as SettlementView[]
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  if (key === SETTLEMENT_KEY) {
    const matched = listSettlementRows(filters)
    return { items: matched, total: matched.length, page: 1, size: matched.length }
  }
  const matched = filterRows(listRaw(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function stampNow(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

function baseStatusUpdate(
  meta: ModuleMeta,
  row: EntryRow,
  action: string,
  target: string,
): EntryRow {
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  return {
    ...row,
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
}

/**
 * 结算单动作：
 * - 发起核算同一张单只认第一次（已提交核算落戳后重复提交直接拒绝）；
 * - 登记开票时把当前归属快照成「开票时归属期间」，已开票永远按当时归属留档。
 */
function runSettlementAction(row: EntryRow, action: string, target: string): ActionResult {
  if (action === '发起核算') {
    if (row['已提交核算'] === true || row['已提交核算'] === 'true') {
      return {
        ok: false,
        message: `结算单 ${row['结算单号']} 已于 ${row['首次核算时间'] || '此前'} 提交过核算，重复提交只认第一次`,
      }
    }
    const updated = {
      ...baseStatusUpdate(moduleMeta(SETTLEMENT_KEY), row, action, target),
      已提交核算: true,
      首次核算时间: stampNow(),
      结算状态: target,
    }
    return applyRowUpdate(SETTLEMENT_KEY, row.id as number, updated, {
      message: `结算单 ${row['结算单号']} 已发起核算（首次提交时间 ${updated['首次核算时间']}），归属 ${formatPeriod(
        attributionOf(updated).key,
      )}`,
    })
  }

  if (action === '确认结算') {
    if (row['已提交核算'] !== true && row['已提交核算'] !== 'true') {
      return { ok: false, message: `结算单 ${row['结算单号']} 尚未发起核算，不能直接确认结算` }
    }
    const updated = {
      ...baseStatusUpdate(moduleMeta(SETTLEMENT_KEY), row, action, target),
      结算状态: target,
    }
    return applyRowUpdate(SETTLEMENT_KEY, row.id as number, updated, {
      message: `结算单 ${row['结算单号']} 已确认，归属 ${formatPeriod(attributionOf(updated).key)}`,
    })
  }

  if (action === '登记开票') {
    const snapshot = resolveAttributionKey(row)
    if (!snapshot) {
      return { ok: false, message: `结算单 ${row['结算单号']} 的结算周期无法确定归属月份，不能开票` }
    }
    const updated = {
      ...baseStatusUpdate(moduleMeta(SETTLEMENT_KEY), row, action, target),
      开票状态: '已开票',
      结算状态: '已开票',
      开票时归属期间: snapshot,
    }
    return applyRowUpdate(SETTLEMENT_KEY, row.id as number, updated, {
      message: `结算单 ${row['结算单号']} 已开票，归属按开票时留档：${formatPeriod(snapshot)}`,
    })
  }

  return { ok: false, message: `结算单没有登记「${action}」这个动作` }
}

function applyRowUpdate(
  key: string,
  id: number,
  updated: EntryRow,
  options: { message: string },
): ActionResult {
  const rows = listRaw(key)
  const index = rows.findIndex((item) => Number(item.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的记录` }
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: options.message }
}

/**
 * 电量计量确认：确认结果同步到待核算清单（按抄表日期月份生成结算单）。
 * 同一计量点只同步第一次，重复确认不再造单。
 */
function runMeterConfirm(row: EntryRow): ActionResult {
  if (!String(row['抄表日期'] ?? '').trim()) {
    return { ok: false, message: `计量点 ${row['计量点编号']} 还没有抄表日期，无法确认计量` }
  }
  if (String(row['本期读数'] ?? '').trim() === '') {
    return { ok: false, message: `计量点 ${row['计量点编号']} 还没有本期读数，无法确认计量` }
  }

  const meters = listRaw(METER_KEY)
  const settlements = listRaw(SETTLEMENT_KEY)
  const linked = findMeterSettlement(settlements, String(row['计量点编号']), row['关联结算单号'])
  if (linked) {
    return {
      ok: false,
      message: `计量点 ${row['计量点编号']} 已同步过结算单 ${linked['结算单号']}，确认计量只同步第一次`,
    }
  }

  const nextId = settlements.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const settlementNo = String(row['关联结算单号'] ?? '').trim() || nextSettlementNo(settlements)
  const confirmedMeter = {
    ...baseStatusUpdate(moduleMeta(METER_KEY), row, '确认计量', '已确认'),
    关联结算单号: settlementNo,
  }
  const newSettlement = buildSettlementFromMeter(confirmedMeter, nextId, settlementNo)
  if (!newSettlement) {
    return { ok: false, message: `计量点 ${row['计量点编号']} 的抄表日期无法识别，未同步待核算清单` }
  }

  const meterIndex = meters.findIndex((item) => Number(item.id) === Number(row.id))
  const nextMeters = [...meters]
  nextMeters[meterIndex] = confirmedMeter
  saveRows(METER_KEY, nextMeters)
  saveRows(SETTLEMENT_KEY, [...settlements, newSettlement])

  return {
    ok: true,
    message: `计量点 ${row['计量点编号']} 已确认，上网电量 ${meterEnergy(
      confirmedMeter,
    )} kWh，已同步待核算结算单 ${settlementNo}（归属 ${newSettlement['归属期间']}）`,
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRaw(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const current = String(row.status)

  if (key === SETTLEMENT_KEY) {
    if (current === target && action !== '发起核算') {
      return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
    }
    return runSettlementAction(row, action, target)
  }

  if (key === METER_KEY && action === '确认计量') {
    if (current === target) {
      return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
    }
    return runMeterConfirm(row)
  }

  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const updated = baseStatusUpdate(meta, row, action, target)
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.map(csvCell).join(',')]
  // 结算单导出同样走统一归属：归属期间列由 enrich 出数，与列表、月度汇总一致。
  const sourceRows = key === SETTLEMENT_KEY ? enrichSettlementRows(listRaw(SETTLEMENT_KEY)) : listRows(key)
  for (const row of sourceRows) {
    lines.push(
      [row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].map(csvCell).join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export type MonthlySettlementResult = {
  buckets: MonthlyBucket[]
  total: MonthlyBucket
  currentMonthKey: string
}

/** 月度汇总：分组键、电量、金额全部来自统一归属取数。 */
export function loadMonthlySettlement(): MonthlySettlementResult {
  const views = enrichSettlementRows(listRaw(SETTLEMENT_KEY))
  const buckets = summarizeByPeriod(views)
  const total: MonthlyBucket = {
    key: '合计',
    label: '全部月份合计',
    count: views.length,
    energy: buckets.reduce((sum, item) => sum + item.energy, 0),
    subsidy: buckets.reduce((sum, item) => sum + item.subsidy, 0),
    amount: buckets.reduce((sum, item) => sum + item.amount, 0),
    byStatus: buckets.reduce<Record<string, number>>((acc, item) => {
      for (const [status, count] of Object.entries(item.byStatus)) {
        acc[status] = (acc[status] ?? 0) + count
      }
      return acc
    }, {}),
  }
  const round = (value: number) => Math.round(value * 100) / 100
  total.energy = round(total.energy)
  total.subsidy = round(total.subsidy)
  total.amount = round(total.amount)
  return { buckets, total, currentMonthKey: monthKeyOfDate(new Date()) }
}

/** 存量单据按结算周期回填：照新规则重算一次并落库；已开票单留档不动。 */
export function backfillSettlement(): BackfillResult {
  const { rows, result } = backfillPeriods(listRaw(SETTLEMENT_KEY))
  saveRows(SETTLEMENT_KEY, rows)
  return result
}

/** 待核算清单：统一从结算数据里取「待核算」状态。 */
export function listPendingSettlement(): SettlementView[] {
  return enrichSettlementRows(listRaw(SETTLEMENT_KEY)).filter(
    (row) => String(row.status) === '待核算',
  )
}

export function settlementMonthStats(): { pending: number; monthEnergy: number; monthAmount: number } {
  const views = enrichSettlementRows(listRaw(SETTLEMENT_KEY))
  const currentMonth = monthKeyOfDate(new Date())
  const monthRows = views.filter((row) => row.归属期间 === currentMonth)
  return {
    pending: views.filter((row) => String(row.status) === '待核算').length,
    monthEnergy: monthRows.reduce((sum, row) => sum + toNumber(row['上网电量']), 0),
    monthAmount: monthRows.reduce((sum, row) => sum + toNumber(row['结算金额']), 0),
  }
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
