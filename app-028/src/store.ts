/** 全局状态（Vue 自带 ref / computed / watch，不引入任何状态库） */
import { computed, ref, watch } from 'vue'
import {
  BUILTIN_PAPERS,
  BUILTIN_PHOTO_SIZES,
  BUILTIN_TEMPLATES,
  groupsFromTask,
  newId,
  optionsFromTask,
  resolvePaper,
} from './logic/library'
import { pack, sheetsFromPlacements } from './logic/packer'
import {
  applyRevision,
  buildRevision,
  paramsOf,
  resolveRevisionPaper,
  revisionNote,
  snapshotRevision,
  summarizeSheets,
  optionsOfParams,
} from './logic/revision'
import { loadJSON, saveJSON } from './logic/storage'
import type {
  DroppedPlacement,
  Leftover,
  Paper,
  PaperTemplate,
  PhotoRef,
  PhotoSize,
  Placement,
  Revision,
  RevisionParams,
  Settings,
  Sheet,
  Task,
} from './logic/types'

const KEY = {
  customPapers: 'ppis.customPapers.v1',
  customSizes: 'ppis.customSizes.v1',
  settings: 'ppis.settings.v1',
  tasks: 'ppis.tasks.v1',
  leftovers: 'ppis.leftovers.v1',
}

export const DEFAULT_SETTINGS: Settings = {
  gapMm: 0,
  kerfMm: 0.5,
  safeEdgeMm: 3,
  allowRotate: true,
  exportDpi: 300,
}

export const customPapers = ref<Paper[]>(loadJSON<Paper[]>(KEY.customPapers, []))
export const customSizes = ref<PhotoSize[]>(loadJSON<PhotoSize[]>(KEY.customSizes, []))
export const settings = ref<Settings>({ ...DEFAULT_SETTINGS, ...loadJSON(KEY.settings, {}) })
export const tasks = ref<Task[]>(loadJSON<Task[]>(KEY.tasks, []))
export const leftovers = ref<Leftover[]>(loadJSON<Leftover[]>(KEY.leftovers, []))

watch(customPapers, (v) => saveJSON(KEY.customPapers, v), { deep: true })
watch(customSizes, (v) => saveJSON(KEY.customSizes, v), { deep: true })
watch(settings, (v) => saveJSON(KEY.settings, v), { deep: true })
watch(tasks, (v) => saveJSON(KEY.tasks, v), { deep: true })
watch(leftovers, (v) => saveJSON(KEY.leftovers, v), { deep: true })

export const allPapers = computed<Paper[]>(() => [...BUILTIN_PAPERS, ...customPapers.value])
export const allSizes = computed<PhotoSize[]>(() => [...BUILTIN_PHOTO_SIZES, ...customSizes.value])
export const templates = computed<PaperTemplate[]>(() => BUILTIN_TEMPLATES)

/** 照片文件只在本机内存里保留，绝不写入存储、绝不上传 */
const photoCache = new Map<string, { url: string; ref: PhotoRef }>()
/** 内存照片变化计数（Map 本身不是响应式的，用它触发重绘） */
export const photoVersion = ref(0)

export function photoKey(itemId: string, copyIndex: number): string {
  return `${itemId}#${copyIndex}`
}

export function setItemPhoto(key: string, url: string, ref: PhotoRef): void {
  const old = photoCache.get(key)
  if (old) URL.revokeObjectURL(old.url)
  photoCache.set(key, { url, ref })
  photoVersion.value++
}

export function getItemPhoto(key: string): { url: string; ref: PhotoRef } | undefined {
  return photoCache.get(key)
}

export function clearItemPhoto(key: string): void {
  const old = photoCache.get(key)
  if (old) URL.revokeObjectURL(old.url)
  photoCache.delete(key)
  photoVersion.value++
}

/** 每张照片（placement）对应第几张底片 */
export function copyIndexMap(sheets: Sheet[]): Map<number, number> {
  const counter = new Map<string, number>()
  const out = new Map<number, number>()
  for (const s of sheets) {
    for (const p of s.placements) {
      const n = counter.get(p.itemId) ?? 0
      out.set(p.seq, n)
      counter.set(p.itemId, n + 1)
    }
  }
  return out
}

/** placement -> 本机照片（key + objectURL），未导入照片时返回 undefined */
export function makePhotoResolver(task: Task, sheets: Sheet[]) {
  const map = copyIndexMap(sheets)
  const repeat = new Map(task.items.map((i) => [i.id, i.repeatSamePhoto]))
  return (p: Placement): { key: string; url: string } | undefined => {
    const ci = repeat.get(p.itemId) === false ? map.get(p.seq) ?? 0 : 0
    const k = photoKey(p.itemId, ci)
    const ph = getItemPhoto(k)
    return ph ? { key: k, url: ph.url } : undefined
  }
}

