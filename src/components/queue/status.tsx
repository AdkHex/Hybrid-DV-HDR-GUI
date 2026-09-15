import {
  AlertTriangle,
  Check,
  Clock,
  Loader2,
  type LucideIcon,
} from 'lucide-react'
import type { JobStatus } from '@/types'

interface StatusStyle {
  label: string
  Icon: LucideIcon
  iconClass?: string
  text: string
  fill: string
  track: string
}

/** Single source of truth for how each status looks (HIG status colours). */
export const JOB_STATUS: Record<JobStatus, StatusStyle> = {
  queued: {
    label: 'Queued',
    Icon: Clock,
    text: 'text-muted-foreground',
    fill: 'bg-muted-foreground/30',
    track: 'bg-muted-foreground/10',
  },
  running: {
    label: 'Running',
    Icon: Loader2,
    iconClass: 'animate-spin',
    text: 'text-status-info',
    fill: 'bg-status-info',
    track: 'bg-status-info/15',
  },
  completed: {
    label: 'Completed',
    Icon: Check,
    text: 'text-status-success',
    fill: 'bg-status-success',
    track: 'bg-status-success/15',
  },
  failed: {
    label: 'Failed',
    Icon: AlertTriangle,
    text: 'text-status-danger',
    fill: 'bg-status-danger',
    track: 'bg-status-danger/15',
  },
}
