import { useMemo } from 'react'
import { FilePlus, FolderPlus, ListPlus, Play, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api, isTauri, pickFiles, pickFolder } from '@/lib/tauri'
import { addPaths, canRun, isComplete } from '@/lib/jobs'
import { startQueue, stopQueue } from '@/lib/processing'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/app-store'
import { useSettingsStore } from '@/store/settings-store'
import type { FileEntry, JobFilter } from '@/types'
import { PairCard } from './PairCard'

const FILTERS: { id: JobFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' },
]

async function pick(kind: 'files' | 'folders') {
  if (!isTauri()) {
    const manual = window.prompt(
      `Enter a ${kind === 'files' ? 'file' : 'folder'} path:`
    )
    if (manual)
      addPaths([
        {
          path: manual,
          exists: true,
          isDir: kind === 'folders',
          isFile: kind === 'files',
        },
      ])
    return
  }
  try {
    const paths =
      kind === 'files'
        ? await pickFiles()
        : [await pickFolder()].filter((p): p is string => !!p)
    if (!paths.length) return
    addPaths(await api.inspectPaths(paths))
  } catch (error) {
    useAppStore
      .getState()
      .addLog('error', `File dialog failed: ${String(error)}`)
  }
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-input p-10 text-center">
      <ListPlus className="mb-1 size-6 text-muted-foreground" />
      <p className="text-sm font-medium">
        Drop HDR and Dolby Vision files or folders here
      </p>
      <p className="max-w-[420px] text-xs text-muted-foreground">
        Files are paired by name — HDR10 / HDR10+ with DV. Two folders make a
        folder pair whose files are matched by name.
      </p>
      <div className="mt-3 flex gap-2">
        <Button variant="outline" size="sm" onClick={() => void pick('files')}>
          Add files…
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void pick('folders')}
        >
          Add folders…
        </Button>
      </div>
    </div>
  )
}

export function PairList() {
  const jobs = useAppStore(s => s.jobs)
  const filesById = useAppStore(s => s.files)
  const filter = useAppStore(s => s.filter)
  const setFilter = useAppStore(s => s.setFilter)
  const runStatus = useAppStore(s => s.runStatus)
  const cancelling = useAppStore(s => s.cancelling)
  const removeFinishedJobs = useAppStore(s => s.removeFinishedJobs)
  const parallelTasks = useSettingsStore(s => s.parallelTasks)
  const busy = runStatus === 'processing'

  const filesByJob = useMemo(() => {
    const map = new Map<string, FileEntry[]>()
    for (const f of Object.values(filesById)) {
      const list = map.get(f.jobId) ?? []
      list.push(f)
      map.set(f.jobId, list)
    }
    for (const list of map.values())
      list.sort((a, b) =>
        a.id.localeCompare(b.id, undefined, { numeric: true })
      )
    return map
  }, [filesById])

  const running = jobs.filter(j => j.status === 'running').length
  const completed = jobs.filter(j => j.status === 'completed').length
  const failed = jobs.filter(j => j.status === 'failed').length
  const incomplete = jobs.filter(j => !isComplete(j)).length
  const runnable = jobs.filter(canRun).length
  const workers = jobs.reduce((n, j) => n + (j.activeWorkers ?? 0), 0)
  const fileCount = jobs.reduce(
    (n, j) => n + (j.fileTotal ?? (isComplete(j) ? 1 : 0)),
    0
  )

  const summary = jobs.length
    ? [
        `${jobs.length} pair${jobs.length === 1 ? '' : 's'}`,
        fileCount > jobs.length ? `${fileCount} files` : null,
        running ? `${running} running` : null,
        busy && workers ? `${workers} of ${parallelTasks} workers` : null,
        completed ? `${completed} done` : null,
        failed ? `${failed} failed` : null,
        incomplete ? `${incomplete} incomplete` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : ''

  const visible = jobs.filter(j => {
    if (filter === 'waiting')
      return j.status === 'queued' || j.status === 'running'
    if (filter === 'done') return j.status === 'completed'
    if (filter === 'failed') return j.status === 'failed'
    return true
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[52px] shrink-0 items-center justify-between gap-2 px-6">
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void pick('files')}
          >
            <FilePlus className="size-3.5" /> Add files
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void pick('folders')}
          >
            <FolderPlus className="size-3.5" /> Add folders
          </Button>
          <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">
            {summary}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {jobs.length > 1 ? (
            <div className="inline-flex rounded-lg border border-input p-0.5 text-xs">
              {FILTERS.map(f => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-muted-foreground',
                    filter === f.id && 'bg-muted text-foreground'
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          ) : null}
          {completed > 0 && !busy ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={removeFinishedJobs}
            >
              Clear finished
            </Button>
          ) : null}
          {busy ? (
            <Button
              size="sm"
              disabled={cancelling}
              onClick={() => void stopQueue()}
            >
              <Square className="size-3.5" />{' '}
              {cancelling ? 'Stopping…' : 'Stop'}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={runnable === 0}
              onClick={() => void startQueue()}
              title={
                runnable === 0 && jobs.length
                  ? 'Every pair needs a base and a Dolby Vision source'
                  : undefined
              }
            >
              <Play className="size-3.5" />{' '}
              {runnable > 1 ? 'Start all' : 'Start'}
            </Button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-6 pb-5 pt-1">
        {jobs.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {visible.map(job => (
              <PairCard
                key={job.id}
                job={job}
                files={filesByJob.get(job.id) ?? []}
              />
            ))}
            {visible.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                No pairs match this filter.
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => void pick('files')}
              className="rounded-[10px] border border-dashed border-input px-4 py-6 text-center text-[13px] text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            >
              Drop more files or folders
            </button>
          </>
        )}
      </div>
    </div>
  )
}
