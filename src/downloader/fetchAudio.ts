import { hostProblem } from './address';
import { MAX_AUDIO_BYTES } from './checkFile';
import { nameFromDisposition } from './filename';
import { isTestOrigin } from './links';
import { blockedContentType, sniff } from './sniff';

/** Web pages are only read to find song links on them; they never need to be large. */
export const MAX_PAGE_BYTES = 3 * 1024 * 1024;
/** Stop if the website sends nothing for this long. */
const IDLE_TIMEOUT_MS = 30_000;
/** Stop any single download after this long. */
const TOTAL_TIMEOUT_MS = 15 * 60_000;

export type FetchErrorCode =
  | 'blocked-url'
  | 'unreachable'
  | 'http'
  | 'too-large'
  | 'timeout'
  | 'interrupted'
  | 'rejected'
  | 'cancelled';

export class FetchError extends Error {
  constructor(
    public code: FetchErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Fetched {
  kind: 'file' | 'page';
  blob: Blob;
  /** Only for pages. */
  text?: string;
  contentType: string | null;
  suggestedName?: string;
  finalUrl: string;
  via: 'browser' | 'helper';
}

export type Expect = 'audio' | 'page' | 'auto';

/* ------------------------------------------------------------------ */
/* Local helper (only present when SongSort runs on the user's computer) */
/* ------------------------------------------------------------------ */

const BASE = import.meta.env.BASE_URL;
let helperPromise: Promise<boolean> | null = null;

/** Is the local download helper running? (Never on the public website.) */
export function helperAvailable(): Promise<boolean> {
  helperPromise ??= fetch(`${BASE}api/health`, { headers: { 'x-songsort': '1' }, cache: 'no-store' })
    .then(async (r) => r.ok && (await r.json()).songsort === true)
    .catch(() => false);
  return helperPromise;
}

/* ------------------------------------------------------------------ */

function httpMessage(status: number): string {
  if (status === 404 || status === 410) return `The file was not found on the website (error ${status}). The link may be old or mistyped.`;
  if (status === 401 || status === 403) return `The website refused access (error ${status}). It may need you to sign in, or it doesn’t allow downloads.`;
  if (status === 429) return 'The website is receiving too many requests right now (error 429). Try again later.';
  if (status >= 500) return `The website had a problem (error ${status}). Try again later.`;
  return `The website answered with error ${status}.`;
}

function checkRedirectTarget(finalUrl: string) {
  let u: URL;
  try {
    u = new URL(finalUrl);
  } catch {
    throw new FetchError('blocked-url', 'The website redirected to an invalid address.');
  }
  if (isTestOrigin(u)) return;
  if (u.protocol !== 'https:') throw new FetchError('blocked-url', 'The website redirected to an insecure (non-https) address, so the download was stopped.');
  const p = hostProblem(u.hostname);
  if (p) throw new FetchError('blocked-url', `The website redirected to an address that isn’t allowed. ${p}`);
}

/** Read a response body with size, idle and total time limits, and an early content check. */
async function readBody(
  res: Response,
  expect: Expect,
  looksAudio: boolean,
  signal: AbortSignal,
  onProgress: (received: number, total?: number) => void,
): Promise<{ blob: Blob; isPage: boolean }> {
  const declared = Number(res.headers.get('content-length') || res.headers.get('x-upstream-length') || '') || undefined;
  const contentType = res.headers.get('x-upstream-type') ?? res.headers.get('content-type');
  let isPage = expect === 'page';
  if (expect === 'auto' && !looksAudio && /text\/html|application\/xhtml/i.test(contentType ?? '')) isPage = true;
  let limit = isPage ? MAX_PAGE_BYTES : MAX_AUDIO_BYTES;
  if (declared && declared > limit) {
    throw new FetchError('too-large', isPage ? 'That web page is too large to read.' : `The file is too large (${Math.round(declared / 1048576)} MB). SongSort accepts songs up to ${MAX_AUDIO_BYTES / 1048576} MB.`);
  }
  if (!res.body) throw new FetchError('interrupted', 'The website sent no data.');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let checked = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      reader.cancel().catch(() => {});
    }, IDLE_TIMEOUT_MS);
  };
  const onAbort = () => reader.cancel().catch(() => {});
  signal.addEventListener('abort', onAbort);
  const head = () => {
    const all = new Uint8Array(Math.min(received, 65536));
    let o = 0;
    for (const c of chunks) {
      if (o >= all.length) break;
      const take = Math.min(c.length, all.length - o);
      all.set(c.subarray(0, take), o);
      o += take;
    }
    return all;
  };
  const earlyCheck = () => {
    checked = true;
    const s = sniff(head());
    if (expect === 'auto' && !looksAudio && s.type === 'blocked' && /web page/.test(s.what)) {
      isPage = true;
      limit = MAX_PAGE_BYTES;
      return;
    }
    if (isPage) {
      if (!(s.type === 'blocked' && /web page|XML/.test(s.what))) throw new FetchError('rejected', 'The link did not lead to a web page or an audio file.');
      return;
    }
    if (s.type === 'blocked') throw new FetchError('rejected', `It is actually ${s.what}.`);
    if (s.type === 'unsupported') throw new FetchError('rejected', `It is ${s.what}, which SongSort does not support.`);
    if (s.type === 'unknown') throw new FetchError('rejected', 'Its contents do not match any supported audio format.');
  };
  try {
    armIdle();
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch {
        if (signal.aborted) throw new FetchError('cancelled', 'Cancelled.');
        throw new FetchError('interrupted', 'The download was interrupted. Check your internet connection and try again.');
      }
      if (signal.aborted) throw new FetchError('cancelled', 'Cancelled.');
      if (timedOut) throw new FetchError('timeout', 'The website stopped sending data, so the download was stopped. Try again later.');
      if (r.done) break;
      armIdle();
      chunks.push(r.value);
      received += r.value.length;
      if (received > limit) {
        reader.cancel().catch(() => {});
        throw new FetchError('too-large', isPage ? 'That web page is too large to read.' : `The file is larger than ${MAX_AUDIO_BYTES / 1048576} MB, so the download was stopped.`);
      }
      if (!checked && received >= 65536) earlyCheck();
      onProgress(received, declared);
    }
    if (timedOut) throw new FetchError('timeout', 'The website stopped sending data, so the download was stopped. Try again later.');
    if (!checked) earlyCheck();
    if (declared && received < declared && !res.headers.get('content-encoding')) {
      throw new FetchError('interrupted', 'The download was interrupted before the whole file arrived. Check your connection and try again.');
    }
    return { blob: new Blob(chunks as BlobPart[]), isPage };
  } finally {
    clearTimeout(idle);
    signal.removeEventListener('abort', onAbort);
  }
}

