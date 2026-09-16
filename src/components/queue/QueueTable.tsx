import { useMemo } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  FilePlus,
  FolderPlus,
  Import,
  ListPlus,
  MoreHorizontal,
  Play,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { dirName } from '@/lib/paths'
import { formatDuration, formatMs } from '@/lib/format'
import { api, isTauri, pickFiles, pickFolders, revealPath } from '@/lib/tauri'
import { canRun, importPaths, isFolderPair, jobTitle } from '@/lib/jobs'
import { startQueue, stopQueue } from '@/lib/processing'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store/app-store'
import { useSettingsStore } from '@/store/settings-store'
import type { FileEntry, Job, JobStatus } from '@/types'
import { STEP_NAMES } from '@/types'
import { JOB_STATUS } from './status'
import { ProgressBar } from './ProgressBar'

const GRID =
  'grid grid-cols-[44px_minmax(0,1fr)_200px_190px_80px_44px] items-center'

const fileStatusToJob = (s: FileEntry['status']): JobStatus =>
  s === 'processing'
    ? 'running'
    : s === 'completed'
      ? 'completed'
      : s === 'error'
        ? 'failed'
        : 'queued'
const elapsed = (a?: number, b?: number) =>
  a && b ? (b - a) / 1000 : undefined
const stepLabel = (job: Job) => {
  const parts = job.currentStep?.split(' - ')
  return parts?.[parts.length - 1]
}

function StatusCell({
  status,
  detail,
  title,
}: {
  status: JobStatus
  detail?: string
  title?: string
}) {
  const s = JOB_STATUS[status]
  return (
    <div
      className={cn('flex min-w-0 items-center gap-1.5 text-[13px]', s.text)}
      title={title}
    >
      <s.Icon className={cn('size-[13px] shrink-0', s.iconClass)} />
      <span className="shrink-0">{s.label}</span>
      {detail ? (
        <span className="truncate text-muted-foreground">· {detail}</span>
      ) : null}
    </div>
  )
}

function FileRow({ file }: { file: FileEntry }) {
  const status = fileStatusToJob(file.status)
  return (
    <div
      className={cn(
        GRID,
        'min-h-10 border-b bg-muted/25 text-[13px] text-muted-foreground'
      )}
    >
      <div />
      <div className="flex min-w-0 items-center gap-2 pl-7 pr-3">
        <File className="size-3.5 shrink-0" />
        <span className="truncate" title={file.name}>
          {file.name}
        </span>
      </div>
      <div className="px-3">
        <ProgressBar
          percent={file.progress}
          status={status}
          label={file.name}
        />
      </div>
      <div className="px-3">
        <StatusCell
          status={status}
          detail={
            file.status === 'processing'
              ? file.stepName || STEP_NAMES[file.stepIndex]
              : undefined
          }
          title={file.status === 'error' ? file.stepName : undefined}
        />
      </div>
      <div className="px-3 tabular-nums">
        {file.status === 'processing'
          ? formatDuration(file.etaSeconds)
          : file.status === 'completed'
            ? formatDuration(elapsed(file.startedAt, file.finishedAt))
            : ''}
      </div>
      <div />
    </div>
  )
}

