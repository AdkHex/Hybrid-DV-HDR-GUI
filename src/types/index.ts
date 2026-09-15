export type JobStatus = 'queued' | 'running' | 'completed' | 'failed'
export type RunStatus = 'idle' | 'processing' | 'completed' | 'error'
export type LogLevel = 'info' | 'success' | 'warning' | 'error'

export interface ToolPaths {
  doviTool: string
  mkvmerge: string
  mkvextract: string
  ffmpeg: string
  mediainfo: string
  mp4box: string
  hdr10plusTool: string
  defaultOutput: string
}

export const toolKeys = [
  'doviTool',
  'mkvmerge',
  'mkvextract',
  'ffmpeg',
  'mediainfo',
  'mp4box',
  'hdr10plusTool',
] as const satisfies readonly (keyof ToolPaths)[]

export type ToolKey = (typeof toolKeys)[number]

/** Bare names mean "not resolved yet"; `get_app_defaults` swaps in absolute paths. */
export const defaultToolPaths: ToolPaths = {
  doviTool: 'dovi_tool',
  mkvmerge: 'mkvmerge',
  mkvextract: 'mkvextract',
  ffmpeg: 'ffmpeg',
  mediainfo: 'MediaInfo',
  mp4box: 'MP4Box',
  hdr10plusTool: 'hdr10plus_tool',
  defaultOutput: '',
}

export interface PathInfo {
  path: string
  exists: boolean
  isDir: boolean
  isFile: boolean
}

export interface SourceInfo {
  path: string
  width: number
  height: number
  fps: number
  codec: string | null
  hasAudioOrSubs: boolean
}

export interface ToolStatus {
  key: string
  name: string
  required: boolean
  path: string | null
  version: string | null
}

export interface AppDefaults {
  defaultOutput: string
  binDir: string
  toolPaths: ToolPaths
}

/** One entry in the queue: a file pair or a folder pair. */
export interface Job {
  id: string
  name: string
  hdrPath: string
  dvPath: string
  hdr10plusPath: string
  outputPath: string
  dvDelayMs: number
  hdr10plusDelayMs: number
  isFolderPair: boolean
  selected: boolean
  status: JobStatus
  progress: number
  currentStep?: string
  error?: string
  etaSeconds?: number
  activeWorkers?: number
  fileTotal?: number
  startedAt?: number
  finishedAt?: number
}

/** Per-file progress inside a folder job (from `processing:file`). */
export interface FileEntry {
  id: string
  jobId: string
  name: string
  progress: number
  stepIndex: number
  stepName: string
  status: 'processing' | 'completed' | 'error' | 'pending'
  etaSeconds?: number
  startedAt?: number
  finishedAt?: number
}

export interface LogEntry {
  seq: number
  time: number
  level: LogLevel
  /** Tool the line came from, parsed from the message when possible. */
  source: string
  message: string
}

export interface Preset {
  id: string
  name: string
  parallelTasks: number
  keepTempFiles: boolean
  dvDelayMs: number
  hdr10plusDelayMs: number
}

export type ThemePreference = 'system' | 'light' | 'dark'

// ---- Backend payloads --------------------------------------------------

export interface LogPayload {
  logType: LogLevel
  message: string
}
export interface QueuePayload {
  id: string
  status: 'pending' | 'processing' | 'completed' | 'error'
  progress: number
  currentStep?: string | null
  activeWorkers?: number | null
  fileTotal?: number | null
}
export interface FilePayload {
  id: string
  queueId: string
  name: string
  progress: number
  stepIndex: number
  stepName: string
  status: FileEntry['status']
}
export interface StatusPayload {
  status: RunStatus
}

export interface QueueItemRequest {
  id: string
  hdrPath: string
  dvPath: string
  outputPath: string
  hdr10plusPath: string
  dvDelayMs: number
  hdr10plusDelayMs: number
}
export interface ProcessingRequest {
  mode: 'batch'
  hdrPath: string
  dvPath: string
  outputPath: string
  hdr10plusPath: string
  dvDelayMs: number
  hdr10plusDelayMs: number
  keepTempFiles: boolean
  parallelTasks: number
  toolPaths: ToolPaths
  queue: QueueItemRequest[]
}

export const STEP_NAMES = [
  'Audio & subtitles',
  'Demux DV video',
  'Extract RPU',
  'Demux HDR10 video',
  'Inject RPU',
  'Mux output',
] as const
