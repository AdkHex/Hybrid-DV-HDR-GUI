import { useState } from 'react';
import { Settings, Folder, Save, RotateCcw, Wrench, Download, ExternalLink } from 'lucide-react';
import { isTauri, openDialog, openUrl, invokeTauri } from '@/lib/tauri';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { ToolPaths } from './types';

interface ToolSettingsProps {
  toolPaths: ToolPaths;
  onSave: (paths: ToolPaths) => void;
  parallelTasks: number;
  onParallelTasksChange: (value: number) => void;
  keepTempFiles: boolean;
  onKeepTempFilesChange: (value: boolean) => void;
}

const defaultPaths: ToolPaths = {
  doviTool: 'dovi_tool',
  mkvmerge: 'mkvmerge',
  mkvextract: 'mkvextract',
  ffmpeg: 'ffmpeg',
  defaultOutput: 'DV.HDR',
};

const toolLabels = [
  { key: 'doviTool' as const, label: 'dovi_tool', icon: '🔧' },
  { key: 'mkvmerge' as const, label: 'mkvmerge', icon: '📦' },
  { key: 'mkvextract' as const, label: 'mkvextract', icon: '📤' },
  { key: 'ffmpeg' as const, label: 'ffmpeg', icon: '🎬' },
  { key: 'defaultOutput' as const, label: 'Default Output Folder', icon: '📁' },
];

const downloadLinks = [
  { name: 'mkvmerge', filename: 'mkvmerge.exe', id: '1ZexvkYqNy3IM71XeNS8hMTX8DW0As0QC' },
  { name: 'mkvextract', filename: 'mkvextract.exe', id: '1wjkKcFVD4YBFc62W1gr4mLHBtIk5nxUF' },
  { name: 'doviTool', filename: 'dovi_tool.exe', id: '1m12rSnBJ7bjzeOFhGyY3HFZD6HAwtGjm' },
  { name: 'ffmpeg', filename: 'ffmpeg.exe', id: '1dn75gMzrhGIMwJR2Ucsmo9EOTnpSHiOQ' },
];

export function ToolSettings({ 
  toolPaths, 
  onSave,
  parallelTasks,
  onParallelTasksChange,
  keepTempFiles,
  onKeepTempFilesChange
}: ToolSettingsProps) {
  const [open, setOpen] = useState(false);
  const [paths, setPaths] = useState<ToolPaths>(toolPaths);
  const [localParallel, setLocalParallel] = useState(parallelTasks);
  const [localKeepTemp, setLocalKeepTemp] = useState(keepTempFiles);
  const [downloading, setDownloading] = useState(false);

  // Sync props to local state when dialog opens
  const handleOpenChange = (isOpen: boolean) => {
      if (isOpen) {
          setPaths(toolPaths);
          setLocalParallel(parallelTasks);
          setLocalKeepTemp(keepTempFiles);
      }
      setOpen(isOpen);
  };

  const handleSave = () => {
    onSave(paths);
    onParallelTasksChange(localParallel);
    onKeepTempFilesChange(localKeepTemp);
    setOpen(false);
  };

  const handleReset = () => {
    setPaths(defaultPaths);
    setLocalParallel(4);
    setLocalKeepTemp(false);
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

  const handleDownloadAll = async () => {
    if (!isTauri()) {
      alert("Auto-download is only available in the desktop app.");
      return;
    }
    
    setDownloading(true);
    const bypassBase = "https://bypasszbot.legendindex.workers.dev/direct.aspx?id=";
    const newPaths = { ...paths };

    try {
      for (const tool of downloadLinks) {
        const url = `${bypassBase}${tool.id}`;
        // Invoke Rust command to download
        const savedPath = await invokeTauri<string>('download_file', { 
           url, 
           filename: tool.filename 
        });
        
        // Update the path for this tool
        if (tool.name === 'doviTool') newPaths.doviTool = savedPath;
        if (tool.name === 'mkvmerge') newPaths.mkvmerge = savedPath;
        if (tool.name === 'mkvextract') newPaths.mkvextract = savedPath;
        if (tool.name === 'ffmpeg') newPaths.ffmpeg = savedPath;
      }
      
      setPaths(newPaths);
      // We don't save immediately here to allow user to review/save manually, 
      // OR we could save immediately. The requirement says "everytime... it should set it".
      // Let's keep the manual save model but update local state so 'Save' button commits it.
      alert("All tools downloaded and configured successfully! Click 'Save Configuration' to apply.");
    } catch (error) {
      console.error(error);
      alert(`Download failed: ${error}`);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" title="Settings">
          <Wrench className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-primary" />
            Configuration
          </DialogTitle>
          <DialogDescription>
            Manage application settings and tool paths.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="tools" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="tools">External Tools</TabsTrigger>
                <TabsTrigger value="processing">Processing</TabsTrigger>
            </TabsList>
            
            <TabsContent value="tools" className="space-y-4 py-4">
                <div className="rounded-lg border border-border bg-muted/50 p-4">
                    <div className="flex items-center justify-between">
                    <div>
                        <h4 className="text-sm font-medium text-foreground">Missing Dependencies?</h4>
                        <p className="text-xs text-muted-foreground">Download required tools automatically.</p>
                    </div>
                    <Button 
                        variant="secondary" 
                        size="sm" 
                        className="gap-2"
                        onClick={handleDownloadAll}
                        disabled={downloading}
                    >
                        <Download className={`h-4 w-4 ${downloading ? 'animate-bounce' : ''}`} />
                        {downloading ? 'Downloading...' : 'Download Needed Packages'}
                    </Button>
                    </div>
                </div>

                <div className="space-y-4">
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
                            className="bg-background border-input font-mono text-sm"
                        />
                        <Button
                            variant="secondary"
                            size="icon"
                            className="shrink-0"
                            onClick={() => handleBrowse(key)}
                            title="Browse"
                        >
                            <Folder className="h-4 w-4" />
                        </Button>
                        </div>
                    </div>
                    ))}
                </div>
            </TabsContent>
            
            <TabsContent value="processing" className="space-y-6 py-4">
                <div className="space-y-4">
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                        <Label className="text-sm">Parallel Processes (Batch Mode)</Label>
                        <span className="text-sm font-mono text-primary">{localParallel}</span>
                        </div>
                        <Slider
                        value={[localParallel]}
                        onValueChange={([v]) => setLocalParallel(v)}
                        min={1}
                        max={8}
                        step={1}
                        className="w-full"
                        />
                        <p className="text-xs text-muted-foreground">
                        Number of files to process simultaneously when in batch mode.
                        </p>
                    </div>

                    <div className="flex items-center justify-between p-4 rounded-lg border border-border">
                        <div>
                            <Label className="text-sm">Keep Temporary Files</Label>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                Preserve intermediate files after processing
                            </p>
                        </div>
                        <Switch
                            checked={localKeepTemp}
                            onCheckedChange={setLocalKeepTemp}
                        />
                    </div>
                </div>
            </TabsContent>
        </Tabs>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={handleReset}>
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset Defaults
          </Button>
          <Button onClick={handleSave}>
            <Save className="h-4 w-4 mr-2" />
            Save Configuration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
