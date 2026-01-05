export const isTauri = () => Boolean((window as any).__TAURI__);

export async function invokeTauri<T>(command: string, payload?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/tauri');
  return invoke<T>(command, payload);
}

export async function listenTauri<T>(event: string, handler: (event: { payload: T }) => void) {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<T>(event, handler);
}

export async function openDialog(options: {
  directory?: boolean;
  multiple?: boolean;
  filters?: { name: string; extensions: string[] }[];
}) {
  const { open } = await import('@tauri-apps/api/dialog');
  const sanitized: {
    directory?: boolean;
    multiple?: boolean;
    filters?: { name: string; extensions: string[] }[];
  } = {};

  if (options.directory === true) {
    sanitized.directory = true;
  }
  if (options.multiple === true) {
    sanitized.multiple = true;
  }
  if (!sanitized.directory && options.filters && options.filters.length > 0) {
    sanitized.filters = options.filters;
  }

  return open(sanitized);
}

export async function saveDialog(options: {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}) {
  const { save } = await import('@tauri-apps/api/dialog');
  const sanitized: {
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  } = {};

  if (options.defaultPath) {
    sanitized.defaultPath = options.defaultPath;
  }
  if (options.filters && options.filters.length > 0) {
    sanitized.filters = options.filters;
  }

  return save(sanitized);
}
