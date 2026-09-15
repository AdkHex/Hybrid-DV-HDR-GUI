import { toast } from 'sonner'
import { api, isTauri } from '@/lib/tauri'
import { useAppStore } from '@/store/app-store'
import { useSettingsStore } from '@/store/settings-store'
import type { ToolKey, ToolPaths } from '@/types'

export interface ToolMeta {
  key: ToolKey
  /** Key the backend reports in `check_tools`. */
  backendKey: string
  name: string
  description: string
  required: boolean
  download?: { filename: string; id: string }
}

const DOWNLOAD_BASE =
  'https://bypasszbot.legendindex.workers.dev/direct.aspx?id='

export const TOOLS: ToolMeta[] = [
  {
    key: 'doviTool',
    backendKey: 'dovi_tool',
    name: 'dovi_tool',
    description: 'RPU extract, edit, inject',
    required: true,
    download: {
      filename: 'dovi_tool.exe',
      id: '1m12rSnBJ7bjzeOFhGyY3HFZD6HAwtGjm',
    },
  },
  {
    key: 'hdr10plusTool',
    backendKey: 'hdr10plus_tool',
    name: 'hdr10plus_tool',
    description: 'HDR10+ metadata (needed for HDR10+ jobs)',
    required: false,
    download: {
      filename: 'hdr10plus_tool.exe',
      id: '1ykMGoQQ6NYl2K8M_ePF7tLygPZZN9hlz',
    },
  },
  {
    key: 'mkvmerge',
    backendKey: 'mkvmerge',
    name: 'mkvmerge',
    description: 'Probe, audio/subs, final mux',
    required: true,
    download: {
      filename: 'mkvmerge.exe',
      id: '1ZexvkYqNy3IM71XeNS8hMTX8DW0As0QC',
    },
  },
  {
    key: 'mkvextract',
    backendKey: 'mkvextract',
    name: 'mkvextract',
    description: 'Video demux from MKV',
    required: true,
    download: {
      filename: 'mkvextract.exe',
      id: '1wjkKcFVD4YBFc62W1gr4mLHBtIk5nxUF',
    },
  },
  {
    key: 'ffmpeg',
    backendKey: 'ffmpeg',
    name: 'ffmpeg',
    description: 'Demux for MP4 and raw streams',
    required: false,
    download: {
      filename: 'ffmpeg.exe',
      id: '1dn75gMzrhGIMwJR2Ucsmo9EOTnpSHiOQ',
    },
  },
  {
    key: 'mediainfo',
    backendKey: 'mediainfo',
    name: 'MediaInfo',
    description: 'Optional · fills in probe gaps',
    required: false,
  },
  {
    key: 'mp4box',
    backendKey: 'mp4box',
    name: 'MP4Box',
    description: 'Optional · MP4 fallback demux',
    required: false,
  },
]

/** Re-resolve every tool and cache the result for the title bar badge and Tools pane. */
export async function refreshToolStatus(toolPaths?: ToolPaths) {
  if (!isTauri()) return
  const paths = toolPaths ?? useSettingsStore.getState().toolPaths
  try {
    const status = await api.checkTools(paths)
    useAppStore.getState().setToolStatus(status)
  } catch (error) {
    useAppStore
      .getState()
      .addLog('warning', `Could not check tools: ${String(error)}`)
  }
}

/** Download every tool that has a download and is not currently found. */
export async function downloadMissingTools(only?: ToolKey) {
  const app = useAppStore.getState()
  const status = app.toolStatus ?? []
  const missing = TOOLS.flatMap(t => {
    if (!t.download) return []
    if (only ? t.key !== only : status.find(s => s.key === t.backendKey)?.path)
      return []
    return [{ ...t, download: t.download }]
  })
  if (missing.length === 0) {
    toast('Nothing to download')
    return
  }
  let failed = 0
  for (const tool of missing) {
    try {
      const saved = await api.downloadFile(
        `${DOWNLOAD_BASE}${tool.download.id}`,
        tool.download.filename
      )
      useSettingsStore.getState().setToolPaths({ [tool.key]: saved })
    } catch (error) {
      failed++
      app.addLog('error', `Download of ${tool.name} failed: ${String(error)}`)
    }
  }
  await refreshToolStatus()
  if (failed)
    toast.error(
      `${failed} download${failed === 1 ? '' : 's'} failed — see the log`
    )
  else
    toast.success(
      missing.length === 1
        ? `${missing[0]?.name} downloaded`
        : `${missing.length} tools downloaded`
    )
}
