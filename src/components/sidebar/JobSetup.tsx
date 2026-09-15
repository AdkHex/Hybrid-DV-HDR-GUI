import { useEffect, useState } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api, isTauri, pickFile, pickFolder, pickSaveFile } from '@/lib/tauri'
import { autoOutputName, baseName, displayLabel } from '@/lib/paths'
import { delayFrames, formatFps, formatMs } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  useAppStore,
  type JobSetup as Setup,
  type PathKind,
  type ProbeState,
} from '@/store/app-store'
import { useSettingsStore } from '@/store/settings-store'
import type { Job } from '@/types'
import { PathPicker } from './PathPicker'

function SectionLabel({
  children,
  hint,
}: {
  children: React.ReactNode
  hint?: string
}) {
  return (
    <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      <span>{children}</span>
      {hint ? (
        <span className="font-normal normal-case tracking-normal">{hint}</span>
      ) : null}
    </div>
  )
}

function FieldLabel({
  children,
  hint,
}: {
  children: React.ReactNode
  hint?: string
}) {
  return (
    <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
      <span>{children}</span>
      {hint ? <span>{hint}</span> : null}
    </div>
  )
}

function ProbeLine({
  probe,
  kind,
  extra,
}: {
  probe?: ProbeState
  kind: PathKind
  extra?: React.ReactNode
}) {
  if (kind === 'folder') {
    return (
      <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
        Folder — files are paired by name
      </p>
    )
  }
  if (!probe) return null
  if (probe.state === 'loading') {
    return <p className="mt-1.5 text-[11px] text-muted-foreground">Reading…</p>
  }
  if (probe.state === 'error') {
    return (
      <p
        className="mt-1.5 truncate text-[11px] text-status-warning"
        title={probe.message}
      >
        {probe.message}
      </p>
    )
  }
  const { info } = probe
  const parts = [
    `${info.height}p`,
    `${formatFps(info.fps)} fps`,
    info.codec?.includes('HEVC') || info.codec?.includes('H.265')
      ? 'HEVC'
      : info.codec,
    info.hasAudioOrSubs ? 'audio/subs' : null,
  ].filter(Boolean)
  return (
    <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
      {parts.join(' · ')}
      {extra}
    </p>
  )
}

const parseDelay = (value: string) => {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === '+' || trimmed === '-') return 0
  const parsed = Number.parseFloat(trimmed)
  return Number.isFinite(parsed) ? parsed : 0
}

