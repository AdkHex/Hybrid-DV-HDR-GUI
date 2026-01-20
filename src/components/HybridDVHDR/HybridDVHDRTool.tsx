import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { 
  Play, 
  Square, 
  Trash2,
  Plus,
  Layers
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { FileInput } from './FileInput';
import { ProcessingSteps } from './ProcessingSteps';
import { ConsoleLog } from './ConsoleLog';
import { ToolSettings } from './ToolSettings';
import { FileQueue } from './FileQueue';
import { isTauri, invokeTauri, listenTauri, openDialog, saveDialog } from '@/lib/tauri';
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
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/api/notification';

const defaultSteps: ProcessingStep[] = [
  { id: 1, name: 'Extract Audio & Subtitles', description: 'Extracting audio tracks and subtitles from HDR source', status: 'pending', progress: 0 },
  { id: 2, name: 'Extract DV Video', description: 'Extracting H.265 video from Dolby Vision source', status: 'pending', progress: 0 },
  { id: 3, name: 'Extract RPU Data', description: 'Extracting RPU metadata from DV stream', status: 'pending', progress: 0 },
  { id: 4, name: 'Extract HDR10 Video', description: 'Extracting H.265 video from HDR10 source', status: 'pending', progress: 0 },
  { id: 5, name: 'Inject RPU Data', description: 'Injecting RPU data into HDR10 video stream', status: 'pending', progress: 0 },
  { id: 6, name: 'Mux Final Output', description: 'Combining video, audio, and subtitles into final MKV', status: 'pending', progress: 0 },
];

const defaultToolPaths: ToolPaths = {
  doviTool: 'dovi_tool',
  mkvmerge: 'mkvmerge',
  mkvextract: 'mkvextract',
  ffmpeg: 'ffmpeg',
  mediainfo: 'MediaInfo',
  mp4box: 'MP4Box',
  hdr10plusTool: 'hdr10plus_tool',
  defaultOutput: 'DV.HDR',
};

export function HybridDVHDRTool() {
  const [pathKinds, setPathKinds] = useState<{
    hdr: 'file' | 'folder' | 'unknown';
    hdr10plus: 'file' | 'folder' | 'unknown';
    dv: 'file' | 'folder' | 'unknown';
    output: 'file' | 'folder' | 'unknown';
  }>({
    hdr: 'unknown',
    hdr10plus: 'unknown',
    dv: 'unknown',
    output: 'unknown',
  });
  const [config, setConfig] = useState<ProcessingConfig>({
    hdrPath: '',
    dvPath: '',
    outputPath: '',
    hdr10plusPath: '',
    dvDelayMs: 0,
    hdr10plusDelayMs: 0,
    mode: 'single',
    parallelTasks: 4,
    keepTempFiles: false,
  });
  
  const [toolPaths, setToolPaths] = useState<ToolPaths>(defaultToolPaths);
  const [status, setStatus] = useState<ProcessingStatus>('idle');
  const [steps, setSteps] = useState<ProcessingStep[]>(defaultSteps);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [queue, setQueue] = useState<QueueFile[]>([]);
  const [fileProgress, setFileProgress] = useState<FileProgressEntry[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showDelays, setShowDelays] = useState(false);
  const [dvDelayInput, setDvDelayInput] = useState('');
  const [hdr10plusDelayInput, setHdr10plusDelayInput] = useState('');
  const [isDropActive, setIsDropActive] = useState(false);
  const [presets, setPresets] = useState<Array<{
    id: string;
    name: string;
    config: ProcessingConfig;
    toolPaths: ToolPaths;
    dvDelayInput: string;
    hdr10plusDelayInput: string;
    showDelays: boolean;
  }>>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');
  const queueMetaRef = useRef(new Map<string, { start: number; lastProgress: number; samples: Array<{ time: number; progress: number }> }>());
  const fileMetaRef = useRef(new Map<string, { start: number; lastProgress: number; samples: Array<{ time: number; progress: number }> }>());
  const statusRef = useRef<ProcessingStatus>('idle');
  const [selectedQueueIds, setSelectedQueueIds] = useState<Set<string>>(new Set());

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    const entry: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      type,
      message,
    };
    setLogs(prev => [...prev, entry]);
  }, []);

  // Load settings from localStorage
  useEffect(() => {
    const savedConfig = localStorage.getItem('hybrid-dv-hdr-config');
    const savedTools = localStorage.getItem('hybrid-dv-hdr-tools');
    const savedPresets = localStorage.getItem('hybrid-dv-hdr-presets');
    
    if (savedConfig) {
      try {
        const parsed = JSON.parse(savedConfig);
        setConfig(prev => ({
            ...prev,
            parallelTasks: parsed.parallelTasks ?? 4,
            keepTempFiles: parsed.keepTempFiles ?? false
        }));
      } catch (e) { console.error("Failed to load config", e); }
    }

    if (savedTools) {
       try {
        const parsed = JSON.parse(savedTools);
        setToolPaths({ ...defaultToolPaths, ...parsed });
       } catch (e) { console.error("Failed to load tool paths", e); }
    }

    if (savedPresets) {
      try {
        const parsed = JSON.parse(savedPresets);
        if (Array.isArray(parsed)) {
          setPresets(parsed);
        }
      } catch (e) {
        console.error("Failed to load presets", e);
      }
    }
  }, []);

  // Save settings to localStorage
  useEffect(() => {
    localStorage.setItem('hybrid-dv-hdr-config', JSON.stringify({
        parallelTasks: config.parallelTasks,
        keepTempFiles: config.keepTempFiles
    }));
  }, [config.parallelTasks, config.keepTempFiles]);

  useEffect(() => {
     localStorage.setItem('hybrid-dv-hdr-tools', JSON.stringify(toolPaths));
  }, [toolPaths]);

  useEffect(() => {
    localStorage.setItem('hybrid-dv-hdr-presets', JSON.stringify(presets));
  }, [presets]);

  const etaAveragingWindow = 6;

  const inferPathKind = useCallback((value: string) => {
    if (!value) return 'unknown' as const;
    if (value.endsWith('\\') || value.endsWith('/')) return 'folder' as const;
    return 'file' as const;
  }, []);

  const notify = useCallback(async (title: string, body: string) => {
    if (!isTauri()) return;
    try {
      let permissionGranted = await isPermissionGranted();
      if (!permissionGranted) {
        const permission = await requestPermission();
        permissionGranted = permission === 'granted';
      }
      if (permissionGranted) {
        sendNotification({ title, body });
      }
    } catch (error) {
      console.error("Failed to send notification", error);
    }
  }, []);

  const computeSmoothedEta = useCallback(
    (
      meta: { start: number; lastProgress: number; samples: Array<{ time: number; progress: number }> },
      progress: number,
    ) => {
      if (progress <= 0) return undefined;
      const now = Date.now();
      const nextSamples = [...meta.samples, { time: now, progress }].slice(-etaAveragingWindow);
      const deltas = nextSamples
        .slice(1)
        .map((sample, index) => {
          const prev = nextSamples[index];
          const dt = (sample.time - prev.time) / 1000;
          const dp = sample.progress - prev.progress;
          return dt > 0 ? dp / dt : 0;
        })
        .filter(rate => rate > 0);
      if (!deltas.length) {
        meta.samples = nextSamples;
        return undefined;
      }
      const avgRate = deltas.reduce((sum, rate) => sum + rate, 0) / deltas.length;
      meta.samples = nextSamples;
      const remaining = Math.max(0, 100 - progress);
      return Math.round(remaining / avgRate);
    },
    [etaAveragingWindow],
  );

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
            const meta = queueMetaRef.current.get(item.id) || { start: Date.now(), lastProgress: 0, samples: [] };
            const smoothed = computeSmoothedEta(meta, payload.progress);
            if (typeof smoothed === 'number') {
              etaSeconds = smoothed;
            }
            meta.lastProgress = payload.progress;
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
        const nextStatus = event.payload.status as ProcessingStatus;
        setStatus(nextStatus);
        if (statusRef.current !== nextStatus) {
          statusRef.current = nextStatus;
          if (nextStatus === 'completed') {
            notify('Hybrid DV HDR', 'Processing queue completed successfully.');
          } else if (nextStatus === 'error') {
            notify('Hybrid DV HDR', 'Processing failed. Check the console output.');
          }
        }
      });

      unlistenFile = await listenTauri<FileProgressPayload>('processing:file', (event) => {
        const payload = event.payload;
        setFileProgress(prev => {
          const existing = prev.find(item => item.id === payload.id);
          let etaSeconds = existing?.etaSeconds;
          const meta = fileMetaRef.current.get(payload.id) || { start: Date.now(), lastProgress: 0, samples: [] };
          const smoothed = computeSmoothedEta(meta, payload.progress);
          if (typeof smoothed === 'number') {
            etaSeconds = smoothed;
          }
          meta.lastProgress = payload.progress;

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
  }, [addLog, computeSmoothedEta, notify]);

  const derivedHdrPath = config.hdrPath || config.hdr10plusPath;
  const derivedHdrKind = config.hdrPath ? pathKinds.hdr : pathKinds.hdr10plus;
  const derivedMode: ProcessingMode =
    queue.length > 0
      ? 'batch'
      : derivedHdrKind === 'folder' && pathKinds.dv === 'folder'
        ? 'batch'
        : 'single';

  const applyPreset = useCallback((presetId: string) => {
    const preset = presets.find(item => item.id === presetId);
    if (!preset) return;
    setConfig(preset.config);
    setToolPaths(preset.toolPaths);
    setDvDelayInput(preset.dvDelayInput || '');
    setHdr10plusDelayInput(preset.hdr10plusDelayInput || '');
    setShowDelays(preset.showDelays ?? false);
    setPathKinds({
      hdr: inferPathKind(preset.config.hdrPath),
      hdr10plus: inferPathKind(preset.config.hdr10plusPath),
      dv: inferPathKind(preset.config.dvPath),
      output: inferPathKind(preset.config.outputPath),
    });
  }, [inferPathKind, presets]);

  const savePreset = useCallback(() => {
    const name = window.prompt('Preset name:');
    if (!name) return;
    const id = crypto.randomUUID();
    const newPreset = {
      id,
      name,
      config,
      toolPaths,
      dvDelayInput,
      hdr10plusDelayInput,
      showDelays,
    };
    setPresets(prev => [...prev, newPreset]);
    setSelectedPresetId(id);
  }, [config, toolPaths, dvDelayInput, hdr10plusDelayInput, showDelays]);

  const handlePresetChange = useCallback((value: string) => {
    if (value === '__save__') {
      savePreset();
      return;
    }
    setSelectedPresetId(value);
    applyPreset(value);
  }, [applyPreset, savePreset]);

  const handleDropAssign = useCallback((path: string, isFolder: boolean, name?: string) => {
    const label = name?.toLowerCase() || path.toLowerCase();
    const isHdr10plus = label.includes('hdr10') || label.includes('hdr10+') || label.includes('hdr10plus');
    const isDv = label.includes('dv') || label.includes('dovi') || label.includes('dolby');
    const isHdr = label.includes('hdr');

    if (isHdr10plus) {
      setConfig(prev => ({ ...prev, hdr10plusPath: path, hdrPath: '' }));
      setPathKinds(prev => ({ ...prev, hdr10plus: isFolder ? 'folder' : 'file' }));
      return;
    }

    if (isDv || (!config.dvPath && !isHdr)) {
      setConfig(prev => ({ ...prev, dvPath: path }));
      setPathKinds(prev => ({ ...prev, dv: isFolder ? 'folder' : 'file' }));
      return;
    }

    if (isHdr || !config.hdrPath) {
      setConfig(prev => ({ ...prev, hdrPath: path, hdr10plusPath: '' }));
      setPathKinds(prev => ({ ...prev, hdr: isFolder ? 'folder' : 'file' }));
      return;
    }
  }, [config.dvPath, config.hdrPath]);

  const dropHandlers = useMemo(() => {
    return {
      onDragEnter: (event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setIsDropActive(true);
      },
      onDragOver: (event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setIsDropActive(true);
      },
      onDragLeave: (event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setIsDropActive(false);
      },
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setIsDropActive(false);
        const items = Array.from(event.dataTransfer.items || []);
        if (items.length > 0) {
          const item = items[0];
          const entry = (item as unknown as { webkitGetAsEntry?: () => { isDirectory: boolean; name: string } | null })
            .webkitGetAsEntry?.();
          const file = item.getAsFile();
          if (file) {
            const path = (file as unknown as { path?: string }).path || file.name;
            const isFolder = !!entry?.isDirectory;
            handleDropAssign(path, isFolder, entry?.name || file.name);
            return;
          }
        }
        const files = Array.from(event.dataTransfer.files || []);
        if (files.length > 0) {
          const file = files[0];
          const path = (file as unknown as { path?: string }).path || file.name;
          handleDropAssign(path, false, file.name);
        }
      },
    };
  }, [handleDropAssign]);

  const addToQueue = useCallback(() => {
    if (!derivedHdrPath || !config.dvPath) return;

    const isBatch = derivedMode === 'batch';
    const hdrLabel = derivedHdrPath.split('\\').filter(Boolean).pop() || derivedHdrPath;
    const dvLabel = config.dvPath.split('\\').filter(Boolean).pop() || config.dvPath;

    const outputFile = isBatch
      ? config.outputPath || toolPaths.defaultOutput
      : config.outputPath || `${hdrLabel.replace('.mkv', '')}.hybrid.mkv`;

    const newFile: QueueFile = {
      id: crypto.randomUUID(),
      hdrFile: hdrLabel,
      dvFile: dvLabel,
      outputFile,
      hdrPath: derivedHdrPath,
      dvPath: config.dvPath,
      outputPath: isBatch ? (config.outputPath || '') : outputFile,
      status: 'pending',
      progress: 0,
    };
    
    setQueue(prev => [...prev, newFile]);
    setSelectedQueueIds(prev => new Set(prev).add(newFile.id));
    setConfig(prev => ({ ...prev, hdrPath: '', hdr10plusPath: '', dvPath: '', outputPath: '' }));
    addLog('info', `Added to queue: ${newFile.outputFile}`);
  }, [config, addLog, derivedMode, toolPaths.defaultOutput, derivedHdrPath]);

  const browseFile = useCallback(
    async (target: 'hdr' | 'dv' | 'output' | 'hdr10plus') => {
      if (!isTauri()) {
        const manual = window.prompt('Enter a file path:');
        if (manual) {
          setConfig(prev => {
            if (target === 'hdr10plus') {
              return { ...prev, hdr10plusPath: manual, hdrPath: '' };
            }
            return {
              ...prev,
              ...(target === 'hdr' ? { hdr10plusPath: '' } : null),
              [target === 'hdr' ? 'hdrPath' : target === 'dv' ? 'dvPath' : 'outputPath']: manual,
            };
          });
          if (target !== 'hdr10plus') {
            setPathKinds(prev => ({ ...prev, [target]: 'file' }));
          } else {
            setPathKinds(prev => ({ ...prev, hdr10plus: 'file' }));
          }
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
        filters: [{ name: 'Video', extensions: ['mkv', 'mp4', 'hevc', 'h265'] }],
      });

      if (typeof selected === 'string') {
        setConfig(prev => {
          if (target === 'hdr10plus') {
            return { ...prev, hdr10plusPath: selected, hdrPath: '' };
          }
          return {
            ...prev,
            ...(target === 'hdr' ? { hdr10plusPath: '' } : null),
            [target === 'hdr' ? 'hdrPath' : target === 'dv' ? 'dvPath' : 'outputPath']: selected,
          };
        });
        if (target !== 'hdr10plus') {
          setPathKinds(prev => ({ ...prev, [target]: 'file' }));
        } else {
          setPathKinds(prev => ({ ...prev, hdr10plus: 'file' }));
        }
      }
    },
    [config.outputPath],
  );

  const browseFolder = useCallback(
    async (target: 'hdr' | 'dv' | 'output' | 'hdr10plus') => {
      if (!isTauri()) {
        const manual = window.prompt('Enter a folder path:');
        if (manual) {
          setConfig(prev => {
            if (target === 'hdr10plus') {
              return { ...prev, hdr10plusPath: manual, hdrPath: '' };
            }
            return {
              ...prev,
              ...(target === 'hdr' ? { hdr10plusPath: '' } : null),
              [target === 'hdr' ? 'hdrPath' : target === 'dv' ? 'dvPath' : 'outputPath']: manual,
            };
          });
          if (target !== 'hdr10plus') {
            setPathKinds(prev => ({ ...prev, [target]: 'folder' }));
          } else {
            setPathKinds(prev => ({ ...prev, hdr10plus: 'folder' }));
          }
        }
        return;
      }

      const selected = await openDialog({
        directory: true,
        multiple: false,
      });

      if (typeof selected === 'string') {
        setConfig(prev => {
          if (target === 'hdr10plus') {
            return { ...prev, hdr10plusPath: selected, hdrPath: '' };
          }
          return {
            ...prev,
            ...(target === 'hdr' ? { hdr10plusPath: '' } : null),
            [target === 'hdr' ? 'hdrPath' : target === 'dv' ? 'dvPath' : 'outputPath']: selected,
          };
        });
        if (target !== 'hdr10plus') {
          setPathKinds(prev => ({ ...prev, [target]: 'folder' }));
        } else {
          setPathKinds(prev => ({ ...prev, hdr10plus: 'folder' }));
        }
      }
    },
    [],
  );

  const simulateProcessing = useCallback(async () => {
    setStatus('processing');
    addLog('info', 'Starting Hybrid DV HDR processing...');
    addLog('info', `Mode: ${derivedMode === 'single' ? 'Single File' : 'Batch'}`);
    
    if (derivedMode === 'batch' && queue.length > 0) {
      // Process queue
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
      // Single file mode
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
    if (derivedMode === 'single' && (!derivedHdrPath || !config.dvPath)) {
      addLog('error', 'Please specify HDR/HDR10+ and DV source paths');
      return;
    }
    if (derivedMode === 'batch' && queue.length === 0) {
      addLog('error', 'Please add files to the queue first');
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
      ? (selectedQueueIds.size > 0 ? queue.filter(item => selectedQueueIds.has(item.id)) : queue)
      : [];

    const parseDelay = (value: string) => {
      const trimmed = value.trim();
      if (trimmed === '' || trimmed === '+' || trimmed === '-') return 0;
      const parsed = Number.parseFloat(trimmed);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const request: ProcessingRequest = {
      mode,
      hdrPath: derivedHdrPath,
      dvPath: config.dvPath,
      outputPath: config.outputPath,
      hdr10plusPath: config.hdr10plusPath,
      dvDelayMs: parseDelay(dvDelayInput),
      hdr10plusDelayMs: parseDelay(hdr10plusDelayInput),
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

  const handleReorderQueue = useCallback((sourceId: string, targetId: string) => {
    setQueue(prev => {
      const sourceIndex = prev.findIndex(item => item.id === sourceId);
      const targetIndex = prev.findIndex(item => item.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, []);

  const isProcessing = status === 'processing';

  return (
    <div className="w-full max-w-5xl mx-auto">
      {/* Header */}
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
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <select
              value={selectedPresetId}
              onChange={(e) => handlePresetChange(e.target.value)}
              className="h-9 rounded-md border border-border bg-muted px-3 text-xs text-foreground"
              title="Presets"
            >
              <option value="">Presets</option>
              {presets.map(preset => (
                <option key={preset.id} value={preset.id}>{preset.name}</option>
              ))}
              <option value="__save__">Save new preset...</option>
            </select>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={savePreset}
            >
              Save
            </Button>
          </div>
          <ToolSettings 
            toolPaths={toolPaths} 
            onSave={setToolPaths}
            parallelTasks={config.parallelTasks}
            onParallelTasksChange={(v) => setConfig(prev => ({ ...prev, parallelTasks: v }))}
            keepTempFiles={config.keepTempFiles}
            onKeepTempFilesChange={(v) => setConfig(prev => ({ ...prev, keepTempFiles: v }))}
          />
        </div>
      </div>

      {/* Mode Tabs */}
      <div
        className="mb-6 p-4 rounded-lg border border-border bg-card space-y-4 relative"
        {...dropHandlers}
      >
        {isDropActive && (
          <div className="absolute inset-0 z-10 rounded-lg border-2 border-primary/60 bg-primary/5 pointer-events-none" />
        )}
          {!config.hdr10plusPath && (
            <FileInput
              label="HDR Source (file or folder)"
              value={config.hdrPath}
              onChange={(v) => {
                setConfig(prev => ({ ...prev, hdrPath: v, hdr10plusPath: '' }));
                setPathKinds(prev => ({ ...prev, hdr: v.endsWith('\\') || v.endsWith('/') ? 'folder' : 'file' }));
              }}
              placeholder={derivedMode === 'batch' ? 'C:\\Videos\\HDR\\' : 'C:\\Videos\\movie.hdr.mkv'}
              icon="hdr"
              disabled={isProcessing}
              onBrowseFile={() => browseFile('hdr')}
              onBrowseFolder={() => browseFolder('hdr')}
            />
          )}
        
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

          {!config.hdrPath && (
            <FileInput
              label="HDR10+ Source (file or folder)"
              value={config.hdr10plusPath}
              onChange={(v) => {
                setConfig(prev => ({ ...prev, hdr10plusPath: v, hdrPath: '' }));
                setPathKinds(prev => ({
                  ...prev,
                  hdr10plus: v.endsWith('\\') || v.endsWith('/') ? 'folder' : 'file',
                }));
              }}
              placeholder={derivedMode === 'batch' ? 'C:\\Videos\\HDR10+\\' : 'C:\\Videos\\movie.hdr10plus.mkv'}
              icon="hdr"
              disabled={isProcessing}
              onBrowseFile={() => browseFile('hdr10plus')}
              onBrowseFolder={() => browseFolder('hdr10plus')}
            />
          )}
        
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

          <div className="space-y-2">
            <Button
              type="button"
              variant="secondary"
              className="w-full justify-between"
              onClick={() => setShowDelays(prev => !prev)}
              disabled={isProcessing}
            >
              Add delay?
              <span className="text-xs">{showDelays ? '▲' : '▼'}</span>
            </Button>
            {showDelays && (
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-sm">Dolby Vision Delay (ms)</Label>
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={dvDelayInput}
                    onChange={(e) => setDvDelayInput(e.target.value)}
                    disabled={isProcessing}
                    className="bg-muted border-border font-mono text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-sm">HDR10+ Delay (ms)</Label>
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={hdr10plusDelayInput}
                    onChange={(e) => setHdr10plusDelayInput(e.target.value)}
                    disabled={isProcessing}
                    className="bg-muted border-border font-mono text-sm"
                  />
                </div>
              </div>
            )}
          </div>

        {derivedMode === 'batch' && (
          <Button
            variant="secondary"
            className="w-full"
            disabled={isProcessing || !derivedHdrPath || !config.dvPath}
            onClick={addToQueue}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add to Queue
          </Button>
        )}
      </div>

      {/* File Queue (Batch Mode) */}
      {derivedMode === 'batch' && (
        <div className="mb-6">
          <FileQueue 
            files={queue} 
            fileProgress={fileProgress}
            selectedIds={selectedQueueIds}
            onReorder={handleReorderQueue}
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

      {/* Settings Dialog (via ToolSettings) handles configuration now */}

      {/* Processing Steps (Single Mode) */}

      {/* Processing Steps (Single Mode) */}
      {derivedMode === 'single' && (status === 'processing' || status === 'completed') && (
        <div className="mb-6">
          <ProcessingSteps steps={steps} />
        </div>
      )}

      {/* Console Log */}
      <div className="mb-6">
        <ConsoleLog logs={logs} />
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3">
        {!isProcessing ? (
          <Button 
            onClick={handleStart} 
            className="flex-1 glow-primary"
            disabled={
              derivedMode === 'single' 
                ? !derivedHdrPath || !config.dvPath
                : queue.length === 0 || selectedQueueIds.size === 0
            }
          >
            <Play className="h-4 w-4 mr-2" />
            Start Processing
          </Button>
        ) : (
          <Button 
            onClick={handleStop} 
            variant="destructive"
            className="flex-1"
          >
            <Square className="h-4 w-4 mr-2" />
            Stop
          </Button>
        )}
        
        <Button 
          onClick={handleClear} 
          variant="outline"
          disabled={isProcessing}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Status Bar */}
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
