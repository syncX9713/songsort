/**
 * Identify a file from its first bytes ("magic bytes"), never from its name.
 * Pure code with no browser or Node APIs, so the browser and the local download helper share it.
 */

export type AudioKind = 'mp3' | 'aac' | 'm4a' | 'wav' | 'flac' | 'ogg' | 'wma' | 'aiff';

export interface FormatInfo {
  label: string;
  ext: string;
  mime: string;
  lossless: boolean;
}

export const FORMATS: Record<AudioKind, FormatInfo> = {
  mp3: { label: 'MP3', ext: 'mp3', mime: 'audio/mpeg', lossless: false },
  aac: { label: 'AAC', ext: 'aac', mime: 'audio/aac', lossless: false },
  m4a: { label: 'M4A', ext: 'm4a', mime: 'audio/mp4', lossless: false },
  wav: { label: 'WAV', ext: 'wav', mime: 'audio/wav', lossless: true },
  flac: { label: 'FLAC', ext: 'flac', mime: 'audio/flac', lossless: true },
  ogg: { label: 'OGG', ext: 'ogg', mime: 'audio/ogg', lossless: false },
  wma: { label: 'WMA', ext: 'wma', mime: 'audio/x-ms-wma', lossless: false },
  aiff: { label: 'AIFF', ext: 'aiff', mime: 'audio/aiff', lossless: true },
};

export type SniffResult =
  | { type: 'audio'; kind: AudioKind }
  /** Something that must never be offered as audio (programs, scripts, web pages, archives, documents…). */
  | { type: 'blocked'; what: string }
  /** Real media, but not a format SongSort supports. */
  | { type: 'unsupported'; what: string }
  | { type: 'unknown' };