/** 生成「placement -> 本机缩略图 URL」的解析函数 */
export function makeThumbResolver(task: Task, sheets: Sheet[]) {
  const resolve = makePhotoResolver(task, sheets)
  return (p: Placement): string | undefined => resolve(p)?.url
}

export function getTask(id: string): Task | undefined {
  return tasks.value.find((t) => t.id === id)
}

export function createTask(partial: Partial<Task> = {}): Task {
  const task: Task = {
    id: newId('task'),
    name: partial.name ?? `拼版任务 ${tasks.value.length + 1}`,
    paperId: partial.paperId ?? 'p5x7',
    customPaper: partial.customPaper,
    items: partial.items ?? [],
    gapMm: partial.gapMm ?? settings.value.gapMm,
    kerfMm: partial.kerfMm ?? settings.value.kerfMm,
    safeEdgeMm: partial.safeEdgeMm ?? settings.value.safeEdgeMm,
    allowRotate: partial.allowRotate ?? settings.value.allowRotate,
    headerText: partial.headerText ?? '',
    footerText: partial.footerText ?? '',
    createdAt: Date.now(),
  }
  tasks.value.unshift(task)
  return task
}

export function deleteTask(id: string): void {
  tasks.value = tasks.value.filter((t) => t.id !== id)
}

export function touch(): void {
  tasks.value = tasks.value.slice()
}

/** 执行排样；返回错误提示（无错误时返回 undefined） */
export function runPack(task: Task): string | undefined {
  const paper = resolvePaper(task, allPapers.value)
  const groups = groupsFromTask(task, allSizes.value)
  if (!groups.length) {
    task.result = undefined
    return '照片清单为空，请先添加照片尺寸与数量'
  }
  const out = pack(groups, optionsFromTask(task, paper))
  if (out.error) {
    task.result = undefined
    return out.error
  }
  task.result = out.result
  task.manual = undefined
  ensureRevisions(task)
  touch()
  return undefined
}

/** 旧任务没有版本记录时，用当前状态补一版 v1（初始排样） */
export function ensureRevisions(task: Task): Revision[] {
  if (!task.revisions) task.revisions = []
  if (!task.revisions.length && task.result) {
    const v1 = snapshotRevision(task, allPapers.value, 1, '初始排样')
    if (v1) {
      task.revisions.push(v1)
      task.currentRevisionId = v1.id
    }
  }
  return task.revisions
}

export function currentRevisionOf(task: Task): Revision | undefined {
  return task.revisions?.find((r) => r.id === task.currentRevisionId)
}

/** 手工微调 / 恢复自动排样后，把当前版本的快照同步成最新状态 */
function syncCurrentRevision(task: Task): void {
  const rev = currentRevisionOf(task)
  if (!rev || !task.result) return
  const paper = resolveRevisionPaper(rev.params, allPapers.value)
  const opts = optionsOfParams(rev.params, paper)
  const effective = task.manual
    ? sheetsFromPlacements(task.manual.placements, opts, manualSheetCount(task)).sheets
    : task.result.sheets
  rev.manual = task.manual
    ? { ...task.manual, placements: task.manual.placements.map((p) => ({ ...p })) }
    : undefined
  rev.summary = summarizeSheets(effective, paper.priceCents)
}

export interface CreateRevisionOutput {
  error?: string
  revision?: Revision
  dropped: DroppedPlacement[]
  keptCount: number
  movedCount: number
}

/**
 * 修订与重排：用新参数重排一遍并存为新版本。
 * 旧的手工位置能按新安全边/间隙保住的保住，保不住的记录在版本里备查。
 */
