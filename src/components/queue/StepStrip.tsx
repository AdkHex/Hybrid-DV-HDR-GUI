import { AlertTriangle, Check, Clock, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { STEP_NAMES } from '@/types'

interface StepStripProps {
  /** 0-based index of the step in progress. */
  stepIndex: number
  /** Percentage inside the current step, if known. */
  stepPercent?: number
  status: 'processing' | 'completed' | 'error' | 'pending'
  note?: string
  /** Inside a card: no background, no border, no indent. */
  bare?: boolean
}

/** One slim line listing the six pipeline steps and where this file is. */
export function StepStrip({
  stepIndex,
  stepPercent,
  status,
  note,
  bare,
}: StepStripProps) {
  return (
    <div
      className={cn(
        'flex items-center overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground',
        bare ? 'mt-2.5' : 'h-[34px] border-b bg-muted/25 pl-[62px] pr-3'
      )}
    >
      {STEP_NAMES.map((name, i) => {
        const done = status === 'completed' || i < stepIndex
        const current = status !== 'completed' && i === stepIndex
        const failed = current && status === 'error'
        const Icon = done
          ? Check
          : failed
            ? AlertTriangle
            : current
              ? Loader2
              : Clock
        return (
          <span key={name} className="flex items-center">
            {i > 0 ? <span className="mx-2 h-px w-4 bg-border" /> : null}
            <span
              className={cn(
                'inline-flex items-center gap-1.5',
                done && 'text-status-success',
                current &&
                  !failed &&
                  status === 'processing' &&
                  'text-status-info',
                failed && 'text-status-danger'
              )}
            >
              <Icon
                className={cn(
                  'size-3',
                  current && status === 'processing' && 'animate-spin'
                )}
              />
              <span
                className={cn(
                  done || current ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {name}
                {current &&
                status === 'processing' &&
                stepPercent !== undefined &&
                stepPercent > 0
                  ? ` ${stepPercent}%`
                  : ''}
              </span>
            </span>
          </span>
        )
      })}
      {note ? <span className="ml-auto truncate pl-4">{note}</span> : null}
    </div>
  )
}
