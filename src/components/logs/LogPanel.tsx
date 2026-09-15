import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Download, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { formatTime } from '@/lib/format'
import { api, isTauri, pickSaveFile } from '@/lib/tauri'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAppStore } from '@/store/app-store'
import { useSettingsStore } from '@/store/settings-store'
import type { LogLevel } from '@/types'

const LEVEL_TEXT: Record<LogLevel, string> = {
  info: 'text-status-info',
  success: 'text-status-success',
  warning: 'text-status-warning',
  error: 'text-status-danger',
}
const LEVEL_LABEL: Record<LogLevel, string> = {
  info: 'info',
  success: 'done',
  warning: 'warn',
  error: 'error',
}

type LevelFilter = 'all' | 'warnings' | 'errors'

function logText(entries: { time: number; level: LogLevel; source: string; message: string }[]) {
  return entries
    .map(e => `${formatTime(e.time)} ${LEVEL_LABEL[e.level].toUpperCase().padEnd(5)} ${e.source.padEnd(14)} ${e.message}`)
    .join('\n')
}

export function LogPanel() {
  const logs = useAppStore(s => s.logs)
  const clearLogs = useAppStore(s => s.clearLogs)
  const setLogVisible = useSettingsStore(s => s.setLogVisible)
  const [level, setLevel] = useState<LevelFilter>('all')
  const [source, setSource] = useState('all')
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const sources = useMemo(() => {
    const set = new Set<string>()
    for (const l of logs) set.add(l.source)
    return [...set].sort()
  }, [logs])

  const visible = useMemo(
    () =>
      logs.filter(l => {
        if (level === 'warnings' && l.level !== 'warning' && l.level !== 'error') return false
        if (level === 'errors' && l.level !== 'error') return false
        if (source !== 'all' && l.source !== source) return false
        return true
      }),
    [logs, level, source]
  )

  // Follow the tail unless the user has scrolled up to read something.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [visible])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logText(visible))
      toast.success('Log copied')
    } catch {
      toast.error('Could not copy the log')
    }
  }

  const save = async () => {
    if (!isTauri()) return
    try {
      const path = await pickSaveFile('hybrid-dv-hdr.log', 'log')
      if (!path) return
      await api.saveTextFile(path, logText(visible))
      toast.success('Log saved')
    } catch (error) {
      toast.error(`Could not save the log: ${String(error)}`)
    }
  }

  return (
    <div className="flex h-52 shrink-0 flex-col border-t bg-card">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <h2 className="text-xs font-semibold">Log</h2>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {logs.length.toLocaleString()} {logs.length === 1 ? 'line' : 'lines'}
        </span>
        <Select value={level} onValueChange={v => setLevel(v as LevelFilter)}>
          <SelectTrigger size="sm" className="ml-2 h-7 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All levels</SelectItem>
            <SelectItem value="warnings">Warnings</SelectItem>
            <SelectItem value="errors">Errors</SelectItem>
          </SelectContent>
        </Select>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger size="sm" className="h-7 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tools</SelectItem>
            {sources.map(s => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" onClick={() => void copy()} aria-label="Copy log">
                <Copy className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Copy</TooltipContent>
          </Tooltip>
          {isTauri() ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" onClick={() => void save()} aria-label="Save log">
                  <Download className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Save…</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" onClick={clearLogs} aria-label="Clear log">
                <Trash2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Clear</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" onClick={() => setLogVisible(false)} aria-label="Hide log">
                <X className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              Hide log<span className="ml-2 opacity-60">⌘2</span>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 select-text overflow-auto px-3 py-1.5">
        {visible.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {logs.length === 0 ? 'Nothing logged yet. Tool output appears here while a job runs.' : 'No lines match the filter.'}
          </p>
        ) : (
          <div className="font-mono text-[11px] leading-[1.5]">
            {visible.map(entry => (
              <div key={entry.seq} className="flex gap-2">
                <span className="shrink-0 tabular-nums text-muted-foreground/70">{formatTime(entry.time)}</span>
                <span className={cn('w-10 shrink-0 uppercase', LEVEL_TEXT[entry.level])}>{LEVEL_LABEL[entry.level]}</span>
                <span className="w-[74px] shrink-0 truncate text-muted-foreground/70">{entry.source}</span>
                <span className="whitespace-pre-wrap break-all">{entry.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
