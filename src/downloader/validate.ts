/**
 * Full validation of a downloaded file before SongSort offers it to the user:
 *   1. identify it from its first bytes (never from its name),
 *   2. walk its internal structure for the detected format,
 *   3. parse it with music-metadata (a maintained audio parser),
 *   4. cross-check the server's declared type.
 * Runs inside a Web Worker. Nothing here ever executes or renders the file.
 */
import { parseBlob } from 'music-metadata';
import { adtsFrameAt, blockedContentType, countFrames, FORMATS, id3Size, mpegFrameAt, sniff, type AudioKind } from './sniff';

export const REJECTED = 'File rejected: This does not appear to be a valid supported audio file.';

export interface AudioDetails {
  kind: AudioKind;
  formatLabel: string;
  codec?: string;
  lossless: boolean;
  bitrate?: number; // kbps
  sampleRate?: number;
  bitsPerSample?: number;
  channels?: number;
  duration?: number; // seconds
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
}

export type ValidationResult =
  | { ok: true; details: AudioDetails; warnings: string[] }
  /** `reason` is a plain-language explanation shown under the standard rejection message. */
  | { ok: false; reason: string };

const fail = (reason: string): ValidationResult => ({ ok: false, reason });

async function bytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(Math.max(0, start), Math.min(blob.size, end)).arrayBuffer());
}

const ascii = (b: Uint8Array, at: number, len: number) => new TextDecoder('latin1').decode(b.subarray(at, at + len));
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u32le = (b: Uint8Array, i: number) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + ((b[i + 3] << 24) >>> 0);

/* ------------------------------------------------------------------ */
/* Per-format structure checks. Each returns an error message or null. */
/* ------------------------------------------------------------------ */

/** MP3 / ADTS: a long run of valid frames at the start, and audio frames in the middle and near the end. */
async function checkFrames(blob: Blob, kind: 'mp3' | 'aac'): Promise<string | null> {
  const head = await bytes(blob, 0, 256 * 1024);
  let start = id3Size(head);
  if (start > blob.size) return 'Its tag information is damaged.';
  const region = start + 64 * 1024 <= head.length ? head : await bytes(blob, 0, start + 128 * 1024);
  // Find the first frame (some files have padding after the tag).
  let found = -1;
  for (let i = start; i < Math.min(region.length - 4, start + 32 * 1024); i++) {
    if (region[i] === 0xff && countFrames(region, i, kind, 8) >= 8) {
      found = i;
      break;
    }
  }
  if (found < 0) {
    // Very short files may have fewer than 8 frames in total.
    for (let i = start; i < region.length - 4; i++) {
      if (region[i] === 0xff && (kind === 'aac' ? adtsFrameAt(region, i) : mpegFrameAt(region, i))) {
        const n = countFrames(region, i, kind, 8);
        if (n >= 2 && blob.size < 64 * 1024) {
          found = i;
          break;
        }
      }
    }
  }
  if (found < 0) return 'No valid audio frames were found at the start of the file.';
  start = found;
  // Sample the middle and the end: a real song is audio frames all the way through.
  if (blob.size > 512 * 1024) {
    for (const at of [0.5, 0.9]) {
      const off = Math.floor(start + (blob.size - start) * at);
      const win = await bytes(blob, off, off + 64 * 1024);
      let ok = false;
      for (let i = 0; i < win.length - 4 && !ok; i++) {
        if (win[i] === 0xff && countFrames(win, i, kind, 4) >= 4) ok = true;
      }
      if (!ok) return `The ${at === 0.5 ? 'middle' : 'end'} of the file does not contain audio — it may be damaged or not a real song.`;
    }
  }
  return null;
}

async function checkFlac(blob: Blob): Promise<string | null> {
  const head = await bytes(blob, 0, 1024 * 1024);
  let i = id3Size(head);
  if (head[i] !== 0x66 || ascii(head, i, 4) !== 'fLaC') return 'The FLAC header is missing.';
  i += 4;
  let first = true;
  for (let blocks = 0; blocks < 1000; blocks++) {
    if (i + 4 > blob.size) return 'The file ends inside its header — it is incomplete.';
    const h = i + 4 <= head.length ? head : await bytes(blob, i, i + 4);
    const at = h === head ? i : 0;
    const last = (h[at] & 0x80) !== 0;
    const type = h[at] & 0x7f;
    const len = (h[at + 1] << 16) | (h[at + 2] << 8) | h[at + 3];
    if (first) {
      if (type !== 0 || len !== 34) return 'The FLAC stream information is missing or damaged.';
      const si = await bytes(blob, i + 4, i + 4 + 34);
      const sampleRate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
      if (sampleRate === 0) return 'The FLAC stream information is damaged.';
      first = false;
    }
    if (type === 127) return 'The FLAC header is damaged.';
    i += 4 + len;
    if (last) break;
  }
  if (i + 2 > blob.size) return 'The file has no audio after its header.';
  const sync = await bytes(blob, i, i + 2);
  if (sync[0] !== 0xff || (sync[1] & 0xfe) !== 0xf8) return 'The audio data after the FLAC header is damaged.';
  return null;
}

