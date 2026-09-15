import { useMemo } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  ListPlus,
  MoreHorizontal,
  Play,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { dirName } from '@/lib/paths'
import { formatDuration, formatMs } from '@/lib/format'
import { isTauri, pickFiles, pickFolder, revealPath, api } from '@/lib/tauri'
import { startQueue, stopQueue } from '@/lib/processing'
import { assignDroppedPaths } from '@/hooks/useFileDrop'
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
import { StepStrip } from './StepStrip'

const GRID =
  'grid grid-cols-[40px_minmax(240px,1fr)_220px_220px_80px_44px] items-center'

function fileStatusToJob(status: FileEntry['status']): JobStatus {
  switch (status) {
    case 'processing':
      return 'running'
    case 'completed':
      return 'completed'
    case 'error':
      return 'failed'
    default:
      return 'queued'
  }
}

function stepPercent(file: FileEntry): number | undefined {
  if (file.status !== 'processing') return undefined
  return Math.max(
    0,
    Math.min(
      100,
      Math.round(file.progress * STEP_NAMES.length - file.stepIndex * 100)
    )
  )
}

/** "Step label" the backend puts in currentStep: "i/total name - Step" or "Step". */
function stepLabel(job: Job): string | undefined {
  if (!job.currentStep) return undefined
  const parts = job.currentStep.split(' - ')
  return parts[parts.length - 1]
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
      className={cn('flex min-w-0 items-center gap-1.5 text-xs', s.text)}
      title={title}
    >
      <s.Icon className={cn('size-3 shrink-0', s.iconClass)} />
      <span className="shrink-0">{s.label}</span>
      {detail ? (
        <span className="truncate text-muted-foreground">· {detail}</span>
      ) : null}
    </div>
  )
}

function elapsed(start?: number, end?: number) {
  if (!start || !end) return undefined
  return (end - start) / 1000
}

function FileRow({ file }: { file: FileEntry }) {
  const status = fileStatusToJob(file.status)
  const showStrip = file.status === 'processing' || file.status === 'error'
  return (
    <>
      <div
        className={cn(
          GRID,
          'min-h-9 border-b bg-muted/25 text-xs text-muted-foreground'
        )}
      >
        <div />
        <div className="flex min-w-0 items-center gap-1.5 pl-6 pr-2.5">
          <File className="size-3.5 shrink-0" />
          <span className="truncate" title={file.name}>
            {file.name}
          </span>
        </div>
        <div className="px-2.5">
          <ProgressBar
            percent={file.progress}
            status={status}
            label={file.name}
          />
        </div>
        <div className="px-2.5">
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
        <div className="px-2.5 tabular-nums">
          {file.status === 'processing'
            ? formatDuration(file.etaSeconds)
            : file.status === 'completed'
              ? formatDuration(elapsed(file.startedAt, file.finishedAt))
              : ''}
        </div>
        <div />
      </div>
      {showStrip ? (
        <StepStrip
          stepIndex={file.stepIndex}
          stepPercent={stepPercent(file)}
          status={file.status}
          note={file.status === 'error' ? file.stepName : undefined}
        />
      ) : null}
    </>
  )
}

