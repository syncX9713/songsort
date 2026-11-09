import { AUDIO_EXTENSIONS } from './platform';
import type { SourceFile } from './types';
import { OUTPUT_ROOT } from './types';

/** Minimal typings for the File System Access API (not yet in TypeScript's DOM lib). */
declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: 'read' | 'readwrite';
      startIn?: string;
    }) => Promise<FileSystemDirectoryHandle>;
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      id?: string;
      types?: { description?: string; accept: Record<string, string[]> }[];
    }) => Promise<FileSystemFileHandle>;
  }
}

export interface Selection {
  /** Human-readable name of what was picked, e.g. "Old Songs" or "12 files". */
  labels: string[];
  files: SourceFile[];
  /** Audio files ignored because the name starts with "._" (macOS metadata) etc. */
  ignoredFiles: number;
  /** Non-audio files that were not included. */
  otherFiles: number;
  /** Folders we did not enter, with the reason. */
  skippedFolders: { path: string; reason: string }[];
}

export const emptySelection = (): Selection => ({
  labels: [],
  files: [],
  ignoredFiles: 0,
  otherFiles: 0,
  skippedFolders: [],
});

let nextId = 1;

const AUDIO = new Set<string>(AUDIO_EXTENSIONS);
const SYSTEM_FOLDERS = new Set([
  '$recycle.bin',
  'system volume information',
  'node_modules',
  '.trashes',
  '.spotlight-v100',
  '.fseventsd',
]);

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

type Classified = 'audio' | 'ignored' | 'other';

function classify(name: string): Classified {
  if (!AUDIO.has(extOf(name))) return 'other';
  // macOS "AppleDouble" files (._song.mp3) look like audio but are not.
  if (name.startsWith('._') || name.startsWith('~$')) return 'ignored';
  return 'audio';
}

function makeSource(file: File, path: string): SourceFile {
  return { id: nextId++, file, path, name: file.name, size: file.size, ext: extOf(file.name) };
}

/** A single file as a scan source (used by the downloader to compare a new song with a collection). */
export function sourceFromFile(file: File, path: string): SourceFile {
  return makeSource(file, path);
}

/** Files picked through an <input type="file"> (individual files, or a folder via webkitdirectory). */
export function fromFileList(list: FileList | File[]): Selection {
  const sel = emptySelection();
  const roots = new Set<string>();
  for (const file of Array.from(list)) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    const path = rel || file.name;
    if (rel.includes('/')) {
      const parts = rel.split('/');
      roots.add(parts[0]);
      // Respect the same folder rules as the folder walker.
      const dirs = parts.slice(1, -1); // the picked folder itself is always allowed
      if (dirs.some((d) => isSkippedFolderName(d))) {
        sel.ignoredFiles++;
        continue;
      }
    }
    const c = classify(file.name);
    if (c === 'audio') sel.files.push(makeSource(file, path));
    else if (c === 'ignored') sel.ignoredFiles++;
    else sel.otherFiles++;
  }
  if (roots.size > 0) sel.labels.push(...roots);
  else if (sel.files.length > 0) sel.labels.push(sel.files.length === 1 ? sel.files[0].name : `${sel.files.length} selected files`);
  return sel;
}

/** Files with an explicit location (used by drag-in integrations and the automated test hook). */
export function fromPathEntries(entries: { file: File; path: string }[], label: string): Selection {
  const sel = emptySelection();
  sel.labels.push(label);
  for (const { file, path } of entries) {
    const c = classify(file.name);
    if (c === 'audio') sel.files.push(makeSource(file, path));
    else if (c === 'ignored') sel.ignoredFiles++;
    else sel.otherFiles++;
  }
  return sel;
}

function isSkippedFolderName(name: string): boolean {
  const lower = name.toLowerCase();
  return name.startsWith('.') || SYSTEM_FOLDERS.has(lower) || lower === OUTPUT_ROOT.toLowerCase() || lower.startsWith(OUTPUT_ROOT.toLowerCase() + ' (');
}

/**
 * Recursively list a folder picked with the File System Access API.
 * Only the directory listing is read here; file contents are read later during the scan.
 */
export async function fromDirectoryHandle(
  root: FileSystemDirectoryHandle,
  onProgress: (found: number) => void,
  signal: AbortSignal,
): Promise<Selection> {
  const sel = emptySelection();
  sel.labels.push(root.name || 'Selected folder');

  const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    let entries: [string, FileSystemHandle][] = [];
    try {
      for await (const entry of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        entries.push(entry);
      }
    } catch (err) {
      sel.skippedFolders.push({ path: prefix || dir.name, reason: 'Could not open this folder (no permission or unreadable).' });
      return;
    }
    entries = entries.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
    for (const [name, handle] of entries) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        if (isSkippedFolderName(name)) {
          if (!name.startsWith('.')) {
            const reason = name.toLowerCase().startsWith(OUTPUT_ROOT.toLowerCase())
              ? 'Output from an earlier SongSort run.'
              : 'System folder.';
            sel.skippedFolders.push({ path, reason });
          }
          continue;
        }
        await walk(handle as FileSystemDirectoryHandle, path);
      } else {
        const c = classify(name);
        if (c === 'other') {
          sel.otherFiles++;
          continue;
        }
        if (c === 'ignored') {
          sel.ignoredFiles++;
          continue;
        }
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          sel.files.push(makeSource(file, path));
          if (sel.files.length % 50 === 0) onProgress(sel.files.length);
        } catch (err) {
          sel.skippedFolders.push({ path, reason: 'This file could not be opened.' });
        }
      }
    }
  };

  await walk(root, root.name);
  onProgress(sel.files.length);
  return sel;
}

/** Combine a new pick with what was already selected, ignoring files picked twice. */
export function mergeSelections(a: Selection, b: Selection): Selection {
  const seen = new Set(a.files.map((f) => `${f.path}|${f.size}|${f.file.lastModified}`));
  const added = b.files.filter((f) => {
    const k = `${f.path}|${f.size}|${f.file.lastModified}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    labels: [...a.labels, ...b.labels.filter((l) => !a.labels.includes(l))],
    files: [...a.files, ...added],
    ignoredFiles: a.ignoredFiles + b.ignoredFiles,
    otherFiles: a.otherFiles + b.otherFiles,
    skippedFolders: [...a.skippedFolders, ...b.skippedFolders],
  };
}

export function describePickerError(err: unknown): string | null {
  if (err instanceof DOMException) {
    if (err.name === 'AbortError') return null; // user closed the picker
    if (err.name === 'SecurityError' || err.name === 'NotAllowedError') {
      return 'Your browser blocked access to that location. Browsers do not allow some places (such as the main system drive or Windows folders). Please choose the folder that contains your music, for example a folder inside the drive.';
    }
  }
  return err instanceof Error ? err.message : String(err);
}
