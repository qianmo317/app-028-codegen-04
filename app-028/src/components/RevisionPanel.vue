<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import SheetView from './SheetView.vue'
import {
  allPapers,
  allSizes,
  currentRevision,
  rollbackTask,
  sheetsOfRevision,
  reviseTask,
  previewTaskRevision,
} from '../store'
import { findPhotoSize, resolvePaper } from '../logic/library'
import { formatCents, formatPercent } from '../logic/units'
import type { Paper, RevisionParams, Task, TaskRevision } from '../logic/types'
import type { RevisionPreview } from '../logic/revision'

const props = defineProps<{ task: Task }>()

const current = computed(() => currentRevision(props.task))
const compareAId = ref('')
const compareBId = ref('')
const sheetA = ref(0)
const sheetB = ref(0)
const defaultCustom = (): Paper => ({
  ...(props.task.customPaper ?? {
    id: 'custom',
    name: '自定义相纸',
    wMm: 152,
    hMm: 210,
    marginMm: 3,
    priceCents: 200,
    kind: 'sheet' as const,
  }),
})

const draft = reactive<RevisionParams>({
  paperId: props.task.paperId,
  customPaper: defaultCustom(),
  gapMm: props.task.gapMm,
  kerfMm: props.task.kerfMm,
  safeEdgeMm: props.task.safeEdgeMm,
})
const note = ref('')
const preview = ref<RevisionPreview | null>(null)
const previewError = ref('')
const previewBusy = ref(false)

watch(
  current,
  (rev) => {
    if (!rev) return
    draft.paperId = rev.params.paperId
    draft.customPaper = rev.params.customPaper ? { ...rev.params.customPaper } : defaultCustom()
    draft.gapMm = rev.params.gapMm
    draft.kerfMm = rev.params.kerfMm
    draft.safeEdgeMm = rev.params.safeEdgeMm
    preview.value = null
    previewError.value = ''
    if (!compareBId.value || compareBId.value === compareAId.value) compareBId.value = rev.id
  },
  { immediate: true },
)

watch(
  () => props.task.revisions.map((r) => r.id).join(','),
  () => {
    const cur = current.value
    if (cur) {
      compareBId.value = cur.id
      if (!compareAId.value && props.task.revisions.length > 1) {
        compareAId.value = props.task.revisions[props.task.revisions.length - 2].id
      }
    }
  },
  { immediate: true },
)

function paramsSnapshot(): RevisionParams {
  return {
    paperId: draft.paperId,
    customPaper: draft.paperId === 'custom' ? { ...draft.customPaper! } : undefined,
    gapMm: draft.gapMm,
    kerfMm: draft.kerfMm,
    safeEdgeMm: draft.safeEdgeMm,
  }
}

function runPreview() {
  previewBusy.value = true
  previewError.value = ''
  const out = previewTaskRevision(props.task, paramsSnapshot())
  previewBusy.value = false
  if (!out.ok) {
    preview.value = null
    previewError.value = out.error
    return
  }
  preview.value = out.preview
}

function confirmRevision() {
  const err = reviseTask(props.task, paramsSnapshot(), note.value)
  if (err) {
    previewError.value = err
    return
  }
  note.value = ''
  preview.value = null
}

function sizeName(seq: number): string {
  const all = props.task.manual?.placements ?? props.task.result?.sheets.flatMap((s) => s.placements) ?? []
  const p = all.find((x) => x.seq === seq)
  const item = props.task.items.find((i) => i.id === p?.itemId)
  const size = item ? findPhotoSize(allSizes.value, item.sizeId) : undefined
  return size?.name ?? '未知尺寸'
}

function doRollback(rev: TaskRevision) {
  if (!window.confirm(`确认退回到第 ${rev.number} 版？当前版不会删除，会另存为一条退回记录。`)) return
  const err = rollbackTask(props.task, rev.id)
  if (err) previewError.value = err
}

