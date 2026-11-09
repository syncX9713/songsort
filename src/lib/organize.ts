import { downloadZip } from 'client-zip';
import { errorMessage } from './format';
import {
  FOLDER_DUPLICATES,
  FOLDER_POTENTIAL,
  FOLDER_UNIQUE,
  OUTPUT_ROOT,
  type Decisions,
  type OutputFolder,
  type ScannedFile,
  type ScanResult,
  type SongKey,
} from './types';

export const OUTPUT_FOLDERS: OutputFolder[] = [FOLDER_UNIQUE, FOLDER_DUPLICATES, FOLDER_POTENTIAL];

export interface PlanItem {
  file: ScannedFile;
  folder: OutputFolder;
  /** File name inside the output folder (original name, or "name (2).mp3" if that name is taken). */
  outName: string;
}

export interface OrganizeProgress {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  current?: string;
}

export interface OrganizeReport {
  mode: 'folder' | 'zip';
  outputName: string;
  copied: number;
  bytes: number;
  failed: { path: string; error: string }[];
  cancelled: boolean;
  renamed: number;
  counts: Record<OutputFolder, number>;
}

/* ------------------------------------------------------------------ */
/* Decisions -> where each file goes                                   */
/* ------------------------------------------------------------------ */

export function exactKeeper(result: ScanResult, decisions: Decisions, groupId: string): number {
  const g = result.exactGroups.find((x) => x.id === groupId)!;
  const chosen = decisions.exactKeep[groupId];
  return chosen !== undefined && g.fileIds.includes(chosen) ? chosen : g.defaultKeep;
}

/** All files that belong to a song (one file, or every identical copy). */
export function filesOfSong(result: ScanResult, key: SongKey): ScannedFile[] {
  if (key.startsWith('f:')) return [result.filesById.get(Number(key.slice(2)))!];
  const g = result.exactGroups.find((x) => x.id === key.slice(2))!;
  return g.fileIds.map((id) => result.filesById.get(id)!);
}

/** The copy that represents a song (for exact groups: the copy the user chose to keep). */
export function representativeOfSong(result: ScanResult, decisions: Decisions, key: SongKey): ScannedFile {
  if (key.startsWith('f:')) return result.filesById.get(Number(key.slice(2)))!;
  return result.filesById.get(exactKeeper(result, decisions, key.slice(2)))!;
}

/** Make a file name unique inside one folder without ever overwriting: "song.mp3" -> "song (2).mp3". */
export function uniqueName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  let n = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base} (${n++})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

export function buildPlan(result: ScanResult, decisions: Decisions): PlanItem[] {
  const folderOf = new Map<number, OutputFolder>();

  // Level 1: exact copies. The chosen copy is the song; every other copy is a duplicate.
  const songKeyOfFile = new Map<number, SongKey>();
  for (const g of result.exactGroups) {
    const keep = exactKeeper(result, decisions, g.id);
    for (const id of g.fileIds) {
      songKeyOfFile.set(id, `x:${g.id}`);
      if (id !== keep) folderOf.set(id, FOLDER_DUPLICATES);
    }
  }

  // Level 2: potential duplicates, according to the user's review.
  const potentialOfSong = new Map<SongKey, string>();
  for (const pg of result.potentialGroups) for (const k of pg.songKeys) potentialOfSong.set(k, pg.id);

  for (const f of result.files) {
    if (folderOf.has(f.id)) continue;
    const key = songKeyOfFile.get(f.id) ?? `f:${f.id}`;
    const pgId = potentialOfSong.get(key);
    if (!pgId) {
      folderOf.set(f.id, FOLDER_UNIQUE);
      continue;
    }
    const d = decisions.potential[pgId] ?? { kind: 'later' };
    if (d.kind === 'later') folderOf.set(f.id, FOLDER_POTENTIAL);
    else if (d.kind === 'different') folderOf.set(f.id, FOLDER_UNIQUE);
    else folderOf.set(f.id, d.keep === key ? FOLDER_UNIQUE : FOLDER_DUPLICATES);
  }

  const used: Record<OutputFolder, Set<string>> = {
    [FOLDER_UNIQUE]: new Set(),
    [FOLDER_DUPLICATES]: new Set(),
    [FOLDER_POTENTIAL]: new Set(),
  };
  // Keep a stable order: by folder, then by original location.
  const items = result.files
    .map((file) => ({ file, folder: folderOf.get(file.id)! }))
    .sort((a, b) => OUTPUT_FOLDERS.indexOf(a.folder) - OUTPUT_FOLDERS.indexOf(b.folder) || a.file.path.localeCompare(b.file.path));
  return items.map(({ file, folder }) => ({ file, folder, outName: uniqueName(file.name, used[folder]) }));
}

