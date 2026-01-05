import { useEffect, useRef, useState } from 'react';
import { Settings, Folder, RotateCcw, Wrench, Download } from 'lucide-react';
import { isTauri, invokeTauri, listenTauri, openDialog } from '@/lib/tauri';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import type { DownloadProgressPayload, ToolPaths } from './types';

interface ToolSettingsProps {
  toolPaths: ToolPaths;
  onSave: (paths: ToolPaths) => void;
  parallelTasks: number;
  onParallelTasksChange: (value: number) => void;
}

const defaultPaths: ToolPaths = {
  doviTool: 'bin\\dovi_tool.exe',
  mkvmerge: 'bin\\mkvmerge.exe',
  mkvextract: 'bin\\mkvextract.exe',
  ffmpeg: 'bin\\ffmpeg.exe',
  defaultOutput: 'DV.HDR',
};

const toolLabels = [
  { key: 'doviTool' as const, label: 'dovi_tool.exe', icon: '🔧', downloadable: true },
  { key: 'mkvmerge' as const, label: 'mkvmerge.exe', icon: '📦', downloadable: true },
  { key: 'mkvextract' as const, label: 'mkvextract.exe', icon: '📤', downloadable: true },
  { key: 'ffmpeg' as const, label: 'ffmpeg.exe', icon: '🎬', downloadable: true },
  { key: 'defaultOutput' as const, label: 'Default Output Folder', icon: '📁', downloadable: false },
];

const toolLabelByKey = new Map(toolLabels.map(item => [item.key, item.label]));

