import type { EntryRow } from './types'

/**
 * 结算周期归属：全系统唯一取数处。
 *
 * 归属规则（列表、导出、月度汇总共用，不得各写一遍）：
 * 1. 一律以结算单「结算周期」栏文字为准，解析成 YYYY-MM：
 *    - 写成区间（如 2026-06-30至2026-07-31）取期末日所在月；
 *    - 只写一个年月/日期，取该月；
 * 2. 周期文字无法解析时，回退「抄表日期」所在月；
 * 3. 已开票存量单：开票当时的归属快照存「开票时归属期间」，之后永不重算，按当时归属留档；
 * 4. 其余存量单通过「按结算周期回填」照本规则重算一次并落库。
 *
 * 计量联动：电量计量「确认计量」生成的结算单，结算周期文字直接写成抄表日期所在月，
 * 因此抄表日期天然与归属期间对得上；手工登记的单子若两者跨月，periodMismatch 会标出来。
 */

export const SETTLEMENT_KEY = 'settlement'
export const METER_KEY = 'meter'

export type AttributionSource =
  | '开票时留档'
  | '结算周期'
  | '抄表日期'
  | '存量留档'
  | '未归属'

/** 列表/导出/汇总统一消费的结算单行：在原始行上补齐归属派生字段。 */
export type SettlementView = EntryRow & {
  归属期间: string
  归属期间显示: string
  归属来源: AttributionSource
}

export type MonthlyBucket = {
  key: string
  label: string
  count: number
  energy: number
  subsidy: number
  amount: number
  byStatus: Record<string, number>
}

export type BackfillResult = {
  scanned: number
  updated: number
  archived: number
  unresolved: number
}

type DateToken = {
  index: number
  end: number
  year: number | null
  month: number
  day: number | null
}

const FULL_DATE_RE = /(\d{4})\s*[-年/.]\s*(\d{1,2})(?:\s*[-月/.]\s*(\d{1,2}))?/g
const BARE_MONTH_RE = /(\d{1,2})\s*月/g

function isValidDateToken(token: Omit<DateToken, 'index' | 'end'>): boolean {
  if (token.month < 1 || token.month > 12) return false
  if (token.day !== null && (token.day < 1 || token.day > 31)) return false
  return true
}

/** 取出文字里全部日期/年月标记，按出现顺序排列；裸「7月」继承前文年份。 */
function collectTokens(text: string): DateToken[] {
  const full: DateToken[] = []
  FULL_DATE_RE.lastIndex = 0
  for (const match of text.matchAll(FULL_DATE_RE)) {
    full.push({
      index: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      year: Number(match[1]),
      month: Number(match[2]),
      day: match[3] !== undefined ? Number(match[3]) : null,
    })
  }

  const tokens = [...full]
  BARE_MONTH_RE.lastIndex = 0
  for (const match of text.matchAll(BARE_MONTH_RE)) {
    const index = match.index ?? 0
    // 落在完整日期区间内的「6月」不再重复计一次。
    if (full.some((item) => index >= item.index && index < item.end)) continue
    tokens.push({
      index,
      end: index + match[0].length,
      year: null,
      month: Number(match[1]),
      day: null,
    })
  }

  return tokens.sort((a, b) => a.index - b.index)
}

function tokenToKey(token: DateToken, tokens: DateToken[]): string | null {
  let year = token.year
  if (year === null) {
    // 区间后半段只写「7月」时，沿用前一个日期的年份。
    for (let i = tokens.indexOf(token) - 1; i >= 0; i -= 1) {
      if (tokens[i].year !== null) {
        year = tokens[i].year
        break
      }
    }
  }
  if (year === null || !isValidDateToken(token)) return null
  return `${year}-${String(token.month).padStart(2, '0')}`
}

/** 解析「结算周期」文字：区间取期末月，单日期取当月。无法识别返回 null。 */
export function parsePeriodText(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (!text) return null
  const tokens = collectTokens(text)
  if (tokens.length === 0) return null
  // 区间归属期末：从最后一个日期标记倒推。
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const key = tokenToKey(tokens[i], tokens)
    if (key) return key
  }
  return null
}

/** 解析单个具体日期（抄表日期用），取第一个可识别日期。 */
export function parseDate(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (!text) return null
  FULL_DATE_RE.lastIndex = 0
  for (const match of text.matchAll(FULL_DATE_RE)) {
    const token: DateToken = {
      index: match.index ?? 0,
      end: 0,
      year: Number(match[1]),
      month: Number(match[2]),
      day: match[3] !== undefined ? Number(match[3]) : null,
    }
    if (isValidDateToken(token)) {
      return `${token.year}-${String(token.month).padStart(2, '0')}`
    }
  }
  return null
}

export function monthKeyOfDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function formatPeriod(key: string): string {
  const matched = /^(\d{4})-(\d{2})$/.exec(key)
  if (!matched) return key
  return `${matched[1]}年${Number(matched[2])}月`
}

/** 不考虑开票留档快照时，按统一规则该归属到哪个月。 */
export function resolveAttributionKey(row: EntryRow): string | null {
  return parsePeriodText(row['结算周期']) ?? parseDate(row['抄表日期'])
}

/**
 * 一行结算单的最终归属：开票留档快照 > 结算周期文字 > 抄表日期 > 已落库的存量值。
 * 列表、导出、月度汇总都只能通过这里取数。
 */
