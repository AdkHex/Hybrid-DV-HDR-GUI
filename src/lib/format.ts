export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
    return ''
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec.toString().padStart(2, '0')}s`
  return `${sec}s`
}

export function formatFps(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(3)
}

export function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

export function formatMs(ms: number): string {
  const sign = ms < 0 ? '−' : ''
  return `${sign}${Math.abs(ms)} ms`
}

/** Frames a millisecond offset covers at `fps`; mirrors `delay_to_frames`. */
export function delayFrames(ms: number, fps: number | undefined): number {
  if (!fps || ms === 0) return 0
  return Math.round((Math.abs(ms) / 1000) * fps)
}
