<template>
  <section class="page" data-module="settlement-monthly">
    <header class="page-head">
      <div>
        <h2>月度结算汇总</h2>
        <p class="page-desc">
          按统一归属期间分组，与结算单列表、导出清单同源同口径。
          归属以「结算周期」栏为准（区间取期末月，解析不出再看抄表日期），已开票单按开票时归属留档。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">重新汇总</button>
        <button class="btn" type="button" @click="backfill">按结算周期回填归属</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">汇总月份数</span>
        <strong class="stat-value">{{ buckets.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">结算单合计</span>
        <strong class="stat-value">{{ total.count }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">上网电量合计</span>
        <strong class="stat-value">{{ total.energy }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">结算金额合计</span>
        <strong class="stat-value">{{ total.amount }}</strong>
      </article>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>归属期间</th>
          <th>结算单数</th>
          <th>上网电量</th>
          <th>补贴金额</th>
          <th>结算金额</th>
          <th>状态分布</th>
          <th>备注</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="bucket in bucketsWithSource" :key="bucket.key || 'unresolved'">
          <td>{{ bucket.label }}</td>
          <td>{{ bucket.count }}</td>
          <td>{{ bucket.energy }}</td>
          <td>{{ bucket.subsidy }}</td>
          <td>{{ bucket.amount }}</td>
          <td>
            <span v-for="item in statusPairs(bucket)" :key="item" class="legend-item">{{ item }}</span>
          </td>
          <td>
            <span v-if="bucket.key === currentMonthKey" class="tag tag-current">本月</span>
            <span v-else>—</span>
          </td>
        </tr>
        <tr v-if="!buckets.length">
          <td colspan="7" class="empty-state">暂无结算单可汇总</td>
        </tr>
      </tbody>
      <tfoot>
        <tr class="total-row">
          <td>合计（与各月之和{{ balanced ? '一致' : '不平' }}）</td>
          <td>{{ total.count }}</td>
          <td>{{ total.energy }}</td>
          <td>{{ total.subsidy }}</td>
          <td>{{ total.amount }}</td>
          <td>
            <span v-for="item in statusPairs(total)" :key="item" class="legend-item">{{ item }}</span>
          </td>
          <td>
            <span :class="balanced ? 'tag tag-archived' : 'tag tag-warn'">
              {{ balanced ? '对平' : '请回填后再看' }}
            </span>
          </td>
        </tr>
      </tfoot>
    </table>

    <section class="sub-panel">
      <h3 class="sub-title">待核算清单（与发电结算页同源）</h3>
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
      <span>本月指 {{ currentMonthLabel }}；分组口径来自 settlement-period 统一取数，不再按上网电量非零倒推</span>
      <span v-if="message" class="info-text">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  backfillSettlement,
  listPendingSettlement,
  loadMonthlySettlement,
} from '@/api/local-service'
import { formatPeriod, type MonthlyBucket, type SettlementView } from '@/data/settlement-period'

const buckets = ref<MonthlyBucket[]>([])
const total = ref<MonthlyBucket>({
  key: '合计',
  label: '全部月份合计',
  count: 0,
  energy: 0,
  subsidy: 0,
  amount: 0,
  byStatus: {},
})
const currentMonthKey = ref('')
const pendingRows = ref<SettlementView[]>([])
const message = ref('')

const currentMonthLabel = computed(() =>
  currentMonthKey.value ? formatPeriod(currentMonthKey.value) : '',
)

const bucketsWithSource = computed(() => buckets.value)

const balanced = computed(() => {
  const sumEnergy = Math.round(buckets.value.reduce((sum, item) => sum + item.energy, 0) * 100) / 100
  const sumAmount = Math.round(buckets.value.reduce((sum, item) => sum + item.amount, 0) * 100) / 100
  const sumCount = buckets.value.reduce((sum, item) => sum + item.count, 0)
  return sumEnergy === total.value.energy && sumAmount === total.value.amount && sumCount === total.value.count
})

function statusPairs(bucket: MonthlyBucket): string[] {
  return Object.entries(bucket.byStatus).map(([status, count]) => `${status} ${count}`)
}

function backfill() {
  const result = backfillSettlement()
  message.value = `回填完成：共 ${result.scanned} 张，重算 ${result.updated} 张，已开票留档跳过 ${result.archived} 张${
    result.unresolved ? `，${result.unresolved} 张周期无法识别` : ''
  }`
  reload()
}

function reload() {
  const payload = loadMonthlySettlement()
  buckets.value = payload.buckets
  total.value = payload.total
  currentMonthKey.value = payload.currentMonthKey
  pendingRows.value = listPendingSettlement()
}

onMounted(reload)
</script>
