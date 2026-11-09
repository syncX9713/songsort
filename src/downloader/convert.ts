/**
 * Optional format conversion with FFmpeg (WebAssembly), entirely on the user's device.
 * Never automatic; the original stays available. The converter (~31 MB) is loaded only when used.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import { FORMATS, type AudioKind } from './sniff';
import type { AudioDetails } from './validate';

export const CONVERT_TARGETS: AudioKind[] = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'wma'];
/** Converting needs the whole file plus the result in memory; keep it reasonable. */
export const MAX_CONVERT_BYTES = 200 * 1024 * 1024;

const TARGET_LABEL: Record<AudioKind, string> = {
  mp3: 'MP3',
  m4a: 'M4A (AAC)',
  aac: 'AAC',
  flac: 'FLAC',
  wav: 'WAV',
  ogg: 'OGG (Vorbis)',
  wma: 'WMA',
  aiff: 'AIFF',
};
export const targetLabel = (k: AudioKind) => TARGET_LABEL[k];

const STANDARD = [128, 160, 192, 224, 256, 320];
const CAP: Partial<Record<AudioKind, number>> = { mp3: 320, m4a: 256, aac: 256, ogg: 256, wma: 192 };

export interface ConversionPlan {
  target: AudioKind;
  args: string[];
  /** e.g. "320 kbps" or "16-bit lossless" */
  quality: string;
  /** Honest note about what conversion does to quality. */
  note: string;
}

/** Plan a conversion that never pretends to add quality and doesn't throw quality away needlessly. */
export function planConversion(src: AudioDetails, target: AudioKind): ConversionPlan {
  const lossyTarget = !FORMATS[target].lossless;
  const args: string[] = ['-map', '0:a:0', '-vn', '-map_metadata', '0'];
  let quality = '';
  if (lossyTarget) {
    const cap = CAP[target]!;
    const kbps = src.lossless || !src.bitrate ? cap : Math.min(Math.max(STANDARD.find((s) => s >= src.bitrate!) ?? 320, 128), cap);
    quality = `up to ${kbps} kbps`;
    if (target === 'ogg') {
      // Vorbis works best (and supports mono) in its quality mode; q4≈128, q6≈192, q8≈256 kbps for stereo.
      const q = kbps <= 128 ? 4 : kbps <= 160 ? 5 : kbps <= 192 ? 6 : kbps <= 224 ? 7 : 8;
      args.push('-c:a', 'libvorbis', '-q:a', String(q));
      quality = `up to about ${kbps} kbps`;
    } else {
      const codec = { mp3: 'libmp3lame', m4a: 'aac', aac: 'aac', wma: 'wmav2' }[target as 'mp3'];
      args.push('-c:a', codec, '-b:a', `${kbps}k`);
    }
    if (src.sampleRate && src.sampleRate > 48000) args.push('-ar', '48000');
    if (src.channels && src.channels > 2) args.push('-ac', '2');
    if (target === 'mp3') args.push('-id3v2_version', '3');
    if (target === 'm4a') args.push('-movflags', '+faststart');
    if (target === 'aac') args.push('-f', 'adts');
  } else {
    const deep = src.lossless && (src.bitsPerSample ?? 16) > 16;
    quality = deep ? '24-bit lossless' : '16-bit lossless';
    if (target === 'wav') args.push('-c:a', deep ? 'pcm_s24le' : 'pcm_s16le');
    else args.push('-c:a', 'flac', '-sample_fmt', deep ? 's32' : 's16');
  }
  let note: string;
  if (!src.lossless && !lossyTarget) note = 'Same sound as the original in a bigger file. Converting can’t add quality the original doesn’t have.';
  else if (!src.lossless && lossyTarget) note = 'Re-compressing loses a little quality. Keep the original if your player supports it.';
  else if (src.lossless && lossyTarget) note = 'Smaller file with slightly lower quality than the original.';
  else note = 'Same quality as the original (both are lossless).';
  return { target, args, quality, note };
}

let ffmpeg: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  loading ??= (async () => {
    const f = new FFmpeg();
    await f.load({ coreURL, wasmURL });
    ffmpeg = f;
    return f;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

export function converterSupported(): boolean {
  return typeof WebAssembly === 'object' && typeof Worker === 'function';
}

/** Convert `blob` (already validated) to `plan.target`. The result must be validated again by the caller. */
export async function convertAudio(
  blob: Blob,
  sourceKind: AudioKind,
  plan: ConversionPlan,
  onStatus: (s: { stage: 'loading' | 'converting'; progress: number }) => void,
  signal: AbortSignal,
): Promise<Blob> {
  if (blob.size > MAX_CONVERT_BYTES) throw new Error(`Files over ${MAX_CONVERT_BYTES / 1048576} MB can’t be converted in the browser.`);
  onStatus({ stage: 'loading', progress: 0 });
  const f = await getFFmpeg();
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  const input = `input.${FORMATS[sourceKind].ext}`;
  const output = `output.${FORMATS[plan.target].ext}`;
  const onProgress = ({ progress }: { progress: number }) => onStatus({ stage: 'converting', progress: Math.max(0, Math.min(1, progress)) });
  const onAbort = () => {
    // Stopping FFmpeg mid-way means starting a fresh one next time.
    f.terminate();
    ffmpeg = null;
  };
  const log: string[] = [];
  const onLog = ({ message }: { message: string }) => {
    log.push(message);
    if (log.length > 30) log.shift();
  };
  f.on('progress', onProgress);
  f.on('log', onLog);
  signal.addEventListener('abort', onAbort);
  try {
    await f.writeFile(input, new Uint8Array(await blob.arrayBuffer()));
    onStatus({ stage: 'converting', progress: 0 });
    const code = await f.exec(['-hide_banner', '-nostdin', '-y', '-i', input, ...plan.args, output]);
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (code !== 0) {
      const reason = [...log].reverse().find((l) => /error|invalid|unable|not supported|failed/i.test(l));
      throw new Error(`The converter could not convert this file${reason ? ` (${reason.trim().slice(0, 140)})` : ''}.`);
    }
    const data = await f.readFile(output);
    if (typeof data === 'string' || data.length === 0) throw new Error('The converter produced no audio.');
    return new Blob([data as BlobPart], { type: FORMATS[plan.target].mime });
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (ffmpeg === f) {
      f.off('progress', onProgress);
      f.off('log', onLog);
      // Remove temporary files from the converter's memory.
      await f.deleteFile(input).catch(() => {});
      await f.deleteFile(output).catch(() => {});
    }
  }
}
