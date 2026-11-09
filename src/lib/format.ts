export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const digits = i <= 1 ? 0 : n < 10 ? 2 : 1;
  return `${n.toFixed(digits)} ${units[i]}`;
}

export function formatDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return '–';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '(selected files)';
}

export function errorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotReadableError':
        return 'The file could not be read. It may have been moved, or the drive was disconnected.';
      case 'NotFoundError':
        return 'The file or folder no longer exists.';
      case 'NotAllowedError':
      case 'SecurityError':
        return 'The browser did not allow access to this location.';
      case 'QuotaExceededError':
        return 'There is not enough free space at the destination.';
      case 'InvalidModificationError':
        return 'The destination could not be changed.';
      case 'AbortError':
        return 'Cancelled.';
    }
    return err.message || err.name;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
