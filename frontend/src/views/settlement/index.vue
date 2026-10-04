<template>
  <section class="page" data-module="settlement">
    <header class="page-head">
      <div>
        <h2>发电结算管理</h2>
        <p class="page-desc">
          归属口径全平台唯一：以结算周期截止日所在月为准，列表、导出、月度汇总同源；已开票单按当时归属冻结留档。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记电量结算单</button>
        <button class="btn" type="button" @click="exportRows">导出发电结算清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span v-if="unattributedCount" class="legend-item" style="background: #fee4e2">
        未归属：{{ unattributedCount }}（结算周期无法识别月份）
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>结算单号</span>
        <input v-model="filters['结算单号']" placeholder="按结算单号检索" />
      </label>
      <label class="filter-item">
        <span>结算周期</span>
        <input v-model="filters['结算周期']" placeholder="按结算周期检索" />
      </label>
      <label class="filter-item">
        <span>归属月份</span>
        <input v-model="monthFilter" placeholder="如 2026-06" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>抄表对齐</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in visibleRows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ formatCell(column, row[column]) }}</td>
          <td>
            <span v-if="alignment(row) === 'matched'" style="color: #067647">一致</span>
            <span v-else-if="alignment(row) === 'cross-month'" class="error-text">跨月</span>
            <span v-else style="color: var(--muted)">—</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!availableActions(row).length" style="color: var(--muted)">—</span>
          </td>
        </tr>
        <tr v-if="!visibleRows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无符合条件的发电结算数据</td>
        </tr>
      </tbody>
    </table>

    <h3 style="margin: 18px 0 8px; font-size: 15px">月度汇总（与列表、导出同一份归属取数）</h3>
    <table class="data-table">
      <thead>
        <tr><th>归属月份</th><th>结算单数</th><th>上网电量合计（kWh）</th><th>结算金额合计（元）</th></tr>
      </thead>
      <tbody>
        <tr v-for="item in monthly" :key="item.month">
          <td>{{ item.label }}（{{ item.month }}）</td>
          <td>{{ item.count }}</td>
          <td>{{ item.energy }}</td>
          <td>{{ item.amount }}</td>
        </tr>
        <tr v-if="!monthly.length">
          <td colspan="4" class="empty-state">暂无可归属的结算单</td>
        </tr>
      </tbody>
    </table>

    <h3 style="margin: 18px 0 8px; font-size: 15px">待核算清单（确认计量的结果同步到这里）</h3>
    <table class="data-table">
      <thead>
        <tr><th>结算单号</th><th>来源计量点</th><th>归属月份</th><th>上网电量（kWh）</th><th>抄表日期</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in pendingRows" :key="String(row.id)">
          <td>{{ row['结算单号'] }}</td>
          <td>{{ row['来源计量点'] ?? '—' }}</td>
          <td>{{ row['归属周期'] }}</td>
          <td>{{ formatNumber(row['上网电量']) }}</td>
          <td>{{ row['抄表日期'] ?? '—' }}</td>
        </tr>
        <tr v-if="!pendingRows.length">
          <td colspan="5" class="empty-state">待核算清单为空，电量计量页确认计量后会自动进入这里</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条发电结算记录；同一张结算单重复提交核算只认第一次</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  ACTION_CONFIRM,
  ACTION_INVOICE,
  ACTION_START_AUDIT,
  STATUS_AUDITING,
  STATUS_CONFIRMED,
  STATUS_PENDING,
  checkMeterAlignment,
  currentMonthStats,
  formatNumber,
  monthlySummary,
  pendingChecklist,
  withAttribution,
} from '@/domain/settlement'
import { isMonthKey } from '@/domain/period'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('settlement')
const columns = ['结算单号', '结算周期', '归属周期', '上网电量', '结算电价', '补贴金额', '结算金额', '开票状态', '抄表日期']
const statuses = ['待核算', '核算中', '已确认', '已开票']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const monthFilter = ref('')

const decoratedRows = computed(() => withAttribution(rows.value))

const visibleRows = computed(() => {
  const month = monthFilter.value.trim()
  if (!month) return decoratedRows.value
  return decoratedRows.value.filter((row) => String(row['归属月份'] ?? '').includes(month))
})

const monthly = computed(() => monthlySummary(rows.value))
const pendingRows = computed(() => pendingChecklist(rows.value))
const unattributedCount = computed(() => currentMonthStats(rows.value).unattributed)

const stats = computed(() => {
  const month = currentMonthStats(rows.value)
  return [
    { label: `待核算结算单（${pendingRows.value.length}）`, value: pendingRows.value.length },
    { label: `${month.label}上网电量(kWh)`, value: formatNumber(month.energy) },
    { label: `${month.label}结算金额(元)`, value: formatNumber(month.amount) },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 动作按状态收敛：待核算只能发起一次核算，核算中才能确认，确认后才能开票。
function availableActions(row: EntryRow): string[] {
  switch (String(row.status)) {
    case STATUS_PENDING:
      return [ACTION_START_AUDIT]
    case STATUS_AUDITING:
      return [ACTION_CONFIRM]
    case STATUS_CONFIRMED:
      return [ACTION_INVOICE]
    default:
      return []
  }
}

function alignment(row: EntryRow) {
  return checkMeterAlignment(row)
}

function formatCell(column: string, value: unknown): string {
  if (column === '上网电量' || column === '补贴金额' || column === '结算金额') {
    return formatNumber(value)
  }
  if (column === '归属周期') {
    return String(value ?? '—')
  }
  return value === undefined || value === '' ? '—' : String(value)
}

function resetFilters() {
  filters.value = {}
  monthFilter.value = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '电量结算单登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    // 归属月份过滤交给页面（派生列不在通用筛选器里），其余条件仍走通用取数。
    const { 结算单号: no = '', 结算周期: period = '' } = filters.value
    const payload = listEntries(meta.key, { 结算单号: no, 结算周期: period })
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '发电结算列表读取失败'
  }
}

onMounted(reload)
</script>
