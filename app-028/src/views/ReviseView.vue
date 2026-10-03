<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  allPapers,
  allSizes,
  createRevision,
  currentRevisionOf,
  ensureRevisions,
  getTask,
  rollbackRevision,
} from '../store'
import {
  diffParams,
  paperLabel,
  planPreservation,
  revisionNote,
  type ParamDiff,
} from '../logic/revision'
import { findPhotoSize } from '../logic/library'
import { formatCents, formatPercent } from '../logic/units'
import type { Paper, Revision, RevisionParams, Task } from '../logic/types'

const route = useRoute()
const router = useRouter()

const task = computed<Task | undefined>(() => getTask(String(route.params.id)))

// 旧任务没有版本记录时补一版 v1
watch(
  task,
  (t) => {
    if (t) ensureRevisions(t)
  },
  { immediate: true },
)

const revisions = computed<Revision[]>(() => task.value?.revisions ?? [])
const currentRev = computed(() => (task.value ? currentRevisionOf(task.value) : undefined))

/** 修订表单：预填当前版本参数 */
const draft = reactive<RevisionParams & { customPaper: Paper }>({
  paperId: 'p5x7',
  customPaper: {
    id: 'custom',
    name: '自定义相纸',
    wMm: 152,
    hMm: 210,
    marginMm: 3,
    priceCents: 200,
    kind: 'sheet',
  },
  gapMm: 0,
  kerfMm: 0.5,
  safeEdgeMm: 3,
  allowRotate: true,
})

function fillFromTask(t: Task) {
  draft.paperId = t.paperId
  draft.gapMm = t.gapMm
  draft.kerfMm = t.kerfMm
  draft.safeEdgeMm = t.safeEdgeMm
  draft.allowRotate = t.allowRotate
  if (t.customPaper) draft.customPaper = { ...t.customPaper }
}
watch(task, (t) => t && fillFromTask(t), { immediate: true })

const message = ref('')
const messageKind = ref<'ok' | 'danger' | 'warn'>('ok')
const error = ref('')

/** 传给 store 的净参数 */
function draftParams(): RevisionParams {
  return {
    paperId: draft.paperId,
    customPaper: draft.paperId === 'custom' ? { ...draft.customPaper } : undefined,
    gapMm: Number(draft.gapMm),
    kerfMm: Number(draft.kerfMm),
    safeEdgeMm: Number(draft.safeEdgeMm),
    allowRotate: draft.allowRotate,
  }
}

const paramDiffs = computed<ParamDiff[]>(() => {
  const t = task.value
  if (!t) return []
  return diffParams(
    {
      paperId: t.paperId,
      customPaper: t.customPaper,
      gapMm: t.gapMm,
      kerfMm: t.kerfMm,
      safeEdgeMm: t.safeEdgeMm,
      allowRotate: t.allowRotate,
    },
    draftParams(),
    allPapers.value,
  )
})

const notePreview = computed(() => {
  const t = task.value
  if (!t) return ''
  return revisionNote(
    {
      paperId: t.paperId,
      customPaper: t.customPaper,
      gapMm: t.gapMm,
      kerfMm: t.kerfMm,
      safeEdgeMm: t.safeEdgeMm,
      allowRotate: t.allowRotate,
    },
    draftParams(),
    allPapers.value,
  )
})

/** 预检：哪些手工位置保不住 */
interface Preview {
  kept: number
  moved: number
  dropped: Array<{ seq: number; label: string; reason: string }>
  checked: boolean
}
const preview = ref<Preview | null>(null)

function itemName(itemId: string): string {
  const t = task.value
  const item = t?.items.find((i) => i.id === itemId)
  const s = item ? findPhotoSize(allSizes.value, item.sizeId) : undefined
  return s?.name ?? '照片'
}

function runPreview() {
  const t = task.value
  if (!t) return
  error.value = ''
  message.value = ''
  if (Number(draft.gapMm) < 0 || Number(draft.kerfMm) < 0 || Number(draft.safeEdgeMm) < 0) {
    error.value = '隙距、刀口补偿、安全边不能为负数'
    return
  }
  if (draft.paperId === 'custom' && (draft.customPaper.wMm <= 0 || draft.customPaper.hMm <= 0)) {
    error.value = '自定义相纸宽高必须大于 0'
    return
  }
  if (!t.result) {
    error.value = '任务还没有排样结果，请先在「新建任务」页完成首次排样'
    return
  }
  const params = draftParams()
  if (!t.manual || !t.manual.placements.length) {
    preview.value = { kept: 0, moved: 0, dropped: [], checked: true }
    return
  }
  const paper =
    params.paperId === 'custom' && params.customPaper
      ? params.customPaper
      : allPapers.value.find((p) => p.id === params.paperId) ?? allPapers.value[0]
  const plan = planPreservation(t.manual.placements, params, paper)
  preview.value = {
    kept: plan.kept.length,
    moved: plan.kept.filter((k) => k.moved).length,
    dropped: plan.dropped.map((d) => ({
      seq: d.seq,
      label: `#${d.seq} ${itemName(d.itemId)}`,
      reason: d.reason,
    })),
    checked: true,
  }
}