export function attributionOf(row: EntryRow): { key: string; source: AttributionSource } {
  const archived = String(row['开票时归属期间'] ?? '').trim()
  if (archived) return { key: archived, source: '开票时留档' }

  const fromPeriod = parsePeriodText(row['结算周期'])
  if (fromPeriod) return { key: fromPeriod, source: '结算周期' }

  const fromReading = parseDate(row['抄表日期'])
  if (fromReading) return { key: fromReading, source: '抄表日期' }

  const stored = String(row['归属期间'] ?? '').trim()
  if (stored) return { key: stored, source: '存量留档' }

  return { key: '', source: '未归属' }
}

export function enrichSettlementRows(rows: EntryRow[]): SettlementView[] {
  return rows.map((row) => {
    const { key, source } = attributionOf(row)
    return {
      ...row,
      归属期间: key,
      归属期间显示: key ? formatPeriod(key) : '未归属',
      归属来源: source,
    }
  })
}

/** 抄表日期月份与归属期间是否对得上；留档单不参与核对。 */
export function periodMismatch(row: EntryRow): boolean {
  const archived = String(row['开票时归属期间'] ?? '').trim()
  if (archived) return false
  const { key } = attributionOf(row)
  if (!key) return false
  const readingMonth = parseDate(row['抄表日期'])
  return readingMonth !== null && readingMonth !== key
}

export function toNumber(value: unknown): number {
  const num = Number.parseFloat(String(value ?? '').replace(/,/g, ''))
  return Number.isFinite(num) ? num : 0
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 按统一口径分组月度汇总：分组键与列表归属同源，合计必然对得平。 */
export function summarizeByPeriod(rows: SettlementView[]): MonthlyBucket[] {
  const buckets = new Map<string, MonthlyBucket>()
  for (const row of rows) {
    const key = row.归属期间
    const existing =
      buckets.get(key) ??
      {
        key,
        label: key ? formatPeriod(key) : '未归属',
        count: 0,
        energy: 0,
        subsidy: 0,
        amount: 0,
        byStatus: {},
      }
    existing.count += 1
    existing.energy += toNumber(row['上网电量'])
    existing.subsidy += toNumber(row['补贴金额'])
    existing.amount += toNumber(row['结算金额'])
    const status = String(row.status ?? '')
    existing.byStatus[status] = (existing.byStatus[status] ?? 0) + 1
    buckets.set(key, existing)
  }
  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      energy: round2(bucket.energy),
      subsidy: round2(bucket.subsidy),
      amount: round2(bucket.amount),
    }))
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
}

/**
 * 存量单据按结算周期回填：未开票单一律照新规则重算一次并落库；
 * 已开票单保留「开票时归属期间」快照，跳过。
 */
export function backfillPeriods(rows: EntryRow[]): { rows: EntryRow[]; result: BackfillResult } {
  const result: BackfillResult = { scanned: rows.length, updated: 0, archived: 0, unresolved: 0 }
  const next = rows.map((row) => {
    if (String(row['开票时归属期间'] ?? '').trim()) {
      result.archived += 1
      return row
    }
    const key = resolveAttributionKey(row)
    if (!key) result.unresolved += 1
    const stored = String(row['归属期间'] ?? '').trim()
    const target = key ?? ''
    if (target !== stored) result.updated += 1
    return { ...row, 归属期间: target }
  })
  return { rows: next, result }
}

/** 关口表倍率电量：（本期读数 - 上期读数）× 倍率。 */
export function meterEnergy(meter: EntryRow): number {
  const current = toNumber(meter['本期读数'])
  const previous = toNumber(meter['上期读数'])
  const ratio = toNumber(meter['倍率']) || 1
  return round2((current - previous) * ratio)
}

export function findMeterSettlement(
  settlements: EntryRow[],
  meterNo: string,
  linkedNo?: unknown,
): EntryRow | undefined {
  const linked = String(linkedNo ?? '').trim()
  return settlements.find((row) => {
    if (linked && String(row['结算单号'] ?? '') === linked) return true
    return String(row['来源计量点'] ?? '') === meterNo
  })
}

export function nextSettlementNo(rows: EntryRow[]): string {
  let max = 0
  for (const row of rows) {
    const matched = /^SETT-(\d+)$/.exec(String(row['结算单号'] ?? ''))
    if (matched) max = Math.max(max, Number(matched[1]))
  }
  return `SETT-${String(max + 1).padStart(4, '0')}`
}

/** 确认计量的结果同步成一张「待核算」结算单，周期文字与抄表日期同月。 */
export function buildSettlementFromMeter(
  meter: EntryRow,
  id: number,
  settlementNo: string,
): EntryRow | null {
  const readingMonth = parseDate(meter['抄表日期'])
  if (!readingMonth) return null
  return {
    id,
    status: '待核算',
    pending: true,
    abnormal: false,
    结算单号: settlementNo,
    结算周期: formatPeriod(readingMonth),
    归属期间: readingMonth,
    抄表日期: String(meter['抄表日期'] ?? ''),
    来源计量点: String(meter['计量点编号'] ?? ''),
    上网电量: meterEnergy(meter),
    结算电价: 0,
    补贴金额: 0,
    结算金额: 0,
    开票状态: '未开票',
    结算状态: '待核算',
    已提交核算: false,
    首次核算时间: '',
    开票时归属期间: '',
  }
}
