import { useRef, useEffect } from 'react';
import { Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LogEntry } from './types';

interface ConsoleLogProps {
  logs: LogEntry[];
}

const typeColors = {
  info: 'text-muted-foreground',
  success: 'text-primary',
  warning: 'text-amber-400',
  error: 'text-destructive',
};

const typePrefixes = {
  info: '[INFO]',
  success: '[OK]',
  warning: '[WARN]',
  error: '[ERR]',
};

export function ConsoleLog({ logs }: ConsoleLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', { 
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border-b border-border">
        <Terminal className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Console Output</span>
      </div>
      
      <div 
        ref={scrollRef}
        className="h-48 overflow-y-auto p-3 font-mono text-xs space-y-1"
      >
        {logs.length === 0 ? (
          <div className="text-muted-foreground/50 italic">
            Waiting for processing to start...
          </div>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="flex gap-2">
              <span className="text-muted-foreground/60 shrink-0">
                {formatTime(log.timestamp)}
              </span>
              <span className={cn("shrink-0 font-semibold", typeColors[log.type])}>
                {typePrefixes[log.type]}
              </span>
              <span className={cn("break-all", typeColors[log.type])}>
                {log.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
