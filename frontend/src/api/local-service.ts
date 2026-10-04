import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  ACTION_CONFIRM,
  ACTION_INVOICE,
  ACTION_START_AUDIT,
  ATTRIBUTION_FIELD,
  ATTRIBUTION_LOCKED_FIELD,
  INVOICE_STATE_FIELD,
  METER_DATE_FIELD,
  STATUS_AUDITING,
  STATUS_CONFIRMED,
  STATUS_INVOICED,
  STATUS_PENDING,
  withAttribution,
  meterConfirmIssue,
  meterEnergy,
  resolveAttributionMonth,
  syncConfirmedMeter,
} from '@/domain/settlement'
import { monthKeyFromDateText } from '@/domain/period'
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

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  // 发电结算列表统一挂上归属月份（取数口径在 domain/settlement，导出与月度汇总共用）。
  const items = key === 'settlement' ? withAttribution(matched) : matched
  return { items, total: items.length, page: 1, size: items.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === 'settlement') {
    return runSettlementAction(id, action)
  }
  if (key === 'meter' && action === '确认计量') {
    return confirmMeter(id)
  }
  return runGenericAction(key, id, action)
}

function runGenericAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/**
 * 发电结算动作：
 * - 同一张结算单重复提交核算只认第一次：离开「待核算」后再点发起核算直接拒绝；
 * - 登记开票时把当前归属月份冻结留档，之后不再随周期文字重算。
 */
function runSettlementAction(id: number, action: string): ActionResult {
  const rows = listRows('settlement')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的电量结算单` }
  }
  const row = rows[index]
  const current = String(row.status)

  if (action === ACTION_START_AUDIT) {
    if (current !== STATUS_PENDING) {
      return {
        ok: false,
        message: `结算单 ${row['结算单号']} 的核算已提交过（当前「${current}」），重复提交不再受理，以第一次为准`,
      }
    }
    saveRows('settlement', patchRow(rows, index, { status: STATUS_AUDITING, pending: true }))
    return { ok: true, message: `结算单 ${row['结算单号']} 已受理核算，这是该单第一次提交` }
  }

  if (action === ACTION_CONFIRM) {
    if (current !== STATUS_AUDITING) {
      return {
        ok: false,
        message:
          current === STATUS_PENDING
            ? `结算单 ${row['结算单号']} 还没发起核算，请先提交核算`
            : `结算单 ${row['结算单号']} 当前「${current}」，不能再确认结算`,
      }
    }
    saveRows('settlement', patchRow(rows, index, { status: STATUS_CONFIRMED, pending: false }))
    return { ok: true, message: `结算单 ${row['结算单号']} 已确认结算` }
  }

  if (action === ACTION_INVOICE) {
    if (current !== STATUS_CONFIRMED) {
      return {
        ok: false,
        message: `只有「${STATUS_CONFIRMED}」的结算单才能登记开票，当前为「${current}」`,
      }
    }
    // 开票即归档：冻结当时的归属月份，永久按当时归属留档。
    const month = resolveAttributionMonth(row)
    if (!month) {
      return {
        ok: false,
        message: `结算单 ${row['结算单号']} 的结算周期无法识别归属月份，请先规范周期文字再开票`,
      }
    }
    saveRows(
      'settlement',
      patchRow(rows, index, {
        status: STATUS_INVOICED,
        pending: false,
        [INVOICE_STATE_FIELD]: STATUS_INVOICED,
        [ATTRIBUTION_FIELD]: month,
        [ATTRIBUTION_LOCKED_FIELD]: true,
      }),
    )
    return { ok: true, message: `结算单 ${row['结算单号']} 已登记开票，归属月份 ${month} 已冻结留档` }
  }

  return { ok: false, message: `电量结算单没有登记「${action}」这个动作` }
}

/** 确认计量：先校验读数齐备，再把计量结果同步到待核算清单。 */
function confirmMeter(id: number): ActionResult {
  const rows = listRows('meter')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的关口计量表` }
  }
  const meter = rows[index]
  if (String(meter.status) === '已确认') {
    return { ok: false, message: '该计量点已经确认过计量，结果已在待核算清单中' }
  }
  const issue = meterConfirmIssue(meter)
  if (issue) {
    return { ok: false, message: issue }
  }
  const confirmed: EntryRow = { ...meter, status: '已确认', pending: false }
  saveRows('meter', patchRow(rows, index, { status: '已确认', pending: false }))

  const synced = syncConfirmedMeter(listRows('settlement'), confirmed)
  saveRows('settlement', synced.settlements)
  const month = monthKeyFromDateText(String(confirmed[METER_DATE_FIELD] ?? ''))
  if (synced.created) {
    return {
      ok: true,
      message: `计量已确认（电量 ${meterEnergy(confirmed)} kWh），已生成待核算结算单 ${synced.created['结算单号']}，归属 ${month}`,
    }
  }
  if (synced.matched) {
    return {
      ok: true,
      message: `计量已确认（电量 ${meterEnergy(confirmed)} kWh），已更新待核算单 ${synced.matched['结算单号']} 的上网电量`,
    }
  }
  return { ok: true, message: '计量已确认' }
}

function patchRow(rows: EntryRow[], index: number, patch: Record<string, string | number | boolean>): EntryRow[] {
  const next = [...rows]
  next[index] = { ...rows[index], ...patch }
  return next
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  if (key === 'settlement') {
    return exportSettlements(meta.name)
  }
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].map(csvCell).join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

/**
 * 导出发电结算清单：归属月份与列表、月度汇总同源（domain/settlement），
 * 不再用单据上的周期文字另分一次。
 */
function exportSettlements(name: string): { filename: string; content: string } {
  const rows = withAttribution(listRows('settlement'))
  const header = [
    '编号',
    '结算单号',
    '结算周期',
    '归属月份',
    '上网电量',
    '结算电价',
    '补贴金额',
    '结算金额',
    '开票状态',
    '抄表日期',
    '当前状态',
  ]
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row['结算单号'],
        row['结算周期'],
        row['归属周期'],
        row['上网电量'],
        row['结算电价'],
        row['补贴金额'],
        row['结算金额'],
        row['开票状态'],
        row['抄表日期'] ?? '',
        row.status,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return { filename: `${name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
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