async function checkRiffWave(blob: Blob): Promise<string | null> {
  const head = await bytes(blob, 0, 12);
  const declared = u32le(head, 4) + 8;
  if (declared > blob.size + 1) return 'The file is shorter than its header says — it is incomplete.';
  let i = 12;
  let fmtOk = false;
  let dataOk = false;
  for (let n = 0; n < 200 && i + 8 <= blob.size; n++) {
    const ch = await bytes(blob, i, i + 8);
    const id = ascii(ch, 0, 4);
    const size = u32le(ch, 4);
    if (id === 'fmt ') {
      if (size < 16) return 'The WAV format information is damaged.';
      const f = await bytes(blob, i + 8, i + 8 + 16);
      const tag = f[0] | (f[1] << 8);
      const channels = f[2] | (f[3] << 8);
      const rate = u32le(f, 4);
      if (![1, 3, 0xfffe].includes(tag)) return `This WAV file uses an unusual compression (format ${tag}) that SongSort does not support.`;
      if (channels < 1 || channels > 8 || rate < 1000 || rate > 768000) return 'The WAV format information is damaged.';
      fmtOk = true;
    } else if (id === 'data') {
      if (!fmtOk) return 'The WAV file has audio before its format information — it is damaged.';
      if (size === 0) return 'The WAV file contains no audio.';
      if (i + 8 + size > blob.size + 1) return 'The file is shorter than its header says — it is incomplete.';
      dataOk = true;
      break;
    }
    i += 8 + size + (size & 1);
  }
  if (!fmtOk || !dataOk) return 'The WAV file structure is incomplete.';
  return null;
}

async function checkAiff(blob: Blob): Promise<string | null> {
  const head = await bytes(blob, 0, 12);
  if (u32be(head, 4) + 8 > blob.size + 1) return 'The file is shorter than its header says — it is incomplete.';
  let i = 12;
  let comm = false;
  for (let n = 0; n < 200 && i + 8 <= blob.size; n++) {
    const ch = await bytes(blob, i, i + 8);
    const id = ascii(ch, 0, 4);
    const size = u32be(ch, 4);
    if (id === 'COMM') comm = true;
    if (id === 'SSND') return comm ? (i + 8 + size > blob.size + 1 ? 'The file is incomplete.' : null) : 'The AIFF file structure is damaged.';
    i += 8 + size + (size & 1);
  }
  return 'The AIFF file structure is incomplete.';
}

async function checkOgg(blob: Blob): Promise<string | null> {
  let i = 0;
  let pages = 0;
  let lastFlagSeen = false;
  const CHUNK = 1024 * 1024;
  let buf = await bytes(blob, 0, CHUNK);
  let bufStart = 0;
  while (i < blob.size) {
    if (i + 27 > bufStart + buf.length) {
      buf = await bytes(blob, i, i + CHUNK);
      bufStart = i;
      if (buf.length < 27) return 'The file ends in the middle of an audio page — it is incomplete.';
    }
    const p = i - bufStart;
    if (ascii(buf, p, 4) !== 'OggS' || buf[p + 4] !== 0) {
      return pages === 0 ? 'The OGG header is damaged.' : 'The OGG audio data is damaged part-way through.';
    }
    const segs = buf[p + 26];
    if (p + 27 + segs > buf.length) {
      buf = await bytes(blob, i, i + CHUNK);
      bufStart = i;
      continue;
    }
    let body = 0;
    for (let s = 0; s < segs; s++) body += buf[i - bufStart + 27 + s];
    if (buf[i - bufStart + 5] & 0x04) lastFlagSeen = true;
    i += 27 + segs + body;
    pages++;
    if (i > blob.size) return 'The file ends in the middle of an audio page — it is incomplete.';
  }
  if (!lastFlagSeen) return 'The file is incomplete (the end of the audio is missing).';
  return null;
}

