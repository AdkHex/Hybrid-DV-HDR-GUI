export type ProcessingMode = 'single' | 'batch';
export type ProcessingStatus = 'idle' | 'processing' | 'completed' | 'error';
export type FileStatus = 'pending' | 'processing' | 'completed' | 'error';

export interface ProcessingStep {
  id: number;
  name: string;
  description: string;
  status: 'pending' | 'active' | 'completed' | 'error';
  progress: number;
}

export interface ToolPaths {
  doviTool: string;
  mkvmerge: string;
  mkvextract: string;
  ffmpeg: string;
  defaultOutput: string;
}

export interface QueueFile {
  id: string;
  hdrFile: string;
  dvFile: string;
  outputFile: string;
  hdrPath: string;
  dvPath: string;
  outputPath: string;
  status: FileStatus;
  progress: number;
  currentStep?: string;
  etaSeconds?: number;
  activeWorkers?: number;
  fileTotal?: number;
}

export interface ProcessingConfig {
  hdrPath: string;
  dvPath: string;
  outputPath: string;
  mode: ProcessingMode;
  parallelTasks: number;
  keepTempFiles: boolean;
}

export interface LogEntry {
  id: string;
  timestamp: Date;
  type: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export interface ProcessingRequest {
  mode: ProcessingMode;
  hdrPath: string;
  dvPath: string;
  outputPath: string;
  keepTempFiles: boolean;
  parallelTasks: number;
  toolPaths: ToolPaths;
  queue: QueueFile[];
}

export interface LogPayload {
  logType: LogEntry['type'];
  message: string;
}

export interface StepPayload {
  stepId: number;
  name: string;
  status: ProcessingStep['status'];
  progress: number;
}

export interface QueuePayload {
  id: string;
  status: FileStatus;
  progress: number;
  currentStep?: string | null;
  activeWorkers?: number | null;
  fileTotal?: number | null;
}

export interface FileProgressEntry {
  id: string;
  queueId: string;
  name: string;
  progress: number;
  etaSeconds?: number;
}

export interface FileProgressPayload {
  id: string;
  queueId: string;
  name: string;
  progress: number;
}

export interface StatusPayload {
  status: ProcessingStatus;
}
