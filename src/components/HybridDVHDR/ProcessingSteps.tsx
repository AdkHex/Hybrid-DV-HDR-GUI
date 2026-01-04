import { Check, Loader2, Circle, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProcessingStep } from './types';

interface ProcessingStepsProps {
  steps: ProcessingStep[];
}

export function ProcessingSteps({ steps }: ProcessingStepsProps) {
  return (
    <div className="space-y-3">
      {steps.map((step, index) => (
        <div
          key={step.id}
          className={cn(
            "flex items-center gap-3 p-3 rounded-lg border transition-all duration-300",
            step.status === 'active' && "bg-primary/10 border-primary/30",
            step.status === 'completed' && "bg-primary/5 border-primary/20",
            step.status === 'error' && "bg-destructive/10 border-destructive/30",
            step.status === 'pending' && "bg-muted/50 border-border/50"
          )}
        >
          {}
          <div className={cn(
            "flex items-center justify-center h-8 w-8 rounded-full shrink-0",
            step.status === 'active' && "bg-primary/20",
            step.status === 'completed' && "bg-primary",
            step.status === 'error' && "bg-destructive",
            step.status === 'pending' && "bg-muted"
          )}>
            {step.status === 'pending' && (
              <span className="text-xs font-medium text-muted-foreground">{index + 1}</span>
            )}
            {step.status === 'active' && (
              <Loader2 className="h-4 w-4 text-primary animate-spin" />
            )}
            {step.status === 'completed' && (
              <Check className="h-4 w-4 text-primary-foreground" />
            )}
            {step.status === 'error' && (
              <AlertCircle className="h-4 w-4 text-destructive-foreground" />
            )}
          </div>

          {}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className={cn(
                "font-medium text-sm truncate",
                step.status === 'pending' && "text-muted-foreground",
                step.status === 'active' && "text-foreground",
                step.status === 'completed' && "text-foreground",
                step.status === 'error' && "text-destructive"
              )}>
                {step.name}
              </span>
              {step.status === 'active' && (
                <span className="text-xs text-primary font-mono">{step.progress}%</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground truncate">{step.description}</p>
            
            {}
            {step.status === 'active' && (
              <div className="mt-2 h-1 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300 ease-out"
                  style={{ width: `${step.progress}%` }}
                />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