async function finish(res: Response, via: 'browser' | 'helper', fallbackUrl: string, expect: Expect, looksAudio: boolean, signal: AbortSignal, onProgress: (r: number, t?: number) => void): Promise<Fetched> {
  const finalUrl = res.headers.get('x-final-url') ?? (res.url || fallbackUrl);
  const contentType = res.headers.get('x-upstream-type') ?? res.headers.get('content-type');
  const blocked = blockedContentType(contentType);
  const htmlAllowed = expect !== 'audio' && !looksAudio && blocked === 'a web page';
  if (blocked && !htmlAllowed) throw new FetchError('rejected', `The website says this file is ${blocked}, not audio.`);
  const { blob, isPage } = await readBody(res, expect, looksAudio, signal, onProgress);
  const disposition = res.headers.get('x-filename') ? decodeURIComponent(res.headers.get('x-filename')!) : nameFromDisposition(res.headers.get('content-disposition'));
  if (isPage) {
    const text = new TextDecoder('utf-8').decode(await blob.arrayBuffer());
    return { kind: 'page', blob, text, contentType, finalUrl, via };
  }
  return { kind: 'file', blob, contentType, suggestedName: disposition, finalUrl, via };
}

async function viaHelper(url: URL, expect: Expect, looksAudio: boolean, signal: AbortSignal, onProgress: (r: number, t?: number) => void): Promise<Fetched> {
  let res: Response;
  try {
    res = await fetch(`${BASE}api/fetch?expect=${expect}&url=${encodeURIComponent(url.href)}`, {
      headers: { 'x-songsort': '1' },
      signal,
      cache: 'no-store',
    });
  } catch {
    if (signal.aborted) throw new FetchError('cancelled', 'Cancelled.');
    throw new FetchError('unreachable', 'SongSort’s download helper on this computer did not respond. Restart SongSort and try again.');
  }
  if (!res.ok) {
    let body: { code?: FetchErrorCode; message?: string } = {};
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    throw new FetchError(body.code ?? 'http', body.message ?? httpMessage(res.status));
  }
  return finish(res, 'helper', url.href, expect, looksAudio, signal, onProgress);
}

/**
 * Download a link with every safety limit applied.
 * The browser is tried first; if the website doesn't allow browser downloads (or redirects),
 * the local helper is used when SongSort runs on the user's computer.
 */
export async function fetchLink(
  url: URL,
  opts: { expect: Expect; looksAudio: boolean; signal: AbortSignal; onProgress: (received: number, total?: number) => void },
): Promise<Fetched> {
  // Overall time limit on top of the user's own Cancel.
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, TOTAL_TIMEOUT_MS);
  const relay = () => ac.abort();
  if (opts.signal.aborted) ac.abort();
  opts.signal.addEventListener('abort', relay);
  try {
    return await fetchLinkOnce(url, { ...opts, signal: ac.signal });
  } catch (err) {
    if (timedOut) throw new FetchError('timeout', 'The download took too long, so it was stopped. Try again later.');
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', relay);
  }
}

async function fetchLinkOnce(
  url: URL,
  opts: { expect: Expect; looksAudio: boolean; signal: AbortSignal; onProgress: (received: number, total?: number) => void },
): Promise<Fetched> {
  const { expect, looksAudio, signal, onProgress } = opts;
  const helper = await helperAvailable();
  let res: Response;
  try {
    res = await fetch(url.href, {
      signal,
      redirect: 'manual',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      mode: 'cors',
    });
  } catch {
    if (signal.aborted) throw new FetchError('cancelled', 'Cancelled.');
    if (helper) return viaHelper(url, expect, looksAudio, signal, onProgress);
    throw new FetchError(
      'unreachable',
      'This website couldn’t be reached, or it doesn’t allow downloads from other websites such as SongSort online. ' +
        'If you run SongSort on your computer (Start SongSort), it can download from more websites. Otherwise, download the file from the website itself.',
    );
  }
  if (res.type === 'opaqueredirect') {
    // A redirect: let the helper follow it with full checks, or follow it here and check where it ended up.
    if (helper) return viaHelper(url, expect, looksAudio, signal, onProgress);
    try {
      res = await fetch(url.href, { signal, redirect: 'follow', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors' });
    } catch {
      if (signal.aborted) throw new FetchError('cancelled', 'Cancelled.');
      throw new FetchError('unreachable', 'The link redirects to a website that doesn’t allow downloads from SongSort online. Run SongSort on your computer to download it.');
    }
    checkRedirectTarget(res.url);
  }
  if (!res.ok) throw new FetchError('http', httpMessage(res.status));
  return finish(res, 'browser', url.href, expect, looksAudio, signal, onProgress);
}