/** MP4/M4A: top-level boxes must cover the file exactly; must contain a sound track and no video or DRM. */
async function checkMp4(blob: Blob): Promise<string | null> {
  let i = 0;
  let moov: { start: number; size: number } | null = null;
  let hasData = false;
  for (let n = 0; n < 10000 && i < blob.size; n++) {
    if (i + 8 > blob.size) return 'The file ends inside a header — it is incomplete.';
    const h = await bytes(blob, i, i + 16);
    let size = u32be(h, 0);
    const type = ascii(h, 4, 4);
    let headerLen = 8;
    if (size === 1) {
      size = u32be(h, 8) * 2 ** 32 + u32be(h, 12);
      headerLen = 16;
    } else if (size === 0) size = blob.size - i;
    if (!/^[\x20-\x7e]{4}$/.test(type) || size < headerLen) return 'The file structure is damaged.';
    if (i + size > blob.size) return 'The file is shorter than its structure says — it is incomplete.';
    if (type === 'moov') moov = { start: i + headerLen, size: size - headerLen };
    if (type === 'mdat' && size > headerLen) hasData = true;
    i += size;
  }
  if (!moov) return 'The file has no track information — it is incomplete or damaged.';
  if (!hasData) return 'The file contains no audio data.';
  if (moov.size > 64 * 1024 * 1024) return 'The file structure is unusually large.';
  const m = await bytes(blob, moov.start, moov.start + moov.size);
  const handlers: string[] = [];
  const sampleTypes: string[] = [];
  let encrypted = false;
  const CONTAINERS = new Set(['trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'sinf', 'schi']);
  const walk = (s: number, e: number, depth: number) => {
    let j = s;
    while (j + 8 <= e && depth < 12) {
      const size = u32be(m, j);
      const type = ascii(m, j + 4, 4);
      if (size < 8 || j + size > e) return;
      if (type === 'hdlr' && j + 20 <= e) handlers.push(ascii(m, j + 16, 4));
      if (type === 'sinf' || type === 'schm' || type === 'tenc' || type === 'pssh') encrypted = true;
      if (type === 'stsd' && j + 16 <= e) {
        let k = j + 16;
        const count = u32be(m, j + 12);
        for (let c = 0; c < count && k + 8 <= j + size; c++) {
          const es = u32be(m, k);
          const et = ascii(m, k + 4, 4);
          sampleTypes.push(et);
          if (et === 'enca' || et === 'encv' || et === 'drms' || et === 'drmi') encrypted = true;
          if (es < 8) break;
          k += es;
        }
      }
      if (CONTAINERS.has(type)) walk(j + 8, j + size, depth + 1);
      j += size;
    }
  };
  walk(0, m.length, 0);
  if (encrypted) return 'This song is copy-protected (DRM), so it cannot be used outside the app or store it came from.';
  if (handlers.includes('vide')) return 'This is a video file, not an audio file.';
  if (!handlers.includes('soun')) return 'The file contains no sound track.';
  if (!sampleTypes.some((t) => t === 'mp4a' || t === 'alac')) {
    return `This file uses an audio type SongSort does not support (${sampleTypes.join(', ') || 'unknown'}).`;
  }
  return null;
}

const GUID = (s: string) => {
  const h = s.replace(/-/g, '');
  const p = (a: number, b: number) => h.slice(a, b).match(/../g)!.map((x) => parseInt(x, 16));
  return [...p(0, 8).reverse(), ...p(8, 12).reverse(), ...p(12, 16).reverse(), ...p(16, 32)];
};
const ASF_HEADER = GUID('75B22630-668E-11CF-A6D9-00AA0062CE6C');
const ASF_STREAM_PROPS = GUID('B7DC0791-A9B7-11CF-8EE6-00C00C205365');
const ASF_AUDIO = GUID('F8699E40-5B4D-11CF-A8FD-00805F5C442B');
const ASF_VIDEO = GUID('BC19EFC0-5B4D-11CF-A8FD-00805F5C442B');
const ASF_ENCRYPTION = GUID('2211B3FB-BD23-11D2-B4B7-00A0C955FC6E');
const ASF_EXT_ENCRYPTION = GUID('298AE614-2622-4C17-B935-DAE07EE9289C');
const ASF_DATA = GUID('75B22636-668E-11CF-A6D9-00AA0062CE6C');
const guidAt = (b: Uint8Array, i: number, g: number[]) => g.every((x, k) => b[i + k] === x);

async function checkAsf(blob: Blob): Promise<string | null> {
  const h = await bytes(blob, 0, 30);
  if (!guidAt(h, 0, ASF_HEADER)) return 'The WMA header is missing.';
  const headerSize = u32le(h, 16) + u32le(h, 20) * 2 ** 32;
  if (headerSize < 30 || headerSize > blob.size || headerSize > 64 * 1024 * 1024) return 'The WMA header is damaged.';
  const head = await bytes(blob, 0, headerSize);
  const count = u32le(head, 24);
  let i = 30;
  let audio = false;
  for (let n = 0; n < count && i + 24 <= head.length; n++) {
    const size = u32le(head, i + 16) + u32le(head, i + 20) * 2 ** 32;
    if (size < 24 || i + size > head.length) return 'The WMA header is damaged.';
    if (guidAt(head, i, ASF_ENCRYPTION) || guidAt(head, i, ASF_EXT_ENCRYPTION)) {
      return 'This song is copy-protected (DRM), so it cannot be used outside the app or store it came from.';
    }
    if (guidAt(head, i, ASF_STREAM_PROPS)) {
      if (guidAt(head, i + 24, ASF_VIDEO)) return 'This is a video file, not an audio file.';
      if (guidAt(head, i + 24, ASF_AUDIO)) audio = true;
    }
    i += size;
  }
  if (!audio) return 'The file contains no sound track.';
  const d = await bytes(blob, headerSize, headerSize + 16);
  if (!guidAt(d, 0, ASF_DATA)) return 'The WMA file has no audio data — it is incomplete.';
  return null;
}

/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */

export interface ValidateInput {
  blob: Blob;
  /** File name the source suggested (only used for warnings). */
  name?: string;
  /** Content-Type the server declared, if any. */
  contentType?: string | null;
  maxBytes: number;
}

export async function validateAudio({ blob, name, contentType, maxBytes }: ValidateInput): Promise<ValidationResult> {
  if (blob.size === 0) return fail('The file is empty.');
  if (blob.size > maxBytes) return fail('The file is larger than SongSort allows.');

  const declared = blockedContentType(contentType);
  if (declared) return fail(`The website says this file is ${declared}, not audio.`);

  const head = await bytes(blob, 0, 64 * 1024);
  const s = sniff(head);
  if (s.type === 'blocked') return fail(`It is actually ${s.what}.`);
  if (s.type === 'unsupported') return fail(`It is ${s.what}, which SongSort does not support.`);
  if (s.type === 'unknown') return fail('Its contents do not match any supported audio format.');
  const kind = s.kind;

  const structural =
    kind === 'mp3' || kind === 'aac'
      ? await checkFrames(blob, kind)
      : kind === 'flac'
        ? await checkFlac(blob)
        : kind === 'wav'
          ? await checkRiffWave(blob)
          : kind === 'aiff'
            ? await checkAiff(blob)
            : kind === 'ogg'
              ? await checkOgg(blob)
              : kind === 'm4a'
                ? await checkMp4(blob)
                : await checkAsf(blob);
  if (structural) return fail(structural);

  // Independent parse with a maintained audio library.
  let m;
  try {
    m = await parseBlob(blob, { duration: true, skipCovers: true });
  } catch (err) {
    return fail(`The audio could not be read (${err instanceof Error ? err.message.slice(0, 100) : 'unknown error'}).`);
  }
  const f = m.format;
  if (f.hasVideo) return fail('This is a video file, not an audio file.');
  if (!f.codec && !f.container) return fail('The audio format could not be confirmed.');
  if (!f.sampleRate && !f.duration) return fail('The file does not contain playable audio.');
  if (f.duration !== undefined && !(f.duration > 0)) return fail('The file does not contain any audio.');
  const codec = (f.codec ?? '').toLowerCase();
  if (kind === 'mp3' && codec && !codec.includes('layer 3')) return fail(`It contains ${f.codec}, not MP3 audio.`);

  const warnings: string[] = [];
  const ext = name?.split('.').pop()?.toLowerCase();
  const fmt = FORMATS[kind];
  const sameFamily = (e: string) => e === fmt.ext || (kind === 'm4a' && ['mp4', 'm4b', 'aac'].includes(e)) || (kind === 'aiff' && e === 'aif') || (kind === 'ogg' && ['oga', 'opus'].includes(e));
  if (ext && /^[a-z0-9]{2,5}$/.test(ext) && !sameFamily(ext)) {
    warnings.push(`The file name ends in “.${ext}”, but the file is really ${fmt.label}. It will be saved as .${fmt.ext}.`);
  }
  const ct = contentType?.split(';')[0].trim().toLowerCase();
  if (ct && ct.startsWith('audio/') && !ct.includes(fmt.ext) && !(kind === 'mp3' && ct.includes('mpeg')) && !(kind === 'm4a' && ct.includes('mp4')) && !(kind === 'wav' && ct.includes('wav')) && !(kind === 'flac' && ct.includes('flac'))) {
    warnings.push(`The website labelled it as ${ct}, but it is really ${fmt.label}.`);
  }

  const lossless = !!f.lossless || fmt.lossless;
  return {
    ok: true,
    warnings,
    details: {
      kind,
      formatLabel: fmt.label,
      codec: f.codec,
      lossless,
      bitrate: f.bitrate ? Math.round(f.bitrate / 1000) : undefined,
      sampleRate: f.sampleRate,
      bitsPerSample: f.bitsPerSample,
      channels: f.numberOfChannels,
      duration: f.duration,
      title: clean(m.common.title),
      artist: clean(m.common.artist),
      album: clean(m.common.album),
      year: m.common.year,
    },
  };
}

function clean(v?: string): string | undefined {
  const s = v?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s ? s.slice(0, 300) : undefined;
}
