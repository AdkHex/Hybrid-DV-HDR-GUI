import { ChevronDown, File, Folder, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { baseName } from '@/lib/paths'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { PathKind } from '@/store/app-store'

interface PathPickerProps {
  value: string
  kind: PathKind
  placeholder: string
  disabled?: boolean
  onPickFile?: () => void
  onPickFolder?: () => void
  onClear: () => void
  fileLabel?: string
  folderLabel?: string
}

/**
 * A picker in the style of the sidebar controls in GDExplorer: dashed while
 * empty, the picked name once set, and a menu for file / folder / clear.
 */
export function PathPicker({
  value,
  kind,
  placeholder,
  disabled,
  onPickFile,
  onPickFolder,
  onClear,
  fileLabel = 'Choose file…',
  folderLabel = 'Choose folder…',
}: PathPickerProps) {
  const empty = !value
  const Icon = empty ? Plus : kind === 'folder' ? Folder : File
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          title={value || undefined}
          className={cn(
            'flex h-10 w-full items-center gap-2 rounded-lg border px-3 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50',
            empty
              ? 'border-dashed border-input text-muted-foreground'
              : 'border-input text-foreground'
          )}
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {empty ? placeholder : baseName(value)}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
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
        {!empty ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onClear}>Clear</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
