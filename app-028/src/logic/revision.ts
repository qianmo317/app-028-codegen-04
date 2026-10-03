/**
 * 修订与重排：任务建好后随时改 隙距 / 刀口补偿 / 安全边 / 相纸 并重排。
 * 每改一次存一版（参数 + 张数 + 利用率 + 总价 + 刀数），两版可对比，可退回。
 * 改参数会让人工摆过的位置失效：能按新安全边与间隙挪进去的保住，保不住的列出清单。
 */
import { planSheetCuts, EPS } from './guillotine'
import { groupsFromTask, newId } from './library'
import { pack, sheetsFromPlacements, usableRegion, type PackGroup, type PackOptions } from './packer'
import { round } from './units'
import type {
  DroppedPlacement,
  ManualState,
  PackResult,
  Paper,
  PhotoSize,
  Placement,
  Revision,
  RevisionParams,
  RevisionSummary,
  Sheet,
  Task,
} from './types'

/** 任务当前生效的裁切参数快照 */
export function paramsOf(task: Task): RevisionParams {
  return {
    paperId: task.paperId,
    customPaper: task.customPaper ? { ...task.customPaper } : undefined,
    gapMm: task.gapMm,
    kerfMm: task.kerfMm,
    safeEdgeMm: task.safeEdgeMm,
    allowRotate: task.allowRotate,
  }
}

/** 按版本参数解析相纸 */
export function resolveRevisionPaper(params: RevisionParams, all: Paper[]): Paper {
  if (params.paperId === 'custom' && params.customPaper) return params.customPaper
  return all.find((p) => p.id === params.paperId) ?? all[0]
}

export function optionsOfParams(params: RevisionParams, paper: Paper): PackOptions {
  return {
    paperW: paper.wMm,
    paperH: paper.hMm,
    marginMm: paper.marginMm,
    safeEdgeMm: params.safeEdgeMm,
    gapMm: params.gapMm,
    kerfMm: params.kerfMm,
    allowRotate: params.allowRotate,
  }
}

/** 由实际生效的版面算出该版本的关键指标 */
export function summarizeSheets(sheets: Sheet[], priceCents: number): RevisionSummary {
  const totalPhotos = sheets.reduce((acc, s) => acc + s.placements.length, 0)
  const totalUsed = sheets.reduce((acc, s) => acc + s.usedAreaMm2, 0)
  const totalArea = sheets.reduce((acc, s) => acc + s.sheetAreaMm2, 0)
  return {
    sheets: sheets.length,
    totalPhotos,
    avgUtilization: totalArea > 0 ? totalUsed / totalArea : 0,
    totalCents: sheets.length * priceCents,
    cutSteps: sheets.reduce((acc, s) => acc + s.cutSteps.length, 0),
    rawCutSteps: sheets.reduce((acc, s) => acc + s.rawCutCount, 0),
  }
}

export function paperLabel(params: RevisionParams, all: Paper[]): string {
  const p = resolveRevisionPaper(params, all)
  return `${p.name} ${p.wMm}×${p.hMm}mm`
}

export interface ParamDiff {
  label: string
  from: string
  to: string
}

/** 两版参数逐项对比，只返回有变化的项 */
export function diffParams(a: RevisionParams, b: RevisionParams, all: Paper[]): ParamDiff[] {
  const out: ParamDiff[] = []
  const pa = resolveRevisionPaper(a, all)
  const pb = resolveRevisionPaper(b, all)
  if (
    a.paperId !== b.paperId ||
    pa.wMm !== pb.wMm ||
    pa.hMm !== pb.hMm ||
    pa.marginMm !== pb.marginMm ||
    pa.priceCents !== pb.priceCents
  ) {
    out.push({
      label: '相纸',
      from: `${pa.name} ${pa.wMm}×${pa.hMm}mm`,
      to: `${pb.name} ${pb.wMm}×${pb.hMm}mm`,
    })
  }
  if (a.gapMm !== b.gapMm) out.push({ label: '隙距', from: `${a.gapMm}mm`, to: `${b.gapMm}mm` })
  if (a.kerfMm !== b.kerfMm)
    out.push({ label: '刀口补偿', from: `${a.kerfMm}mm`, to: `${b.kerfMm}mm` })
  if (a.safeEdgeMm !== b.safeEdgeMm)
    out.push({ label: '安全边', from: `${a.safeEdgeMm}mm`, to: `${b.safeEdgeMm}mm` })
  if (a.allowRotate !== b.allowRotate)
    out.push({
      label: '整体旋转',
      from: a.allowRotate ? '允许' : '禁止',
      to: b.allowRotate ? '允许' : '禁止',
    })
  return out
}

