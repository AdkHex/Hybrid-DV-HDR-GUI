import { useState } from 'react'
import { Download, Loader2, ScrollText, Settings, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { detectPlatform } from '@/lib/platform'
import { installUpdate } from '@/lib/updater'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { MacOSWindowControls } from './MacOSWindowControls'
import { WindowsWindowControls } from './WindowsWindowControls'
import { useAppStore } from '@/store/app-store'
import { useSettingsStore } from '@/store/settings-store'

const iconButton = 'size-7 text-foreground/70 hover:text-foreground'

export function TitleBar() {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const platform = detectPlatform()
  const { logVisible, toggleLog } = useSettingsStore()
  const openPreferences = useAppStore(s => s.openPreferences)
  const toolStatus = useAppStore(s => s.toolStatus)
  const {
    updateDownloading,
    updateReady,
    updateVersion,
    updateProgress,
    runStatus,
  } = useAppStore()
  const processing = runStatus === 'processing'
  const missingRequired = toolStatus?.some(t => t.required && !t.path) ?? false

  return (
    <div
      data-tauri-drag-region
      className="relative flex h-9 w-full shrink-0 items-center justify-between border-b bg-background"
    >
      <div className="flex items-center">
        {platform === 'macos' ? (
          <MacOSWindowControls />
        ) : (
          <div className="w-2" />
        )}
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={toggleLog}
                variant="ghost"
                size="icon"
                className={cn(iconButton, logVisible && 'text-foreground')}
                aria-label={logVisible ? 'Hide log' : 'Show log'}
                aria-pressed={logVisible}
              >
                <ScrollText className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {logVisible ? 'Hide log' : 'Show log'}
              <span className="ml-2 opacity-60">⌘2</span>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div
        data-tauri-drag-region
        className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-baseline gap-1.5"
      >
        <span className="text-sm font-medium text-foreground/80">
          Hybrid DV HDR
        </span>
        <span className="text-[10px] text-muted-foreground">by Ionicboy</span>
      </div>

      <div className="flex items-center gap-1 pr-2">
        {updateDownloading ? (
          <div className="flex items-center gap-1 text-xs text-foreground/70">
            <Loader2 className="size-3 animate-spin" />
            {updateProgress !== null ? `${updateProgress}%` : 'Downloading…'}
          </div>
        ) : null}
        {updateReady ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => setConfirmOpen(true)}
                variant="ghost"
                size="icon"
                className="size-7 text-status-info hover:text-status-info"
                aria-label="Restart to install update"
              >
                <Download className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {updateVersion
                ? `Restart to update (${updateVersion})`
                : 'Restart to update'}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={() => openPreferences('tools')}
              variant="ghost"
              size="icon"
              className={cn(iconButton, 'relative')}
              aria-label="Tools"
            >
              <Wrench className="size-3.5" />
              {missingRequired ? (
                <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-status-warning" />
              ) : null}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {missingRequired ? 'Tools — a required tool is missing' : 'Tools'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={() => openPreferences('general')}
              variant="ghost"
              size="icon"
              className={iconButton}
              aria-label="Settings"
            >
              <Settings className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Settings
            <span className="ml-2 opacity-60">⌘,</span>
          </TooltipContent>
        </Tooltip>
        {platform === 'windows' ? (
          <WindowsWindowControls className="ml-2" />
        ) : null}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart to update?</AlertDialogTitle>
            <AlertDialogDescription>
              Hybrid DV HDR will restart to install{' '}
              {updateVersion ?? 'the update'}.
              {processing
                ? ' A job is still running — stop it first or wait for it to finish.'
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Later</AlertDialogCancel>
            <AlertDialogAction
              disabled={processing}
              onClick={() => void installUpdate()}
            >
              Restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
