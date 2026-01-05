import { useState } from 'react';
import { Settings, Folder, Save, RotateCcw, Wrench } from 'lucide-react';
import { isTauri, invokeTauri, openDialog } from '@/lib/tauri';
import { Input } from '@/components/ui/input';
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
import type { ToolPaths } from './types';

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
  { key: 'doviTool' as const, label: 'dovi_tool.exe', icon: '🔧' },
  { key: 'mkvmerge' as const, label: 'mkvmerge.exe', icon: '📦' },
  { key: 'mkvextract' as const, label: 'mkvextract.exe', icon: '📤' },
  { key: 'ffmpeg' as const, label: 'ffmpeg.exe', icon: '🎬' },
  { key: 'defaultOutput' as const, label: 'Default Output Folder', icon: '📁' },
];

export function ToolSettings({
  toolPaths,
  onSave,
  parallelTasks,
  onParallelTasksChange,
}: ToolSettingsProps) {
  const [open, setOpen] = useState(false);
  const [paths, setPaths] = useState<ToolPaths>(toolPaths);
  const [isDownloading, setIsDownloading] = useState(false);
  const { toast } = useToast();

  const handleSave = () => {
    onSave(paths);
    setOpen(false);
  };

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
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" title="Tool Settings">
          <Wrench className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg bg-card border-border">
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

          {toolLabels.map(({ key, label, icon }) => (
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
                <Button
                  variant="secondary"
                  size="icon"
                  className="shrink-0"
                  onClick={() => handleBrowse(key)}
                >
                  <Folder className="h-4 w-4" />
                </Button>
              </div>
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
          <Button variant="secondary" onClick={handleDownload} disabled={isDownloading}>
            {isDownloading ? 'Downloading...' : 'Download Pre-requisites'}
          </Button>
          <Button variant="outline" onClick={handleReset}>
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset
          </Button>
          <Button onClick={handleSave}>
            <Save className="h-4 w-4 mr-2" />
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
