import { useState, useCallback, useEffect, useRef } from 'react';
import { 
  Play, 
  Square, 
  Settings2, 
  Trash2,
  Plus,
  Layers
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { FileInput } from './FileInput';
import { ProcessingSteps } from './ProcessingSteps';
import { ConsoleLog } from './ConsoleLog';
import { ToolSettings } from './ToolSettings';
import { FileQueue } from './FileQueue';
import { 
  isTauri, 
  invokeTauri, 
  listenTauri, 
  openDialog, 
  saveDialog
} from '@/lib/tauri';
import type {
  ProcessingConfig, 
  ProcessingStep, 
  LogEntry, 
  ProcessingStatus, 
  ProcessingMode,
  ToolPaths,
  QueueFile,
  LogPayload,
  StepPayload,
  QueuePayload,
  StatusPayload,
  ProcessingRequest,
  FileProgressPayload,
  FileProgressEntry
} from './types';

const defaultSteps: ProcessingStep[] = [
  { id: 1, name: 'Extract Audio & Subtitles', description: 'Extracting audio tracks and subtitles from HDR source', status: 'pending', progress: 0 },
  { id: 2, name: 'Extract DV Video', description: 'Extracting H.265 video from Dolby Vision source', status: 'pending', progress: 0 },
  { id: 3, name: 'Extract RPU Data', description: 'Extracting RPU metadata from DV stream', status: 'pending', progress: 0 },
  { id: 4, name: 'Extract HDR10 Video', description: 'Extracting H.265 video from HDR10 source', status: 'pending', progress: 0 },
  { id: 5, name: 'Inject RPU Data', description: 'Injecting RPU data into HDR10 video stream', status: 'pending', progress: 0 },
  { id: 6, name: 'Mux Final Output', description: 'Combining video, audio, and subtitles into final MKV', status: 'pending', progress: 0 },
];

const defaultToolPaths: ToolPaths = {
  doviTool: 'bin\\dovi_tool.exe',
  mkvmerge: 'bin\\mkvmerge.exe',
  mkvextract: 'bin\\mkvextract.exe',
  ffmpeg: 'bin\\ffmpeg.exe',
  defaultOutput: 'DV.HDR',
};

export function HybridDVHDRTool() {
  const toolPathsStorageKey = 'hybrid-dv-hdr:toolPaths';
  const configStorageKey = 'hybrid-dv-hdr:config';
  const [pathKinds, setPathKinds] = useState<{ hdr: 'file' | 'folder' | 'unknown'; dv: 'file' | 'folder' | 'unknown'; output: 'file' | 'folder' | 'unknown' }>({
    hdr: 'unknown',
    dv: 'unknown',
    output: 'unknown',
  });
  const [config, setConfig] = useState<ProcessingConfig>(() => {
    if (typeof window === 'undefined') {
      return {
        hdrPath: '',
        dvPath: '',
        outputPath: '',
        mode: 'single',
        parallelTasks: 8,
        keepTempFiles: false,
      };
    }
    try {
      const stored = window.localStorage.getItem(configStorageKey);
      if (!stored) {
        return {
          hdrPath: '',
          dvPath: '',
          outputPath: '',
          mode: 'single',
          parallelTasks: 8,
          keepTempFiles: false,
        };
      }
      const parsed = JSON.parse(stored) as Partial<ProcessingConfig>;
      return {
        hdrPath: '',
        dvPath: '',
        outputPath: '',
        mode: 'single',
        parallelTasks: 8,
        keepTempFiles: false,
        ...parsed,
      };
    } catch {
      return {
        hdrPath: '',
        dvPath: '',
        outputPath: '',
        mode: 'single',
        parallelTasks: 8,
        keepTempFiles: false,
      };
    }
  });
  
  const [toolPaths, setToolPaths] = useState<ToolPaths>(() => {
    if (typeof window === 'undefined') return defaultToolPaths;
    try {
      const stored = window.localStorage.getItem(toolPathsStorageKey);
      if (!stored) return defaultToolPaths;
      const parsed = JSON.parse(stored) as Partial<ToolPaths>;
      return { ...defaultToolPaths, ...parsed };
    } catch {
      return defaultToolPaths;
    }
  });
  const [status, setStatus] = useState<ProcessingStatus>('idle');
  const [steps, setSteps] = useState<ProcessingStep[]>(defaultSteps);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [queue, setQueue] = useState<QueueFile[]>([]);
  const [fileProgress, setFileProgress] = useState<FileProgressEntry[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const queueMetaRef = useRef(new Map<string, { start: number; lastProgress: number }>());
  const fileMetaRef = useRef(new Map<string, { start: number; lastProgress: number }>());
  const [selectedQueueIds, setSelectedQueueIds] = useState<Set<string>>(new Set());
  const configSaveRef = useRef<number | null>(null);
  const toolPathsSaveRef = useRef<number | null>(null);

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    const entry: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      type,
      message,
    };
    setLogs(prev => [...prev, entry]);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;

    let unlistenLog: (() => void) | undefined;
    let unlistenStep: (() => void) | undefined;
    let unlistenQueue: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let unlistenFile: (() => void) | undefined;

    const setupListeners = async () => {
      unlistenLog = await listenTauri<LogPayload>('processing:log', (event) => {
        addLog(event.payload.logType, event.payload.message);
      });

      unlistenStep = await listenTauri<StepPayload>('processing:step', (event) => {
        const payload = event.payload;
        setSteps(prev => prev.map(step => (
          step.id === payload.stepId
            ? { ...step, status: payload.status, progress: payload.progress }
            : step
        )));
      });

      unlistenQueue = await listenTauri<QueuePayload>('processing:queue', (event) => {
        const payload = event.payload;
        setQueue(prev => prev.map(item => {
          if (item.id !== payload.id) return item;

          let etaSeconds = item.etaSeconds;
          if (payload.status === 'processing') {
            const meta = queueMetaRef.current.get(item.id) || { start: Date.now(), lastProgress: 0 };
            if (payload.progress > 0) {
              const elapsed = (Date.now() - meta.start) / 1000;
              etaSeconds = Math.round((elapsed / payload.progress) * (100 - payload.progress));
              meta.lastProgress = payload.progress;
            }
            queueMetaRef.current.set(item.id, meta);
          } else if (payload.status === 'completed') {
            etaSeconds = 0;
            queueMetaRef.current.delete(item.id);
          } else if (payload.status === 'error' || payload.status === 'pending') {
            queueMetaRef.current.delete(item.id);
          }

          return {
            ...item,
            status: payload.status,
            progress: payload.progress,
            currentStep: payload.currentStep || undefined,
            etaSeconds,
            activeWorkers: payload.activeWorkers ?? item.activeWorkers,
            fileTotal: payload.fileTotal ?? item.fileTotal,
          };
        }));
      });

      unlistenStatus = await listenTauri<StatusPayload>('processing:status', (event) => {
        setStatus(event.payload.status);
      });

      unlistenFile = await listenTauri<FileProgressPayload>('processing:file', (event) => {
        const payload = event.payload;
        setFileProgress(prev => {
          const existing = prev.find(item => item.id === payload.id);
          let etaSeconds = existing?.etaSeconds;
          const meta = fileMetaRef.current.get(payload.id) || { start: Date.now(), lastProgress: 0 };

          if (payload.progress > 0) {
            const elapsed = (Date.now() - meta.start) / 1000;
            etaSeconds = Math.round((elapsed / payload.progress) * (100 - payload.progress));
            meta.lastProgress = payload.progress;
          }

          fileMetaRef.current.set(payload.id, meta);

          const nextEntry: FileProgressEntry = {
            id: payload.id,
            queueId: payload.queueId,
            name: payload.name,
            progress: payload.progress,
            etaSeconds,
          };

          if (existing) {
            return prev.map(item => (item.id === payload.id ? nextEntry : item));
          }
          return [...prev, nextEntry];
        });
      });
    };

    setupListeners();

    return () => {
      if (unlistenLog) unlistenLog();
      if (unlistenStep) unlistenStep();
      if (unlistenQueue) unlistenQueue();
      if (unlistenStatus) unlistenStatus();
      if (unlistenFile) unlistenFile();
    };
  }, [addLog]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (toolPathsSaveRef.current) {
      window.clearTimeout(toolPathsSaveRef.current);
    }
    toolPathsSaveRef.current = window.setTimeout(() => {
      try {
        window.localStorage.setItem(toolPathsStorageKey, JSON.stringify(toolPaths));
      } catch {
        // ignore storage errors
      }
    }, 400);
  }, [toolPaths, toolPathsStorageKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (configSaveRef.current) {
      window.clearTimeout(configSaveRef.current);
    }
    configSaveRef.current = window.setTimeout(() => {
      try {
        window.localStorage.setItem(configStorageKey, JSON.stringify(config));
      } catch {
        // ignore storage errors
      }
    }, 400);
  }, [config, configStorageKey]);

  const derivedMode: ProcessingMode =
    pathKinds.hdr === 'folder' && pathKinds.dv === 'folder' ? 'batch' : 'single';

  const addToQueue = useCallback(() => {
    if (!config.hdrPath || !config.dvPath) return;

    const isBatch = derivedMode === 'batch';
    const hdrLabel = config.hdrPath.split('\\').filter(Boolean).pop() || config.hdrPath;
    const dvLabel = config.dvPath.split('\\').filter(Boolean).pop() || config.dvPath;

    const outputFile = isBatch
      ? config.outputPath || toolPaths.defaultOutput
      : config.outputPath || `${hdrLabel.replace('.mkv', '')}.hybrid.mkv`;

    const newFile: QueueFile = {
      id: crypto.randomUUID(),
      hdrFile: hdrLabel,
      dvFile: dvLabel,
      outputFile,
      hdrPath: config.hdrPath,
      dvPath: config.dvPath,
      outputPath: isBatch ? (config.outputPath || '') : outputFile,
      status: 'pending',
      progress: 0,
    };
    
    setQueue(prev => [...prev, newFile]);
    setSelectedQueueIds(prev => new Set(prev).add(newFile.id));
    setConfig(prev => ({ ...prev, hdrPath: '', dvPath: '', outputPath: '' }));
    addLog('info', `Added to queue: ${newFile.outputFile}`);
  }, [config, addLog, derivedMode, toolPaths.defaultOutput]);



  const browseFile = useCallback(
    async (target: 'hdr' | 'dv' | 'output') => {
      if (!isTauri()) {
        const manual = window.prompt('Enter a file path:');
        if (manual) {
          setConfig(prev => ({
            ...prev,
            [target === 'hdr' ? 'hdrPath' : target === 'dv' ? 'dvPath' : 'outputPath']: manual,
          }));
          setPathKinds(prev => ({ ...prev, [target]: 'file' }));
        }
        return;
      }

      if (target === 'output') {
        const selected = await saveDialog({
          defaultPath: config.outputPath || undefined,
          filters: [{ name: 'MKV', extensions: ['mkv'] }],
        });
        if (typeof selected === 'string') {
          setConfig(prev => ({ ...prev, outputPath: selected }));
          setPathKinds(prev => ({ ...prev, output: 'file' }));
        }
        return;
      }

      const selected = await openDialog({
        directory: false,
        multiple: false,
        filters: [{ name: 'Video', extensions: ['mkv', 'hevc'] }],
      });

      if (typeof selected === 'string') {
        setConfig(prev => ({
          ...prev,
          [target === 'hdr' ? 'hdrPath' : target === 'dv' ? 'dvPath' : 'outputPath']: selected,
        }));
        setPathKinds(prev => ({ ...prev, [target]: 'file' }));
      }
    },
    [config.outputPath],
  );

  const browseFolder = useCallback(
    async (target: 'hdr' | 'dv' | 'output') => {
      if (!isTauri()) {
        const manual = window.prompt('Enter a folder path:');
        if (manual) {
          setConfig(prev => ({
            ...prev,
            [target === 'hdr' ? 'hdrPath' : target === 'dv' ? 'dvPath' : 'outputPath']: manual,
          }));
          setPathKinds(prev => ({ ...prev, [target]: 'folder' }));
        }
        return;
      }

      const selected = await openDialog({
        directory: true,
        multiple: false,
      });

      if (typeof selected === 'string') {
        setConfig(prev => ({
          ...prev,
          [target === 'hdr' ? 'hdrPath' : target === 'dv' ? 'dvPath' : 'outputPath']: selected,
        }));
        setPathKinds(prev => ({ ...prev, [target]: 'folder' }));
      }
    },
    [],
  );

  const simulateProcessing = useCallback(async () => {
    setStatus('processing');
    addLog('info', 'Starting Hybrid DV HDR processing...');
    addLog('info', `Mode: ${derivedMode === 'single' ? 'Single File' : 'Batch'}`);
    
    if (derivedMode === 'batch' && queue.length > 0) {
      for (let q = 0; q < queue.length; q++) {
        const file = queue[q];
        addLog('info', `Processing file ${q + 1}/${queue.length}: ${file.outputFile}`);
        
        setQueue(prev => prev.map(f => 
          f.id === file.id ? { ...f, status: 'processing' as const, progress: 0 } : f
        ));
        
        for (let step = 0; step < defaultSteps.length; step++) {
          const stepProgress = Math.round(((step + 1) / defaultSteps.length) * 100);
          
          setQueue(prev => prev.map(f => 
            f.id === file.id ? { 
              ...f, 
              progress: stepProgress - 10,
              currentStep: defaultSteps[step].name 
            } : f
          ));
          
          await new Promise(r => setTimeout(r, 400));
          
          setQueue(prev => prev.map(f => 
            f.id === file.id ? { ...f, progress: stepProgress } : f
          ));
        }
        
        setQueue(prev => prev.map(f => 
          f.id === file.id ? { ...f, status: 'completed' as const, progress: 100 } : f
        ));
        
        addLog('success', `Completed: ${file.outputFile}`);
      }
    } else {
      addLog('info', `HDR Source: ${config.hdrPath}`);
      addLog('info', `DV Source: ${config.dvPath}`);
      
      const newSteps = [...defaultSteps];
      
      for (let i = 0; i < newSteps.length; i++) {
        newSteps[i] = { ...newSteps[i], status: 'active', progress: 0 };
        setSteps([...newSteps]);
        addLog('info', `Step ${i + 1}: ${newSteps[i].name}`);
        
        for (let p = 0; p <= 100; p += 10) {
          await new Promise(r => setTimeout(r, 100));
          newSteps[i] = { ...newSteps[i], progress: p };
          setSteps([...newSteps]);
        }
        
        newSteps[i] = { ...newSteps[i], status: 'completed', progress: 100 };
        setSteps([...newSteps]);
        addLog('success', `${newSteps[i].name} completed`);
      }
    }
    
    addLog('success', 'Processing completed successfully!');
    setStatus('completed');
  }, [config, queue, addLog, derivedMode]);

  const handleStart = async () => {
    if (derivedMode === 'single' && (!config.hdrPath || !config.dvPath)) {
      addLog('error', 'Please specify both HDR and DV source paths');
      return;
    }
    if (derivedMode === 'batch' && queue.length === 0) {
      addLog('error', 'Please add files to the queue first');
      return;
    }
    if (derivedMode === 'batch' && selectedQueueIds.size === 0) {
      addLog('error', 'Please select at least one queue item');
      return;
    }

    const mode = derivedMode;
    if (!isTauri()) {
      simulateProcessing();
      return;
    }

    setSteps(defaultSteps);
    setStatus('processing');
    setFileProgress([]);
    fileMetaRef.current.clear();

    const queueToProcess = derivedMode === 'batch'
      ? queue.filter(item => selectedQueueIds.has(item.id))
      : [];

    const request: ProcessingRequest = {
      mode,
      hdrPath: config.hdrPath,
      dvPath: config.dvPath,
      outputPath: config.outputPath,
      keepTempFiles: config.keepTempFiles,
      parallelTasks: config.parallelTasks,
      toolPaths,
      queue: queueToProcess,
    };

    try {
      await invokeTauri<void>('start_processing', { request });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addLog('error', message);
      setStatus('error');
    }
  };

  const handleStop = async () => {
    if (isTauri()) {
      await invokeTauri<void>('cancel_processing');
      return;
    }

    setStatus('idle');
    setSteps(defaultSteps);
    setQueue(prev => prev.map(f => ({ ...f, status: 'pending' as const, progress: 0 })));
    addLog('warning', 'Processing cancelled by user');
    setFileProgress([]);
    fileMetaRef.current.clear();
  };

  const handleClear = () => {
    setLogs([]);
    setSteps(defaultSteps);
    setStatus('idle');
    setQueue([]);
    setFileProgress([]);
    queueMetaRef.current.clear();
    fileMetaRef.current.clear();
    setSelectedQueueIds(new Set());
  };

  const isProcessing = status === 'processing';
  const canStart =
    derivedMode === 'single'
      ? Boolean(config.hdrPath && config.dvPath)
      : queue.length > 0 && selectedQueueIds.size > 0;
  const startLabel =
    derivedMode === 'batch'
      ? `Start Selected (${selectedQueueIds.size})`
      : 'Start Processing';

  return (
    <div className="w-full max-w-5xl mx-auto">
      {}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10 border border-primary/20">
            <Layers className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground tracking-tight">
              Hybrid DV HDR Tool
            </h1>
            <p className="text-xs text-muted-foreground">
              Combine Dolby Vision metadata with HDR10 sources
            </p>
          </div>
        </div>
        <ToolSettings
          toolPaths={toolPaths}
          onSave={setToolPaths}
          parallelTasks={config.parallelTasks}
          onParallelTasksChange={(v) => setConfig(prev => ({ ...prev, parallelTasks: v }))}
        />
      </div>

      {}
      <div className="mb-6 p-4 rounded-lg border border-border bg-card space-y-4">
          <FileInput
            label="HDR Source (file or folder)"
            value={config.hdrPath}
            onChange={(v) => {
              setConfig(prev => ({ ...prev, hdrPath: v }));
              setPathKinds(prev => ({ ...prev, hdr: v.endsWith('\\') || v.endsWith('/') ? 'folder' : 'file' }));
            }}
            placeholder={derivedMode === 'batch' ? 'C:\\Videos\\HDR\\' : 'C:\\Videos\\movie.hdr.mkv'}
            icon="hdr"
            disabled={isProcessing}
            onBrowseFile={() => browseFile('hdr')}
            onBrowseFolder={() => browseFolder('hdr')}
          />
        
          <FileInput
            label="Dolby Vision (file or folder)"
            value={config.dvPath}
            onChange={(v) => {
              setConfig(prev => ({ ...prev, dvPath: v }));
              setPathKinds(prev => ({ ...prev, dv: v.endsWith('\\') || v.endsWith('/') ? 'folder' : 'file' }));
            }}
            placeholder={derivedMode === 'batch' ? 'C:\\Videos\\DV\\' : 'C:\\Videos\\movie.dv.mkv'}
            icon="dv"
            disabled={isProcessing}
            onBrowseFile={() => browseFile('dv')}
            onBrowseFolder={() => browseFolder('dv')}
          />
        
          <FileInput
            label="Output (file or folder)"
            value={config.outputPath}
            onChange={(v) => {
              setConfig(prev => ({ ...prev, outputPath: v }));
              setPathKinds(prev => ({ ...prev, output: v.endsWith('\\') || v.endsWith('/') ? 'folder' : 'file' }));
            }}
            placeholder={derivedMode === 'batch' ? toolPaths.defaultOutput : 'movie.hybrid.mkv (auto)'}
            icon="output"
            disabled={isProcessing}
            onBrowseFile={() => browseFile('output')}
            onBrowseFolder={() => browseFolder('output')}
          />

        {derivedMode === 'batch' && (
          <Button
            variant="secondary"
            className="w-full"
            disabled={isProcessing || !config.hdrPath || !config.dvPath}
            onClick={addToQueue}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add to Queue
          </Button>
        )}
      </div>

      {}
      {derivedMode === 'batch' && (
        <div className="mb-6">
          <FileQueue 
            files={queue} 
            fileProgress={fileProgress}
            selectedIds={selectedQueueIds}
            onToggle={(id) => {
              setSelectedQueueIds(prev => {
                const next = new Set(prev);
                if (next.has(id)) {
                  next.delete(id);
                } else {
                  next.add(id);
                }
                return next;
              });
            }}
            onToggleAll={() => {
              setSelectedQueueIds(prev => {
                if (prev.size === queue.length) {
                  return new Set();
                }
                return new Set(queue.map(item => item.id));
              });
            }}
          />
        </div>
      )}

      <div className="mb-6 rounded-lg border border-border bg-card p-4 flex items-center gap-3">
        {!isProcessing ? (
          <Button 
            onClick={handleStart} 
            className="flex-1 glow-primary h-11 text-base"
            disabled={!canStart}
          >
            <Play className="h-4 w-4 mr-2" />
            {startLabel}
          </Button>
        ) : (
          <Button 
            onClick={handleStop} 
            variant="destructive"
            className="flex-1 h-11 text-base"
          >
            <Square className="h-4 w-4 mr-2" />
            Stop Processing
          </Button>
        )}
        
        <Button 
          onClick={handleClear} 
          variant="outline"
          disabled={isProcessing}
          className="h-11"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {}
      <div className="mb-6 rounded-lg border border-border bg-card overflow-hidden">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3"
          onClick={() => setSettingsOpen(prev => !prev)}
        >
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Settings</span>
          </div>
          <span className="text-xs text-muted-foreground">
            {settingsOpen ? 'Hide' : 'Show'}
          </span>
        </button>

        {settingsOpen && (
          <div className="p-4 border-t border-border space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm">Keep Temporary Files</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Preserve intermediate files after processing
                </p>
              </div>
              <Switch
                checked={config.keepTempFiles}
                onCheckedChange={(v) => setConfig(prev => ({ ...prev, keepTempFiles: v }))}
                disabled={isProcessing}
              />
            </div>
          </div>
        )}
      </div>

      {}
      {derivedMode === 'single' && (status === 'processing' || status === 'completed') && (
        <div className="mb-6">
          <ProcessingSteps steps={steps} />
        </div>
      )}

      {}
      <div className="mb-6">
        <ConsoleLog logs={logs} />
      </div>

      {}
      {status !== 'idle' && (
        <div className="mt-4 text-center">
          <span className={`text-sm font-medium ${
            status === 'processing' ? 'text-primary' : 
            status === 'completed' ? 'text-primary' : 
            'text-destructive'
          }`}>
            {status === 'processing' && '⚡ Processing...'}
            {status === 'completed' && '✓ Completed Successfully'}
            {status === 'error' && '✗ Processing Failed'}
          </span>
        </div>
      )}
    </div>
  );
}
