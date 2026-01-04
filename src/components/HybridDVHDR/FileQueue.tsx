import { Check } from 'lucide-react';
import { useState } from 'react';
import type { QueueFile, FileProgressEntry } from './types';

interface FileQueueProps {
  files: QueueFile[];
  fileProgress: FileProgressEntry[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}

export function FileQueue({ files, fileProgress, selectedIds, onToggle, onToggleAll }: FileQueueProps) {
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
  const [showFiles, setShowFiles] = useState(false);

  const formatEta = (seconds?: number) => {
    if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins <= 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
  };

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-3 py-2 bg-muted/50 border-b border-border flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Processing Queue
        </span>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            Active {processingCount} • Pending {pendingCount} • Done {completedCount}
            {errorCount > 0 ? ` • Errors ${errorCount}` : ''}
            {activeWorkers > 0 ? ` • Workers ${activeWorkers}` : ''}
          </span>
          {showSelectionControls && (
            <button
              type="button"
              className="text-xs text-primary underline underline-offset-4"
              onClick={onToggleAll}
            >
              {allSelected ? 'Unselect All' : 'Select All'}
            </button>
          )}
          <button
            type="button"
            className="text-xs text-primary underline underline-offset-4"
            onClick={() => setShowFiles(prev => !prev)}
          >
            {showFiles ? 'Hide Files' : 'Show Files'}
          </button>
        </div>
      </div>
      
      <div className="divide-y divide-border">
        {files.map((file) => {
          const isSelected = selectedIds.has(file.id);
          return (
            <div key={file.id} className="p-3">
              <div className="flex items-center gap-3">
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
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono truncate text-foreground">{file.outputFile}</span>
                    <span className="font-mono text-primary">{file.progress}%</span>
                  </div>
                  <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-300 ease-out"
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
        <div className="border-t border-border max-h-64 overflow-y-auto divide-y divide-border">
          {(fileProgress.length ? fileProgress : files.map(file => ({
            id: file.id,
            queueId: file.id,
            name: file.outputFile,
            progress: file.progress,
            etaSeconds: file.etaSeconds,
          })) ).map((file) => (
            <div key={file.id} className="p-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-mono truncate text-foreground">{file.name}</span>
                <span className="font-mono text-primary">
                  {file.progress}%
                  {formatEta(file.etaSeconds) ? ` • ETA ${formatEta(file.etaSeconds)}` : ''}
                </span>
              </div>
              <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300 ease-out"
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