export function summarizePlan(plan: PlanItem[]) {
  const counts: Record<OutputFolder, number> = { [FOLDER_UNIQUE]: 0, [FOLDER_DUPLICATES]: 0, [FOLDER_POTENTIAL]: 0 };
  const bytes: Record<OutputFolder, number> = { [FOLDER_UNIQUE]: 0, [FOLDER_DUPLICATES]: 0, [FOLDER_POTENTIAL]: 0 };
  let renamed = 0;
  for (const p of plan) {
    counts[p.folder]++;
    bytes[p.folder] += p.file.size;
    if (p.outName !== p.file.name) renamed++;
  }
  const totalBytes = plan.reduce((a, p) => a + p.file.size, 0);
  return { counts, bytes, renamed, totalBytes };
}

/* ------------------------------------------------------------------ */
/* Copy into a real folder (File System Access API)                    */
/* ------------------------------------------------------------------ */

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getDirectoryHandle(name);
    return true;
  } catch {
    try {
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }
}

function counting(onBytes: (n: number) => void): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      onBytes(chunk.byteLength);
      controller.enqueue(chunk);
    },
  });
}

/**
 * Copy every planned file into `<destination>/SongSort Output/<folder>/`.
 * Originals are only read, never changed or deleted. Existing files are never overwritten:
 * if "SongSort Output" already exists, a new "SongSort Output (2)" is created.
 */
