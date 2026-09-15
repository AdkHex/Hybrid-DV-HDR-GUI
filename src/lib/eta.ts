/**
 * Smoothed ETA from progress samples: the average rate over the last few
 * samples, so a stalled step does not make the estimate jump to zero.
 */
export interface EtaMeta {
  samples: { time: number; progress: number }[]
}

const WINDOW = 6

export function computeEta(
  meta: EtaMeta,
  progress: number
): number | undefined {
  if (progress <= 0) return undefined
  const now = Date.now()
  meta.samples = [...meta.samples, { time: now, progress }].slice(-WINDOW)
  const rates: number[] = []
  for (let i = 1; i < meta.samples.length; i++) {
    const a = meta.samples[i - 1]
    const b = meta.samples[i]
    if (!a || !b) continue
    const dt = (b.time - a.time) / 1000
    const dp = b.progress - a.progress
    if (dt > 0 && dp > 0) rates.push(dp / dt)
  }
  if (!rates.length) return undefined
  const avg = rates.reduce((s, r) => s + r, 0) / rates.length
  return Math.round(Math.max(0, 100 - progress) / avg)
}
