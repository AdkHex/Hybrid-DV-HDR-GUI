import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open, save } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import type {
  AppDefaults,
  PathInfo,
  ProcessingRequest,
  SourceInfo,
  ToolPaths,
  ToolStatus,
} from '@/types'

// `window.__TAURI_INTERNALS__` only exists inside the Tauri shell; in a plain
// browser (vite dev) every backend call is skipped.
export const isTauri = () => '__TAURI_INTERNALS__' in window

export function listenTauri<T>(
  event: string,
  handler: (payload: T) => void
): Promise<UnlistenFn> {
  return listen<T>(event, e => handler(e.payload))
}

export const api = {
  inspectPaths: (paths: string[]) =>
    paths.length
      ? invoke<PathInfo[]>('inspect_paths', { paths })
      : Promise.resolve([]),
  getAppDefaults: () => invoke<AppDefaults>('get_app_defaults'),
  probeSource: (path: string, toolPaths: ToolPaths) =>
    invoke<SourceInfo>('probe_source', { path, toolPaths }),
  checkTools: (toolPaths: ToolPaths) =>
    invoke<ToolStatus[]>('check_tools', { toolPaths }),
  startProcessing: (request: ProcessingRequest) =>
    invoke('start_processing', { request }),
  cancelProcessing: () => invoke('cancel_processing'),
  downloadFile: (url: string, filename: string) =>
    invoke<string>('download_file', { url, filename }),
  saveTextFile: (path: string, contents: string) =>
    invoke('save_text_file', { path, contents }),
}

const videoFilter = [
  {
    name: 'Video',
    extensions: ['mkv', 'mp4', 'm4v', 'mov', 'hevc', 'h265', 'ts', 'm2ts'],
  },
]

export async function pickFile(defaultPath?: string): Promise<string | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: videoFilter,
    defaultPath,
  })
  return typeof picked === 'string' ? picked : null
}

export async function pickFiles(): Promise<string[]> {
  const picked = await open({
    multiple: true,
    directory: false,
    filters: videoFilter,
  })
  return Array.isArray(picked) ? picked : picked ? [picked] : []
}

export async function pickFolder(defaultPath?: string): Promise<string | null> {
  const picked = await open({ multiple: false, directory: true, defaultPath })
  return typeof picked === 'string' ? picked : null
}

export async function pickExecutable(): Promise<string | null> {
  const picked = await open({ multiple: false, directory: false })
  return typeof picked === 'string' ? picked : null
}

export async function pickSaveFile(
  defaultPath?: string,
  ext = 'mkv'
): Promise<string | null> {
  const picked = await save({
    defaultPath,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  })
  return typeof picked === 'string' ? picked : null
}

export function revealPath(path: string) {
  return revealItemInDir(path)
}