export function ToolSettings({
  toolPaths,
  onSave,
  parallelTasks,
  onParallelTasksChange,
}: ToolSettingsProps) {
  const [open, setOpen] = useState(false);
  const [paths, setPaths] = useState<ToolPaths>(toolPaths);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadingKey, setDownloadingKey] = useState<keyof ToolPaths | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, DownloadProgressPayload>>(
    {}
  );
  const [progressVisible, setProgressVisible] = useState<Record<string, boolean>>({});
  const [activeDownloadKey, setActiveDownloadKey] = useState<keyof ToolPaths | null>(null);
  const { toast } = useToast();
  const hasMountedRef = useRef(false);

  const handleReset = () => {
    setPaths(defaultPaths);
  };

  const updatePath = (key: keyof ToolPaths, value: string) => {
    setPaths(prev => ({ ...prev, [key]: value }));
  };

  const handleBrowse = async (key: keyof ToolPaths) => {
    if (!isTauri()) {
      const manual = window.prompt('Enter a full path:');
      if (manual) updatePath(key, manual);
      return;
    }

    const selected = await openDialog({
      directory: key === 'defaultOutput',
      multiple: false,
      filters: key === 'defaultOutput' ? undefined : [{ name: 'Executable', extensions: ['exe'] }],
    });

    if (typeof selected === 'string') {
      updatePath(key, selected);
    }
  };

  const handleDownload = async () => {
    if (!isTauri()) {
      toast({
        title: 'Downloads unavailable',
        description: 'Pre-requisites can only be downloaded from the desktop app.',
        variant: 'destructive',
      });
      return;
    }

    setIsDownloading(true);
    setDownloadStatus('Preparing downloads...');
    setDownloadProgress({});
    setProgressVisible({});
    setActiveDownloadKey(null);
    try {
      const downloaded = await invokeTauri<ToolPaths>('download_prerequisites');
      setPaths(downloaded);
      onSave(downloaded);
      toast({
        title: 'Downloads complete',
        description: 'Tool paths were updated to the downloaded binaries.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({
        title: 'Download failed',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setIsDownloading(false);
      setDownloadStatus(null);
      setActiveDownloadKey(null);
    }
  };

  const handleDownloadTool = async (key: keyof ToolPaths) => {
    if (!isTauri()) {
      toast({
        title: 'Downloads unavailable',
        description: 'Pre-requisites can only be downloaded from the desktop app.',
        variant: 'destructive',
      });
      return;
    }

    setDownloadingKey(key);
    setDownloadStatus('Preparing download...');
    setDownloadProgress({});
    setProgressVisible({});
    setActiveDownloadKey(key);
    try {
      const downloaded = await invokeTauri<string>('download_tool', { tool: key });
      setPaths((prev) => {
        const next = { ...prev, [key]: downloaded };
        onSave(next);
        return next;
      });
      const label = toolLabels.find((tool) => tool.key === key)?.label ?? key;
      toast({
        title: 'Download complete',
        description: `${label} path was updated.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({
        title: 'Download failed',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setDownloadingKey(null);
      setDownloadStatus(null);
      setActiveDownloadKey(null);
    }
  };

  const formatBytes = (bytes: number | undefined) => {
    if (!bytes && bytes !== 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
  };

  const areToolPathsEqual = (a: ToolPaths, b: ToolPaths) => (
    a.doviTool === b.doviTool &&
    a.mkvmerge === b.mkvmerge &&
    a.mkvextract === b.mkvextract &&
    a.ffmpeg === b.ffmpeg &&
    a.defaultOutput === b.defaultOutput
  );

  useEffect(() => {
    setPaths(toolPaths);
  }, [toolPaths]);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    if (areToolPathsEqual(paths, toolPaths)) return;
    const timeout = window.setTimeout(() => {
      onSave(paths);
    }, 400);
    return () => window.clearTimeout(timeout);
  }, [onSave, paths, toolPaths]);

  useEffect(() => {
    if (!isTauri()) return;

    let unlistenProgress: (() => void) | undefined;

    const setup = async () => {
      unlistenProgress = await listenTauri<DownloadProgressPayload>(
        'download:progress',
        (event) => {
          if (!isDownloading && !downloadingKey) return;
          const payload = event.payload;
          const key = payload.tool as keyof ToolPaths;
          const label = toolLabelByKey.get(key) ?? payload.tool;
          setDownloadProgress((prev) => ({ ...prev, [payload.tool]: payload }));

          if (payload.stage === 'starting') {
            setDownloadStatus(`Preparing ${label}...`);
            setActiveDownloadKey(key);
          } else if (payload.stage === 'downloading') {
            setDownloadStatus(`Downloading ${label}`);
            setActiveDownloadKey(key);
            setProgressVisible((prev) => ({ ...prev, [payload.tool]: true }));
          } else if (payload.stage === 'installed') {
            setDownloadStatus(`Updating path for ${label}`);
            if (payload.path) {
              setPaths((prev) => {
                const next = { ...prev, [key]: payload.path };
                onSave(next);
                return next;
              });
            }
            setProgressVisible((prev) => ({ ...prev, [payload.tool]: false }));
            window.setTimeout(() => {
              setDownloadProgress((prev) => {
                const next = { ...prev };
                delete next[payload.tool];
                return next;
              });
            }, 1500);
          } else if (payload.stage === 'downloaded') {
            setDownloadStatus(`Downloaded ${label}`);
          }
        }
      );
    };

    setup();

    return () => {
      if (unlistenProgress) unlistenProgress();
    };
  }, [downloadingKey, isDownloading, onSave]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" title="Tool Settings">
          <Wrench className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-primary" />
            Tool Configuration
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <p className="text-sm text-muted-foreground">
            Configure paths to required tools. Relative paths are resolved from the application directory.
          </p>

          {toolLabels.map(({ key, label, icon, downloadable }) => (
            <div key={key} className="space-y-1.5">
              <Label className="text-sm flex items-center gap-2">
                <span>{icon}</span>
                {label}
              </Label>
              <div className="flex gap-2">
                <Input
                  value={paths[key]}
                  onChange={(e) => updatePath(key, e.target.value)}
                  placeholder={defaultPaths[key]}
                  className="bg-muted border-border font-mono text-sm"
                />
                {downloadable && (
                  <Button
                    variant="secondary"
                    size="icon"
                    className="shrink-0"
                    onClick={() => handleDownloadTool(key)}
                    disabled={isDownloading || downloadingKey === key}
                    title={`Download ${label}`}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="icon"
                  className="shrink-0"
                  onClick={() => handleBrowse(key)}
                >
                  <Folder className="h-4 w-4" />
                </Button>
              </div>
              {downloadable && downloadProgress[key]?.stage && (
                <div className="text-xs text-muted-foreground flex items-center gap-2">
                  <span>
                    {downloadProgress[key]?.stage === 'starting'
                      ? `Preparing ${label}...`
                      : downloadProgress[key]?.stage === 'downloading'
                        ? `Downloading ${label}`
                        : downloadProgress[key]?.stage === 'installed'
                          ? `Updated path for ${label}`
                          : `Downloaded ${label}`}
                  </span>
                  {downloadProgress[key]?.stage === 'downloading' &&
                    typeof downloadProgress[key]?.percent === 'number' && (
                    <span>{downloadProgress[key]?.percent}%</span>
                  )}
                  {downloadProgress[key]?.stage === 'downloading' &&
                    downloadProgress[key]?.bytesReceived !== undefined && (
                    <span className="font-mono">
                      {formatBytes(downloadProgress[key]?.bytesReceived)}
                      {downloadProgress[key]?.totalBytes
                        ? ` / ${formatBytes(downloadProgress[key]?.totalBytes)}`
                        : ''}
                    </span>
                  )}
                </div>
              )}
              {downloadable &&
                progressVisible[key] &&
                typeof downloadProgress[key]?.percent === 'number' && (
                <Progress value={downloadProgress[key]?.percent} className="h-2" />
              )}
            </div>
          ))}

          <div className="space-y-2 pt-2 border-t border-border">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Parallel Processes</Label>
              <span className="text-sm font-mono text-primary">{parallelTasks}</span>
            </div>
            <Slider
              value={[parallelTasks]}
              onValueChange={([v]) => onParallelTasksChange(v)}
              min={1}
              max={15}
              step={1}
              className="w-full"
            />
            <p className="text-xs text-muted-foreground">
              Number of files to process simultaneously
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <div className="mr-auto space-y-2">
            {downloadStatus && (
              <p className="text-xs text-muted-foreground">{downloadStatus}</p>
            )}
            {activeDownloadKey && typeof downloadProgress[activeDownloadKey]?.percent === 'number' && (
              <Progress value={downloadProgress[activeDownloadKey]?.percent} className="h-2 w-48" />
            )}
          </div>
          <Button variant="secondary" onClick={handleDownload} disabled={isDownloading}>
            {isDownloading ? 'Downloading...' : 'Download Pre-requisites'}
          </Button>
          <Button variant="outline" onClick={handleReset}>
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
