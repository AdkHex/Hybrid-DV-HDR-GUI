import { cn } from '@/lib/utils'
import { TitleBar } from '@/components/titlebar/TitleBar'
import { PairList } from '@/components/pairs/PairList'
import { LogPanel } from '@/components/logs/LogPanel'
import { Footer } from './Footer'
import { useAppStore } from '@/store/app-store'
import { useSettingsStore } from '@/store/settings-store'

export function Layout() {
  const logVisible = useSettingsStore(s => s.logVisible)
  const dropActive = useAppStore(s => s.dropActive)

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden rounded-xl bg-background text-foreground">
      <TitleBar />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <PairList />
        {logVisible ? <LogPanel /> : null}
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-2 rounded-lg border-2 border-dashed border-foreground/40 bg-background/60 opacity-0 transition-opacity',
            dropActive && 'opacity-100'
          )}
        >
          <div className="flex h-full items-center justify-center text-sm font-medium">
            Drop files or folders
          </div>
        </div>
      </div>
      <Footer />
    </div>
  )
}
