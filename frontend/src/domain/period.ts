/**
 * 结算周期归属：全平台唯一取数口径。
 *
 * 规则（列表、导出、月度汇总三处共用，不得再各写一遍）：
 * 1. 以结算单上填写的「结算周期」文字为准，解析周期区间，取【截止日所在月】为归属月份；
 * 2. 抄表日期只用于和归属月份做对齐校验，绝不参与归属推算；
 * 3. 月度汇总只按这里解出的月份分组，不再拿上网电量非零的月份倒推。
 */

export type MonthKey = string // 形如 2026-06

const MONTH_KEY_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/

// 一次扫出周期文字里的全部日期/月份片段，按出现顺序排列，取最后一个作为周期截止：
// - 分组 1-3：2026年6月 / 2026年6月30日
// - 分组 4-6：2026-06 / 2026-06-30 / 2026/06/30
// - 分组 7  ：裸写的「6月」（年份向前找最近的年份，找不到用兜底年份）
const PERIOD_TOKEN_RE =
  /(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日?)?|(\d{4})\s*[\-/.]\s*(\d{1,2})(?:\s*[\-/.]\s*(\d{1,2}))?|(?<![\d.])(\d{1,2})\s*月/g

type Token = { index: number; year?: number; month: number }

function isValidMonth(month: number): boolean {
  return Number.isInteger(month) && month >= 1 && month <= 12
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  for (const match of text.matchAll(new RegExp(PERIOD_TOKEN_RE))) {
    const index = match.index ?? 0
    if (match[1] !== undefined) {
      const month = Number(match[2])
      if (isValidMonth(month)) tokens.push({ index, year: Number(match[1]), month })
    } else if (match[4] !== undefined) {
      const month = Number(match[5])
      if (isValidMonth(month)) tokens.push({ index, year: Number(match[4]), month })
    } else if (match[7] !== undefined) {
      const month = Number(match[7])
      if (isValidMonth(month)) tokens.push({ index, month })
    }
  }
  return tokens
}

function keyOf(token: Token, tokens: Token[], fallbackYear: number): MonthKey {
  let year = token.year
  if (year === undefined) {
    for (let i = tokens.indexOf(token) - 1; i >= 0; i -= 1) {
      if (tokens[i].year !== undefined) {
        year = tokens[i].year
        break
      }
    }
  }
  return `${year ?? fallbackYear}-${String(token.month).padStart(2, '0')}`
}

/** 解析周期文字的归属月份：取区间【截止日】所在月；无法识别时返回 null。 */
export function periodMonthKey(text: string, fallbackYear: number = new Date().getFullYear()): MonthKey | null {
  if (!text) return null
  const tokens = tokenize(text)
  if (tokens.length === 0) return null
  return keyOf(tokens[tokens.length - 1], tokens, fallbackYear)
}

/** 解析单个日期文字（如抄表日期 2026-06-30）所在月份。 */
export function monthKeyFromDateText(text: string, fallbackYear: number = new Date().getFullYear()): MonthKey | null {
  if (!text) return null
  const tokens = tokenize(text)
  if (tokens.length === 0) return null
  return keyOf(tokens[0], tokens, fallbackYear)
}

export function isMonthKey(value: unknown): value is MonthKey {
  return typeof value === 'string' && MONTH_KEY_RE.test(value)
}

/** 2026-06 -> 2026年6月 */
export function formatMonthKey(key: MonthKey): string {
  if (!isMonthKey(key)) return ''
  const [year, month] = key.split('-')
  return `${year}年${Number(month)}月`
}

export function currentMonthKey(): MonthKey {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}
