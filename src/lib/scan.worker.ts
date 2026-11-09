/// <reference lib="webworker" />
import { parseBlob } from 'music-metadata';
import { createSHA256 } from 'hash-wasm';
import type { SongMeta } from './types';

export type WorkerRequest =
  | { kind: 'meta'; job: number; file: File }
  | { kind: 'hash'; job: number; file: File };

export type WorkerResponse =
  | { kind: 'meta'; job: number; meta: SongMeta; warning?: string }
  | { kind: 'hash'; job: number; hash: string }
  | { kind: 'progress'; job: number; bytes: number }
  | { kind: 'error'; job: number; error: string; unreadable: boolean };

/** Read size for hashing. Files are hashed piece by piece, never loaded whole. */
const CHUNK = 4 * 1024 * 1024;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Strip NUL padding and whitespace that some taggers leave behind.
  const v = value.replace(/\u0000/g, '').trim();
  return v.length > 0 ? v : undefined;
}

async function isReadable(file: File): Promise<boolean> {
  try {
    await file.slice(0, Math.min(file.size, 16)).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

async function readMeta(job: number, file: File): Promise<WorkerResponse> {
  try {
    const m = await parseBlob(file, { duration: false, skipCovers: true });
    const artist = clean(m.common.artist) ?? clean(m.common.artists?.join(', ')) ?? clean(m.common.albumartist);
    const meta: SongMeta = {
      title: clean(m.common.title),
      artist,
      album: clean(m.common.album),
      duration: typeof m.format.duration === 'number' && Number.isFinite(m.format.duration) ? m.format.duration : undefined,
      bitrate: typeof m.format.bitrate === 'number' && Number.isFinite(m.format.bitrate) ? Math.round(m.format.bitrate / 1000) : undefined,
      codec: clean(m.format.codec) ?? clean(m.format.container),
      lossless: m.format.lossless,
    };
    const recognized = !!(m.format.codec || m.format.container || meta.duration);
    return {
      kind: 'meta',
      job,
      meta,
      warning: recognized ? undefined : 'This file was not recognized as audio. It may be damaged or misnamed.',
    };
  } catch (err) {
    if (!(await isReadable(file))) {
      return { kind: 'error', job, error: 'The file could not be read. It may have been moved, or the drive was disconnected.', unreadable: true };
    }
    // The file opens fine but its tags/format could not be understood: keep it, flag it.
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'meta', job, meta: {}, warning: `Song details could not be read (${msg.slice(0, 120)}). The file may be damaged or in an unusual format.` };
  }
}

async function hashFile(job: number, file: File): Promise<WorkerResponse> {
  try {
    const hasher = await createSHA256();
    hasher.init();
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + CHUNK, file.size);
      const buf = await file.slice(offset, end).arrayBuffer();
      hasher.update(new Uint8Array(buf));
      ctx.postMessage({ kind: 'progress', job, bytes: end - offset } satisfies WorkerResponse);
      offset = end;
    }
    return { kind: 'hash', job, hash: hasher.digest('hex') };
  } catch (err) {
    const msg = err instanceof DOMException && err.name === 'NotReadableError'
      ? 'The file could not be read. It may have been moved, or the drive was disconnected.'
      : err instanceof Error ? err.message : String(err);
    return { kind: 'error', job, error: msg, unreadable: true };
  }
}

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  const res = req.kind === 'meta' ? await readMeta(req.job, req.file) : await hashFile(req.job, req.file);
  ctx.postMessage(res);
};
