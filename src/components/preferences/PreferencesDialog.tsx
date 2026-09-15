import { useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Info,
  Loader2,
  Palette,
  Settings,
  Star,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { isTauri, pickExecutable, pickFolder } from '@/lib/tauri'
import { checkForUpdates } from '@/lib/updater'
import { downloadMissingTools, refreshToolStatus, TOOLS } from '@/lib/tools'
import { formatMs } from '@/lib/format'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAppStore, type PreferencesPage } from '@/store/app-store'
import { MAX_PARALLEL, useSettingsStore } from '@/store/settings-store'
import type { ThemePreference } from '@/types'

const PAGES: { id: PreferencesPage; name: string; icon: LucideIcon }[] = [
  { id: 'general', name: 'General', icon: Settings },
  { id: 'tools', name: 'Tools', icon: Wrench },
  { id: 'presets', name: 'Presets', icon: Star },
  { id: 'appearance', name: 'Appearance', icon: Palette },
  { id: 'about', name: 'About', icon: Info },
]

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="mb-6">
      <div className="mb-4 flex items-center justify-between border-b pb-2">
        <h3 className="text-base font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function Row({
  label,
  help,
  control,
  children,
}: {
  label: string
  help?: string
  control?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between gap-4">
        <span className="text-sm font-medium">{label}</span>
        {control}
      </div>
      {children}
      {help ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{help}</p>
      ) : null}
    </div>
  )
}

function GeneralPane() {
  const s = useSettingsStore()
  const setToolPaths = useSettingsStore(st => st.setToolPaths)
  const chooseOutput = async () => {
    const picked = await pickFolder(s.toolPaths.defaultOutput || undefined)
    if (picked) setToolPaths({ defaultOutput: picked })
  }
  return (
    <>
      <Section title="Processing">
        <Row
          label="Parallel workers"
          help={`How many files a folder job processes at once. Each worker is CPU and disk heavy; 2–4 is a sensible range (max ${MAX_PARALLEL}).`}
        >
          <Input
            type="number"
            min={1}
            max={MAX_PARALLEL}
            value={s.parallelTasks}
            onChange={e => s.setParallelTasks(Number(e.target.value) || 1)}
            className="w-24"
          />
        </Row>
        <Row
          label="Keep temporary files"
          help="Leaves the .hevc, .bin, .json and .mka intermediates next to the output instead of deleting them after the final mux."
          control={
            <Switch
              checked={s.keepTempFiles}
              onCheckedChange={s.setKeepTempFiles}
            />
          }
        />
        <Row
          label="Default output folder"
          help="Used when a job has no output of its own. Files are named <base>.DV.HDR.H.265-NOGRP.mkv."
        >
          <div className="flex gap-2">
            <Input
              value={s.toolPaths.defaultOutput}
              onChange={e => setToolPaths({ defaultOutput: e.target.value })}
              placeholder="Videos\DV.HDR"
              className="flex-1"
            />
            {isTauri() ? (
              <Button variant="secondary" onClick={() => void chooseOutput()}>
                Browse…
              </Button>
            ) : null}
          </div>
        </Row>
      </Section>
      <Section title="Notifications">
        <Row
          label="Notify when the queue finishes"
          help="Posts a system notification with the result, including failures."
          control={
            <Switch
              checked={s.notifyOnFinish}
              onCheckedChange={s.setNotifyOnFinish}
            />
          }
        />
        <Row
          label="Play a sound"
          control={
            <Switch
              checked={s.soundOnFinish}
              onCheckedChange={s.setSoundOnFinish}
            />
          }
        />
      </Section>
      <Section title="Updates">
        <Row
          label="Check for updates on launch"
          help="Downloads new versions from GitHub Releases in the background; the title bar offers a restart when one is ready."
          control={
            <Switch
              checked={s.autoCheckUpdates}
              onCheckedChange={s.setAutoCheckUpdates}
            />
          }
        />
      </Section>
    </>
  )
}