function JobRow({ job, files }: { job: Job; files: FileEntry[] }) {
  const expanded = useAppStore(s => s.expandedJobs.has(job.id))
  const toggleExpanded = useAppStore(s => s.toggleExpanded)
  const setJobSelected = useAppStore(s => s.setJobSelected)
  const removeJob = useAppStore(s => s.removeJob)
  const busy = useAppStore(s => s.runStatus === 'processing')
  const defaultOutput = useSettingsStore(s => s.toolPaths.defaultOutput)
  const folder = isFolderPair(job)
  const title = folder
    ? `${jobTitle(job)}${job.fileTotal ? ` (${job.fileTotal} files)` : ''}`
    : jobTitle(job)
  const outputDir = job.outputPath
    ? job.outputKind === 'file'
      ? dirName(job.outputPath)
      : job.outputPath
    : defaultOutput
  const sub = folder
    ? `${job.hdrPath} + ${job.dvPath} → ${outputDir}`
    : [
        job.hdr10plusPath ? 'HDR10+' : 'HDR10',
        'DV',
        job.dvDelayMs ? `DV ${formatMs(job.dvDelayMs)}` : null,
        job.hdr10plusDelayMs
          ? `HDR10+ ${formatMs(job.hdr10plusDelayMs)}`
          : null,
        outputDir,
      ]
        .filter(Boolean)
        .join(' · ')
  const single = !folder ? files[0] : undefined
  const detail =
    job.status === 'running'
      ? folder && job.fileTotal
        ? `${files.filter(f => f.status === 'completed').length} of ${job.fileTotal}`
        : [
            stepLabel(job),
            single
              ? `step ${single.stepIndex + 1} of ${STEP_NAMES.length}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')
      : job.status === 'failed'
        ? job.error
        : undefined
  const eta =
    job.status === 'running'
      ? formatDuration(job.etaSeconds)
      : job.status === 'completed'
        ? formatDuration(elapsed(job.startedAt, job.finishedAt))
        : ''

  return (
    <>
      <div
        className={cn(GRID, 'min-h-[52px] border-b text-sm hover:bg-accent/50')}
      >
        <div className="flex justify-center">
          <Checkbox
            checked={job.selected}
            disabled={busy}
            onCheckedChange={v => setJobSelected(job.id, v === true)}
            aria-label={`Select ${title}`}
          />
        </div>
        <div className="flex min-w-0 items-center gap-2 pr-3">
          {folder && files.length ? (
            <button
              type="button"
              onClick={() => toggleExpanded(job.id)}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
            </button>
          ) : (
            <span className="size-5 shrink-0" />
          )}
          {folder ? (
            <Folder className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <File className="size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <div className="truncate font-medium" title={title}>
              {title}
            </div>
            <div className="truncate text-xs text-muted-foreground" title={sub}>
              {sub}
            </div>
          </div>
        </div>
        <div className="px-3">
          <ProgressBar
            percent={job.progress}
            status={job.status}
            label={title}
          />
        </div>
        <div className="px-3">
          <StatusCell status={job.status} detail={detail} title={job.error} />
        </div>
        <div className="px-3 text-[13px] tabular-nums text-muted-foreground">
          {eta}
        </div>
        <div className="flex justify-center">
          {job.status === 'completed' && isTauri() ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-foreground"
                  onClick={() => void revealPath(outputDir || job.hdrPath)}
                  aria-label="Show in folder"
                >
                  <FolderOpen className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">Show in folder</TooltipContent>
            </Tooltip>
          ) : job.status !== 'running' ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              onClick={() => removeJob(job.id)}
              aria-label="Remove"
            >
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>
      {expanded && folder
        ? files.map(f => <FileRow key={f.id} file={f} />)
        : null}
    </>
  )
}

async function pick(kind: 'files' | 'folders') {
  if (!isTauri()) return
  try {
    const paths = kind === 'files' ? await pickFiles() : await pickFolders()
    if (paths.length) importPaths(await api.inspectPaths(paths))
  } catch (error) {
    useAppStore
      .getState()
      .addLog('error', `File dialog failed: ${String(error)}`)
  }
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
      <div className="mb-2 flex size-16 items-center justify-center rounded-full bg-muted">
        <ListPlus className="size-6 text-muted-foreground" />
      </div>
      <p className="text-base font-medium">Nothing queued</p>
      <p className="max-w-[440px] text-[13px] text-muted-foreground">
        Use Import to pick files or folders, drop them anywhere in this window,
        or fill in the pair on the left. Several folders at once are paired by
        name and queued as separate items.
      </p>
    </div>
  )
}

export function QueueTable() {
  const jobs = useAppStore(s => s.jobs)
  const filesById = useAppStore(s => s.files)
  const runStatus = useAppStore(s => s.runStatus)
  const cancelling = useAppStore(s => s.cancelling)
  const setAllSelected = useAppStore(s => s.setAllSelected)
  const removeFinishedJobs = useAppStore(s => s.removeFinishedJobs)
  const clearQueue = useAppStore(s => s.clearQueue)
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
  const runnable = jobs.filter(canRun).length
  const selectable = jobs.filter(j => j.status !== 'completed')
  const selected = selectable.filter(j => j.selected).length
  const allSelected = selectable.length > 0 && selected === selectable.length
  const workers = jobs.reduce((n, j) => n + (j.activeWorkers ?? 0), 0)
  const files = jobs.reduce((n, j) => n + (j.fileTotal ?? 1), 0)
  const summary = jobs.length
    ? [
        `${jobs.length} item${jobs.length === 1 ? '' : 's'}`,
        files > jobs.length ? `${files} files` : null,
        running ? `${running} running` : null,
        busy && workers ? `${workers} of ${parallelTasks} workers` : null,
        completed === jobs.length
          ? 'all completed'
          : completed
            ? `${completed} done`
            : null,
        failed ? `${failed} failed` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Empty'

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-base font-semibold">Queue</h2>
          <span className="truncate text-[13px] tabular-nums text-muted-foreground">
            {summary}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary">
                <Import className="size-3.5" /> Import
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void pick('files')}>
                <FilePlus className="size-4" /> Files…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void pick('folders')}>
                <FolderPlus className="size-4" /> Folders…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-foreground"
                disabled={completed === 0}
                onClick={removeFinishedJobs}
                aria-label="Clear finished"
              >
                <Trash2 className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Clear finished</TooltipContent>
          </Tooltip>
          {busy ? (
            <Button
              variant="secondary"
              disabled={cancelling}
              onClick={() => void stopQueue()}
            >
              <Square className="size-3.5" />{' '}
              {cancelling ? 'Stopping…' : 'Stop'}
            </Button>
          ) : (
            <Button
              variant="secondary"
              disabled={runnable === 0}
              onClick={() => void startQueue()}
            >
              <Play className="size-3.5" /> Start
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-foreground"
                aria-label="More"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={busy || jobs.length === 0}
                onSelect={() => setAllSelected(!allSelected)}
              >
                {allSelected ? 'Deselect all' : 'Select all'}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={completed === 0}
                onSelect={removeFinishedJobs}
              >
                Clear finished
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={busy || jobs.length === 0}
                onSelect={clearQueue}
              >
                Clear queue
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
        <div
          className={cn(
            GRID,
            'h-10 shrink-0 border-b text-[13px] text-muted-foreground'
          )}
        >
          <div className="flex justify-center">
            <Checkbox
              checked={
                allSelected ? true : selected > 0 ? 'indeterminate' : false
              }
              disabled={busy || selectable.length === 0}
              onCheckedChange={v => setAllSelected(v === true)}
              aria-label="Select all"
            />
          </div>
          <div>Name</div>
          <div className="px-3">Progress</div>
          <div className="px-3">Status</div>
          <div className="px-3">ETA</div>
          <div />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {jobs.length === 0 ? (
            <EmptyState />
          ) : (
            jobs.map(job => (
              <JobRow
                key={job.id}
                job={job}
                files={filesByJob.get(job.id) ?? []}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