function confirmRepack() {
  const t = task.value
  if (!t) return
  const out = createRevision(t, draftParams())
  preview.value = null
  if (out.error || !out.revision) {
    error.value = out.error ?? '重排失败'
    return
  }
  fillFromTask(t)
  const rev = out.revision
  const parts = [
    `已存为 v${rev.seq}：${rev.summary.sheets} 张相纸 / 利用率 ${formatPercent(rev.summary.avgUtilization)} / ${formatCents(rev.summary.totalCents)} / ${rev.summary.cutSteps} 刀`,
  ]
  if (t.manual && out.keptCount > 0) {
    parts.push(`保住 ${out.keptCount} 个手工位置（${out.movedCount} 个已挪进新安全边）`)
  }
  if (out.dropped.length) {
    parts.push(`${out.dropped.length} 个手工位置保不住，已重新自动排（清单见 v${rev.seq}）`)
  }
  messageKind.value = out.dropped.length ? 'warn' : 'ok'
  message.value = parts.join('；')
}

function cancelPreview() {
  preview.value = null
}

// ---------- 版本对比 ----------
const compareAId = ref('')
const compareBId = ref('')

watch(
  [revisions, currentRev],
  () => {
    const list = revisions.value
    if (!list.length) return
    const cur = currentRev.value ?? list[list.length - 1]
    if (!compareBId.value || !list.some((r) => r.id === compareBId.value)) compareBId.value = cur.id
    if (!compareAId.value || !list.some((r) => r.id === compareAId.value) || compareAId.value === compareBId.value) {
      const idx = list.findIndex((r) => r.id === compareBId.value)
      compareAId.value = (idx > 0 ? list[idx - 1] : list[0]).id
    }
  },
  { immediate: true },
)

const revA = computed(() => revisions.value.find((r) => r.id === compareAId.value))
const revB = computed(() => revisions.value.find((r) => r.id === compareBId.value))

const compareDiffs = computed(() =>
  revA.value && revB.value ? diffParams(revA.value.params, revB.value.params, allPapers.value) : [],
)

function deltaText(a: number, b: number, unit: string, digits = 0): string {
  const d = b - a
  if (Math.abs(d) < Math.pow(10, -digits) / 2) return '持平'
  return `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(digits)}${unit}`
}

const summaryRows = computed(() => {
  const a = revA.value
  const b = revB.value
  if (!a || !b) return []
  return [
    { label: '用纸张数', a: `${a.summary.sheets} 张`, b: `${b.summary.sheets} 张`, delta: deltaText(a.summary.sheets, b.summary.sheets, ' 张') },
    { label: '照片总数', a: `${a.summary.totalPhotos}`, b: `${b.summary.totalPhotos}`, delta: deltaText(a.summary.totalPhotos, b.summary.totalPhotos, ' 张') },
    {
      label: '平均利用率',
      a: formatPercent(a.summary.avgUtilization),
      b: formatPercent(b.summary.avgUtilization),
      delta: deltaText(a.summary.avgUtilization * 100, b.summary.avgUtilization * 100, ' pp', 1),
    },
    {
      label: '总价',
      a: formatCents(a.summary.totalCents),
      b: formatCents(b.summary.totalCents),
      delta:
        a.summary.totalCents === b.summary.totalCents
          ? '持平'
          : `${b.summary.totalCents > a.summary.totalCents ? '+' : '−'}${formatCents(Math.abs(b.summary.totalCents - a.summary.totalCents))}`,
    },
    { label: '刀数（已合并）', a: `${a.summary.cutSteps}`, b: `${b.summary.cutSteps}`, delta: deltaText(a.summary.cutSteps, b.summary.cutSteps, ' 刀') },
    { label: '刀数（未合并）', a: `${a.summary.rawCutSteps}`, b: `${b.summary.rawCutSteps}`, delta: deltaText(a.summary.rawCutSteps, b.summary.rawCutSteps, ' 刀') },
  ]
})

// ---------- 版本历史 ----------
const expandedId = ref('')

