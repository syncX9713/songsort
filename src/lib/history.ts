/**
 * Previous scans, kept privately in this browser (IndexedDB). Only song details and locations are
 * stored — never the music itself. For folders picked with the File System Access API (Chrome/Edge
 * on a computer) the folder handle is stored too, so the same folder can be scanned again later.
 */
import { filesOfSong, summarizePlan, buildPlan } from './organize';
import { FOLDER_DUPLICATES, type Decisions, type OutputFolder, type ScanResult } from './types';

export interface OrganizeRecord {
  at: number;
  mode: 'folder' | 'zip';
  where: string;
  copied: number;
  failed: number;
  counts: Record<OutputFolder, number>;
}

export interface ScanSummary {
  id: string;
  at: number;
  source: string;
  files: number;
  totalBytes: number;
  unique: number;
  exactGroups: number;
  extraCopies: number;
  potentialGroups: number;
  potentialFiles: number;
  unreadable: number;
  savableBytes: number;
  /** Full report saved (older entries only have these numbers). */
  hasDetails: boolean;
  /** Folder access was saved, so "Scan again" can be offered. */
  canRescan: boolean;
  organized?: OrganizeRecord;
}

export interface SavedFile {
  id: number;
  path: string;
  title: string;
  fromFileName: boolean;
  artist?: string;
  album?: string;
  ext: string;
  size: number;
  duration?: number;
  bitrate?: number;
}

export interface ScanDetails {
  id: string;
  files: SavedFile[];
  uniqueIds: number[];
  exact: { fileIds: number[]; keep: number }[];
  /** Each group is a list of songs; each song is one file or several identical copies. */
  potential: { songs: number[][]; reasons: string[] }[];
  unreadable: { path: string; size: number; error: string }[];
}

const DB_NAME = 'songsort';
const DB_VERSION = 1;
const MAX_SCANS = 20;
const LEGACY_KEY = 'songsort.history.v1';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('summaries', { keyPath: 'id' });
        db.createObjectStore('details', { keyPath: 'id' });
        db.createObjectStore('handles');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('Storage is busy in another tab'));
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Storage write was aborted'));
  });
}

function read<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Bring over the number-only history from the first version of SongSort. */
async function migrateLegacy(db: IDBDatabase) {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const old = JSON.parse(raw) as Partial<ScanSummary>[];
    const tx = db.transaction('summaries', 'readwrite');
    for (const o of Array.isArray(old) ? old : []) {
      if (!o.at) continue;
      tx.objectStore('summaries').put({
        id: `legacy-${o.at}`,
        at: o.at,
        source: o.source ?? 'Earlier scan',
        files: o.files ?? 0,
        totalBytes: o.totalBytes ?? 0,
        unique: o.unique ?? 0,
        exactGroups: o.exactGroups ?? 0,
        extraCopies: o.extraCopies ?? 0,
        potentialGroups: o.potentialGroups ?? 0,
        potentialFiles: 0,
        unreadable: 0,
        savableBytes: o.savableBytes ?? 0,
        hasDetails: false,
        canRescan: false,
      } satisfies ScanSummary);
    }
    await done(tx);
  } catch {
    /* unreadable legacy data: drop it */
  }
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
}