const ascii = (b: Uint8Array, at: number, s: string) => {
  if (at + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};
const bytesEq = (b: Uint8Array, at: number, sig: number[]) => {
  if (at + sig.length > b.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
  return true;
};

/* ------------------------------------------------------------------ */
/* MPEG audio / ADTS frame headers                                     */
/* ------------------------------------------------------------------ */

const MPEG_BITRATES: Record<string, number[]> = {
  // [version-group][layer]: kbps by index (0 = free, 15 = bad)
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MPEG_RATES = [
  [11025, 12000, 8000], // 2.5
  null,
  [22050, 24000, 16000], // 2
  [44100, 48000, 32000], // 1
];

export interface MpegFrame {
  layer: 1 | 2 | 3;
  version: 0 | 2 | 3; // 0 = MPEG 2.5, 2 = MPEG 2, 3 = MPEG 1
  sampleRate: number;
  bitrate: number;
  length: number;
}

/** Parse an MPEG audio frame header at `i`, or null if it is not a valid one. */
export function mpegFrameAt(b: Uint8Array, i: number): MpegFrame | null {
  if (i + 4 > b.length) return null;
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = ((b[i + 1] >> 3) & 3) as 0 | 1 | 2 | 3;
  const layerBits = (b[i + 1] >> 1) & 3;
  if (version === 1 || layerBits === 0) return null;
  const layer = (4 - layerBits) as 1 | 2 | 3;
  const brIdx = b[i + 2] >> 4;
  const srIdx = (b[i + 2] >> 2) & 3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const padding = (b[i + 2] >> 1) & 1;
  const group = version === 3 ? '1' : '2';
  const bitrate = MPEG_BITRATES[`${group}-${layer}`][brIdx] * 1000;
  const sampleRate = MPEG_RATES[version]![srIdx];
  let length: number;
  if (layer === 1) length = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
  else if (layer === 3 && version !== 3) length = Math.floor((72 * bitrate) / sampleRate) + padding;
  else length = Math.floor((144 * bitrate) / sampleRate) + padding;
  if (length < 24) return null;
  return { layer, version: version as 0 | 2 | 3, sampleRate, bitrate, length };
}

/** Parse an AAC ADTS frame header at `i`; returns the frame length or 0. */
export function adtsFrameAt(b: Uint8Array, i: number): number {
  if (i + 7 > b.length) return 0;
  if (b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) return 0;
  const srIdx = (b[i + 2] >> 2) & 0x0f;
  if (srIdx > 12) return 0;
  const len = ((b[i + 3] & 0x03) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
  return len >= 7 ? len : 0;
}

/** Count consecutive valid frames starting at `i` (stops at the end of the buffer). */
export function countFrames(b: Uint8Array, i: number, kind: 'mp3' | 'aac', max: number): number {
  let n = 0;
  let first: MpegFrame | null = null;
  while (n < max && i < b.length) {
    if (kind === 'aac') {
      const len = adtsFrameAt(b, i);
      if (!len) break;
      i += len;
    } else {
      const f = mpegFrameAt(b, i);
      if (!f) break;
      if (first && (f.layer !== first.layer || f.version !== first.version || f.sampleRate !== first.sampleRate)) break;
      first ??= f;
      i += f.length;
    }
    n++;
  }
  return n;
}

/** Size of an ID3v2 tag at `i` (header + body), or 0. */
export function id3Size(b: Uint8Array, i = 0): number {
  if (!ascii(b, i, 'ID3') || i + 10 > b.length) return 0;
  const s = ((b[i + 6] & 0x7f) << 21) | ((b[i + 7] & 0x7f) << 14) | ((b[i + 8] & 0x7f) << 7) | (b[i + 9] & 0x7f);
  const footer = b[i + 5] & 0x10 ? 10 : 0;
  return 10 + s + footer;
}

/* ------------------------------------------------------------------ */
/* Text detection                                                      */
/* ------------------------------------------------------------------ */

function looksLikeText(b: Uint8Array): boolean {
  const n = Math.min(b.length, 1024);
  if (n < 4) return false;
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 0) return false;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0xc2) printable++;
  }
  return printable / n > 0.95;
}

function firstNonSpace(b: Uint8Array): number {
  let i = bytesEq(b, 0, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  return i;
}

/* ------------------------------------------------------------------ */
/* Main sniffer                                                        */
/* ------------------------------------------------------------------ */

/** Identify `head` (the first bytes of a file, ideally 64 KB or more). */
export function sniff(head: Uint8Array): SniffResult {
  const b = head;
  if (b.length < 4) return { type: 'unknown' };

  // --- things that must never pass as audio ---
  if (ascii(b, 0, 'MZ')) return { type: 'blocked', what: 'a Windows program' };
  if (bytesEq(b, 0, [0x7f, 0x45, 0x4c, 0x46])) return { type: 'blocked', what: 'a Linux program' };
  for (const sig of [[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]]) {
    if (bytesEq(b, 0, sig)) return { type: 'blocked', what: 'a Mac or Java program' };
  }
  if (ascii(b, 0, '#!')) return { type: 'blocked', what: 'a script' };
  if (ascii(b, 0, 'PK\x03\x04') || ascii(b, 0, 'PK\x05\x06') || ascii(b, 0, 'PK\x07\x08')) {
    return { type: 'blocked', what: 'a ZIP archive (or an app or document packed as one)' };
  }
  if (ascii(b, 0, 'Rar!')) return { type: 'blocked', what: 'a RAR archive' };
  if (bytesEq(b, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { type: 'blocked', what: 'a 7-Zip archive' };
  if (bytesEq(b, 0, [0x1f, 0x8b])) return { type: 'blocked', what: 'a compressed archive' };
  if (ascii(b, 0, 'BZh') || bytesEq(b, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) || ascii(b, 0, 'MSCF')) {
    return { type: 'blocked', what: 'a compressed archive' };
  }
  if (ascii(b, 0, '%PDF')) return { type: 'blocked', what: 'a PDF document' };
  if (bytesEq(b, 0, [0xd0, 0xcf, 0x11, 0xe0])) return { type: 'blocked', what: 'an Office document or installer' };
  if (ascii(b, 0, '{\\rtf')) return { type: 'blocked', what: 'a document' };
  if (bytesEq(b, 0, [0x89, 0x50, 0x4e, 0x47])) return { type: 'blocked', what: 'a picture' };
  if (bytesEq(b, 0, [0xff, 0xd8, 0xff])) return { type: 'blocked', what: 'a picture' };
  if (ascii(b, 0, 'GIF8')) return { type: 'blocked', what: 'a picture' };

  // --- audio containers ---
  const id3 = id3Size(b);
  if (id3) {
    if (id3 + 4 > b.length) return { type: 'audio', kind: 'mp3' }; // very large tag; checked fully later
    if (ascii(b, id3, 'fLaC')) return { type: 'audio', kind: 'flac' };
    if (adtsFrameAt(b, id3)) return { type: 'audio', kind: 'aac' };
    return { type: 'audio', kind: 'mp3' };
  }
  if (ascii(b, 0, 'fLaC')) return { type: 'audio', kind: 'flac' };
  if (ascii(b, 0, 'OggS')) {
    const hay = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 512)));
    if (/\x01vorbis|OpusHead|\x7fFLAC|Speex/.test(hay)) return { type: 'audio', kind: 'ogg' };
    if (/theora/.test(hay)) return { type: 'unsupported', what: 'an OGG video' };
    return { type: 'unsupported', what: 'an OGG file of an unknown kind' };
  }
  if (ascii(b, 0, 'RIFF') && b.length >= 12) {
    if (ascii(b, 8, 'WAVE')) return { type: 'audio', kind: 'wav' };
    if (ascii(b, 8, 'WEBP')) return { type: 'blocked', what: 'a picture' };
    if (ascii(b, 8, 'AVI ')) return { type: 'unsupported', what: 'a video' };
    return { type: 'unsupported', what: 'a RIFF file that is not WAV audio' };
  }
  if (ascii(b, 0, 'FORM') && b.length >= 12 && (ascii(b, 8, 'AIFF') || ascii(b, 8, 'AIFC'))) return { type: 'audio', kind: 'aiff' };
  if (b.length >= 12 && ascii(b, 4, 'ftyp')) {
    const brand = new TextDecoder('latin1').decode(b.subarray(8, 12));
    if (brand === 'M4P ') return { type: 'blocked', what: 'a copy-protected (DRM) song' };
    if (/^(heic|heix|avif|mif1|msf1)$/.test(brand)) return { type: 'blocked', what: 'a picture' };
    if (/^(qt {2})$/.test(brand)) return { type: 'unsupported', what: 'a QuickTime video' };
    return { type: 'audio', kind: 'm4a' }; // video MP4s are rejected after the full check
  }
  if (bytesEq(b, 0, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c])) {
    return { type: 'audio', kind: 'wma' };
  }

  // --- media SongSort does not support ---
  if (ascii(b, 0, 'MThd')) return { type: 'unsupported', what: 'a MIDI file (notes, not recorded sound)' };
  if (bytesEq(b, 0, [0x1a, 0x45, 0xdf, 0xa3])) return { type: 'unsupported', what: 'a WebM/MKV file' };
  if (ascii(b, 0, 'MAC ')) return { type: 'unsupported', what: "a Monkey's Audio (APE) file" };
  if (ascii(b, 0, 'wvpk')) return { type: 'unsupported', what: 'a WavPack file' };
  if (ascii(b, 0, '.snd')) return { type: 'unsupported', what: 'an AU sound file' };
  if (ascii(b, 0, 'caff')) return { type: 'unsupported', what: 'a CAF sound file' };
  if (ascii(b, 0, '#!AMR')) return { type: 'unsupported', what: 'an AMR voice recording' };
  if (ascii(b, 0, 'DSD ') || ascii(b, 0, 'FRM8')) return { type: 'unsupported', what: 'a DSD audio file' };

  // --- bare MPEG audio / ADTS AAC (no tag): need two valid frames in a row ---
  const scan = Math.min(b.length - 4, 8192);
  for (let i = 0; i < scan; i++) {
    if (b[i] !== 0xff) continue;
    if (countFrames(b, i, 'aac', 3) >= 2) return { type: 'audio', kind: 'aac' };
    const f = mpegFrameAt(b, i);
    if (f && countFrames(b, i, 'mp3', 3) >= 2) {
      if (f.layer !== 3) return { type: 'unsupported', what: `an MPEG Layer ${f.layer === 2 ? 'II (MP2)' : 'I'} file` };
      return { type: 'audio', kind: 'mp3' };
    }
  }

  // --- text: web pages, scripts, SVG, JSON… ---
  const t = firstNonSpace(b);
  if (b[t] === 0x3c /* < */) {
    const start = new TextDecoder('latin1').decode(b.subarray(t, t + 256)).toLowerCase();
    if (start.includes('<svg') || (start.startsWith('<?xml') && start.includes('svg'))) return { type: 'blocked', what: 'an SVG image (which can contain scripts)' };
    if (start.startsWith('<?xml')) return { type: 'blocked', what: 'an XML document' };
    return { type: 'blocked', what: 'a web page (HTML)' };
  }
  if (looksLikeText(b)) return { type: 'blocked', what: 'a text or script file' };

  return { type: 'unknown' };
}

/** Content types that a server may send for things that are definitely not audio. */
export function blockedContentType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const t = contentType.split(';')[0].trim().toLowerCase();
  if (t === 'text/html' || t === 'application/xhtml+xml') return 'a web page';
  if (t.includes('javascript') || t === 'application/ecmascript' || t === 'text/ecmascript') return 'a script';
  if (t === 'image/svg+xml') return 'an SVG image';
  if (/x-msdownload|x-msdos-program|x-executable|portable-executable|x-msi|x-sh\b|x-shellscript|java-archive|x-apple-diskimage|vnd\.android\.package-archive/.test(t)) {
    return 'a program or installer';
  }
  if (/zip|x-rar|x-7z|x-tar|gzip|x-bzip/.test(t)) return 'an archive';
  if (t === 'application/pdf' || /msword|officedocument|vnd\.ms-(excel|powerpoint|word)/.test(t)) return 'a document';
  if (t.startsWith('text/')) return 'a text file';
  return null;
}
