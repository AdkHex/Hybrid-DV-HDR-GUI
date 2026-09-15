import { ChevronDown, File, Folder } from 'lucide-react'
import { cn } from '@/lib/utils'
import { baseName } from '@/lib/paths'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { PathKind } from '@/types'

interface PathFieldProps {
  value: string
  kind: PathKind
  placeholder: string
  meta?: React.ReactNode
  disabled?: boolean
  onPickFile?: () => void
  onPickFolder?: () => void
  onSwap?: () => void
  onClear: () => void
  fileLabel?: string
  folderLabel?: string
  /** Show the full path when the value is a folder (folder names alone are ambiguous). */
  showPath?: boolean
}

/** A picked path with a menu to change it: dashed while empty. */
export function PathField({
  value,
  kind,
  placeholder,
  meta,
  disabled,
  onPickFile,
  onPickFolder,
  onSwap,
  onClear,
  fileLabel = 'Choose file…',
  folderLabel = 'Choose folder…',
  showPath,
}: PathFieldProps) {
  const empty = !value
  const Icon = kind === 'folder' ? Folder : File
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          title={value || undefined}
          className={cn(
            'flex h-8 w-full min-w-0 items-center gap-2 rounded-md border px-2.5 text-left text-[13px] transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-60',
            empty
              ? 'border-dashed border-input text-muted-foreground'
              : 'border-input'
          )}
        >
          {!empty ? (
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          <span className="min-w-0 flex-1 truncate">
            {empty ? placeholder : showPath ? value : baseName(value)}
          </span>
          {meta ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {meta}
            </span>
          ) : null}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {onPickFile ? (
          <DropdownMenuItem onSelect={onPickFile}>
            <File className="size-4" /> {fileLabel}
          </DropdownMenuItem>
        ) : null}
        {onPickFolder ? (
          <DropdownMenuItem onSelect={onPickFolder}>
            <Folder className="size-4" /> {folderLabel}
          </DropdownMenuItem>
        ) : null}
        {onSwap || !empty ? <DropdownMenuSeparator /> : null}
        {onSwap ? (
          <DropdownMenuItem onSelect={onSwap}>
            Swap base and donor
          </DropdownMenuItem>
        ) : null}
        {!empty ? (
          <DropdownMenuItem onSelect={onClear}>Clear</DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
