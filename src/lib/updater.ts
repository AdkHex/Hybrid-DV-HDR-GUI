import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { toast } from 'sonner'
import { useAppStore } from '@/store/app-store'

let checkInFlight = false
let pendingUpdate: Awaited<ReturnType<typeof check>> | null = null

interface CheckOptions {
  notifyIfLatest?: boolean
  notifyOnError?: boolean
  notifyOnReady?: boolean
}

export type UpdateCheckResult = 'latest' | 'downloading' | 'ready' | 'error'

/**
 * Check GitHub Releases for a newer build and download it in the background.
 * The title bar offers a restart once it is ready.
 */
export async function checkForUpdates(
  options: CheckOptions = {}
): Promise<UpdateCheckResult> {
  const {
    notifyIfLatest = false,
    notifyOnError = false,
    notifyOnReady = false,
  } = options
  if (checkInFlight) return 'downloading'
  checkInFlight = true

  const store = useAppStore.getState()
  store.setUpdateChecking(true)

  try {
    const update = await check()
    if (!update) {
      if (notifyIfLatest) toast.success('You are running the latest version')
      return 'latest'
    }

    const { updateReady, updateDownloading } = useAppStore.getState()
    if (updateReady || updateDownloading) {
      if (notifyOnReady && updateReady)
        toast('Update ready. Use the title bar to restart.')
      return updateReady ? 'ready' : 'downloading'
    }

    store.setUpdateDownloading(true, update.version)
    store.setUpdateProgress(null)
    store.addLog('info', `Update available: ${update.version}`)

    let totalBytes: number | null = null
    let downloadedBytes = 0
    await update.download(event => {
      switch (event.event) {
        case 'Started':
          totalBytes = event.data.contentLength ?? null
          break
        case 'Progress':
          downloadedBytes += event.data.chunkLength
          if (totalBytes && totalBytes > 0) {
            store.setUpdateProgress(
              Math.min(
                100,
                Math.max(0, Math.round((downloadedBytes / totalBytes) * 100))
              )
            )
          }
          break
        case 'Finished':
          store.setUpdateProgress(100)
          break
      }
    })

    pendingUpdate = update
    store.setUpdateReady(true, update.version)
    if (notifyOnReady) toast(`Update ${update.version} is ready to install`)
    return 'ready'
  } catch (error) {
    store.addLog('warning', `Update check failed: ${String(error)}`)
    store.setUpdateDownloading(false)
    store.setUpdateProgress(null)
    pendingUpdate = null
    if (notifyOnError) toast.error('Failed to check for updates')
    return 'error'
  } finally {
    useAppStore.getState().setUpdateChecking(false)
    checkInFlight = false
  }
}

export async function installUpdate() {
  const store = useAppStore.getState()
  if (!store.updateReady || !pendingUpdate) return
  try {
    await pendingUpdate.install()
    pendingUpdate = null
    store.setUpdateReady(false)
    await relaunch()
  } catch (error) {
    store.addLog('error', `Update install failed: ${String(error)}`)
    toast.error('Failed to install update')
  }
}