/** Newest first. Returns [] if this browser does not allow storage (e.g. some private windows). */
export async function listScans(): Promise<ScanSummary[]> {
  try {
    const db = await openDb();
    await migrateLegacy(db);
    const all = await read(db.transaction('summaries').objectStore('summaries').getAll() as IDBRequest<ScanSummary[]>);
    return all.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export function storageAvailable(): Promise<boolean> {
  return openDb().then(
    () => true,
    () => false,
  );
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Save a finished scan. Returns its id, or null if storage is unavailable. */
export async function saveScan(
  result: ScanResult,
  decisions: Decisions,
  handles: FileSystemDirectoryHandle[] | null,
): Promise<string | null> {
  const id = makeId();
  const plan = summarizePlan(buildPlan(result, decisions));
  const summary: ScanSummary = {
    id,
    at: result.scannedAt,
    source: result.sourceLabel,
    files: result.files.length + result.unreadable.length,
    totalBytes: result.files.reduce((a, f) => a + f.size, 0),
    unique: result.uniqueIds.length,
    exactGroups: result.exactGroups.length,
    extraCopies: result.exactGroups.reduce((a, g) => a + g.fileIds.length - 1, 0),
    potentialGroups: result.potentialGroups.length,
    potentialFiles: result.potentialGroups.reduce((a, g) => a + g.songKeys.reduce((b, k) => b + filesOfSong(result, k).length, 0), 0),
    unreadable: result.unreadable.length,
    savableBytes: plan.bytes[FOLDER_DUPLICATES],
    hasDetails: true,
    canRescan: !!handles && handles.length > 0,
  };
  const details: ScanDetails = {
    id,
    files: result.files.map((f) => ({
      id: f.id,
      path: f.path,
      title: f.displayTitle,
      fromFileName: f.titleFromFileName,
      artist: f.meta.artist,
      album: f.meta.album,
      ext: f.ext,
      size: f.size,
      duration: f.meta.duration,
      bitrate: f.meta.bitrate,
    })),
    uniqueIds: result.uniqueIds,
    exact: result.exactGroups.map((g) => ({ fileIds: g.fileIds, keep: g.defaultKeep })),
    potential: result.potentialGroups.map((g) => ({
      songs: g.songKeys.map((k) => filesOfSong(result, k).map((f) => f.id)),
      reasons: g.reasons,
    })),
    unreadable: result.unreadable,
  };
  try {
    const db = await openDb();
    const tx = db.transaction(['summaries', 'details', 'handles'], 'readwrite');
    tx.objectStore('summaries').put(summary);
    tx.objectStore('details').put(details);
    if (handles && handles.length) tx.objectStore('handles').put(handles, id);
    await done(tx);
    // Keep only the most recent scans.
    const all = await listScans();
    for (const old of all.slice(MAX_SCANS)) await deleteScan(old.id);
    return id;
  } catch {
    return null;
  }
}

export async function getScanDetails(id: string): Promise<ScanDetails | null> {
  try {
    const db = await openDb();
    return (await read(db.transaction('details').objectStore('details').get(id))) ?? null;
  } catch {
    return null;
  }
}

export async function getScanHandles(id: string): Promise<FileSystemDirectoryHandle[] | null> {
  try {
    const db = await openDb();
    return (await read(db.transaction('handles').objectStore('handles').get(id))) ?? null;
  } catch {
    return null;
  }
}

export async function markOrganized(id: string, record: OrganizeRecord): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction('summaries', 'readwrite');
    const store = tx.objectStore('summaries');
    const s = (await read(store.get(id))) as ScanSummary | undefined;
    if (s) store.put({ ...s, organized: record });
    await done(tx);
  } catch {
    /* history is optional */
  }
}

export async function deleteScan(id: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(['summaries', 'details', 'handles'], 'readwrite');
    tx.objectStore('summaries').delete(id);
    tx.objectStore('details').delete(id);
    tx.objectStore('handles').delete(id);
    await done(tx);
  } catch {
    /* ignore */
  }
}

export async function clearScans(): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(['summaries', 'details', 'handles'], 'readwrite');
    tx.objectStore('summaries').clear();
    tx.objectStore('details').clear();
    tx.objectStore('handles').clear();
    await done(tx);
  } catch {
    /* ignore */
  }
}

/**
 * Ask the browser for read access to saved folders again (it asks the user if needed).
 * Must be called from a click. Returns the folders the user allowed.
 */
export async function regainAccess(handles: FileSystemDirectoryHandle[]): Promise<FileSystemDirectoryHandle[]> {
  type WithPermission = FileSystemDirectoryHandle & {
    queryPermission?: (d: { mode: 'read' }) => Promise<PermissionState>;
    requestPermission?: (d: { mode: 'read' }) => Promise<PermissionState>;
  };
  const allowed: FileSystemDirectoryHandle[] = [];
  for (const h of handles as WithPermission[]) {
    let state: PermissionState = (await h.queryPermission?.({ mode: 'read' })) ?? 'prompt';
    if (state !== 'granted') state = (await h.requestPermission?.({ mode: 'read' })) ?? 'denied';
    if (state === 'granted') allowed.push(h);
  }
  return allowed;
}