function doRollback(rev: Revision) {
  const t = task.value
  if (!t) return
  const cur = currentRev.value
  rollbackRevision(t, rev.id)
  fillFromTask(t)
  preview.value = null
  messageKind.value = 'ok'
  message.value = `已退回到 v${rev.seq}（${rev.note}）：排样结果、裁切步骤、成本与导出稿均按该版重新生成；${
    cur && cur.id !== rev.id ? `v${cur.seq} 仍保留在版本历史里备查` : '其余版本仍保留备查'
  }`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function goto(routeName: string) {
  const t = task.value
  if (t) router.push(`/${routeName}/${t.id}`)
}
</script>

<template>
  <div v-if="!task" class="card">
    <h2>任务不存在</h2>
    <p>可能已被删除，请回到<a href="/">新建任务</a>页重新创建。</p>
  </div>
  <div v-else class="stack">
    <div class="row">
      <h1 style="margin: 0">修订与重排</h1>
      <span class="badge brand">{{ task.name }}</span>
      <span v-if="currentRev" class="badge ok">当前 v{{ currentRev.seq }}</span>
      <span class="badge">{{ revisions.length }} 个版本</span>
      <div class="spacer"></div>
      <button class="btn" @click="goto('layout')">排样预览</button>
      <button class="btn" @click="goto('cut')">裁切步骤</button>
      <button class="btn primary" @click="goto('export')">导出 1:1 →</button>
    </div>

    <div v-if="message" class="note" :class="messageKind">{{ message }}</div>
    <div v-if="error" class="note danger">{{ error }}</div>
    <div v-if="!task.result" class="note warn">
      任务还没有排样结果，请先在<a href="/">新建任务</a>页完成首次排样，之后再回来修订参数。
    </div>

    <div class="grid sidebar">
      <div class="stack">
        <div class="card">
          <h3>改参数并重排</h3>
          <div class="card-sub">
            隙距、刀口补偿、安全边、相纸随时可改；每重排一次存一版，旧版本不会丢
          </div>
          <div class="stack">
            <label class="field">
              相纸
              <select v-model="draft.paperId">
                <option v-for="p in allPapers" :key="p.id" :value="p.id">
                  {{ p.name }} · {{ p.wMm }}×{{ p.hMm }}mm · {{ formatCents(p.priceCents) }}/张
                </option>
                <option value="custom">自定义相纸…</option>
              </select>
            </label>
            <div v-if="draft.paperId === 'custom'" class="grid cols-2">
              <label class="field">
                宽 mm
                <input v-model.number="draft.customPaper.wMm" type="number" min="10" step="0.1" />
              </label>
              <label class="field">
                高 mm
                <input v-model.number="draft.customPaper.hMm" type="number" min="10" step="0.1" />
              </label>
              <label class="field">
                纸边留白 mm
                <input v-model.number="draft.customPaper.marginMm" type="number" min="0" step="0.5" />
              </label>
              <label class="field">
                单价（分）
                <input v-model.number="draft.customPaper.priceCents" type="number" min="0" step="10" />
              </label>
            </div>
            <label class="field">
              相邻照片间距 gapMm：{{ draft.gapMm }} mm
              <input v-model.number="draft.gapMm" type="range" min="0" max="10" step="0.5" />
            </label>
            <label class="field">
              最小裁切余量（刀口补偿）kerfMm：{{ draft.kerfMm }} mm
              <input v-model.number="draft.kerfMm" type="range" min="0" max="3" step="0.1" />
            </label>
            <label class="field">
              四周安全边 safeEdgeMm：{{ draft.safeEdgeMm }} mm
              <input v-model.number="draft.safeEdgeMm" type="range" min="0" max="20" step="0.5" />
            </label>
            <label class="check">
              <input v-model="draft.allowRotate" type="checkbox" />
              允许整体旋转 90°（证件照建议关闭）
            </label>

            <div v-if="paramDiffs.length" class="note">
              本次改动：{{ notePreview }}
            </div>
            <div v-else class="note">参数与当前版本一致，重排将按相同参数再存一版</div>

            <div class="row">
              <button class="btn" :disabled="!task.result" @click="runPreview">预检重排影响</button>
              <button
                v-if="preview"
                class="btn primary"
                @click="confirmRepack"
              >
                确认重排并存为新版本
              </button>
              <button v-if="preview" class="btn" @click="cancelPreview">取消</button>
            </div>

            <div v-if="preview" class="note" :class="preview.dropped.length ? 'warn' : 'ok'">
              <template v-if="task.manual">
                <template v-if="preview.dropped.length">
                  重排后 {{ preview.kept }} 个手工位置保得住（{{ preview.moved }} 个会按新安全边/间隙挪入），
                  以下 {{ preview.dropped.length }} 个保不住，将重新自动排：
                </template>
                <template v-else>
                  全部 {{ preview.kept }} 个手工位置都保得住（{{ preview.moved }} 个会按新安全边/间隙挪入），可放心重排。
                </template>
              </template>
              <template v-else>当前没有手工微调，重排不影响任何手工位置。</template>
            </div>
            <table v-if="preview && preview.dropped.length" class="data">
              <thead>
                <tr>
                  <th class="num">编号</th>
                  <th>照片</th>
                  <th>保不住的原因</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="d in preview.dropped" :key="d.seq">
                  <td class="num">#{{ d.seq }}</td>
                  <td>{{ d.label }}</td>
                  <td>{{ d.reason }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <h3>版本对比</h3>
          <div class="card-sub">新旧两版摆在一起：差在哪几条参数、多/少几张纸、价格差多少</div>
          <div class="row">
            <label class="field" style="max-width: 220px">
              版本 A
              <select v-model="compareAId">
                <option v-for="r in revisions" :key="r.id" :value="r.id">
                  v{{ r.seq }} · {{ r.note }}
                </option>
              </select>
            </label>
            <label class="field" style="max-width: 220px">
              版本 B
              <select v-model="compareBId">
                <option v-for="r in revisions" :key="r.id" :value="r.id">
                  v{{ r.seq }} · {{ r.note }}
                </option>
              </select>
            </label>
          </div>
          <template v-if="revA && revB">
            <h4 style="margin: 12px 0 6px">参数差异</h4>
            <table v-if="compareDiffs.length" class="data">
              <thead>
                <tr>
                  <th>参数</th>
                  <th>v{{ revA.seq }}</th>
                  <th>v{{ revB.seq }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="d in compareDiffs" :key="d.label">
                  <td>{{ d.label }}</td>
                  <td>{{ d.from }}</td>
                  <td>{{ d.to }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="note">两版参数完全一致</div>
            <h4 style="margin: 12px 0 6px">指标差异（B 相对 A）</h4>
            <table class="data">
              <thead>
                <tr>
                  <th>指标</th>
                  <th class="num">v{{ revA.seq }}</th>
                  <th class="num">v{{ revB.seq }}</th>
                  <th class="num">差值</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in summaryRows" :key="row.label">
                  <td>{{ row.label }}</td>
                  <td class="num">{{ row.a }}</td>
                  <td class="num">{{ row.b }}</td>
                  <td class="num">{{ row.delta }}</td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <h3>版本历史</h3>
          <div class="card-sub">
            每改一次参数重排就存一版；退回后排样、成本与导出稿都按退回的那版重新生成，被退回的版本留着备查
          </div>
          <div v-if="!revisions.length" class="note">还没有版本记录</div>
          <table v-else class="data">
            <thead>
              <tr>
                <th>版本</th>
                <th>改动</th>
                <th class="num">张数</th>
                <th class="num">利用率</th>
                <th class="num">总价</th>
                <th class="num">刀数</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="r in revisions" :key="r.id">
                <tr>
                  <td>
                    <span class="badge" :class="r.id === task.currentRevisionId ? 'ok' : ''">
                      v{{ r.seq }}
                    </span>
                    <div class="mono" style="font-size: 11px; color: var(--ink-3)">
                      {{ formatTime(r.createdAt) }}
                    </div>
                  </td>
                  <td>
                    {{ r.note }}
                    <div class="mono" style="font-size: 11px; color: var(--ink-3)">
                      {{ paperLabel(r.params, allPapers) }} ｜ 隙距 {{ r.params.gapMm }} ｜ 刀口
                      {{ r.params.kerfMm }} ｜ 安全边 {{ r.params.safeEdgeMm }}
                    </div>
                    <button
                      v-if="r.droppedManual.length"
                      class="btn small link"
                      @click="expandedId = expandedId === r.id ? '' : r.id"
                    >
                      {{ expandedId === r.id ? '收起' : `${r.droppedManual.length} 个手工位置未保住` }}
                    </button>
                  </td>
                  <td class="num">{{ r.summary.sheets }}</td>
                  <td class="num">{{ formatPercent(r.summary.avgUtilization) }}</td>
                  <td class="num">{{ formatCents(r.summary.totalCents) }}</td>
                  <td class="num">{{ r.summary.cutSteps }}</td>
                  <td>
                    <span v-if="r.id === task.currentRevisionId" class="badge ok">当前</span>
                    <button v-else class="btn small" @click="doRollback(r)">退回此版</button>
                  </td>
                </tr>
                <tr v-if="expandedId === r.id && r.droppedManual.length">
                  <td colspan="7">
                    <div class="note warn" style="margin: 4px 0">
                      v{{ r.seq }} 重排时以下手工位置没保住（已重新自动排）：
                    </div>
                    <table class="data">
                      <thead>
                        <tr>
                          <th class="num">编号</th>
                          <th>照片</th>
                          <th>原因</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="d in r.droppedManual" :key="d.seq">
                          <td class="num">#{{ d.seq }}</td>
                          <td>{{ itemName(d.itemId) }}</td>
                          <td>{{ d.reason }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
