import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  defaultToolPaths,
  type Preset,
  type ThemePreference,
  type ToolPaths,
} from '@/types'

export const MAX_PARALLEL = 8

interface SettingsState {
  toolPaths: ToolPaths
  parallelTasks: number
  keepTempFiles: boolean
  defaultDvDelayMs: number
  defaultHdr10plusDelayMs: number
  presets: Preset[]
  theme: ThemePreference
  notifyOnFinish: boolean
  soundOnFinish: boolean
  autoCheckUpdates: boolean
  logVisible: boolean

  setToolPaths: (paths: Partial<ToolPaths>) => void
  setParallelTasks: (n: number) => void
  setKeepTempFiles: (v: boolean) => void
  setDefaultOffsets: (dv: number, hdr10plus: number) => void
  setTheme: (t: ThemePreference) => void
  setNotifyOnFinish: (v: boolean) => void
  setSoundOnFinish: (v: boolean) => void
  setAutoCheckUpdates: (v: boolean) => void
  toggleLog: () => void
  setLogVisible: (v: boolean) => void
  addPreset: (preset: Preset) => void
  removePreset: (id: string) => void
}

/**
 * Earlier builds stored tool paths and options under separate localStorage
 * keys. They seed the defaults so nobody has to re-pick their tools; the
 * persisted state (if any) is merged on top.
 */
function legacyDefaults() {
  const out = {
    toolPaths: defaultToolPaths,
    parallelTasks: 4,
    keepTempFiles: false,
  }
  try {
    const tools = localStorage.getItem('hybrid-dv-hdr-tools')
    if (tools) out.toolPaths = { ...defaultToolPaths, ...JSON.parse(tools) }
    const config = localStorage.getItem('hybrid-dv-hdr-config')
    if (config) {
      const parsed = JSON.parse(config)
      if (typeof parsed.parallelTasks === 'number')
        out.parallelTasks = parsed.parallelTasks
      if (typeof parsed.keepTempFiles === 'boolean')
        out.keepTempFiles = parsed.keepTempFiles
    }
  } catch {
    // Unreadable legacy data is ignored.
  }
  return out
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    set => ({
      ...legacyDefaults(),
      presets: [],
      theme: 'system',
      notifyOnFinish: true,
      soundOnFinish: false,
      autoCheckUpdates: true,
      defaultDvDelayMs: 0,
      defaultHdr10plusDelayMs: 0,
      logVisible: false,

      setToolPaths: paths =>
        set(s => ({ toolPaths: { ...s.toolPaths, ...paths } })),
      setParallelTasks: n =>
        set({
          parallelTasks: Math.min(MAX_PARALLEL, Math.max(1, Math.round(n))),
        }),
      setKeepTempFiles: keepTempFiles => set({ keepTempFiles }),
      setDefaultOffsets: (defaultDvDelayMs, defaultHdr10plusDelayMs) =>
        set({ defaultDvDelayMs, defaultHdr10plusDelayMs }),
      setTheme: theme => set({ theme }),
      setNotifyOnFinish: notifyOnFinish => set({ notifyOnFinish }),
      setSoundOnFinish: soundOnFinish => set({ soundOnFinish }),
      setAutoCheckUpdates: autoCheckUpdates => set({ autoCheckUpdates }),
      toggleLog: () => set(s => ({ logVisible: !s.logVisible })),
      setLogVisible: logVisible => set({ logVisible }),
      addPreset: preset => set(s => ({ presets: [...s.presets, preset] })),
      removePreset: id =>
        set(s => ({ presets: s.presets.filter(p => p.id !== id) })),
    }),
    { name: 'hybrid-dv-hdr-settings' }
  )
)
