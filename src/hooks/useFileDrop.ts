import { useEffect } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { api, isTauri } from '@/lib/tauri'
import { classifyDropName, type DropSlot } from '@/lib/paths'
import { useAppStore, type JobSetup, type PathKind } from '@/store/app-store'
import type { PathInfo } from '@/types'

const slotKey: Record<DropSlot, keyof JobSetup> = {
  hdr: 'hdrPath',
  hdr10plus: 'hdr10plusPath',
  dv: 'dvPath',
  output: 'outputPath',
}

/**
 * Assign dropped paths to the setup form. Names are classified by whole
 * tokens (HDR10+ / DV / HDR); anything unrecognised fills the first empty
 * slot in the order HDR → DV → Output.
 */
export function assignDroppedPaths(infos: PathInfo[]) {
  const { setup, setSetup, addLog } = useAppStore.getState()
  const next: Partial<JobSetup> = {}
  const current = { ...setup }
  const placed: string[] = []

  for (const info of infos) {
    const kind: PathKind = info.isDir ? 'folder' : 'file'
    let slot = classifyDropName(info.path)
    if (!slot) {
      if (!current.hdrPath) slot = 'hdr'
      else if (!current.dvPath) slot = 'dv'
      else if (!current.outputPath) slot = 'output'
    }
    if (!slot) {
      addLog(
        'warning',
        `Ignored dropped path (all inputs are filled): ${info.path}`
      )
      continue
    }
    if (slot === 'hdr10plus' && !current.hdrPath) {
      // An HDR10+ file with no base yet is the base as well.
      slot = 'hdr'
    }
    ;(next as Record<string, string>)[slotKey[slot]] = info.path
    ;(current as Record<string, string>)[slotKey[slot]] = info.path
    if (slot === 'hdr') {
      next.hdrKind = kind
      current.hdrKind = kind
    }
    if (slot === 'dv') {
      next.dvKind = kind
      current.dvKind = kind
    }
    if (slot === 'output') {
      next.outputKind = kind
      current.outputKind = kind
    }
    placed.push(slot)
  }
  if (placed.length) setSetup(next)
}

/** Native drag-and-drop from the OS (DOM drag events never fire in Tauri). */
export function useFileDrop() {
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    void getCurrentWebview()
      .onDragDropEvent(async event => {
        const store = useAppStore.getState()
        if (event.payload.type === 'enter' || event.payload.type === 'over') {
          if (!store.dropActive) store.setDropActive(true)
          return
        }
        store.setDropActive(false)
        if (event.payload.type !== 'drop') return
        if (
          store.runStatus === 'processing' ||
          event.payload.paths.length === 0
        )
          return
        try {
          const infos = await api.inspectPaths(event.payload.paths)
          if (!cancelled) assignDroppedPaths(infos.filter(i => i.exists))
        } catch (error) {
          store.addLog(
            'error',
            `Could not inspect dropped paths: ${String(error)}`
          )
        }
      })
      .then(fn => {
        if (cancelled) fn()
        else unlisten = fn
      })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
}
