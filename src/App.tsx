import { useEffect, useRef } from 'react'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Layout } from '@/components/layout/Layout'
import { PreferencesDialog } from '@/components/preferences/PreferencesDialog'
import { UpdateSplash } from '@/components/update/UpdateSplash'
import { useTheme } from '@/hooks/useTheme'
import { useProcessingEvents } from '@/hooks/useProcessingEvents'
import { useFileDrop } from '@/hooks/useFileDrop'
import { api, isTauri } from '@/lib/tauri'
import { checkForUpdates } from '@/lib/updater'
import { refreshToolStatus } from '@/lib/tools'
import { hasPathSeparator, isAbsolutePath } from '@/lib/paths'
import { useAppStore } from '@/store/app-store'
import { useSettingsStore } from '@/store/settings-store'
import { toolKeys, type ToolPaths } from '@/types'

export default function App() {
  useTheme()
  useProcessingEvents()
  useFileDrop()
  const booted = useRef(false)

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    if (!isTauri()) return

    // Bare tool names and an empty output folder become absolute paths from
    // the backend; anything the user set explicitly is left alone.
    api
      .getAppDefaults()
      .then(defaults => {
        const settings = useSettingsStore.getState()
        const next: Partial<ToolPaths> = {}
        for (const key of toolKeys) {
          if (
            !hasPathSeparator(settings.toolPaths[key]) &&
            defaults.toolPaths[key]
          )
            next[key] = defaults.toolPaths[key]
        }
        const output = settings.toolPaths.defaultOutput
        if ((!output || !isAbsolutePath(output)) && defaults.defaultOutput)
          next.defaultOutput = defaults.defaultOutput
        if (Object.keys(next).length) settings.setToolPaths(next)
        return refreshToolStatus()
      })
      .catch(error =>
        useAppStore
          .getState()
          .addLog('warning', `Could not read app defaults: ${String(error)}`)
      )

    if (useSettingsStore.getState().autoCheckUpdates) {
      const timer = window.setTimeout(
        () => void checkForUpdates({ notifyOnReady: true }),
        1500
      )
      return () => window.clearTimeout(timer)
    }
  }, [])

  // ⌘/Ctrl shortcuts: 2 or L toggles the log, comma opens preferences.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const settings = useSettingsStore.getState()
      if (e.key === '2' || e.key === 'l') {
        e.preventDefault()
        settings.toggleLog()
      } else if (e.key === ',') {
        e.preventDefault()
        useAppStore.getState().openPreferences('general')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <TooltipProvider delayDuration={300}>
      <Layout />
      <PreferencesDialog />
      <UpdateSplash />
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  )
}