/** 自动生成版本说明，如「隙距 0mm→2mm；安全边 3mm→5mm」 */
export function revisionNote(from: RevisionParams, to: RevisionParams, all: Paper[]): string {
  const diffs = diffParams(from, to, all)
  if (!diffs.length) return '参数未变，按当前参数重新排样'
  return diffs.map((d) => `${d.label} ${d.from}→${d.to}`).join('；')
}

export interface KeptPlacement {
  placement: Placement
  /** 为落进新的安全边被挪动过 */
  moved: boolean
}

export interface PreservationPlan {
  kept: KeptPlacement[]
  dropped: DroppedPlacement[]
}

/**
 * 预检：旧的手工位置在新参数（安全边 / 间隙 / 刀口补偿 / 相纸）下哪些保得住。
 * 能挪进新安全边且不与邻居冲突的保住；保不住的进 dropped 清单（附原因）。
 */
export function planPreservation(
  placements: Placement[],
  params: RevisionParams,
  paper: Paper,
): PreservationPlan {
  const kept: KeptPlacement[] = []
  const dropped: DroppedPlacement[] = []
  const opts = optionsOfParams(params, paper)
  const region = usableRegion(opts)
  if (!region) {
    for (const p of placements) {
      dropped.push({ seq: p.seq, itemId: p.itemId, reason: '纸边留白 + 新安全边已超过相纸尺寸' })
    }
    return { kept, dropped }
  }
  const m = (params.kerfMm + params.gapMm) / 2
  const ordered = placements
    .slice()
    .sort((a, b) => a.sheetIndex - b.sheetIndex || a.seq - b.seq)
  // 切块（照片 + 刀口/隙距补偿）必须落在可用区内，guillotine 拆解才成立
  const lo = { x: region.x + m, y: region.y + m }
  for (const p of ordered) {
    if (p.w + 2 * m > region.w + EPS || p.h + 2 * m > region.h + EPS) {
      dropped.push({
        seq: p.seq,
        itemId: p.itemId,
        reason: `照片 ${round(p.w, 1)}×${round(p.h, 1)}mm 加刀口补偿后放不进新可用区 ${round(region.w, 1)}×${round(region.h, 1)}mm`,
      })
      continue
    }
    const maxX = region.x + region.w - m - p.w
    const maxY = region.y + region.h - m - p.h
    const nx = round(Math.min(Math.max(lo.x, p.x), maxX), 3)
    const ny = round(Math.min(Math.max(lo.y, p.y), maxY), 3)
    const moved = Math.abs(nx - p.x) > 0.01 || Math.abs(ny - p.y) > 0.01
    // 按新的 间隙+刀口补偿 与已保住的照片做冲突检查
    const slot = { x: nx - m, y: ny - m, w: p.w + 2 * m, h: p.h + 2 * m }
    const clash = kept.find((k) => {
      const q = k.placement
      if (q.sheetIndex !== p.sheetIndex) return false
      const qs = { x: q.x - m, y: q.y - m, w: q.w + 2 * m, h: q.h + 2 * m }
      return (
        slot.x < qs.x + qs.w - EPS &&
        qs.x < slot.x + slot.w - EPS &&
        slot.y < qs.y + qs.h - EPS &&
        qs.y < slot.y + slot.h - EPS
      )
    })
    if (clash) {
      dropped.push({
        seq: p.seq,
        itemId: p.itemId,
        reason: `按新间隙/刀口补偿挪入后与 #${clash.placement.seq} 冲突`,
      })
      continue
    }
    kept.push({ placement: { ...p, x: nx, y: ny }, moved })
  }
  // 每张纸单独过一遍 guillotine 贯通校验；整纸过不了则该纸的手工位置全部放弃
  const bySheet = new Map<number, KeptPlacement[]>()
  for (const k of kept) {
    const list = bySheet.get(k.placement.sheetIndex) ?? []
    list.push(k)
    bySheet.set(k.placement.sheetIndex, list)
  }
  const finalKept: KeptPlacement[] = []
  for (const [sheetIndex, list] of bySheet) {
    const slots = list.map((k) => ({
      x: k.placement.x - m,
      y: k.placement.y - m,
      w: k.placement.w + 2 * m,
      h: k.placement.h + 2 * m,
    }))
    const plan = planSheetCuts(region, slots)
    if (plan.validation.ok) {
      finalKept.push(...list)
    } else {
      for (const k of list) {
        dropped.push({
          seq: k.placement.seq,
          itemId: k.placement.itemId,
          reason: `新参数下第 ${sheetIndex + 1} 张纸的切割线无法贯通（${plan.validation.reason}）`,
        })
      }
    }
  }
  dropped.sort((a, b) => a.seq - b.seq)
  return { kept: finalKept, dropped }
}

