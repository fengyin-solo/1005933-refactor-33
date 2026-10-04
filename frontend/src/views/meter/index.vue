<template>
  <section class="page" data-module="meter">
    <header class="page-head">
      <div>
        <h2>电量计量管理</h2>
        <p class="page-desc">
          维护关口计量表读数。「确认计量」按抄表日期所在月份把上网电量同步到待核算清单，
          结算周期文字与抄表日期同月；同一张结算单重复确认只同步第一次。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记关口计量表</button>
        <button class="btn" type="button" @click="exportRows">导出电量计量清单</button>
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
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无电量计量数据，可先登记关口计量表</td>
        </tr>
      </tbody>
    </table>

    <section class="sub-panel">
      <h3 class="sub-title">待核算清单（确认计量的结果同步到这里）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>结算单号</th><th>归属期间</th><th>来源计量点</th><th>抄表日期</th><th>上网电量</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in pendingRows" :key="`pending-${String(row.id)}`">
            <td>{{ row['结算单号'] }}</td>
            <td>{{ row.归属期间显示 }}</td>
            <td>{{ row['来源计量点'] || '手工登记' }}</td>
            <td>{{ row['抄表日期'] || '—' }}</td>
            <td>{{ row['上网电量'] || 0 }}</td>
          </tr>
          <tr v-if="!pendingRows.length">
            <td colspan="5" class="empty-state">待核算清单为空</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条电量计量记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listPendingSettlement,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { SettlementView } from '@/data/settlement-period'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('meter')
const columns = ["计量点编号", "计量方向", "表计型号", "倍率", "抄表日期", "本期读数", "上期读数", "关联结算单号", "计量状态"]
const statuses = ["待抄表", "已抄录", "待复核", "已确认"]

const rows = ref<EntryRow[]>([])
const pendingRows = ref<SettlementView[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["计量点编号", "计量方向", "抄表日期"]

const stats = computed(() => [
  { label: '计量点总数', value: rows.value.length },
  { label: '待抄表计量点', value: rows.value.filter((row) => String(row.status) === '待抄表').length },
  { label: '待复核读数', value: rows.value.filter((row) => String(row.status) === '待复核').length },
  { label: '已同步待核算', value: pendingRows.value.length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function availableActions(row: EntryRow): string[] {
  switch (String(row.status)) {
    case '待抄表':
      return ['录入读数']
    case '已抄录':
      return ['提交复核']
    case '待复核':
      return ['确认计量']
    default:
      return []
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '关口计量表登记入口尚未接入审批流'
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
    rows.value = payload.items
    total.value = payload.total
    pendingRows.value = listPendingSettlement()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '电量计量列表读取失败'
  }
}

onMounted(reload)
</script>
