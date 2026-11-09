/**
 * Bring a downloaded song into the user's music collection, using the Music Organizer's own engine
 * to find out whether the song is already there. Nothing existing is ever modified or overwritten.
 */
import { filesOfSong } from '../lib/organize';
import { scanFiles, type ScanProgress } from '../lib/scan';
import { sourceFromFile, type Selection } from '../lib/select';
import { checkAudioFile } from './checkFile';

export interface CollectionMatch {
  path: string;
  title: string;
}

export interface CollectionCheck {
  scanned: number;
  /** Byte-for-byte identical songs already in the collection. */
  identical: CollectionMatch[];
  /** Songs with the same details but different contents (other versions or qualities). */
  similar: CollectionMatch[];
  /** Same file name already used at the top of the chosen folder. */
  nameTaken: boolean;
}

export async function compareWithCollection(
  collection: Selection,
  file: File,
  onProgress: (p: ScanProgress) => void,
  signal: AbortSignal,
): Promise<CollectionCheck> {
  const incoming = sourceFromFile(file, `(new) ${file.name}`);
  const result = await scanFiles([...collection.files, incoming], 'Collection', onProgress, signal);
  const identical: CollectionMatch[] = [];
  const similar: CollectionMatch[] = [];
  const exact = result.exactGroups.find((g) => g.fileIds.includes(incoming.id));
  if (exact) {
    for (const id of exact.fileIds) {
      if (id === incoming.id) continue;
      const f = result.filesById.get(id)!;
      identical.push({ path: f.path, title: f.displayTitle });
    }
  }
  const key = exact ? `x:${exact.id}` : `f:${incoming.id}`;
  const pg = result.potentialGroups.find((g) => g.songKeys.includes(key));
  if (pg) {
    for (const k of pg.songKeys) {
      if (k === key) continue;
      for (const f of filesOfSong(result, k)) similar.push({ path: f.path, title: f.displayTitle });
    }
  }
  const lower = file.name.toLowerCase();
  const root = collection.labels[0];
  const nameTaken = collection.files.some((f) => f.name.toLowerCase() === lower && f.path === `${root}/${f.name}`);
  return { scanned: collection.files.length, identical, similar, nameTaken };
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    try {
      await dir.getDirectoryHandle(name);
      return true;
    } catch {
      return false;
    }
  }
}

/** Save into the folder without overwriting anything: "song.flac" becomes "song (2).flac" if needed. */
export async function saveIntoFolder(dir: FileSystemDirectoryHandle, file: File): Promise<{ savedAs: string; renamed: boolean }> {
  // Validate again right before writing, as required.
  const v = await checkAudioFile({ blob: file, name: file.name });
  if (!v.ok) throw new Error(`The file failed its final check and was not saved: ${v.reason}`);
  const dot = file.name.lastIndexOf('.');
  const base = file.name.slice(0, dot);
  const ext = file.name.slice(dot);
  let name = file.name;
  for (let n = 2; await exists(dir, name); n++) name = `${base} (${n})${ext}`;
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  try {
    await w.write(file);
    await w.close();
  } catch (err) {
    await w.abort().catch(() => {});
    await dir.removeEntry(name).catch(() => {});
    throw err;
  }
  return { savedAs: name, renamed: name !== file.name };
}

/** Save to the device: the native "Save as" window where available, otherwise a normal download. */
export async function saveToDevice(file: File): Promise<'saved' | 'downloaded' | 'cancelled'> {
  if (typeof window.showSaveFilePicker === 'function' && window.isSecureContext) {
    const ext = file.name.slice(file.name.lastIndexOf('.'));
    let handle: FileSystemFileHandle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: file.name,
        id: 'songsort-song',
        types: [{ description: 'Audio file', accept: { [file.type || 'application/octet-stream']: [ext] } }],
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      throw err;
    }
    const w = await handle.createWritable();
    await w.write(file);
    await w.close();
    return 'saved';
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
  return 'downloaded';
}