function JobRow({ job, files }: { job: Job; files: FileEntry[] }) {
  const expanded = useAppStore(s => s.expandedJobs.has(job.id))
  const toggleExpanded = useAppStore(s => s.toggleExpanded)
  const setJobSelected = useAppStore(s => s.setJobSelected)
  const removeJob = useAppStore(s => s.removeJob)
  const runStatus = useAppStore(s => s.runStatus)
  const defaultOutput = useSettingsStore(s => s.toolPaths.defaultOutput)
  const busy = runStatus === 'processing'
  const sources = [
    job.hdr10plusPath ? 'HDR10+' : 'HDR10',
    'DV',
    job.dvDelayMs ? `DV ${formatMs(job.dvDelayMs)}` : null,
    job.hdr10plusDelayMs ? `HDR10+ ${formatMs(job.hdr10plusDelayMs)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const outputDir = job.outputPath ? dirName(job.outputPath) : defaultOutput
  const sub = `${sources} · ${job.isFolderPair ? job.hdrPath : outputDir || dirName(job.hdrPath)}`
  const singleFile = !job.isFolderPair ? files[0] : undefined
  const detail =
    job.status === 'running'
      ? job.isFolderPair && job.fileTotal
        ? `${files.filter(f => f.status === 'completed').length} of ${job.fileTotal}`
        : stepLabel(job)
      : job.status === 'failed'
        ? job.error
        : undefined
  const eta =
    job.status === 'running'
      ? formatDuration(job.etaSeconds)
      : job.status === 'completed'
        ? formatDuration(elapsed(job.startedAt, job.finishedAt))
        : ''
  const canExpand = job.isFolderPair ? files.length > 0 : Boolean(singleFile)

  return (
    <>
      <div className={cn(GRID, 'min-h-12 border-b text-sm hover:bg-accent/50')}>
        <div className="flex justify-center">
          <Checkbox
            checked={job.selected}
            disabled={busy}
            onCheckedChange={v => setJobSelected(job.id, v === true)}
            aria-label={`Select ${job.name}`}
          />
        </div>
        <div className="flex min-w-0 items-center gap-1.5 pr-2.5">
          {canExpand ? (
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
          {job.isFolderPair ? (
            <Folder className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <File className="size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <div className="truncate font-medium" title={job.name}>
              {job.name}
            </div>
            <div
              className="truncate text-[11px] text-muted-foreground"
              title={sub}
            >
              {sub}
            </div>
          </div>
        </div>
        <div className="px-2.5">
          <ProgressBar
            percent={job.progress}
            status={job.status}
            label={job.name}
          />
        </div>
        <div className="px-2.5">
          <StatusCell status={job.status} detail={detail} title={job.error} />
        </div>
        <div className="px-2.5 text-xs tabular-nums text-muted-foreground">
          {eta}
        </div>
        <div className="flex justify-end pr-2">
          {job.status === 'completed' && isTauri() ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    void revealPath(
                      job.isFolderPair
                        ? job.hdrPath
                        : job.outputPath || job.hdrPath
                    )
                  }
                  aria-label="Show in folder"
                >
                  <FolderOpen className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">Show in folder</TooltipContent>
            </Tooltip>
          ) : job.status !== 'running' ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={() => removeJob(job.id)}
              aria-label="Remove from queue"
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
      {expanded && job.isFolderPair
        ? files.map(f => <FileRow key={f.id} file={f} />)
        : null}
      {expanded &&
      singleFile &&
      (singleFile.status === 'processing' || singleFile.status === 'error') ? (
        <StepStrip
          stepIndex={singleFile.stepIndex}
          stepPercent={stepPercent(singleFile)}
          status={singleFile.status}
          note={singleFile.status === 'error' ? singleFile.stepName : undefined}
        />
      ) : null}
    </>
  )
}

function EmptyState() {
  const addLog = useAppStore(s => s.addLog)
  const sidebarVisible = useSettingsStore(s => s.sidebarVisible)
  const pick = async (kind: 'files' | 'folder') => {
    if (!isTauri()) return
    try {
      const paths =
        kind === 'files'
          ? await pickFiles()
          : [await pickFolder()].filter((p): p is string => !!p)
      if (!paths.length) return
      const infos = await api.inspectPaths(paths)
      assignDroppedPaths(infos.filter(i => i.exists))
    } catch (error) {
      addLog('error', `File dialog failed: ${String(error)}`)
    }
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
      <div className="mb-2 flex size-14 items-center justify-center rounded-full bg-muted">
        <ListPlus className="size-6 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">Nothing queued</p>
      <p className="max-w-[360px] text-xs text-muted-foreground">
        {sidebarVisible
          ? 'Pick an HDR10 / HDR10+ base and a Dolby Vision donor on the left, then add the pair — or drop files or folders anywhere in this window.'
          : 'Drop files or folders anywhere in this window, or use the buttons below. Names containing HDR, HDR10+ or DV are sorted into the right slot.'}
      </p>
      <div className="mt-2 flex gap-2">
        <Button variant="outline" size="sm" onClick={() => void pick('files')}>
          Add files…
        </Button>
        <Button variant="outline" size="sm" onClick={() => void pick('folder')}>
          Add folder…
        </Button>
      </div>
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
  const failed = jobs.filter(j => j.status === 'failed').length
  const completed = jobs.filter(j => j.status === 'completed').length
  const selectable = jobs.filter(j => j.status !== 'completed')
  const selected = selectable.filter(j => j.selected).length
  const allSelected = selectable.length > 0 && selected === selectable.length
  const workers = jobs.reduce((sum, j) => sum + (j.activeWorkers ?? 0), 0)

  const statusText =
    jobs.length === 0
      ? 'Empty'
      : [
          `${jobs.length} job${jobs.length === 1 ? '' : 's'}`,
          running ? `${running} running` : null,
          busy && workers ? `${workers} of ${parallelTasks} workers` : null,
          completed ? `${completed} done` : null,
          failed ? `${failed} failed` : null,
        ]
          .filter(Boolean)
          .join(' · ')

  const handleClear = () => {
    if (busy) return
    clearQueue()
    toast('Queue cleared')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-5 pb-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-sm font-semibold">Queue</h2>
          <span className="truncate text-xs tabular-nums text-muted-foreground">
            {statusText}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-foreground"
                disabled={completed === 0}
                onClick={removeFinishedJobs}
                aria-label="Remove finished"
              >
                <Trash2 className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Remove finished</TooltipContent>
          </Tooltip>
          {busy ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={cancelling}
              onClick={() => void stopQueue()}
            >
              <Square className="size-3.5" />{' '}
              {cancelling ? 'Stopping…' : 'Stop'}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={selected === 0}
              onClick={() => void startQueue()}
              title={selected === 0 ? 'Select at least one job' : undefined}
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
                Remove finished
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={busy || jobs.length === 0}
                onSelect={handleClear}
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
            'h-9 shrink-0 border-b text-xs text-muted-foreground'
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
          <div className="px-2.5">Progress</div>
          <div className="px-2.5">Status</div>
          <div className="px-2.5">ETA</div>
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