export function JobSetup() {
  const setup = useAppStore(s => s.setup)
  const setSetup = useAppStore(s => s.setSetup)
  const resetSetup = useAppStore(s => s.resetSetup)
  const probes = useAppStore(s => s.probes)
  const setProbe = useAppStore(s => s.setProbe)
  const addJob = useAppStore(s => s.addJob)
  const addLog = useAppStore(s => s.addLog)
  const runStatus = useAppStore(s => s.runStatus)
  const toolPaths = useSettingsStore(s => s.toolPaths)
  const [offsetsOpen, setOffsetsOpen] = useState(false)
  const busy = runStatus === 'processing'

  // Probe each picked file once so the picker can show what it is.
  useEffect(() => {
    if (!isTauri()) return
    const targets = [
      [setup.hdrPath, setup.hdrKind],
      [setup.dvPath, setup.dvKind],
    ] as const
    for (const [path, kind] of targets) {
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
    setup.hdrPath,
    setup.hdrKind,
    setup.dvPath,
    setup.dvKind,
    probes,
    setProbe,
    toolPaths,
  ])

  const hdrProbe = probes[setup.hdrPath]
  const dvProbe = probes[setup.dvPath]
  const hdrInfo = hdrProbe?.state === 'ok' ? hdrProbe.info : undefined
  const dvInfo = dvProbe?.state === 'ok' ? dvProbe.info : undefined
  const fpsMismatch =
    hdrInfo && dvInfo && Math.abs(hdrInfo.fps - dvInfo.fps) > 0.001
  const letterbox = hdrInfo && dvInfo && hdrInfo.height !== dvInfo.height
  const fps = hdrInfo?.fps ?? dvInfo?.fps

  const set = (key: keyof Setup, value: string, kind?: PathKind) => {
    const patch: Partial<Setup> = { [key]: value }
    if (key === 'hdrPath' && kind) patch.hdrKind = value ? kind : 'unknown'
    if (key === 'dvPath' && kind) patch.dvKind = value ? kind : 'unknown'
    if (key === 'outputPath' && kind)
      patch.outputKind = value ? kind : 'unknown'
    setSetup(patch)
  }

  const choose = async (
    key: 'hdrPath' | 'dvPath' | 'hdr10plusPath' | 'outputPath',
    kind: 'file' | 'folder'
  ) => {
    try {
      if (!isTauri()) {
        const manual = window.prompt(`Enter a ${kind} path:`)
        if (manual) set(key, manual, kind)
        return
      }
      const picked =
        key === 'outputPath' && kind === 'file'
          ? await pickSaveFile(setup.outputPath || undefined)
          : kind === 'folder'
            ? await pickFolder()
            : await pickFile()
      if (picked) set(key, picked, kind)
    } catch (error) {
      addLog('error', `File dialog failed: ${String(error)}`)
    }
  }

  const canAdd = Boolean(setup.hdrPath && setup.dvPath) && !busy
  const isFolderPair = setup.hdrKind === 'folder' && setup.dvKind === 'folder'
  const mixed =
    setup.hdrPath &&
    setup.dvPath &&
    setup.hdrKind !== 'unknown' &&
    setup.dvKind !== 'unknown' &&
    setup.hdrKind !== setup.dvKind

  const outputPreview = !setup.hdrPath
    ? ''
    : isFolderPair
      ? `${baseName(setup.outputPath || toolPaths.defaultOutput || 'DV.HDR')}\\`
      : setup.outputKind === 'file' && setup.outputPath
        ? baseName(setup.outputPath)
        : autoOutputName(setup.hdrPath)

  const handleAdd = () => {
    if (!canAdd) return
    if (mixed) {
      toast.error('Pick two files or two folders, not one of each')
      return
    }
    const dvDelayMs = parseDelay(setup.dvDelayMs)
    const hdr10plusDelayMs = parseDelay(setup.hdr10plusDelayMs)
    const job: Job = {
      id: crypto.randomUUID(),
      name: isFolderPair
        ? `${displayLabel(setup.hdrPath)} (folder pair)`
        : outputPreview,
      hdrPath: setup.hdrPath,
      dvPath: setup.dvPath,
      hdr10plusPath: setup.hdr10plusPath,
      outputPath: setup.outputPath,
      dvDelayMs,
      hdr10plusDelayMs,
      isFolderPair,
      selected: true,
      status: 'queued',
      progress: 0,
    }
    addJob(job)
    addLog('info', `Added to queue: ${job.name}`)
    resetSetup()
  }

  const dvFrames = delayFrames(parseDelay(setup.dvDelayMs), fps)
  const hpFrames = delayFrames(parseDelay(setup.hdr10plusDelayMs), fps)
  const offsetSummary = [
    parseDelay(setup.dvDelayMs)
      ? `DV ${formatMs(parseDelay(setup.dvDelayMs))}`
      : null,
    parseDelay(setup.hdr10plusDelayMs)
      ? `HDR10+ ${formatMs(parseDelay(setup.hdr10plusDelayMs))}`
      : null,
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <aside className="flex w-[320px] shrink-0 flex-col gap-7 overflow-y-auto border-r bg-background p-6">
      <div>
        <SectionLabel>Sources</SectionLabel>
        <div className="mt-3">
          <FieldLabel>HDR10 / HDR10+ base</FieldLabel>
          <PathPicker
            value={setup.hdrPath}
            kind={setup.hdrKind}
            placeholder="Choose a file or folder"
            disabled={busy}
            onPickFile={() => choose('hdrPath', 'file')}
            onPickFolder={() => choose('hdrPath', 'folder')}
            onClear={() => set('hdrPath', '', 'unknown')}
          />
          <ProbeLine probe={hdrProbe} kind={setup.hdrKind} />
        </div>
        <div className="mt-3.5">
          <FieldLabel>Dolby Vision donor</FieldLabel>
          <PathPicker
            value={setup.dvPath}
            kind={setup.dvKind}
            placeholder="Choose a file or folder"
            disabled={busy}
            onPickFile={() => choose('dvPath', 'file')}
            onPickFolder={() => choose('dvPath', 'folder')}
            onClear={() => set('dvPath', '', 'unknown')}
          />
          <ProbeLine
            probe={dvProbe}
            kind={setup.dvKind}
            extra={
              fpsMismatch ? (
                <span className="text-status-danger">
                  {' '}
                  · frame rate differs from base
                </span>
              ) : letterbox ? (
                <span className="text-status-warning">
                  {' '}
                  · letterboxed, offsets applied
                </span>
              ) : null
            }
          />
          {mixed ? (
            <p className="mt-1.5 text-[11px] text-status-danger">
              Base and donor must both be files or both be folders.
            </p>
          ) : null}
        </div>
        <div className="mt-3.5">
          <FieldLabel hint="optional">HDR10+ metadata</FieldLabel>
          <PathPicker
            value={setup.hdr10plusPath}
            kind="file"
            placeholder="Same as base"
            disabled={busy}
            onPickFile={() => choose('hdr10plusPath', 'file')}
            onPickFolder={() => choose('hdr10plusPath', 'folder')}
            onClear={() => set('hdr10plusPath', '')}
          />
        </div>
      </div>

      <div>
        <SectionLabel>Output</SectionLabel>
        <div className="mt-3">
          <PathPicker
            value={setup.outputPath}
            kind={setup.outputKind === 'unknown' ? 'folder' : setup.outputKind}
            placeholder={
              toolPaths.defaultOutput
                ? baseName(toolPaths.defaultOutput)
                : 'Default folder'
            }
            disabled={busy}
            onPickFile={
              isFolderPair ? undefined : () => choose('outputPath', 'file')
            }
            onPickFolder={() => choose('outputPath', 'folder')}
            onClear={() => set('outputPath', '', 'unknown')}
            fileLabel="Save as…"
          />
          {outputPreview ? (
            <p
              className="mt-1.5 truncate text-[11px] text-muted-foreground"
              title={outputPreview}
            >
              {outputPreview}
            </p>
          ) : null}
        </div>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setOffsetsOpen(o => !o)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronRight
            className={cn(
              'size-3 transition-transform',
              offsetsOpen && 'rotate-90'
            )}
          />
          Sync offsets
          {!offsetsOpen && offsetSummary ? (
            <span> · {offsetSummary}</span>
          ) : null}
        </button>
        {offsetsOpen ? (
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <div>
              <FieldLabel>Dolby Vision</FieldLabel>
              <div className="relative">
                <Input
                  inputMode="numeric"
                  value={setup.dvDelayMs}
                  onChange={e => setSetup({ dvDelayMs: e.target.value })}
                  placeholder="0"
                  disabled={busy}
                  className="h-8 pr-8 text-sm"
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  ms
                </span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {dvFrames
                  ? `${dvFrames} frame${dvFrames === 1 ? '' : 's'}`
                  : 'no shift'}
              </p>
            </div>
            <div>
              <FieldLabel>HDR10+</FieldLabel>
              <div className="relative">
                <Input
                  inputMode="numeric"
                  value={setup.hdr10plusDelayMs}
                  onChange={e => setSetup({ hdr10plusDelayMs: e.target.value })}
                  placeholder="0"
                  disabled={busy}
                  className="h-8 pr-8 text-sm"
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  ms
                </span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {hpFrames
                  ? `${hpFrames} frame${hpFrames === 1 ? '' : 's'}`
                  : 'no shift'}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex-1" />
      <Button
        variant="secondary"
        className="w-full"
        disabled={!canAdd}
        onClick={handleAdd}
      >
        <Plus className="size-4" /> Add to queue
      </Button>
    </aside>
  )
}
