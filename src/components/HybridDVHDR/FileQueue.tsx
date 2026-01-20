import { Check, GripVertical } from 'lucide-react';
import { useRef, useState } from 'react';
import type { QueueFile, FileProgressEntry } from './types';

interface FileQueueProps {
  files: QueueFile[];
  fileProgress: FileProgressEntry[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onReorder: (sourceId: string, targetId: string) => void;
}

export function FileQueue({ files, fileProgress, selectedIds, onToggle, onToggleAll, onReorder }: FileQueueProps) {
  const draggingIdRef = useRef<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);

  if (files.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center">
        <div className="h-8 w-8 mx-auto mb-2 rounded-full border border-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">
          No files in queue
        </p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          Drop files or add HDR/DV folder paths above
        </p>
      </div>
    );
  }

  const completedCount = files.filter(f => f.status === 'completed').length;
  const processingCount = files.filter(f => f.status === 'processing').length;
  const pendingCount = files.filter(f => f.status === 'pending').length;
  const errorCount = files.filter(f => f.status === 'error').length;
  const activeWorkers = files.reduce((sum, file) => sum + (file.activeWorkers || 0), 0);
  const allSelected = selectedIds.size > 0 && selectedIds.size === files.length;
  const showSelectionControls = files.length > 1;

  const statusPill = (label: string, value: number, tone: 'default' | 'success' | 'warning' | 'danger') => {
    const toneClass = {
      default: 'border-muted-foreground/30 text-muted-foreground',
      success: 'border-emerald-400/40 text-emerald-300',
      warning: 'border-amber-400/40 text-amber-300',
      danger: 'border-red-400/40 text-red-300',
    }[tone];

    return (
      <span className={`rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-wide ${toneClass}`}>
        {label} {value}
      </span>
    );
  };

  const formatEta = (seconds?: number) => {
    if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins <= 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden shadow-[0_10px_30px_-20px_rgba(0,0,0,0.6)]">
      <div className="px-4 py-3 bg-gradient-to-r from-muted/40 via-muted/60 to-muted/20 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-[0.2em]">
            Processing Queue
          </span>
          <div className="flex items-center gap-2">
            {statusPill('Active', processingCount, 'success')}
            {statusPill('Pending', pendingCount, 'default')}
            {statusPill('Done', completedCount, 'default')}
            {errorCount > 0 && statusPill('Errors', errorCount, 'danger')}
            {activeWorkers > 0 && statusPill('Workers', activeWorkers, 'warning')}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {showSelectionControls && (
            <button
              type="button"
              className="rounded-full border border-primary/40 px-3 py-1 text-[11px] font-medium text-primary hover:border-primary hover:bg-primary/10"
              onClick={onToggleAll}
            >
              {allSelected ? 'Unselect All' : 'Select All'}
            </button>
          )}
          <button
            type="button"
            className="rounded-full border border-muted-foreground/30 px-3 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:border-muted-foreground/60"
            onClick={() => setShowFiles(prev => !prev)}
          >
            {showFiles ? 'Hide Files' : 'Show Files'}
          </button>
        </div>
      </div>
      
      <div className="divide-y divide-border/70">
        {files.map((file) => {
          const isSelected = selectedIds.has(file.id);
          const isActive = file.status === 'processing';
          const etaLabel = formatEta(file.etaSeconds);
          const stepLabel = file.currentStep
            ? file.currentStep
                .replace(/^\d+\/\d+\s+/, '')
                .split(' - ')
                .pop()
            : undefined;
          return (
            <div
              key={file.id}
              className={`px-4 py-3 transition-colors ${
                isActive ? 'bg-primary/5' : 'hover:bg-muted/30'
              }`}
              draggable
              onDragStart={(event) => {
                draggingIdRef.current = file.id;
                event.dataTransfer.setData('text/plain', file.id);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                draggingIdRef.current = null;
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const sourceId = event.dataTransfer.getData('text/plain') || draggingIdRef.current;
                if (sourceId && sourceId !== file.id) {
                  onReorder(sourceId, file.id);
                }
                draggingIdRef.current = null;
              }}
            >
              <div className="flex items-center gap-3">
                <GripVertical className="h-4 w-4 text-muted-foreground/40" />
                {showSelectionControls && (
                  <button
                    type="button"
                    className={`h-5 w-5 rounded border flex items-center justify-center ${
                      isSelected ? 'bg-primary text-primary-foreground border-primary' : 'border-muted-foreground/40'
                    }`}
                    onClick={() => onToggle(file.id)}
                  >
                    {isSelected && <Check className="h-3 w-3" />}
                  </button>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="font-mono truncate text-foreground">{file.outputFile}</div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="uppercase tracking-[0.2em]">{file.status}</span>
                        {stepLabel && <span className="truncate">{stepLabel}</span>}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-primary">{file.progress}%</div>
                      {etaLabel && <div className="text-[11px] text-muted-foreground">ETA {etaLabel}</div>}
                    </div>
                  </div>
                  <div className="mt-2 h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-primary/70 via-primary to-emerald-300 transition-all duration-300 ease-out"
                      style={{ width: `${file.progress}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {showFiles && (
        <div className="border-t border-border max-h-64 overflow-y-auto divide-y divide-border/70 bg-muted/10">
          {(fileProgress.length ? fileProgress : files.map(file => ({
            id: file.id,
            queueId: file.id,
            name: file.outputFile,
            progress: file.progress,
            etaSeconds: file.etaSeconds,
          })) ).map((file) => (
            <div key={file.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-mono truncate text-foreground">{file.name}</span>
                <span className="font-mono text-primary">
                  {file.progress}%
                  {formatEta(file.etaSeconds) ? ` • ETA ${formatEta(file.etaSeconds)}` : ''}
                </span>
              </div>
              <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-primary/70 via-primary to-emerald-300 transition-all duration-300 ease-out"
                  style={{ width: `${file.progress}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
