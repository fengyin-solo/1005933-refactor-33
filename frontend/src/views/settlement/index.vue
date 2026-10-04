<template>
  <section class="page" data-module="settlement">
    <header class="page-head">
      <div>
        <h2>发电结算管理</h2>
        <p class="page-desc">
          归属期间统一以「结算周期」栏解析（区间取期末月，解析不出再看抄表日期）；列表、导出、月度汇总同源。
          已开票单按开票时归属留档，不再重算。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记电量结算单</button>
        <button class="btn" type="button" @click="exportRows">导出发电结算清单</button>
        <button class="btn" type="button" @click="backfill">按结算周期回填归属</button>
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
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field.name" class="filter-item">
        <span>{{ field.name }}</span>
        <input v-model="filters[field.key]" :placeholder="`按${field.name}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '归属期间'">
              <span>{{ row.归属期间显示 }}</span>
              <span v-if="row.归属来源 === '开票时留档'" class="tag tag-archived">开票时留档</span>
              <span v-else-if="isMismatch(row)" class="tag tag-warn">抄表日期跨月</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
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
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无发电结算数据，可先登记电量结算单</td>
        </tr>
      </tbody>
    </table>

    <section class="sub-panel">
      <h3 class="sub-title">待核算清单（计量确认同步、手工登记都进这里）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>结算单号</th><th>归属期间</th><th>来源计量点</th><th>抄表日期</th><th>上网电量</th><th>首次核算时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in pendingRows" :key="`pending-${String(row.id)}`">
            <td>{{ row['结算单号'] }}</td>
            <td>{{ row.归属期间显示 }}</td>
            <td>{{ row['来源计量点'] || '手工登记' }}</td>
            <td>{{ row['抄表日期'] || '—' }}</td>
            <td>{{ row['上网电量'] || 0 }}</td>
            <td>{{ row['首次核算时间'] || '未提交' }}</td>
          </tr>
          <tr v-if="!pendingRows.length">
            <td colspan="6" class="empty-state">待核算清单为空</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条发电结算记录；本月指 {{ currentMonthLabel }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  backfillSettlement,
  downloadEntries,
  listEntries,
  listPendingSettlement,
  moduleMeta,
  runAction as applyAction,
  settlementMonthStats,
} from '@/api/local-service'
import { formatPeriod, monthKeyOfDate, periodMismatch, type SettlementView } from '@/data/settlement-period'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('settlement')
const columns = ["结算单号", "结算周期", "归属期间", "抄表日期", "上网电量", "结算电价", "补贴金额", "结算金额", "开票状态", "结算状态"]
const actions = ["发起核算", "确认结算", "登记开票"]
const statuses = ["待核算", "核算中", "已确认", "已开票"]

const rows = ref<SettlementView[]>([])
const pendingRows = ref<SettlementView[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = [
  { key: '结算单号', name: '结算单号' },
  { key: '结算周期', name: '结算周期' },
  { key: '归属期间', name: '归属期间' },
]

const currentMonthLabel = computed(() => formatPeriod(monthKeyOfDate(new Date())))

const stats = computed(() => {
  const live = settlementMonthStats()
  return [
    { label: '待核算结算单', value: live.pending },
    { label: '本月上网电量', value: live.monthEnergy },
    { label: '本月结算金额', value: live.monthAmount },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function isMismatch(row: EntryRow): boolean {
  return periodMismatch(row)
}

function availableActions(row: EntryRow): string[] {
  const status = String(row.status)
  const submitted = row['已提交核算'] === true || row['已提交核算'] === 'true'
  if (status === '待核算') return ['发起核算']
  if (status === '核算中') return submitted ? ['确认结算'] : ['发起核算', '确认结算']
  if (status === '已确认') return ['登记开票']
  return []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
  infoMessage.value = '导出清单的归属期间与本列表、月度汇总完全一致'
}

function backfill() {
  errorMessage.value = ''
  const result = backfillSettlement()
  infoMessage.value = `回填完成：共 ${result.scanned} 张，重算 ${result.updated} 张，已开票留档跳过 ${result.archived} 张${
    result.unresolved ? `，${result.unresolved} 张周期无法识别` : ''
  }`
  reload()
}

function openCreate() {
  errorMessage.value = '电量结算单登记入口尚未接入审批流；待核算结算单可由电量计量「确认计量」自动同步'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items as SettlementView[]
    total.value = payload.total
    pendingRows.value = listPendingSettlement()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '发电结算列表读取失败'
  }
}

onMounted(reload)
</script>
