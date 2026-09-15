import {
  autoOutputName,
  baseName,
  classifyDropName,
  displayLabel,
} from '@/lib/paths'
import { useAppStore } from '@/store/app-store'
import { useSettingsStore } from '@/store/settings-store'
import type { Job, PathInfo, PathKind } from '@/types'

export function newJob(patch: Partial<Job> = {}): Job {
  const s = useSettingsStore.getState()
  return {
    id: crypto.randomUUID(),
    hdrPath: '',
    hdrKind: 'unknown',
    dvPath: '',
    dvKind: 'unknown',
    hdr10plusPath: '',
    outputPath: '',
    outputKind: 'unknown',
    dvDelayMs: s.defaultDvDelayMs,
    hdr10plusDelayMs: s.defaultHdr10plusDelayMs,
    selected: true,
    status: 'queued',
    progress: 0,
    ...patch,
  }
}

export const isFolderPair = (j: Job) =>
  j.hdrKind === 'folder' && j.dvKind === 'folder'
export const isComplete = (j: Job) => Boolean(j.hdrPath && j.dvPath)
/** Both slots filled but one is a file and the other a folder. */
export const isMixed = (j: Job) =>
  isComplete(j) &&
  j.hdrKind !== 'unknown' &&
  j.dvKind !== 'unknown' &&
  j.hdrKind !== j.dvKind
export const canRun = (j: Job) =>
  j.selected &&
  isComplete(j) &&
  !isMixed(j) &&
  j.status !== 'completed' &&
  j.status !== 'running'

/** Card title: the output name for files, the folder name for folder pairs. */
export function jobTitle(j: Job): string {
  if (j.hdrPath) {
    if (j.hdrKind === 'folder') return baseName(j.hdrPath)
    if (j.outputKind === 'file' && j.outputPath) return baseName(j.outputPath)
    return autoOutputName(j.hdrPath)
  }
  if (j.dvPath) return displayLabel(j.dvPath)
  return 'New pair'
}

// ---- Drop handling ---------------------------------------------------------

/**
 * Assign dropped paths to the sidebar form. Names are classified by whole
 * tokens (HDR10+ / DV / HDR); anything unrecognised fills the first empty slot
 * in the order HDR → DV → Output.
 */
export function assignDroppedPaths(infos: PathInfo[]) {
  const store = useAppStore.getState()
  const next = { ...store.setup }
  let placed = 0
  for (const info of infos) {
    if (!info.exists) continue
    const kind: PathKind = info.isDir ? 'folder' : 'file'
    let slot = classifyDropName(info.path)
    if (slot === 'hdr10plus' && !next.hdrPath) slot = 'hdr'
    if (!slot) {
      if (!next.hdrPath) slot = 'hdr'
      else if (!next.dvPath) slot = 'dv'
      else if (!next.outputPath) slot = 'output'
    }
    if (!slot) {
      store.addLog(
        'warning',
        `Ignored dropped path (all inputs are filled): ${info.path}`
      )
      continue
    }
    if (slot === 'hdr')
      Object.assign(next, { hdrPath: info.path, hdrKind: kind })
    else if (slot === 'dv')
      Object.assign(next, { dvPath: info.path, dvKind: kind })
    else if (slot === 'hdr10plus') next.hdr10plusPath = info.path
    else Object.assign(next, { outputPath: info.path, outputKind: kind })
    placed++
  }
  if (placed) store.setSetup(next)
}
