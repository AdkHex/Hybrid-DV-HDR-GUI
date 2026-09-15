import { useEffect, useRef } from 'react'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { isTauri, listenTauri } from '@/lib/tauri'
import { computeEta, type EtaMeta } from '@/lib/eta'
import { useAppStore } from '@/store/app-store'
import { useSettingsStore } from '@/store/settings-store'
import type {
  FilePayload,
  LogPayload,
  QueuePayload,
  RunStatus,
  StatusPayload,
} from '@/types'

async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted()
    if (!granted) granted = (await requestPermission()) === 'granted'
    if (granted) sendNotification({ title, body })
  } catch {
    // Notifications are best-effort.
  }
}

/** Subscribes to the backend's processing events and folds them into the store. */
export function useProcessingEvents() {
  const jobEta = useRef(new Map<string, EtaMeta>())
  const fileEta = useRef(new Map<string, EtaMeta>())
  const lastStatus = useRef<RunStatus>('idle')

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    const unlisteners: (() => void)[] = []
    const register = async (subscribe: () => Promise<() => void>) => {
      const unlisten = await subscribe()
      if (cancelled) unlisten()
      else unlisteners.push(unlisten)
    }

    const store = useAppStore.getState

    void register(() =>
      listenTauri<LogPayload>('processing:log', p =>
        store().addLog(p.logType, p.message)
      )
    )

    void register(() =>
      listenTauri<QueuePayload>('processing:queue', p => {
        const job = store().jobs.find(j => j.id === p.id)
        if (!job) return
        const now = Date.now()
        if (p.status === 'processing') {
          const meta = jobEta.current.get(p.id) ?? { samples: [] }
          const eta = computeEta(meta, p.progress)
          jobEta.current.set(p.id, meta)
          store().updateJob(p.id, {
            status: 'running',
            progress: p.progress,
            currentStep: p.currentStep ?? undefined,
            activeWorkers: p.activeWorkers ?? job.activeWorkers,
            fileTotal: p.fileTotal ?? job.fileTotal,
            etaSeconds: eta ?? job.etaSeconds,
            startedAt: job.startedAt ?? now,
            error: undefined,
          })
        } else if (p.status === 'completed') {
          jobEta.current.delete(p.id)
          store().updateJob(p.id, {
            status: 'completed',
            progress: 100,
            currentStep: undefined,
            etaSeconds: undefined,
            activeWorkers: 0,
            finishedAt: now,
          })
        } else if (p.status === 'error') {
          jobEta.current.delete(p.id)
          store().updateJob(p.id, {
            status: 'failed',
            progress: p.progress,
            error: p.currentStep ?? 'Failed',
            etaSeconds: undefined,
            activeWorkers: 0,
            finishedAt: now,
          })
        } else {
          jobEta.current.delete(p.id)
          store().updateJob(p.id, {
            status: 'queued',
            progress: 0,
            currentStep: undefined,
            etaSeconds: undefined,
            activeWorkers: 0,
            startedAt: undefined,
          })
        }
      })
    )

    void register(() =>
      listenTauri<FilePayload>('processing:file', p => {
        const existing = store().files[p.id]
        const now = Date.now()
        if (p.status === 'processing') {
          const meta = fileEta.current.get(p.id) ?? { samples: [] }
          const eta = computeEta(meta, p.progress)
          fileEta.current.set(p.id, meta)
          store().upsertFile({
            id: p.id,
            jobId: p.queueId,
            name: p.name,
            progress: p.progress,
            stepIndex: p.stepIndex,
            stepName: p.stepName,
            status: 'processing',
            etaSeconds: eta ?? existing?.etaSeconds,
            startedAt: existing?.startedAt ?? now,
          })
        } else {
          fileEta.current.delete(p.id)
          store().upsertFile({
            id: p.id,
            jobId: p.queueId,
            name: p.name,
            progress:
              p.status === 'completed'
                ? 100
                : p.status === 'error'
                  ? (existing?.progress ?? 0)
                  : 0,
            stepIndex: p.status === 'error' ? (existing?.stepIndex ?? 0) : 0,
            stepName: p.stepName,
            status: p.status,
            etaSeconds: undefined,
            startedAt: existing?.startedAt,
            finishedAt: p.status === 'pending' ? undefined : now,
          })
        }
      })
    )

    void register(() =>
      listenTauri<StatusPayload>('processing:status', p => {
        const s = store()
        s.setRunStatus(p.status)
        if (p.status !== 'processing') s.setCancelling(false)
        if (p.status === 'idle') {
          // Stop confirmed: anything still marked running goes back to queued.
          for (const job of s.jobs) {
            if (job.status === 'running') {
              s.updateJob(job.id, {
                status: 'queued',
                progress: 0,
                currentStep: undefined,
                etaSeconds: undefined,
              })
              s.clearFilesForJob(job.id)
            }
          }
          jobEta.current.clear()
          fileEta.current.clear()
        }
        const previous = lastStatus.current
        lastStatus.current = p.status
        if (previous === p.status) return
        const { notifyOnFinish, soundOnFinish } = useSettingsStore.getState()
        if (p.status === 'completed' || p.status === 'error') {
          if (notifyOnFinish) {
            void notify(
              'Hybrid DV HDR',
              p.status === 'completed'
                ? 'Queue finished.'
                : 'A job failed. See the log for details.'
            )
          }
          if (soundOnFinish) {
            try {
              const ctx = new AudioContext()
              const osc = ctx.createOscillator()
              const gain = ctx.createGain()
              osc.frequency.value = p.status === 'completed' ? 880 : 330
              gain.gain.value = 0.08
              osc.connect(gain).connect(ctx.destination)
              osc.start()
              osc.stop(ctx.currentTime + 0.18)
            } catch {
              // No audio device; ignore.
            }
          }
        }
      })
    )

    return () => {
      cancelled = true
      unlisteners.forEach(fn => fn())
    }
  }, [])
}