export async function copyToFolder(
  destination: FileSystemDirectoryHandle,
  plan: PlanItem[],
  onProgress: (p: OrganizeProgress) => void,
  signal: AbortSignal,
): Promise<OrganizeReport> {
  let outputName = OUTPUT_ROOT;
  for (let n = 2; await exists(destination, outputName); n++) outputName = `${OUTPUT_ROOT} (${n})`;
  const root = await destination.getDirectoryHandle(outputName, { create: true });
  const dirs = {} as Record<OutputFolder, FileSystemDirectoryHandle>;
  for (const f of OUTPUT_FOLDERS) dirs[f] = await root.getDirectoryHandle(f, { create: true });

  const summary = summarizePlan(plan);
  const report: OrganizeReport = {
    mode: 'folder',
    outputName,
    copied: 0,
    bytes: 0,
    failed: [],
    cancelled: false,
    renamed: summary.renamed,
    counts: { [FOLDER_UNIQUE]: 0, [FOLDER_DUPLICATES]: 0, [FOLDER_POTENTIAL]: 0 },
  };
  let bytesDone = 0;
  let filesDone = 0;
  const emit = (current?: string) =>
    onProgress({ filesDone, filesTotal: plan.length, bytesDone, bytesTotal: summary.totalBytes, current });

  for (const item of plan) {
    if (signal.aborted) {
      report.cancelled = true;
      break;
    }
    emit(item.file.path);
    const dir = dirs[item.folder];
    let created = false;
    let fileBytes = 0;
    let name = item.outName;
    try {
      // Belt and braces: never overwrite, even if something else wrote into the folder meanwhile.
      if (await exists(dir, name)) {
        const used = new Set<string>([name.toLowerCase()]);
        do name = uniqueName(item.outName, used);
        while (await exists(dir, name));
      }
      const handle = await dir.getFileHandle(name, { create: true });
      created = true;
      const writable = await handle.createWritable();
      await item.file.file
        .stream()
        .pipeThrough(counting((n) => { fileBytes += n; bytesDone += n; }))
        .pipeTo(writable, { signal });
      report.copied++;
      report.bytes += item.file.size;
      report.counts[item.folder]++;
      if (name !== item.outName) report.renamed++;
    } catch (err) {
      bytesDone += item.file.size - fileBytes;
      if (signal.aborted) {
        report.cancelled = true;
      } else {
        report.failed.push({ path: item.file.path, error: errorMessage(err) });
      }
      // Remove the incomplete copy so it is never mistaken for a good file.
      if (created) {
        try {
          await dir.removeEntry(name);
        } catch {
          /* nothing to clean up */
        }
      }
      if (report.cancelled) break;
    }
    filesDone++;
    emit();
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* ZIP export (works everywhere, including phones)                     */
/* ------------------------------------------------------------------ */

function zipEntries(plan: PlanItem[], onFile: (item: PlanItem) => void, onBytes: (n: number) => void, signal: AbortSignal) {
  return (async function* () {
    for (const f of OUTPUT_FOLDERS) yield { name: `${OUTPUT_ROOT}/${f}/`, lastModified: new Date() };
    for (const item of plan) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      onFile(item);
      yield {
        name: `${OUTPUT_ROOT}/${item.folder}/${item.outName}`,
        lastModified: new Date(item.file.file.lastModified || Date.now()),
        size: item.file.size,
        input: item.file.file.stream().pipeThrough(counting(onBytes)),
      };
    }
  })();
}

/**
 * Build a ZIP of the organized collection. Music is stored without recompression
 * (audio does not shrink), so the ZIP is about the same size as the files inside it.
 * If `saveTo` is given (desktop Chrome/Edge) the ZIP is streamed straight to disk;
 * otherwise it is assembled in the browser and offered as a download.
 */
export async function exportZip(
  plan: PlanItem[],
  onProgress: (p: OrganizeProgress) => void,
  signal: AbortSignal,
  saveTo?: FileSystemFileHandle,
): Promise<{ report: OrganizeReport; blob?: Blob }> {
  const summary = summarizePlan(plan);
  let bytesDone = 0;
  let filesDone = -1;
  let current = '';
  const emit = () =>
    onProgress({ filesDone: Math.max(0, filesDone), filesTotal: plan.length, bytesDone, bytesTotal: summary.totalBytes, current });
  const report: OrganizeReport = {
    mode: 'zip',
    outputName: `${OUTPUT_ROOT}.zip`,
    copied: 0,
    bytes: 0,
    failed: [],
    cancelled: false,
    renamed: summary.renamed,
    counts: { ...summary.counts },
  };

  const response = downloadZip(
    zipEntries(
      plan,
      (item) => {
        filesDone++;
        current = item.file.path;
        emit();
      },
      (n) => {
        bytesDone += n;
        emit();
      },
      signal,
    ),
  );
  const body = response.body!;

  try {
    if (saveTo) {
      const writable = await saveTo.createWritable();
      await body.pipeTo(writable, { signal });
      filesDone = plan.length;
      emit();
      report.copied = plan.length;
      report.bytes = summary.totalBytes;
      report.outputName = saveTo.name;
      return { report };
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    const onAbort = () => reader.cancel().catch(() => {});
    signal.addEventListener('abort', onAbort);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    filesDone = plan.length;
    emit();
    report.copied = plan.length;
    report.bytes = summary.totalBytes;
    return { report, blob: new Blob(chunks as BlobPart[], { type: 'application/zip' }) };
  } catch (err) {
    if (signal.aborted) {
      report.cancelled = true;
      report.counts = { [FOLDER_UNIQUE]: 0, [FOLDER_DUPLICATES]: 0, [FOLDER_POTENTIAL]: 0 };
      return { report };
    }
    throw new Error(
      `The ZIP could not be created${current ? ` while reading "${current}"` : ''}: ${errorMessage(err)}`,
    );
  }
}

export function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser plenty of time to start the download before releasing the memory.
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
}
