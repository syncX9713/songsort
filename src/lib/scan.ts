import { analyze, titleFromFileName } from './analyze';
import { WorkerPool } from './pool';
import type { ScannedFile, ScanResult, SourceFile, UnreadableFile } from './types';

export interface ScanProgress {
  phase: 'details' | 'compare' | 'finishing';
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function eachLimit<T>(items: T[], limit: number, signal: AbortSignal, fn: (item: T) => Promise<void>) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length && !signal.aborted) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(runners);
}

function throttle<T>(fn: (v: T) => void, ms: number) {
  let last = 0;
  let pending: T | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    timer = null;
    last = Date.now();
    if (pending !== null) fn(pending);
    pending = null;
  };
  return (v: T, force = false) => {
    pending = v;
    if (force) {
      if (timer) clearTimeout(timer);
      fire();
      return;
    }
    const wait = ms - (Date.now() - last);
    if (wait <= 0) fire();
    else if (!timer) timer = setTimeout(fire, wait);
  };
}

/**
 * Scan the selected files:
 *  1. read song details (title, artist, album, length) from every file, in background workers;
 *  2. SHA-256 every file that has the same byte size as another file (files of different sizes
 *     can never be identical, so they do not need hashing);
 *  3. group exact and potential duplicates.
 * Nothing is uploaded anywhere: all reading happens in this browser tab.
 */
export async function scanFiles(
  sources: SourceFile[],
  sourceLabel: string,
  onProgress: (p: ScanProgress) => void,
  signal: AbortSignal,
): Promise<ScanResult> {
  const pool = new WorkerPool(WorkerPool.defaultSize());
  const abort = () => pool.terminate();
  signal.addEventListener('abort', abort);
  const report = throttle(onProgress, 120);

  try {
    const scanned: ScannedFile[] = [];
    const unreadable: UnreadableFile[] = [];
    const totalBytes = sources.reduce((a, f) => a + f.size, 0);

    /* Phase 1: song details */
    let done = 0;
    report({ phase: 'details', done: 0, total: sources.length, bytesDone: 0, bytesTotal: totalBytes }, true);
    const byId = new Map<number, ScannedFile>();
    await eachLimit(sources, WorkerPool.defaultSize() * 2, signal, async (src) => {
      if (src.size === 0) {
        unreadable.push({ path: src.path, size: 0, error: 'The file is empty (0 bytes).' });
      } else {
        const res = await pool.run('meta', src.file);
        if (signal.aborted) return;
        if (res.kind === 'meta') {
          const fromTags = !!res.meta.title;
          const f: ScannedFile = {
            ...src,
            meta: res.meta,
            titleFromFileName: !fromTags,
            displayTitle: res.meta.title ?? titleFromFileName(src.name),
            metaWarning: res.warning,
          };
          byId.set(f.id, f);
        } else if (res.kind === 'error') {
          unreadable.push({ path: src.path, size: src.size, error: res.error });
        }
      }
      done++;
      report({ phase: 'details', done, total: sources.length, bytesDone: 0, bytesTotal: totalBytes });
    });
    if (signal.aborted) throw new DOMException('Scan cancelled', 'AbortError');
    // Keep the original selection order.
    for (const s of sources) {
      const f = byId.get(s.id);
      if (f) scanned.push(f);
    }

    /* Phase 2: fingerprint (SHA-256) files that share a size */
    const bySize = new Map<number, ScannedFile[]>();
    for (const f of scanned) {
      const l = bySize.get(f.size);
      if (l) l.push(f);
      else bySize.set(f.size, [f]);
    }
    const candidates = [...bySize.values()].filter((l) => l.length > 1).flat();
    const hashBytes = candidates.reduce((a, f) => a + f.size, 0);
    let hashed = 0;
    let bytesDone = 0;
    const failed = new Set<number>();
    report({ phase: 'compare', done: 0, total: candidates.length, bytesDone: 0, bytesTotal: hashBytes }, true);
    await eachLimit(candidates, WorkerPool.defaultSize(), signal, async (f) => {
      let fileBytes = 0;
      const res = await pool.run('hash', f.file, (b) => {
        fileBytes += b;
        bytesDone += b;
        report({ phase: 'compare', done: hashed, total: candidates.length, bytesDone, bytesTotal: hashBytes });
      });
      if (signal.aborted) return;
      if (res.kind === 'hash') {
        f.hash = res.hash;
      } else if (res.kind === 'error') {
        failed.add(f.id);
        unreadable.push({ path: f.path, size: f.size, error: res.error });
        bytesDone += f.size - fileBytes;
      }
      hashed++;
      report({ phase: 'compare', done: hashed, total: candidates.length, bytesDone, bytesTotal: hashBytes });
    });
    if (signal.aborted) throw new DOMException('Scan cancelled', 'AbortError');

    report({ phase: 'finishing', done: 1, total: 1, bytesDone: hashBytes, bytesTotal: hashBytes }, true);
    const readable = failed.size ? scanned.filter((f) => !failed.has(f.id)) : scanned;
    return analyze(readable, unreadable, sourceLabel, hashed - failed.size);
  } finally {
    signal.removeEventListener('abort', abort);
    pool.terminate();
  }
}
