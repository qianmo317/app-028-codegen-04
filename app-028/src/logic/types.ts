/** 数据模型（对应规格书 §7） */

export type PaperKind = 'sheet' | 'roll'

export interface Paper {
  id: string
  name: string
  wMm: number
  hMm: number
  marginMm: number
  priceCents: number
  kind: PaperKind
}

export interface PhotoSize {
  id: string
  name: string
  wMm: number
  hMm: number
  rotateByDefault: boolean
}

/** 本机读取的照片文件信息（只读尺寸与方向，不上传） */
export interface PhotoRef {
  name: string
  wPx: number
  hPx: number
  landscape: boolean
}

export interface Item {
  id: string
  sizeId: string
  qty: number
  rotateAllowed: boolean
  /** true = 同一张照片重复排；false = 一张照片只出现一次（每张各需一张底片） */
  repeatSamePhoto: boolean
  /** true = 该尺寸的照片尽量不拆散，排在同一张相纸上 */
  keepTogether: boolean
  photo?: PhotoRef
}

/** 实际照片矩形（mm，含旋转后的宽高） */
export interface Placement {
  itemId: string
  sheetIndex: number
  x: number
  y: number
  w: number
  h: number
  rotated: boolean
  seq: number
}

export type CutAxis = 'v' | 'h'

/** 贯通切割线；axis='v' 时 at 为 x，from/to 为 y 区间 */
export interface CutStep {
  sheetIndex: number
  axis: CutAxis
  at: number
  from: number
  to: number
  /** 该步由共边合并而来 */
  merged: boolean
}

export interface Sheet {
  index: number
  placements: Placement[]
  cutSteps: CutStep[]
  /** 合并前的切割步数（用于共边合并的对比断言） */
  rawCutCount: number
  usedAreaMm2: number
  sheetAreaMm2: number
  utilization: number
  wasteRects: WasteRect[]
}

export interface WasteRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PackStats {
  totalPhotos: number
  sheets: number
  avgUtilization: number
  elapsedMs: number
  keepTogetherBroken: string[]
}

export interface PackResult {
  sheets: Sheet[]
  stats: PackStats
}

export interface CostReport {
  paperName: string
  sheets: number
  totalCents: number
  perPhotoCents: number
  totalPhotoCount: number
  /** 本方案浪费率 */
  wasteRate: number
  /** 不排样逐张打印的浪费率 */
  naiveWasteRate: number
  naiveTotalCents: number
  savedCents: number
}

/** 手工微调过的排样（存在时优先于自动排样结果） */
export interface ManualState {
  placements: Placement[]
  valid: boolean
  message: string
  validationMs: number
  stepCount: number
}

/** 一个版本定格的裁切参数与相纸（修订与重排的最小单元） */
export interface RevisionParams {
  paperId: string
  /** 自定义相纸（paperId 为 'custom' 时生效） */
  customPaper?: Paper
  gapMm: number
  kerfMm: number
  safeEdgeMm: number
  allowRotate: boolean
}

/** 一个版本的关键指标快照（张数 / 利用率 / 总价 / 刀数） */
export interface RevisionSummary {
  sheets: number
  totalPhotos: number
  avgUtilization: number
  totalCents: number
  cutSteps: number
  rawCutSteps: number
}

/** 重排时保不住的手工位置（含原因） */
export interface DroppedPlacement {
  seq: number
  itemId: string
  reason: string
}

/** 一次修订存下的版本：参数 + 排样结果 + 指标快照，可退回 */
export interface Revision {
  id: string
  /** 版本号（从 1 开始递增） */
  seq: number
  createdAt: number
  /** 这一版改了什么（自动生成，如「隙距 0→2mm」） */
  note: string
  params: RevisionParams
  summary: RevisionSummary
  result: PackResult
  /** 该版本生效的手工排样（含重排时保下来的位置） */
  manual?: ManualState
  /** 重排时保不住、被重新自动排的手工位置清单 */
  droppedManual: DroppedPlacement[]
}

export interface Task {
  id: string
  name: string
  paperId: string
  /** 自定义相纸（paperId 为 'custom' 时生效） */
  customPaper?: Paper
  items: Item[]
  gapMm: number
  kerfMm: number
  safeEdgeMm: number
  allowRotate: boolean
  headerText: string
  footerText: string
  createdAt: number
  /** 手工微调过的排样（存在时优先于自动排样结果） */
  manual?: ManualState
  result?: PackResult
  /** 修订历史：每改一次参数重排就存一版；顶层字段始终与当前版本同步 */
  revisions?: Revision[]
  currentRevisionId?: string
}

export interface Leftover {
  id: string
  name: string
  wMm: number
  hMm: number
  marginMm: number
  priceCents: number
  createdAt: number
  usedCount: number
}

export interface Settings {
  gapMm: number
  kerfMm: number
  safeEdgeMm: number
  allowRotate: boolean
  exportDpi: number
}

export interface PaperTemplate {
  id: string
  name: string
  paperId: string
  items: Array<{
    sizeId: string
    qty: number
    rotateAllowed: boolean
    keepTogether: boolean
  }>
}
