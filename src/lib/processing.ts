import { toast } from 'sonner'
import { api, isTauri } from '@/lib/tauri'
import { useAppStore } from '@/store/app-store'
import { useSettingsStore } from '@/store/settings-store'
import type { ProcessingRequest } from '@/types'

/** Start every selected queued/failed job. */
export async function startQueue() {
  const app = useAppStore.getState()
  const settings = useSettingsStore.getState()
  const jobs = app.jobs.filter(j => j.selected && j.status !== 'completed')
  if (jobs.length === 0) {
    toast('Nothing selected to process')
    return
  }
  if (!isTauri()) {
    toast.error('Processing needs the desktop app')
    return
  }

  for (const job of jobs) {
    app.updateJob(job.id, {
      status: 'queued',
      progress: 0,
      error: undefined,
      currentStep: undefined,
      etaSeconds: undefined,
    })
    app.clearFilesForJob(job.id)
    app.setExpanded(job.id, true)
  }
  app.setRunStatus('processing')
  app.setCancelling(false)

  const request: ProcessingRequest = {
    mode: 'batch',
    hdrPath: '',
    dvPath: '',
    outputPath: '',
    hdr10plusPath: '',
    dvDelayMs: 0,
    hdr10plusDelayMs: 0,
    keepTempFiles: settings.keepTempFiles,
    parallelTasks: settings.parallelTasks,
    toolPaths: settings.toolPaths,
    queue: jobs.map(j => ({
      id: j.id,
      hdrPath: j.hdrPath,
      dvPath: j.dvPath,
      outputPath: j.outputPath,
      hdr10plusPath: j.hdr10plusPath,
      dvDelayMs: j.dvDelayMs,
      hdr10plusDelayMs: j.hdr10plusDelayMs,
    })),
  }

  try {
    await api.startProcessing(request)
  } catch (error) {
    // The backend already logged and emitted the error status; a request that
    // failed before any job ran (bad tool path, empty folder) lands here too.
    const message = String(error)
    useAppStore.getState().addLog('error', message)
    useAppStore.getState().setRunStatus('error')
    toast.error(message.split('\n')[0] ?? 'Processing failed')
  }
}

export async function stopQueue() {
  const app = useAppStore.getState()
  if (!isTauri()) {
    app.setRunStatus('idle')
    return
  }
  app.setCancelling(true)
  try {
    await api.cancelProcessing()
  } catch (error) {
    app.setCancelling(false)
    app.addLog('error', `Cancel failed: ${String(error)}`)
  }
}