export function createRevision(task: Task, params: RevisionParams): CreateRevisionOutput {
  ensureRevisions(task)
  const built = buildRevision(task, params, allSizes.value, allPapers.value)
  if (built.error || !built.result) {
    return { error: built.error ?? '重排失败', dropped: [], keptCount: 0, movedCount: 0 }
  }
  const paper = resolveRevisionPaper(params, allPapers.value)
  const effective = built.manual
    ? sheetsFromPlacements(
        built.manual.placements,
        optionsOfParams(params, paper),
        Math.max(
          1,
          built.manual.placements.reduce((acc, p) => Math.max(acc, p.sheetIndex + 1), 0),
        ),
      ).sheets
    : built.result.sheets
  const rev: Revision = {
    id: newId('rev'),
    seq: (task.revisions?.length ?? 0) + 1,
    createdAt: Date.now(),
    note: revisionNote(paramsOf(task), params, allPapers.value),
    params: { ...params, customPaper: params.customPaper ? { ...params.customPaper } : undefined },
    summary: summarizeSheets(effective, paper.priceCents),
    result: built.result,
    manual: built.manual,
    droppedManual: built.dropped,
  }
  task.revisions = [...(task.revisions ?? []), rev]
  task.currentRevisionId = rev.id
  applyRevision(task, rev)
  touch()
  return { revision: rev, dropped: built.dropped, keptCount: built.keptCount, movedCount: built.movedCount }
}

/** 退回到指定版本：排样结果、成本与导出稿都按该版重新生成；被退回的版本保留备查 */
export function rollbackRevision(task: Task, revisionId: string): Revision | undefined {
  const rev = task.revisions?.find((r) => r.id === revisionId)
  if (!rev) return undefined
  applyRevision(task, rev)
  task.currentRevisionId = rev.id
  touch()
  return rev
}

/** 手工版面实际占用的纸张数（可能多于自动排样结果：重排保留 + 剩余重排的混合版面） */
function manualSheetCount(task: Task): number {
  const base = Math.max(1, task.result?.sheets.length ?? 1)
  if (!task.manual) return base
  const maxIdx = task.manual.placements.reduce((acc, p) => Math.max(acc, p.sheetIndex + 1), 0)
  return Math.max(base, maxIdx)
}

/** 当前生效的相纸版面：手工微调优先于自动排样 */
export function sheetsOf(task: Task): Sheet[] {
  if (task.manual) {
    const paper = resolvePaper(task, allPapers.value)
    return sheetsFromPlacements(task.manual.placements, optionsFromTask(task, paper), manualSheetCount(task)).sheets
  }
  return task.result?.sheets ?? []
}

export function manualPlacementsOf(task: Task): Placement[] {
  if (task.manual) return task.manual.placements
  return (task.result?.sheets ?? []).flatMap((s) => s.placements)
}

/** 写入手工微调结果并做增量校验（不重新排样） */
export function setManual(task: Task, placements: Placement[]): void {
  const paper = resolvePaper(task, allPapers.value)
  const count = Math.max(
    manualSheetCount(task),
    placements.reduce((acc, p) => Math.max(acc, p.sheetIndex + 1), 0),
  )
  const t0 = performance.now()
  const { sheets, errors } = sheetsFromPlacements(placements, optionsFromTask(task, paper), count)
  const ms = performance.now() - t0
  const stepCount = sheets.reduce((acc, s) => acc + s.cutSteps.length, 0)
  task.manual = {
    placements,
    valid: errors.length === 0,
    message: errors.length
      ? errors[0]
      : `guillotine 校验通过：${stepCount} 刀全部贯通，用时 ${ms.toFixed(1)}ms`,
    validationMs: Math.round(ms * 100) / 100,
    stepCount,
  }
  syncCurrentRevision(task)
  touch()
}

export function resetManual(task: Task): void {
  task.manual = undefined
  syncCurrentRevision(task)
  touch()
}

export function addCustomPaper(p: Omit<Paper, 'id'>): Paper {
  const paper: Paper = { ...p, id: newId('paper') }
  customPapers.value = [...customPapers.value, paper]
  return paper
}

export function addCustomSize(s: Omit<PhotoSize, 'id'>): PhotoSize {
  const size: PhotoSize = { ...s, id: newId('size') }
  customSizes.value = [...customSizes.value, size]
  return size
}

export function removeCustomPaper(id: string): void {
  customPapers.value = customPapers.value.filter((p) => p.id !== id)
}

export function removeCustomSize(id: string): void {
  customSizes.value = customSizes.value.filter((s) => s.id !== id)
}

export function addLeftover(l: Omit<Leftover, 'id' | 'createdAt' | 'usedCount'>): Leftover {
  const item: Leftover = {
    ...l,
    id: newId('leftover'),
    createdAt: Date.now(),
    usedCount: 0,
  }
  leftovers.value = [item, ...leftovers.value]
  return item
}

export function removeLeftover(id: string): void {
  leftovers.value = leftovers.value.filter((l) => l.id !== id)
}

export function markLeftoverUsed(id: string): void {
  leftovers.value = leftovers.value.map((l) =>
    l.id === id ? { ...l, usedCount: l.usedCount + 1 } : l,
  )
}