export interface BuildRevisionOutput {
  error?: string
  result?: PackResult
  manual?: ManualState
  dropped: DroppedPlacement[]
  /** 保住但被挪动的手工位置数量 */
  movedCount: number
  /** 保住的手工位置数量 */
  keptCount: number
}

/**
 * 用新参数重排一版：
 * - 自动排样始终全量重跑（作为该版本的兜底结果）；
 * - 旧的手工位置能保的保（必要时挪进新安全边），保不住的集中重新自动排，
 *   两部分合成该版本生效的手工版面。
 */
export function buildRevision(
  task: Task,
  params: RevisionParams,
  sizes: PhotoSize[],
  all: Paper[],
): BuildRevisionOutput {
  const paper = resolveRevisionPaper(params, all)
  const opts = optionsOfParams(params, paper)
  const groups = groupsFromTask(task, sizes)
  if (!groups.length) return { error: '照片清单为空，请先添加照片尺寸与数量', dropped: [], movedCount: 0, keptCount: 0 }
  const out = pack(groups, opts)
  if (out.error) return { error: out.error, dropped: [], movedCount: 0, keptCount: 0 }

  const oldManual = task.manual
  if (!oldManual || !oldManual.placements.length) {
    return { result: out.result, dropped: [], movedCount: 0, keptCount: 0 }
  }

  const plan = planPreservation(oldManual.placements, params, paper)
  if (!plan.kept.length) {
    return { result: out.result, dropped: plan.dropped, movedCount: 0, keptCount: 0 }
  }

  // 保住的照片沿用原编号与原纸张顺序（纸张编号重映射为连续的 0..k-1）
  const sheetIds = Array.from(new Set(plan.kept.map((k) => k.placement.sheetIndex))).sort(
    (a, b) => a - b,
  )
  const remap = new Map(sheetIds.map((s, i) => [s, i]))
  const keptPlacements: Placement[] = plan.kept.map((k) => ({
    ...k.placement,
    sheetIndex: remap.get(k.placement.sheetIndex) ?? 0,
  }))
  let seq = keptPlacements.reduce((acc, p) => Math.max(acc, p.seq), 0)

  // 保不住的照片集中重新自动排，接在保住的纸后面
  let extraSheets: Sheet[] = []
  if (plan.dropped.length) {
    const countByItem = new Map<string, number>()
    for (const d of plan.dropped) countByItem.set(d.itemId, (countByItem.get(d.itemId) ?? 0) + 1)
    const regroups: PackGroup[] = []
    for (const item of task.items) {
      const copies = countByItem.get(item.id) ?? 0
      if (copies <= 0) continue
      const s = sizes.find((x) => x.id === item.sizeId)
      if (!s) continue
      regroups.push({
        itemId: item.id,
        copies,
        photoW: s.wMm,
        photoH: s.hMm,
        allowRotate: item.rotateAllowed,
        keepTogether: item.keepTogether,
      })
    }
    if (regroups.length) {
      const re = pack(regroups, opts)
      if (!re.error) {
        extraSheets = re.result.sheets
        const offset = sheetIds.length
        for (const s of re.result.sheets) {
          for (const p of s.placements) {
            seq += 1
            keptPlacements.push({ ...p, sheetIndex: s.index + offset, seq })
          }
        }
      } else {
        // 兜底：剩余照片排不进去时整版退回全自动结果
        return { result: out.result, dropped: plan.dropped, movedCount: 0, keptCount: 0 }
      }
    }
  }

  const sheetCount = sheetIds.length + extraSheets.length
  const t0 = performance.now()
  const { sheets, errors } = sheetsFromPlacements(keptPlacements, opts, sheetCount)
  const ms = performance.now() - t0
  if (errors.length) {
    // 理论上不会发生（保住的部分已逐纸校验过），兜底退回全自动结果
    return { result: out.result, dropped: plan.dropped, movedCount: 0, keptCount: 0 }
  }
  const movedCount = plan.kept.filter((k) => k.moved).length
  const stepCount = sheets.reduce((acc, s) => acc + s.cutSteps.length, 0)
  const manual: ManualState = {
    placements: sheets.flatMap((s) => s.placements),
    valid: true,
    message: plan.dropped.length
      ? `重排保留 ${plan.kept.length} 个手工位置（${movedCount} 个已挪进新安全边），${plan.dropped.length} 个保不住已重新自动排`
      : movedCount
        ? `重排保留全部 ${plan.kept.length} 个手工位置，其中 ${movedCount} 个已按新安全边挪入`
        : `重排保留全部 ${plan.kept.length} 个手工位置`,
    validationMs: Math.round(ms * 100) / 100,
    stepCount,
  }
  return { result: out.result, manual, dropped: plan.dropped, movedCount, keptCount: plan.kept.length }
}

