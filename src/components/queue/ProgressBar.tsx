import { cn } from '@/lib/utils'
import { JOB_STATUS } from './status'
import type { JobStatus } from '@/types'

/**
 * Slim macOS-style bar with the percentage beside it, so the number never
 * loses contrast as the fill sweeps underneath.
 */
export function ProgressBar({
  percent,
  status,
  label,
  indeterminate = false,
}: {
  percent: number
  status: JobStatus
  label?: string
  indeterminate?: boolean
}) {
  const pct = Math.min(100, Math.max(0, percent))
  const { fill, track } = JOB_STATUS[status]
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        className={cn(
          'relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full',
          track
        )}
      >
        <div
          className={cn(
            'absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out',
            fill,
            indeterminate && 'progress-indeterminate'
          )}
          style={{ width: indeterminate ? '35%' : `${pct}%` }}
        />
      </div>
      <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {status === 'queued' ? '' : `${Math.round(pct)}%`}
      </span>
    </div>
  )
}
