import type { ValidateInput, ValidationResult } from './validate';

/** Largest file SongSort will download or accept (keeps memory use on phones reasonable). */
export const MAX_AUDIO_BYTES = 250 * 1024 * 1024;

/** Validation may not take longer than this (protects against files built to make parsers loop). */
const VALIDATION_TIMEOUT_MS = 90_000;

/** Validate a file in a separate worker so the page stays responsive and runaway parsing can be stopped. */
export function checkAudioFile(input: Omit<ValidateInput, 'maxBytes'>): Promise<ValidationResult> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./validate.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ ok: false, reason: 'Checking the file took too long, so it was stopped.' });
    }, VALIDATION_TIMEOUT_MS);
    worker.onmessage = (e: MessageEvent<ValidationResult>) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      clearTimeout(timer);
      worker.terminate();
      resolve({ ok: false, reason: 'The file could not be checked.' });
    };
    worker.postMessage({ ...input, maxBytes: MAX_AUDIO_BYTES } satisfies ValidateInput);
  });
}