/** 由任务当前顶层状态定格一个版本（v1 初始版 / 迁移旧任务用） */
export function snapshotRevision(task: Task, all: Paper[], seq: number, note: string): Revision | undefined {
  if (!task.result) return undefined
  const params = paramsOf(task)
  const paper = resolveRevisionPaper(params, all)
  const opts = optionsOfParams(params, paper)
  const manualCount = task.manual
    ? task.manual.placements.reduce((acc, p) => Math.max(acc, p.sheetIndex + 1), 0)
    : 0
  const effective = task.manual
    ? sheetsFromPlacements(
        task.manual.placements,
        opts,
        Math.max(1, task.result.sheets.length, manualCount),
      ).sheets
    : task.result.sheets
  return {
    id: newId('rev'),
    seq,
    createdAt: Date.now(),
    note,
    params,
    summary: summarizeSheets(effective, paper.priceCents),
    result: task.result,
    manual: task.manual ? { ...task.manual, placements: task.manual.placements.map((p) => ({ ...p })) } : undefined,
    droppedManual: [],
  }
}

/** 把某个版本应用回任务顶层字段（退回 / 切换到该版） */
export function applyRevision(task: Task, rev: Revision): void {
  task.paperId = rev.params.paperId
  task.customPaper = rev.params.customPaper ? { ...rev.params.customPaper } : undefined
  task.gapMm = rev.params.gapMm
  task.kerfMm = rev.params.kerfMm
  task.safeEdgeMm = rev.params.safeEdgeMm
  task.allowRotate = rev.params.allowRotate
  task.result = rev.result
  task.manual = rev.manual
    ? { ...rev.manual, placements: rev.manual.placements.map((p) => ({ ...p })) }
    : undefined
}
