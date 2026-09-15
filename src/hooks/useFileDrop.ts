import { useEffect } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { api, isTauri } from '@/lib/tauri'
import { addPaths } from '@/lib/jobs'
import { useAppStore } from '@/store/app-store'

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
        if (event.payload.paths.length === 0) return
        try {
          const infos = await api.inspectPaths(event.payload.paths)
          if (!cancelled) addPaths(infos)
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
