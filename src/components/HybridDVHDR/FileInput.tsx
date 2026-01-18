import { useState, useCallback } from "react";
import { Folder, File, X, Upload } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface FileInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  icon: "hdr" | "dv" | "output";
  disabled?: boolean;
  accept?: string;
  onFileDrop?: (files: string[]) => void;
  onBrowseFile?: () => void;
  onBrowseFolder?: () => void;
}

const iconColors = {
  hdr: "text-amber-400",
  dv: "text-purple-400",
  output: "text-primary",
};

const dropzoneColors = {
  hdr: "border-amber-400/50 bg-amber-400/5",
  dv: "border-purple-400/50 bg-purple-400/5",
  output: "border-primary/50 bg-primary/5",
};

export function FileInput({
  label,
  value,
  onChange,
  placeholder,
  icon,
  disabled,
  onFileDrop,
  onBrowseFile,
  onBrowseFolder,
}: FileInputProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) {
        setIsDragOver(true);
      }
    },
    [disabled],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      if (disabled) return;

      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        // For single file mode, just use the first file
        const filePath = (files[0] as unknown as { path?: string }).path || files[0].name;
        onChange(filePath);

        // If multiple files dropped and handler exists, pass all
        if (onFileDrop && files.length > 1) {
          onFileDrop(
            files.map((f) => (f as unknown as { path?: string }).path || f.name),
          );
        }
      }
    },
    [disabled, onChange, onFileDrop],
  );

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-foreground flex items-center gap-2">
        <File className={cn("h-4 w-4", iconColors[icon])} />
        {label}
      </label>

      <div
        className={cn(
          "relative rounded-lg border-2 border-dashed transition-all duration-200",
          isDragOver ? dropzoneColors[icon] : "border-transparent",
          disabled && "opacity-50 cursor-not-allowed",
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg z-10 pointer-events-none">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Upload className={cn("h-4 w-4", iconColors[icon])} />
              <span className={iconColors[icon]}>Drop file here</span>
            </div>
          </div>
        )}

        <div className={cn("flex gap-2", isDragOver && "opacity-30")}>
          <div className="relative flex-1">
            <Input
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              disabled={disabled}
              className="bg-muted border-border pr-8 font-mono text-sm"
            />
            {value && !disabled && (
              <button
                onClick={() => onChange("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            {onBrowseFile && (
              <Button
                variant="secondary"
                size="icon"
                disabled={disabled}
                title="Browse file..."
                onClick={onBrowseFile}
              >
                <File className="h-4 w-4" />
              </Button>
            )}
            {onBrowseFolder && (
              <Button
                variant="secondary"
                size="icon"
                disabled={disabled}
                title="Browse folder..."
                onClick={onBrowseFolder}
              >
                <Folder className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {!value && !disabled && <p className="text-xs text-muted-foreground">Drag & drop a file or click browse</p>}
    </div>
  );
}