function ToolsPane() {
  const toolPaths = useSettingsStore(s => s.toolPaths)
  const setToolPaths = useSettingsStore(s => s.setToolPaths)
  const status = useAppStore(s => s.toolStatus)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void refreshToolStatus(toolPaths)
  }, [toolPaths])

  const missingRequired = TOOLS.filter(
    t => t.required && !status?.find(s => s.key === t.backendKey)?.path
  )
  const anyMissingDownloadable = TOOLS.some(
    t => t.download && !status?.find(s => s.key === t.backendKey)?.path
  )

  const browse = async (key: (typeof TOOLS)[number]['key']) => {
    const picked = await pickExecutable()
    if (picked) setToolPaths({ [key]: picked })
  }
  const download = async (key?: (typeof TOOLS)[number]['key']) => {
    setBusy(key ?? 'all')
    try {
      await downloadMissingTools(key)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section
      title="External tools"
      action={
        isTauri() ? (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refreshToolStatus(toolPaths)}
            >
              Re-scan
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!anyMissingDownloadable || busy !== null}
              onClick={() => void download()}
            >
              {busy === 'all' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              Download missing
            </Button>
          </div>
        ) : null
      }
    >
      <p className="-mt-2 mb-4 text-xs text-muted-foreground">
        Nothing is bundled. Downloaded tools go to the app data folder; anything
        found on PATH is used as-is. Leave a field blank to search the usual
        places.
        {missingRequired.length ? (
          <span className="text-status-warning">
            {' '}
            {missingRequired.map(t => t.name).join(', ')} must be found before a
            job can run.
          </span>
        ) : null}
      </p>
      <div className="divide-y">
        {TOOLS.map(tool => {
          const st = status?.find(s => s.key === tool.backendKey)
          const found = Boolean(st?.path)
          return (
            <div
              key={tool.key}
              className="grid grid-cols-[150px_1fr_84px_auto] items-center gap-3 py-2.5"
            >
              <div>
                <div className="text-sm font-medium">{tool.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {tool.description}
                </div>
              </div>
              <Input
                value={toolPaths[tool.key]}
                onChange={e => setToolPaths({ [tool.key]: e.target.value })}
                placeholder={st?.path ?? tool.name}
                className="h-8 font-mono text-xs"
                title={st?.path ?? undefined}
              />
              <div
                className={cn(
                  'flex items-center gap-1 text-xs',
                  found
                    ? 'text-status-success'
                    : tool.required
                      ? 'text-status-warning'
                      : 'text-muted-foreground'
                )}
              >
                {found ? (
                  <Check className="size-3" />
                ) : tool.required ? (
                  <AlertTriangle className="size-3" />
                ) : null}
                {found
                  ? (st?.version ?? 'found')
                  : tool.required
                    ? 'Missing'
                    : status
                      ? 'Not found'
                      : ''}
              </div>
              <div className="flex gap-1.5">
                {!found && tool.download && isTauri() ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={busy !== null}
                    onClick={() => void download(tool.key)}
                  >
                    {busy === tool.key ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : null}
                    Download
                  </Button>
                ) : null}
                {isTauri() ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => void browse(tool.key)}
                  >
                    Browse…
                  </Button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

function PresetsPane() {
  const {
    presets,
    addPreset,
    removePreset,
    parallelTasks,
    keepTempFiles,
    setParallelTasks,
    setKeepTempFiles,
  } = useSettingsStore()
  const setup = useAppStore(s => s.setup)
  const setSetup = useAppStore(s => s.setSetup)
  const [name, setName] = useState('')

  const save = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    addPreset({
      id: crypto.randomUUID(),
      name: trimmed,
      parallelTasks,
      keepTempFiles,
      dvDelayMs: Number.parseFloat(setup.dvDelayMs) || 0,
      hdr10plusDelayMs: Number.parseFloat(setup.hdr10plusDelayMs) || 0,
    })
    setName('')
    toast.success(`Preset "${trimmed}" saved`)
  }

  return (
    <Section title="Presets">
      <p className="-mt-2 mb-4 text-xs text-muted-foreground">
        A preset stores the worker count, the keep-temp switch and the sync
        offsets — never file paths.
      </p>
      <div className="divide-y">
        {presets.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No presets yet.</p>
        ) : (
          presets.map(p => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-4 py-2.5"
            >
              <div>
                <div className="text-sm font-medium">{p.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {[
                    `${p.parallelTasks} worker${p.parallelTasks === 1 ? '' : 's'}`,
                    p.keepTempFiles ? 'keep temp' : null,
                    p.dvDelayMs ? `DV ${formatMs(p.dvDelayMs)}` : null,
                    p.hdr10plusDelayMs
                      ? `HDR10+ ${formatMs(p.hdr10plusDelayMs)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <div className="flex gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setParallelTasks(p.parallelTasks)
                    setKeepTempFiles(p.keepTempFiles)
                    setSetup({
                      dvDelayMs: p.dvDelayMs ? String(p.dvDelayMs) : '',
                      hdr10plusDelayMs: p.hdr10plusDelayMs
                        ? String(p.hdr10plusDelayMs)
                        : '',
                    })
                    toast.success(`Applied "${p.name}"`)
                  }}
                >
                  Apply
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => removePreset(p.id)}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="mt-4 flex gap-2">
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && save()}
          placeholder="Preset name"
          className="max-w-xs"
        />
        <Button variant="secondary" disabled={!name.trim()} onClick={save}>
          Save current settings
        </Button>
      </div>
    </Section>
  )
}

function AppearancePane() {
  const theme = useSettingsStore(s => s.theme)
  const setTheme = useSettingsStore(s => s.setTheme)
  return (
    <Section title="Theme">
      <Row label="Appearance" help="System follows the OS light/dark setting.">
        <Select
          value={theme}
          onValueChange={v => setTheme(v as ThemePreference)}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">System</SelectItem>
            <SelectItem value="light">Light</SelectItem>
            <SelectItem value="dark">Dark</SelectItem>
          </SelectContent>
        </Select>
      </Row>
    </Section>
  )
}

function AboutPane() {
  const [version, setVersion] = useState('')
  const {
    updateChecking,
    updateDownloading,
    updateReady,
    updateVersion,
    updateProgress,
  } = useAppStore()
  useEffect(() => {
    if (isTauri())
      getVersion()
        .then(setVersion)
        .catch(() => setVersion(''))
  }, [])
  const updateText = updateReady
    ? `Version ${updateVersion} is ready — restart from the title bar to install.`
    : updateDownloading
      ? `Downloading ${updateVersion ?? 'update'}${updateProgress !== null ? ` (${updateProgress}%)` : '…'}`
      : updateChecking
        ? 'Checking…'
        : null
  return (
    <Section title="Hybrid DV HDR">
      <Row
        label={version ? `Version ${version}` : 'Version'}
        help="Combines Dolby Vision RPU metadata with HDR10 / HDR10+ video. Drives dovi_tool, hdr10plus_tool, MKVToolNix and ffmpeg."
      >
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={!isTauri() || updateChecking || updateDownloading}
            onClick={() =>
              void checkForUpdates({
                notifyIfLatest: true,
                notifyOnError: true,
                notifyOnReady: true,
              })
            }
          >
            {updateChecking ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : null}
            Check for updates
          </Button>
          {updateText ? (
            <span className="text-xs text-muted-foreground">{updateText}</span>
          ) : null}
        </div>
      </Row>
      <Row
        label="Ionicboy"
        help="Releases and source: github.com/AdkHex/Hybrid-DV-HDR-GUI"
      />
    </Section>
  )
}

export function PreferencesDialog() {
  const open = useAppStore(s => s.preferencesOpen)
  const page = useAppStore(s => s.preferencesPage)
  const openPreferences = useAppStore(s => s.openPreferences)
  const closePreferences = useAppStore(s => s.closePreferences)
  const current = PAGES.find(p => p.id === page) ?? { name: 'General' }

  return (
    <Dialog
      open={open}
      onOpenChange={v => (v ? openPreferences() : closePreferences())}
    >
      <DialogContent className="flex h-[640px] max-w-[1000px] gap-0 overflow-hidden p-0 sm:max-w-[1000px]">
        <DialogTitle className="sr-only">Preferences</DialogTitle>
        <DialogDescription className="sr-only">
          Application preferences
        </DialogDescription>
        <nav className="flex w-56 shrink-0 flex-col gap-1 border-r bg-background p-3">
          {PAGES.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => openPreferences(p.id)}
              className={cn(
                'flex h-9 items-center gap-2.5 rounded-md px-3 text-sm hover:bg-accent',
                p.id === page && 'bg-accent font-medium'
              )}
            >
              <p.icon className="size-4 text-muted-foreground" />
              {p.name}
            </button>
          ))}
        </nav>
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex h-14 shrink-0 items-center gap-2 px-6 text-sm text-muted-foreground">
            Preferences <ChevronRight className="size-3.5" />{' '}
            <span className="text-foreground">{current.name}</span>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            {page === 'general' ? <GeneralPane /> : null}
            {page === 'tools' ? <ToolsPane /> : null}
            {page === 'presets' ? <PresetsPane /> : null}
            {page === 'appearance' ? <AppearancePane /> : null}
            {page === 'about' ? <AboutPane /> : null}
          </div>
        </main>
      </DialogContent>
    </Dialog>
  )
}
