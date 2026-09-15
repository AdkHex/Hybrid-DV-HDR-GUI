import { useEffect } from 'react'
import { ChevronDown, ChevronRight, FolderOpen, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  isTauri,
  pickFile,
  pickFolder,
  pickSaveFile,
  revealPath,
  api,
} from '@/lib/tauri'
import { delayFrames, formatDuration, formatFps } from '@/lib/format'
import { baseName } from '@/lib/paths'
import { isFolderPair, isMixed, jobTitle } from '@/lib/jobs'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useAppStore, type ProbeState } from '@/store/app-store'
import { useSettingsStore } from '@/store/settings-store'
import type { FileEntry, Job, JobStatus } from '@/types'
import { STEP_NAMES } from '@/types'
import { JOB_STATUS } from '@/components/queue/status'
import { ProgressBar } from '@/components/queue/ProgressBar'
import { StepStrip } from '@/components/queue/StepStrip'
import { PathField } from './PathField'

function probeMeta(
  probe: ProbeState | undefined,
  kind: Job['hdrKind'],
  extra?: string
): string {
  if (kind === 'folder') return ''
  if (!probe) return ''
  if (probe.state === 'loading') return 'reading…'
  if (probe.state === 'error') return 'could not read'
  const { info } = probe
  const parts = [
    info.codec?.includes('HEVC') || info.codec?.includes('H.265')
      ? 'HEVC'
      : info.codec,
    `${info.height}p`,
    `${formatFps(info.fps)} fps`,
    extra,
  ].filter(Boolean)
  return parts.join(' · ')
}

function OffsetInput({
  label,
  value,
  fps,
  disabled,
  onChange,
}: {
  label: string
  value: number
  fps?: number
  disabled?: boolean
  onChange: (v: number) => void
}) {
  const frames = delayFrames(value, fps)
  return (
    <label
      className="flex h-8 items-center gap-1.5 rounded-md border border-input px-2.5 text-[13px]"
      title={
        frames
          ? `${frames} frame${frames === 1 ? '' : 's'} at ${fps ? formatFps(fps) : '?'} fps`
          : 'No shift'
      }
    >
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input
        inputMode="numeric"
        value={value === 0 ? '' : value}
        placeholder="0"
        disabled={disabled}
        onChange={e => {
          const n = Number.parseFloat(e.target.value)
          onChange(Number.isFinite(n) ? n : 0)
        }}
        className="w-12 bg-transparent text-right outline-none disabled:opacity-60"
      />
      <span className="text-[11px] text-muted-foreground">ms</span>
    </label>
  )
}