const revA = computed(() => props.task.revisions.find((r) => r.id === compareAId.value))
const revB = computed(() => props.task.revisions.find((r) => r.id === compareBId.value))
const paperA = computed(() =>
  revA.value ? (revA.value.params.paperId === 'custom' && revA.value.params.customPaper
    ? revA.value.params.customPaper
    : allPapers.value.find((p) => p.id === revA.value!.params.paperId) ?? resolvePaper(props.task, allPapers.value)) : resolvePaper(props.task, allPapers.value),
)
const paperB = computed(() =>
  revB.value ? (revB.value.params.paperId === 'custom' && revB.value.params.customPaper
    ? revB.value.params.customPaper
    : allPapers.value.find((p) => p.id === revB.value!.params.paperId) ?? resolvePaper(props.task, allPapers.value)) : resolvePaper(props.task, allPapers.value),
)
const sheetsA = computed(() => (revA.value ? sheetsOfRevision(props.task, revA.value.id) : []))
const sheetsB = computed(() => (revB.value ? sheetsOfRevision(props.task, revB.value.id) : []))
const viewA = computed(() => sheetsA.value[Math.min(sheetA.value, sheetsA.value.length - 1)])
const viewB = computed(() => sheetsB.value[Math.min(sheetB.value, sheetsB.value.length - 1)])

const paramDiffs = computed(() => {
  if (!revA.value || !revB.value) return []
  const rows: Array<{ label: string; a: string; b: string; changed: boolean }> = [
    {
      label: '相纸',
      a: `${revA.value.metrics.paperName} ${paperA.value.wMm}×${paperA.value.hMm}mm`,
      b: `${revB.value.metrics.paperName} ${paperB.value.wMm}×${paperB.value.hMm}mm`,
      changed: revA.value.params.paperId !== revB.value.params.paperId || paperA.value.wMm !== paperB.value.wMm || paperA.value.hMm !== paperB.value.hMm,
    },
    { label: '隙距', a: `${revA.value.params.gapMm}mm`, b: `${revB.value.params.gapMm}mm`, changed: revA.value.params.gapMm !== revB.value.params.gapMm },
    { label: '刀口补偿', a: `${revA.value.params.kerfMm}mm`, b: `${revB.value.params.kerfMm}mm`, changed: revA.value.params.kerfMm !== revB.value.params.kerfMm },
    { label: '安全边', a: `${revA.value.params.safeEdgeMm}mm`, b: `${revB.value.params.safeEdgeMm}mm`, changed: revA.value.params.safeEdgeMm !== revB.value.params.safeEdgeMm },
  ]
  return rows
})

function signed(n: number, suffix = '') {
  if (n === 0) return '不变'
  if (suffix === ' 个百分点') return `${n > 0 ? '+' : ''}${n.toFixed(2)}${suffix}`
  if (suffix) return `${n > 0 ? '+' : ''}${n}${suffix}`
  return `${n > 0 ? '+' : ''}${n}`
}

