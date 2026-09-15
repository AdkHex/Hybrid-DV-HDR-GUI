import { useEffect } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api, isTauri, pickFile, pickFolder, pickSaveFile } from '@/lib/tauri'
import { autoOutputName, baseName } from '@/lib/paths'
import { delayFrames, formatFps } from '@/lib/format'
import { newJob } from '@/lib/jobs'
import { Button } from '@/components/ui/button'
import {
  useAppStore,
  type JobSetup as Setup,
  type PathKind,
  type ProbeState,
} from '@/store/app-store'
import { useSettingsStore } from '@/store/settings-store'
import { PathPicker } from './PathPicker'

type Slot = 'hdr' | 'dv' | 'hdr10plus' | 'output'

const parseDelay = (value: string) => {
  const n = Number.parseFloat(value.trim())
  return Number.isFinite(n) ? n : 0
}

function probeLine(
  probe: ProbeState | undefined,
  kind: PathKind,
  tag: string,
  extra?: React.ReactNode
) {
  if (kind === 'folder') return 'Folder — files are paired by name'
  if (!probe) return null
  if (probe.state === 'loading') return 'Reading…'
  if (probe.state === 'error')
    return <span className="text-status-warning">{probe.message}</span>
  const { info } = probe
  const codec =
    info.codec?.includes('HEVC') || info.codec?.includes('H.265')
      ? 'HEVC'
      : info.codec
  return (
    <>
      {[
        tag,
        codec,
        `${info.width}×${info.height}`,
        `${formatFps(info.fps)} fps`,
      ]
        .filter(Boolean)
        .join(' · ')}
      {extra}
    </>
  )
}

function Field({
  label,
  hint,
  children,
  under,
}: {
  label: string
  hint?: string
  children: React.ReactNode
  under?: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-sm text-muted-foreground">
        <span>{label}</span>
        {hint ? <span className="text-xs">{hint}</span> : null}
      </div>
      {children}
      {under ? (
        <p className="mt-1.5 truncate text-xs text-muted-foreground">{under}</p>
      ) : null}
    </div>
  )
}