function fileStatusToJob(status: FileEntry['status']): JobStatus {
  return status === 'processing'
    ? 'running'
    : status === 'completed'
      ? 'completed'
      : status === 'error'
        ? 'failed'
        : 'queued'
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

const elapsed = (a?: number, b?: number) =>
  a && b ? (b - a) / 1000 : undefined

/** Last segment of the backend's "i/total name - Step" label. */
function stepLabel(job: Job) {
  const parts = job.currentStep?.split(' - ')
  return parts?.[parts.length - 1]
}

export function PairCard({ job, files }: { job: Job; files: FileEntry[] }) {
  const expanded = useAppStore(s => s.expandedJobs.has(job.id))
  const toggleExpanded = useAppStore(s => s.toggleExpanded)
  const updateJob = useAppStore(s => s.updateJob)
  const removeJob = useAppStore(s => s.removeJob)
  const probes = useAppStore(s => s.probes)
  const setProbe = useAppStore(s => s.setProbe)
  const addLog = useAppStore(s => s.addLog)
  const setLogVisible = useSettingsStore(s => s.setLogVisible)
  const toolPaths = useSettingsStore(s => s.toolPaths)
  const defaultOutput = useSettingsStore(s => s.toolPaths.defaultOutput)
  const running = job.status === 'running'
  const folder = isFolderPair(job)
  const mixed = isMixed(job)

  // Probe picked files once so the fields can show what they are.
  useEffect(() => {
    if (!isTauri()) return
    for (const [path, kind] of [
      [job.hdrPath, job.hdrKind],
      [job.dvPath, job.dvKind],
    ] as const) {
      if (!path || kind !== 'file' || probes[path]) continue
      setProbe(path, { state: 'loading' })
      api
        .probeSource(path, toolPaths)
        .then(info => setProbe(path, { state: 'ok', info }))
        .catch(error =>
          setProbe(path, { state: 'error', message: String(error) })
        )
    }
  }, [
    job.hdrPath,
    job.hdrKind,
    job.dvPath,
    job.dvKind,
    probes,
    setProbe,
    toolPaths,
  ])

  const hdrProbe = probes[job.hdrPath]
  const dvProbe = probes[job.dvPath]
  const hdrInfo = hdrProbe?.state === 'ok' ? hdrProbe.info : undefined
  const dvInfo = dvProbe?.state === 'ok' ? dvProbe.info : undefined
  const fpsMismatch =
    hdrInfo && dvInfo && Math.abs(hdrInfo.fps - dvInfo.fps) > 0.001
  const letterbox = hdrInfo && dvInfo && hdrInfo.height !== dvInfo.height
  const fps = hdrInfo?.fps ?? dvInfo?.fps

  const choose = async (
    slot: 'hdr' | 'dv' | 'hdr10plus' | 'output',
    kind: 'file' | 'folder'
  ) => {
    try {
      if (!isTauri()) {
        const manual = window.prompt(`Enter a ${kind} path:`)
        if (manual) apply(slot, manual, kind)
        return
      }
      const picked =
        slot === 'output' && kind === 'file'
          ? await pickSaveFile(job.outputPath || undefined)
          : kind === 'folder'
            ? await pickFolder()
            : await pickFile()
      if (picked) apply(slot, picked, kind)
    } catch (error) {
      addLog('error', `File dialog failed: ${String(error)}`)
    }
  }
  const apply = (
    slot: 'hdr' | 'dv' | 'hdr10plus' | 'output',
    value: string,
    kind: Job['hdrKind']
  ) => {
    const k = value ? kind : 'unknown'
    if (slot === 'hdr') updateJob(job.id, { hdrPath: value, hdrKind: k })
    else if (slot === 'dv') updateJob(job.id, { dvPath: value, dvKind: k })
    else if (slot === 'hdr10plus') updateJob(job.id, { hdr10plusPath: value })
    else updateJob(job.id, { outputPath: value, outputKind: k })
  }
  const swap = () =>
    updateJob(job.id, {
      hdrPath: job.dvPath,
      hdrKind: job.dvKind,
      dvPath: job.hdrPath,
      dvKind: job.hdrKind,
    })

  const s = JOB_STATUS[job.status]
  const title = jobTitle(job)
  const sub = folder
    ? `folder pair${job.fileTotal ? ` · ${job.fileTotal} files` : ''}`
    : job.hdr10plusPath
      ? 'HDR10+'
      : ''
  const doneFiles = files.filter(f => f.status === 'completed').length
  const singleFile = !folder ? files[0] : undefined

  let statusLine: React.ReactNode = null
  if (running) {
    statusLine = folder
      ? `${doneFiles} of ${job.fileTotal ?? '?'} done · ${job.activeWorkers ?? 0} running${job.etaSeconds ? ` · about ${formatDuration(job.etaSeconds)} left` : ''}`
      : `${singleFile ? `Step ${singleFile.stepIndex + 1} of ${STEP_NAMES.length} · ` : ''}${stepLabel(job) ?? 'Starting…'}${job.etaSeconds ? ` · about ${formatDuration(job.etaSeconds)} left` : ''}`
  } else if (job.status === 'completed') {
    const took = formatDuration(elapsed(job.startedAt, job.finishedAt))
    statusLine = folder
      ? `${job.fileTotal ?? files.length} files${took ? ` · ${took}` : ''}`
      : `Finished${took ? ` in ${took}` : ''}`
  } else if (job.status === 'failed') {
    statusLine = (
      <>
        <span className="text-status-danger">
          Failed
          {singleFile?.status === 'error'
            ? ` at step ${singleFile.stepIndex + 1} · ${STEP_NAMES[singleFile.stepIndex]}`
            : ''}
        </span>
        {job.error ? <> · {job.error}</> : null}
        {' · '}
        <button
          type="button"
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
          onClick={() => setLogVisible(true)}
        >
          Show log
        </button>
      </>
    )
  }
  const showProgress = job.status !== 'queued'

  return (
    <div className="rounded-[10px] border bg-card">
      <div className="flex items-center gap-2.5 py-2.5 pl-3 pr-2.5">
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
        <div
          className="min-w-0 flex-1 truncate text-sm font-medium"
          title={title}
        >
          {title}
          {sub ? (
            <span className="ml-2 font-normal text-muted-foreground">
              {sub}
            </span>
          ) : null}
        </div>
        <span
          className={cn('flex shrink-0 items-center gap-1.5 text-xs', s.text)}
        >
          <s.Icon className={cn('size-3', s.iconClass)} />
          {s.label}
        </span>
        {job.status === 'completed' && isTauri() ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={() =>
                  void revealPath(
                    folder
                      ? job.outputPath || job.hdrPath
                      : job.outputPath || defaultOutput
                  )
                }
                aria-label="Show in folder"
              >
                <FolderOpen className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Show in folder</TooltipContent>
          </Tooltip>
        ) : null}
        {!running ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => removeJob(job.id)}
            aria-label="Remove"
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>

      {expanded ? (
        <div className="grid grid-cols-[88px_1fr] items-center gap-x-3 gap-y-2 border-t px-3.5 py-3">
          <span className="text-xs text-muted-foreground">Base</span>
          <PathField
            value={job.hdrPath}
            kind={job.hdrKind}
            placeholder="Choose the HDR10 / HDR10+ file or folder"
            meta={probeMeta(hdrProbe, job.hdrKind)}
            disabled={running}
            showPath={job.hdrKind === 'folder'}
            onPickFile={() => choose('hdr', 'file')}
            onPickFolder={() => choose('hdr', 'folder')}
            onSwap={job.hdrPath && job.dvPath ? swap : undefined}
            onClear={() => apply('hdr', '', 'unknown')}
          />
          <span className="text-xs text-muted-foreground">Dolby Vision</span>
          <div className="min-w-0">
            <PathField
              value={job.dvPath}
              kind={job.dvKind}
              placeholder="Choose the Dolby Vision file or folder"
              meta={probeMeta(
                dvProbe,
                job.dvKind,
                fpsMismatch
                  ? 'frame rate differs'
                  : letterbox
                    ? 'letterboxed'
                    : undefined
              )}
              disabled={running}
              showPath={job.dvKind === 'folder'}
              onPickFile={() => choose('dv', 'file')}
              onPickFolder={() => choose('dv', 'folder')}
              onSwap={job.hdrPath && job.dvPath ? swap : undefined}
              onClear={() => apply('dv', '', 'unknown')}
            />
            {mixed ? (
              <p className="mt-1 text-[11px] text-status-danger">
                Base and donor must both be files or both be folders.
              </p>
            ) : null}
            {fpsMismatch ? (
              <p className="mt-1 text-[11px] text-status-danger">
                Frame rates differ — the job will be refused.
              </p>
            ) : null}
          </div>
          <span className="text-xs text-muted-foreground">HDR10+</span>
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <PathField
                value={job.hdr10plusPath}
                kind={job.hdrKind === 'folder' ? 'folder' : 'file'}
                placeholder="Same as base"
                disabled={running}
                onPickFile={() => choose('hdr10plus', 'file')}
                onPickFolder={() => choose('hdr10plus', 'folder')}
                onClear={() => apply('hdr10plus', '', 'unknown')}
              />
            </div>
            <span className="ml-1 text-xs text-muted-foreground">Offsets</span>
            <OffsetInput
              label="DV"
              value={job.dvDelayMs}
              fps={fps}
              disabled={running}
              onChange={v => updateJob(job.id, { dvDelayMs: v })}
            />
            <OffsetInput
              label="HDR10+"
              value={job.hdr10plusDelayMs}
              fps={fps}
              disabled={running}
              onChange={v => updateJob(job.id, { hdr10plusDelayMs: v })}
            />
          </div>
          <span className="text-xs text-muted-foreground">Output</span>
          <PathField
            value={job.outputPath}
            kind={job.outputKind === 'unknown' ? 'folder' : job.outputKind}
            placeholder={
              defaultOutput
                ? `${baseName(defaultOutput)} (default)`
                : 'Default folder'
            }
            disabled={running}
            showPath
            onPickFile={folder ? undefined : () => choose('output', 'file')}
            onPickFolder={() => choose('output', 'folder')}
            onClear={() => apply('output', '', 'unknown')}
            fileLabel="Save as…"
          />
        </div>
      ) : null}

      {showProgress ? (
        <div className="border-t px-3.5 pb-3 pt-2.5">
          <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{statusLine}</span>
            <span className="tabular-nums">{Math.round(job.progress)}%</span>
          </div>
          <div className="mt-2">
            <ProgressBar
              percent={job.progress}
              status={job.status}
              label={title}
              hidePercent
            />
          </div>
          {singleFile &&
          (singleFile.status === 'processing' ||
            singleFile.status === 'error') ? (
            <StepStrip
              stepIndex={singleFile.stepIndex}
              stepPercent={stepPercent(singleFile)}
              status={singleFile.status}
              bare
            />
          ) : null}
          {folder && files.length ? (
            <div className="mt-2.5 grid grid-cols-[1fr_160px_150px] items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {files.map(f => (
                <div key={f.id} className="contents">
                  <span
                    className={cn(
                      'truncate',
                      f.status === 'processing' && 'text-foreground',
                      f.status === 'completed' && 'opacity-60'
                    )}
                    title={f.name}
                  >
                    {f.name}
                  </span>
                  <ProgressBar
                    percent={f.progress}
                    status={fileStatusToJob(f.status)}
                    label={f.name}
                    hidePercent
                  />
                  <span className="truncate whitespace-nowrap">
                    {f.status === 'processing' ? (
                      `${f.stepName || STEP_NAMES[f.stepIndex]}${f.etaSeconds ? ` · ${formatDuration(f.etaSeconds)}` : ''}`
                    ) : f.status === 'completed' ? (
                      `done${elapsed(f.startedAt, f.finishedAt) ? ` · ${formatDuration(elapsed(f.startedAt, f.finishedAt))}` : ''}`
                    ) : f.status === 'error' ? (
                      <span className="text-status-danger">
                        {f.stepName || 'failed'}
                      </span>
                    ) : (
                      'waiting'
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
