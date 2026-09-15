import { create } from 'zustand'
import type {
  FileEntry,
  Job,
  JobFilter,
  LogEntry,
  LogLevel,
  PathKind,
  RunStatus,
  SourceInfo,
  ToolStatus,
} from '@/types'

export type { PathKind }
export type ProbeState =
  | { state: 'loading' }
  | { state: 'ok'; info: SourceInfo }
  | { state: 'error'; message: string }

export type PreferencesPage =
  'general' | 'tools' | 'presets' | 'appearance' | 'about'

const MAX_LOG_LINES = 5000

/** Tool name at the start of a backend message, e.g. "mkvmerge could not…". */
const SOURCE_RE =
  /^(dovi_tool|hdr10plus_tool|mkvmerge|mkvextract|ffmpeg|ffprobe|MediaInfo|MP4Box)\b/i

interface AppState {
  filter: JobFilter
  probes: Record<string, ProbeState>
  jobs: Job[]
  expandedJobs: Set<string>
  files: Record<string, FileEntry>
  logs: LogEntry[]
  runStatus: RunStatus
  cancelling: boolean
  dropActive: boolean
  toolStatus: ToolStatus[] | null
  preferencesOpen: boolean
  preferencesPage: PreferencesPage
  updateChecking: boolean
  updateDownloading: boolean
  updateReady: boolean
  updateVersion: string | null
  updateProgress: number | null
  updateSplashDismissed: boolean

  setFilter: (filter: JobFilter) => void
  setProbe: (path: string, probe: ProbeState) => void
  addJob: (job: Job) => void
  updateJob: (id: string, patch: Partial<Job>) => void
  removeJob: (id: string) => void
  removeFinishedJobs: () => void
  clearQueue: () => void
  toggleExpanded: (id: string) => void
  setExpanded: (id: string, expanded: boolean) => void
  upsertFile: (entry: FileEntry) => void
  clearFilesForJob: (jobId: string) => void
  addLog: (level: LogLevel, message: string) => void
  clearLogs: () => void
  setRunStatus: (status: RunStatus) => void
  setCancelling: (v: boolean) => void
  setDropActive: (v: boolean) => void
  setToolStatus: (status: ToolStatus[] | null) => void
  openPreferences: (page?: PreferencesPage) => void
  closePreferences: () => void
  setUpdateChecking: (v: boolean) => void
  setUpdateDownloading: (v: boolean, version?: string) => void
  setUpdateReady: (v: boolean, version?: string) => void
  setUpdateProgress: (p: number | null) => void
  dismissUpdateSplash: () => void
}

let logSeq = 0

export const useAppStore = create<AppState>()((set, get) => ({
  filter: 'all',
  probes: {},
  jobs: [],
  expandedJobs: new Set(),
  files: {},
  logs: [],
  runStatus: 'idle',
  cancelling: false,
  dropActive: false,
  toolStatus: null,
  preferencesOpen: false,
  preferencesPage: 'general',
  updateChecking: false,
  updateDownloading: false,
  updateReady: false,
  updateVersion: null,
  updateProgress: null,
  updateSplashDismissed: false,

  setFilter: filter => set({ filter }),
  setProbe: (path, probe) =>
    set(s => ({ probes: { ...s.probes, [path]: probe } })),

  addJob: job => set(s => ({ jobs: [...s.jobs, job] })),
  updateJob: (id, patch) =>
    set(s => ({
      jobs: s.jobs.map(j => (j.id === id ? { ...j, ...patch } : j)),
    })),
  removeJob: id =>
    set(s => ({
      jobs: s.jobs.filter(j => j.id !== id),
      files: Object.fromEntries(
        Object.entries(s.files).filter(([, f]) => f.jobId !== id)
      ),
    })),
  removeFinishedJobs: () =>
    set(s => {
      const keep = s.jobs.filter(j => j.status !== 'completed')
      const ids = new Set(keep.map(j => j.id))
      return {
        jobs: keep,
        files: Object.fromEntries(
          Object.entries(s.files).filter(([, f]) => ids.has(f.jobId))
        ),
      }
    }),
  clearQueue: () => set({ jobs: [], files: {}, expandedJobs: new Set() }),
  toggleExpanded: id =>
    set(s => {
      const next = new Set(s.expandedJobs)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { expandedJobs: next }
    }),

  setExpanded: (id, expanded) =>
    set(s => {
      const next = new Set(s.expandedJobs)
      if (expanded) next.add(id)
      else next.delete(id)
      return { expandedJobs: next }
    }),

  upsertFile: entry => set(s => ({ files: { ...s.files, [entry.id]: entry } })),
  clearFilesForJob: jobId =>
    set(s => ({
      files: Object.fromEntries(
        Object.entries(s.files).filter(([, f]) => f.jobId !== jobId)
      ),
    })),

  addLog: (level, message) => {
    const source = SOURCE_RE.exec(message)?.[1]?.toLowerCase() ?? 'app'
    const entry: LogEntry = {
      seq: ++logSeq,
      time: Date.now(),
      level,
      source,
      message,
    }
    const logs = get().logs
    const kept =
      logs.length >= MAX_LOG_LINES
        ? logs.slice(logs.length - MAX_LOG_LINES + 1)
        : logs
    set({ logs: [...kept, entry] })
  },
  clearLogs: () => set({ logs: [] }),

  setRunStatus: runStatus => set({ runStatus }),
  setCancelling: cancelling => set({ cancelling }),
  setDropActive: dropActive => set({ dropActive }),
  setToolStatus: toolStatus => set({ toolStatus }),
  openPreferences: page =>
    set(s => ({
      preferencesOpen: true,
      preferencesPage: page ?? s.preferencesPage,
    })),
  closePreferences: () => set({ preferencesOpen: false }),

  setUpdateChecking: updateChecking => set({ updateChecking }),
  setUpdateDownloading: (updateDownloading, version) =>
    set(s => ({
      updateDownloading,
      updateVersion: version ?? s.updateVersion,
    })),
  setUpdateReady: (updateReady, version) =>
    set(s => ({
      updateReady,
      updateDownloading: updateReady ? false : s.updateDownloading,
      updateVersion: version ?? s.updateVersion,
    })),
  setUpdateProgress: updateProgress => set({ updateProgress }),
  dismissUpdateSplash: () => set({ updateSplashDismissed: true }),
}))
