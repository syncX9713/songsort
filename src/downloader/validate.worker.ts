/// <reference lib="webworker" />
import { validateAudio, type ValidateInput, type ValidationResult } from './validate';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<ValidateInput>) => {
  let result: ValidationResult;
  try {
    result = await validateAudio(e.data);
  } catch (err) {
    result = { ok: false, reason: `The file could not be checked (${err instanceof Error ? err.message : 'error'}).` };
  }
  ctx.postMessage(result);
};
