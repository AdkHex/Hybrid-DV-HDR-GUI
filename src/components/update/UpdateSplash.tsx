import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/app-store'

export function UpdateSplash() {
  const {
    updateChecking,
    updateDownloading,
    updateProgress,
    updateReady,
    updateVersion,
    updateSplashDismissed,
    dismissUpdateSplash,
  } = useAppStore()
  const visible =
    (updateChecking || updateDownloading) && !updateSplashDismissed
  if (!visible) return null

  const message = updateReady
    ? `Update ready: ${updateVersion ?? ''}`
    : updateDownloading
      ? updateProgress !== null
        ? `Downloading update (${updateProgress}%)`
        : 'Downloading update…'
      : 'Checking for updates…'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="w-[280px] rounded-2xl border bg-card px-6 py-8 text-center shadow-xl">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted">
          <Loader2 className="size-6 animate-spin text-foreground/80" />
        </div>
        <p className="mt-4 text-sm font-medium">{message}</p>
        {/* The download keeps running in the background; the title bar shows it. */}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-4 w-full"
          onClick={dismissUpdateSplash}
        >
          Continue in background
        </Button>
      </div>
    </div>
  )
}