function OffsetInput({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: string
  disabled?: boolean
  onChange: (v: string) => void
}) {
  return (
    <label className="flex h-9 items-center gap-1.5 rounded-lg border border-input px-2.5 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        inputMode="numeric"
        value={value}
        placeholder="0"
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="w-0 min-w-0 flex-1 bg-transparent outline-none disabled:opacity-60"
      />
    </label>
  )
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
  const defaultDv = useSettingsStore(s => s.defaultDvDelayMs)
  const defaultHp = useSettingsStore(s => s.defaultHdr10plusDelayMs)
  const defaults = { dv: defaultDv, hp: defaultHp }
  const busy = runStatus === 'processing'

  // Probe each picked file once so the picker can say what it is.
  useEffect(() => {
    if (!isTauri()) return
    for (const [path, kind] of [
      [setup.hdrPath, setup.hdrKind],
      [setup.dvPath, setup.dvKind],
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
  const isFolderPair = setup.hdrKind === 'folder' && setup.dvKind === 'folder'
  const mixed = Boolean(
    setup.hdrPath &&
    setup.dvPath &&
    setup.hdrKind !== 'unknown' &&
    setup.dvKind !== 'unknown' &&
    setup.hdrKind !== setup.dvKind
  )
  const canAdd = Boolean(setup.hdrPath && setup.dvPath) && !mixed && !busy

  const apply = (slot: Slot, value: string, kind: PathKind) => {
    const k = value ? kind : 'unknown'
    const patch: Partial<Setup> =
      slot === 'hdr'
        ? { hdrPath: value, hdrKind: k }
        : slot === 'dv'
          ? { dvPath: value, dvKind: k }
          : slot === 'hdr10plus'
            ? { hdr10plusPath: value }
            : { outputPath: value, outputKind: k }
    setSetup(patch)
  }
  const choose = async (slot: Slot, kind: 'file' | 'folder') => {
    try {
      if (!isTauri()) {
        const manual = window.prompt(`Enter a ${kind} path:`)
        if (manual) apply(slot, manual, kind)
        return
      }
      const picked =
        slot === 'output' && kind === 'file'
          ? await pickSaveFile(setup.outputPath || undefined)
          : kind === 'folder'
            ? await pickFolder()
            : await pickFile()
      if (picked) apply(slot, picked, kind)
    } catch (error) {
      addLog('error', `File dialog failed: ${String(error)}`)
    }
  }
  const swap = () =>
    setSetup({
      hdrPath: setup.dvPath,
      hdrKind: setup.dvKind,
      dvPath: setup.hdrPath,
      dvKind: setup.hdrKind,
    })

  const outputName = !setup.hdrPath
    ? ''
    : isFolderPair
      ? 'One file per pair, named after the HDR file'
      : setup.outputKind === 'file' && setup.outputPath
        ? baseName(setup.outputPath)
        : autoOutputName(setup.hdrPath)

  const dvMs =
    setup.dvDelayMs === '' ? defaults.dv : parseDelay(setup.dvDelayMs)
  const hpMs =
    setup.hdr10plusDelayMs === ''
      ? defaults.hp
      : parseDelay(setup.hdr10plusDelayMs)
  const frames = [
    dvMs
      ? `DV: ${delayFrames(dvMs, fps)} frame${delayFrames(dvMs, fps) === 1 ? '' : 's'}`
      : null,
    hpMs
      ? `HDR10+: ${delayFrames(hpMs, fps)} frame${delayFrames(hpMs, fps) === 1 ? '' : 's'}`
      : null,
  ].filter(Boolean)

  const handleAdd = () => {
    if (!canAdd) return
    if (fpsMismatch) {
      toast.error('Frame rates differ — the job would be refused')
      return
    }
    const job = newJob({
      hdrPath: setup.hdrPath,
      hdrKind: setup.hdrKind,
      dvPath: setup.dvPath,
      dvKind: setup.dvKind,
      hdr10plusPath: setup.hdr10plusPath,
      outputPath: setup.outputPath,
      outputKind: setup.outputKind,
      dvDelayMs: dvMs,
      hdr10plusDelayMs: hpMs,
    })
    addJob(job)
    addLog('info', `Added to queue: ${outputName}`)
    resetSetup()
  }

  return (
    <aside className="flex w-[350px] shrink-0 flex-col gap-5 overflow-y-auto border-r bg-background p-6">
      <Field
        label="HDR video"
        under={probeLine(hdrProbe, setup.hdrKind, hdrInfo ? 'HDR' : '')}
      >
        <PathPicker
          value={setup.hdrPath}
          kind={setup.hdrKind}
          placeholder="Choose a file or folder"
          disabled={busy}
          onPickFile={() => choose('hdr', 'file')}
          onPickFolder={() => choose('hdr', 'folder')}
          onSwap={setup.hdrPath && setup.dvPath ? swap : undefined}
          onClear={() => apply('hdr', '', 'unknown')}
        />
      </Field>
      <Field
        label="Dolby Vision video"
        under={
          mixed ? (
            <span className="text-status-danger">
              Both must be files or both folders
            </span>
          ) : (
            probeLine(
              dvProbe,
              setup.dvKind,
              'DV',
              fpsMismatch ? (
                <span className="text-status-danger">
                  {' '}
                  · frame rate differs
                </span>
              ) : letterbox ? (
                <span className="text-status-warning"> · letterboxed</span>
              ) : null
            )
          )
        }
      >
        <PathPicker
          value={setup.dvPath}
          kind={setup.dvKind}
          placeholder="Choose a file or folder"
          disabled={busy}
          onPickFile={() => choose('dv', 'file')}
          onPickFolder={() => choose('dv', 'folder')}
          onSwap={setup.hdrPath && setup.dvPath ? swap : undefined}
          onClear={() => apply('dv', '', 'unknown')}
        />
      </Field>
      <Field label="HDR10+ metadata" hint="optional">
        <PathPicker
          value={setup.hdr10plusPath}
          kind={setup.hdrKind === 'folder' ? 'folder' : 'file'}
          placeholder="Same as HDR video"
          disabled={busy}
          onPickFile={() => choose('hdr10plus', 'file')}
          onPickFolder={() => choose('hdr10plus', 'folder')}
          onClear={() => apply('hdr10plus', '', 'unknown')}
        />
      </Field>

      <div className="h-px bg-border" />

      <Field label="Output" under={outputName || undefined}>
        <PathPicker
          value={setup.outputPath || toolPaths.defaultOutput}
          kind={setup.outputKind === 'unknown' ? 'folder' : setup.outputKind}
          placeholder="Default folder"
          showPath
          disabled={busy}
          onPickFile={isFolderPair ? undefined : () => choose('output', 'file')}
          onPickFolder={() => choose('output', 'folder')}
          onClear={() => apply('output', '', 'unknown')}
          fileLabel="Save as…"
        />
      </Field>
      <Field
        label="Sync offsets"
        hint="ms"
        under={frames.length ? frames.join(' · ') : undefined}
      >
        <div className="grid grid-cols-2 gap-2.5">
          <OffsetInput
            label="DV"
            value={setup.dvDelayMs || (defaults.dv ? String(defaults.dv) : '')}
            disabled={busy}
            onChange={v => setSetup({ dvDelayMs: v })}
          />
          <OffsetInput
            label="HDR10+"
            value={
              setup.hdr10plusDelayMs || (defaults.hp ? String(defaults.hp) : '')
            }
            disabled={busy}
            onChange={v => setSetup({ hdr10plusDelayMs: v })}
          />
        </div>
      </Field>

      <div className="flex-1" />
      <Button
        variant="secondary"
        className={cn('h-9 w-full')}
        disabled={!canAdd}
        onClick={handleAdd}
      >
        <Plus className="size-4" /> Add to queue
      </Button>
    </aside>
  )
}
