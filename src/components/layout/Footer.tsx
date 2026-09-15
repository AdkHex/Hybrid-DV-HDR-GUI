import { pickFolder } from '@/lib/tauri'
import { useAppStore } from '@/store/app-store'
import { useSettingsStore } from '@/store/settings-store'

export function Footer() {
  const {
    toolPaths,
    parallelTasks,
    keepTempFiles,
    setToolPaths,
    logVisible,
    toggleLog,
  } = useSettingsStore()
  const runStatus = useAppStore(s => s.runStatus)
  const jobs = useAppStore(s => s.jobs)
  const failed = jobs.filter(j => j.status === 'failed').length
  const status =
    runStatus === 'processing'
      ? 'Processing…'
      : failed
        ? `${failed} failed`
        : runStatus === 'completed'
          ? 'Finished'
          : 'Ready'

  const change = async () => {
    const picked = await pickFolder(toolPaths.defaultOutput || undefined)
    if (picked) setToolPaths({ defaultOutput: picked })
  }

  return (
    <div className="flex h-11 shrink-0 items-center justify-between border-t px-6 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate">
          Output{' '}
          <span className="font-medium text-foreground">
            {toolPaths.defaultOutput || 'default folder'}
          </span>
        </span>
        <span>·</span>
        <button
          type="button"
          className="hover:text-foreground"
          onClick={() => void change()}
        >
          Change…
        </button>
        <span>·</span>
        <span>
          {parallelTasks} worker{parallelTasks === 1 ? '' : 's'}
        </span>
        <span>·</span>
        <span>{keepTempFiles ? 'Temp files kept' : 'Temp files removed'}</span>
      </div>
      <div className="flex items-center gap-4">
        <span>{status}</span>
        <button
          type="button"
          className="hover:text-foreground"
          onClick={toggleLog}
        >
          {logVisible ? 'Hide log' : 'Show log'}
        </button>
      </div>
    </div>
  )
}
