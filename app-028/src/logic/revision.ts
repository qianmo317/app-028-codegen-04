/** 修订版本：参数快照、排样快照、手工位置保留与版本对比 */
import { computeCost } from './cost'
import { groupsFromTask, optionsFromTask } from './library'
import { pack, sheetsFromPlacements } from './packer'
import { round } from './units'
import type {
  ManualLayout,
  Paper,
  PhotoSize,
  Placement,
  RevisionMetrics,
  RevisionParams,
  Task,
  TaskRevision,
} from './types'

export interface PreservedPlacement extends Placement {
  oldSeq: number
}

export interface RevisionPreview {
  result: NonNullable<TaskRevision['result']>
  preserved: PreservedPlacement[]
  lostSeqs: number[]
  manual?: ManualLayout
}

export interface RevisionParamChange {
  key: keyof RevisionParams | 'paper'
  label: string
  oldText: string
  newText: string
}

const r3 = (n: number) => round(n, 3)

export function revisionParams(task: Task): RevisionParams {
  return {
    paperId: task.paperId,
    customPaper: task.customPaper ? { ...task.customPaper } : undefined,
    gapMm: task.gapMm,
    kerfMm: task.kerfMm,
    safeEdgeMm: task.safeEdgeMm,
  }
}

export function revisionPaper(params: RevisionParams, allPapers: Paper[]): Paper {
  if (params.paperId === 'custom' && params.customPaper) return params.customPaper
  return allPapers.find((p) => p.id === params.paperId) ?? allPapers[0]
}

export function metricsFromResult(
  paper: Paper,
  result: TaskRevision['result'],
  elapsedMs = result.stats.elapsedMs,
): RevisionMetrics {
  const cost = computeCost(paper, result)
  return {
    paperName: paper.name,
    sheets: result.stats.sheets,
    totalPhotos: result.stats.totalPhotos,
    avgUtilization: result.stats.avgUtilization,
    totalCents: cost.totalCents,
    cutCount: result.sheets.reduce((acc, s) => acc + s.cutSteps.length, 0),
    rawCutCount: result.sheets.reduce((acc, s) => acc + s.rawCutCount, 0),
    elapsedMs,
  }
}

export function buildManual(
  task: Task,
  paper: Paper,
  placements: Placement[],
  sheetCount: number,
): ManualLayout {
  const t0 = performance.now()
  const { sheets, errors } = sheetsFromPlacements(
    placements,
    optionsFromTask(task, paper),
    sheetCount,
  )
  const ms = performance.now() - t0
  const stepCount = sheets.reduce((acc, s) => acc + s.cutSteps.length, 0)
  return {
    placements,
    valid: errors.length === 0,
    message: errors.length
      ? errors[0]
      : `guillotine 校验通过：${stepCount} 刀全部贯通，用时 ${ms.toFixed(1)}ms`,
    validationMs: round(ms, 2),
    stepCount,
  }
}

function paperText(paper: Paper): string {
  return `${paper.name} ${paper.wMm}×${paper.hMm}mm`
}

export function diffParams(
  oldParams: RevisionParams,
  newParams: RevisionParams,
  oldPaper: Paper,
  newPaper: Paper,
): RevisionParamChange[] {
  const out: RevisionParamChange[] = []
  if (
    oldParams.paperId !== newParams.paperId ||
    oldPaper.wMm !== newPaper.wMm ||
    oldPaper.hMm !== newPaper.hMm ||
    oldPaper.marginMm !== newPaper.marginMm ||
    oldPaper.priceCents !== newPaper.priceCents ||
    oldPaper.name !== newPaper.name
  ) {
    out.push({
      key: 'paper',
      label: '相纸',
      oldText: paperText(oldPaper),
      newText: paperText(newPaper),
    })
  }
  const numeric: Array<['gapMm' | 'kerfMm' | 'safeEdgeMm', string]> = [
    ['gapMm', '隙距'],
    ['kerfMm', '刀口补偿'],
    ['safeEdgeMm', '安全边'],
  ]
  for (const [key, label] of numeric) {
    if (oldParams[key] !== newParams[key]) {
      out.push({
        key,
        label,
        oldText: `${oldParams[key]}mm`,
        newText: `${newParams[key]}mm`,
      })
    }
  }
  return out
}