function timeOf(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function reasonLabel(rev: TaskRevision) {
  if (rev.reason === 'initial') return '初始'
  if (rev.reason === 'rollback') return `退回→第${rev.rolledBackToNumber}版`
  return '修订'
}

const draftPaper = computed(() =>
  draft.paperId === 'custom' ? draft.customPaper! : allPapers.value.find((p) => p.id === draft.paperId) ?? allPapers.value[0],
)
const usable = computed(() => {
  const p = draftPaper.value
  const inset = p.marginMm + draft.safeEdgeMm
  const w = p.wMm - 2 * inset
  const h = p.hMm - 2 * inset
  return w > 0 && h > 0 ? `${w.toFixed(1)}×${h.toFixed(1)}mm` : '超出相纸'
})
</script>

<template>
  <div class="stack">
    <div class="card">
      <h3>修订并重排</h3>
      <div class="card-sub">
        修改隙距、刀口补偿、安全边或更换相纸后先预检；确认后另存新版本，旧版本保留备查。
      </div>
      <div class="grid cols-2">
        <label class="field">
          相纸
          <select v-model="draft.paperId">
            <option v-for="p in allPapers" :key="p.id" :value="p.id">
              {{ p.name }} · {{ p.wMm }}×{{ p.hMm }}mm · {{ formatCents(p.priceCents) }}/张
            </option>
            <option value="custom">自定义相纸…</option>
          </select>
        </label>
        <label class="field">
          可用区
          <input :value="usable" readonly />
        </label>
      </div>
      <div v-if="draft.paperId === 'custom'" class="grid cols-4">
        <label class="field">宽 mm<input v-model.number="draft.customPaper!.wMm" type="number" min="10" step="0.1" /></label>
        <label class="field">高 mm<input v-model.number="draft.customPaper!.hMm" type="number" min="10" step="0.1" /></label>
        <label class="field">纸边留白 mm<input v-model.number="draft.customPaper!.marginMm" type="number" min="0" step="0.5" /></label>
        <label class="field">单价（分）<input v-model.number="draft.customPaper!.priceCents" type="number" min="0" step="10" /></label>
      </div>
      <div class="grid cols-3">
        <label class="field">
          隙距：{{ draft.gapMm }}mm
          <input v-model.number="draft.gapMm" type="range" min="0" max="10" step="0.5" />
        </label>
        <label class="field">
          刀口补偿：{{ draft.kerfMm }}mm
          <input v-model.number="draft.kerfMm" type="range" min="0" max="3" step="0.1" />
        </label>
        <label class="field">
          安全边：{{ draft.safeEdgeMm }}mm
          <input v-model.number="draft.safeEdgeMm" type="range" min="0" max="20" step="0.5" />
        </label>
      </div>
      <label class="field">
        修订说明
        <input v-model="note" type="text" placeholder="如：客户要求多留 1mm 刀口 / 换 6×8 纸" />
      </label>
      <div class="row">
        <button class="btn" :disabled="previewBusy" @click="runPreview">预检并重排</button>
        <button class="btn primary" :disabled="!preview" @click="confirmRevision">确认另存为新版本</button>
      </div>
      <div v-if="previewError" class="note danger">{{ previewError }}</div>
      <div v-if="preview" class="stack" style="margin-top: 10px">
        <div class="note ok">
          试排完成：{{ preview.result.stats.sheets }} 张纸，利用率
          {{ formatPercent(preview.result.stats.avgUtilization) }}，总价
          {{ formatCents(preview.result.stats.sheets * draftPaper.priceCents) }}，
          {{ preview.result.sheets.reduce((a, s) => a + s.cutSteps.length, 0) }} 刀。
        </div>
        <div v-if="task.manual" class="note warn">
          手工位置保留 {{ preview.preserved.length }} 张；保不住 {{ preview.lostSeqs.length }} 张。
        </div>
        <div v-if="task.manual && preview.lostSeqs.length" class="note danger">
          以下手工位置无法按新安全边与间隙挪入，将由自动排样接管：
          <span v-for="seq in preview.lostSeqs" :key="seq" class="badge danger" style="margin: 2px">
            #{{ seq }} {{ sizeName(seq) }}
          </span>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>版本记录</h3>
      <div class="card-sub">每版固定保存参数、用纸张数、利用率、总价与刀数；退回会生成新版本，不删除旧版。</div>
      <table class="data">
        <thead>
          <tr>
            <th class="num">版本</th>
            <th>时间/说明</th>
            <th>参数</th>
            <th class="num">纸</th>
            <th class="num">利用率</th>
            <th class="num">总价</th>
            <th class="num">刀数</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="rev in [...task.revisions].reverse()" :key="rev.id" :class="{ 'current-rev': rev.id === current?.id }">
            <td class="num">
              第{{ rev.number }}版
              <span class="badge">{{ reasonLabel(rev) }}</span>
              <span v-if="rev.id === current?.id" class="badge ok">当前</span>
            </td>
            <td>
              <div>{{ timeOf(rev.createdAt) }}</div>
              <div class="card-sub">{{ rev.note }}</div>
            </td>
            <td>
              {{ rev.metrics.paperName }}｜{{ rev.params.gapMm }}/{{ rev.params.kerfMm }}/{{ rev.params.safeEdgeMm }}mm
            </td>
            <td class="num">{{ rev.metrics.sheets }}</td>
            <td class="num">{{ formatPercent(rev.metrics.avgUtilization) }}</td>
            <td class="num">{{ formatCents(rev.metrics.totalCents) }}</td>
            <td class="num">{{ rev.metrics.cutCount }}</td>
            <td>
              <div class="row tight">
                <button class="btn small" @click="compareAId = rev.id">左比</button>
                <button class="btn small" @click="compareBId = rev.id">右比</button>
                <button
                  class="btn small"
                  :disabled="rev.id === current?.id"
                  @click="doRollback(rev)"
                >退回</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="revA && revB" class="card">
      <h3>新旧版本并排比较</h3>
      <div class="grid cols-2">
        <div>
          <select v-model="compareAId" style="margin-bottom: 8px">
            <option v-for="r in task.revisions" :key="r.id" :value="r.id">第{{ r.number }}版</option>
          </select>
        </div>
        <div>
          <select v-model="compareBId" style="margin-bottom: 8px">
            <option v-for="r in task.revisions" :key="r.id" :value="r.id">第{{ r.number }}版</option>
          </select>
        </div>
      </div>

      <table class="data compare-table">
        <thead>
          <tr><th>项目</th><th>第{{ revA.number }}版</th><th>第{{ revB.number }}版差异</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in paramDiffs" :key="row.label" :class="{ changed: row.changed }">
            <td>{{ row.label }}</td>
            <td>{{ row.a }}</td>
            <td>{{ row.b }}</td>
          </tr>
          <tr>
            <td>用纸张数</td>
            <td>{{ revA.metrics.sheets }} 张</td>
            <td>{{ revB.metrics.sheets }} 张（{{ signed(revB.metrics.sheets - revA.metrics.sheets, ' 张') }}）</td>
          </tr>
          <tr>
            <td>照片数</td>
            <td>{{ revA.metrics.totalPhotos }}</td>
            <td>{{ revB.metrics.totalPhotos }}</td>
          </tr>
          <tr>
            <td>平均利用率</td>
            <td>{{ formatPercent(revA.metrics.avgUtilization) }}</td>
            <td>
              {{ formatPercent(revB.metrics.avgUtilization) }}
              （{{ signed(Math.round((revB.metrics.avgUtilization - revA.metrics.avgUtilization) * 10000) / 100, ' 个百分点') }}）
            </td>
          </tr>
          <tr>
            <td>总价</td>
            <td>{{ formatCents(revA.metrics.totalCents) }}</td>
            <td>{{ formatCents(revB.metrics.totalCents) }}（{{ formatCents(revB.metrics.totalCents - revA.metrics.totalCents) }}）</td>
          </tr>
          <tr>
            <td>刀数</td>
            <td>{{ revA.metrics.cutCount }}</td>
            <td>{{ revB.metrics.cutCount }}（{{ signed(revB.metrics.cutCount - revA.metrics.cutCount, ' 刀') }}）</td>
          </tr>
        </tbody>
      </table>

      <div class="grid cols-2" style="margin-top: 12px">
        <div>
          <div class="row tight">
            <button v-for="(s, i) in sheetsA" :key="s.index" class="btn small" :class="{ primary: i === sheetA }" @click="sheetA = i">第{{ i + 1 }}张</button>
          </div>
          <div v-if="viewA" class="sheet-wrap">
            <SheetView :sheet="viewA" :paper="paperA" :safe-edge-mm="revA.params.safeEdgeMm" :scale="Math.min(1, 420 / paperA.wMm)" />
          </div>
        </div>
        <div>
          <div class="row tight">
            <button v-for="(s, i) in sheetsB" :key="s.index" class="btn small" :class="{ primary: i === sheetB }" @click="sheetB = i">第{{ i + 1 }}张</button>
          </div>
          <div v-if="viewB" class="sheet-wrap">
            <SheetView :sheet="viewB" :paper="paperB" :safe-edge-mm="revB.params.safeEdgeMm" :scale="Math.min(1, 420 / paperB.wMm)" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