function clampShiftPlacements(placements: Placement[], paper: Paper, params: RevisionParams) {
  const inset = paper.marginMm + params.safeEdgeMm
  const minX = inset
  const minY = inset
  const maxX = paper.wMm - inset
  const maxY = paper.hMm - inset
  const m = (params.kerfMm + params.gapMm) / 2

  const shifted: PreservedPlacement[] = placements
    .filter((p) => p.w + 2 * m <= maxX - minX + 1e-6 && p.h + 2 * m <= maxY - minY + 1e-6)
    .map((p) => {
      const rawX = Math.max(p.x, minX)
      const rawY = Math.max(p.y, minY)
      const x = Math.max(minX + m, Math.min(rawX, Math.max(minX + m, maxX - m - p.w)))
      const y = Math.max(minY + m, Math.min(rawY, Math.max(minY + m, maxY - m - p.h)))
      return { ...p, x: r3(x), y: r3(y), oldSeq: p.seq }
    })

  // 新增间隙时，把重叠的手工切块沿最短方向推开；边界内无解则保留重叠，后续校验会丢弃。
  for (let iter = 0; iter < 160; iter++) {
    let changed = false
    for (let j = 1; j < shifted.length; j++) {
      const b = shifted[j]
      const bx1 = b.x - m
      const by1 = b.y - m
      const bx2 = b.x + b.w + m
      const by2 = b.y + b.h + m
      const moves: Array<{ x: number; y: number; d: number }> = []
      let blocked = false
      for (let s = 0; s < j; s++) {
        if (shifted[s].sheetIndex !== b.sheetIndex) continue
        const a = shifted[s]
        const ax1 = a.x - m
        const ay1 = a.y - m
        const ax2 = a.x + a.w + m
        const ay2 = a.y + a.h + m
        const ox = Math.min(ax2 - bx1, bx2 - ax1)
        const oy = Math.min(ay2 - by1, by2 - ay1)
        if (ox <= 1e-6 || oy <= 1e-6) continue
        blocked = true
        moves.push(
          { x: ax1 - b.w - m, y: b.y, d: Math.abs(ax1 - b.w - m - b.x) },
          { x: ax2 + m, y: b.y, d: Math.abs(ax2 + m - b.x) },
          { x: b.x, y: ay1 - b.h - m, d: Math.abs(ay1 - b.h - m - b.y) },
          { x: b.x, y: ay2 + m, d: Math.abs(ay2 + m - b.y) },
        )
      }
      if (!blocked) continue
      const fit = moves
        .filter(
          (mv) =>
            mv.x >= minX + m - 1e-6 &&
            mv.y >= minY + m - 1e-6 &&
            mv.x + b.w + m <= maxX + 1e-6 &&
            mv.y + b.h + m <= maxY + 1e-6,
        )
        .sort((a, b) => a.d - b.d)[0]
      if (fit) {
        shifted[j] = { ...shifted[j], x: r3(fit.x), y: r3(fit.y) }
        changed = true
      }
    }
    if (!changed) break
  }
  return shifted
}

function packedWithAnchors(
  task: Task,
  paper: Paper,
  params: RevisionParams,
  sizes: PhotoSize[],
  anchors: PreservedPlacement[],
) {
  const probeTask: Task = {
    ...task,
    paperId: params.paperId,
    customPaper: params.customPaper ? { ...params.customPaper } : undefined,
    gapMm: params.gapMm,
    kerfMm: params.kerfMm,
    safeEdgeMm: params.safeEdgeMm,
  }
  return pack(groupsFromTask(probeTask, sizes), optionsFromTask(probeTask, paper), anchors)
}

/** 用新参数试排，并尽量把原手工位置按新安全边/间隙平移保留 */
export function previewRevision(
  task: Task,
  params: RevisionParams,
  allPapers: Paper[],
  sizes: PhotoSize[],
): { ok: true; preview: RevisionPreview } | { ok: false; error: string } {
  const paper = revisionPaper(params, allPapers)
  const oldManual = task.manual?.valid ? task.manual : undefined
  const oldPlacements = oldManual?.placements ?? task.result?.sheets.flatMap((s) => s.placements)
  const candidates = oldManual && oldPlacements
    ? clampShiftPlacements(oldPlacements, paper, params)
    : []

  const orders = [
    candidates,
    [...candidates].sort((a, b) => a.x - b.x || a.y - b.y),
    [...candidates].sort((a, b) => a.y - b.y || a.x - b.x),
    [...candidates].sort((a, b) => b.w * b.h - a.w * a.h),
  ]

  type Best = {
    result: NonNullable<TaskRevision['result']>
    map: Map<number, number>
  }
  let best: Best | undefined

  for (const anchors of orders) {
    const out = packedWithAnchors(task, paper, params, sizes, anchors)
    if (!out.error && out.preservedSeqByNewSeq) {
      if (!best || out.preservedSeqByNewSeq.size > best.map.size) {
        best = { result: out.result, map: out.preservedSeqByNewSeq }
      }
      if (out.preservedSeqByNewSeq.size === candidates.length) break
    }
  }

  // 全部候选无法一次保留时，贪心逐个加入；每一步都让排样器重新开洞并保持 guillotine。
  let greedy: Best | undefined
  if (candidates.length && (!best || best.map.size < candidates.length)) {
    const accepted: PreservedPlacement[] = []
    for (const candidate of candidates) {
      const next = [...accepted, candidate]
      const out = packedWithAnchors(task, paper, params, sizes, next)
      if (
        !out.error &&
        out.preservedSeqByNewSeq &&
        [...out.preservedSeqByNewSeq.values()].includes(candidate.oldSeq)
      ) {
        accepted.length = 0
        accepted.push(...next)
        greedy = { result: out.result, map: out.preservedSeqByNewSeq }
      }
    }
  }
  if (greedy && (!best || greedy.map.size > best.map.size)) best = greedy

  const auto = packedWithAnchors(task, paper, params, sizes, [])
  if (auto.error) return { ok: false, error: auto.error }
  const result = best?.result ?? auto.result

  const oldSeqs = new Set(candidates.map((p) => p.oldSeq))
  const retainedOld = new Set(best ? [...best.map.values()] : [])
  const lostSeqs = [...oldSeqs].filter((seq) => !retainedOld.has(seq)).sort((a, b) => a - b)
  const preserved: PreservedPlacement[] = []
  for (const sheet of result.sheets) {
    for (const p of sheet.placements) {
      const oldSeq = best?.map.get(p.seq)
      if (oldSeq !== undefined) preserved.push({ ...p, oldSeq })
    }
  }

  let manual: ManualLayout | undefined
  if (oldManual && (preserved.length || lostSeqs.length)) {
    const probeTask: Task = {
      ...task,
      paperId: params.paperId,
      customPaper: params.customPaper ? { ...params.customPaper } : undefined,
      gapMm: params.gapMm,
      kerfMm: params.kerfMm,
      safeEdgeMm: params.safeEdgeMm,
    }
    const placements = result.sheets.flatMap((s) => s.placements)
    manual = buildManual(probeTask, paper, placements, result.stats.sheets)
  }
  return { ok: true, preview: { result, preserved, lostSeqs, manual } }
}
