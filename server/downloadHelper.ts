/**
 * SongSort's local download helper.
 *
 * Runs only inside SongSort's own local server (`npm start` on the user's computer); the public website
 * has no server. It lets SongSort download from websites that don't allow downloads from other web pages.
 *
 * Security:
 *  - https only, standard port only, no user names/passwords in links;
 *  - every host name is resolved and EVERY address is checked: this computer, private/home networks,
 *    link-local (cloud metadata), multicast and reserved ranges are refused (SSRF protection);
 *    the connection uses the checked address, so DNS answers can't change in between;
 *  - every redirect is checked the same way (at most 5);
 *  - size limits (250 MB audio, 3 MB web pages), idle and total time limits;
 *  - the first bytes are checked and non-audio is refused before the rest is downloaded;
 *  - nothing is written to disk; nothing from the remote site is executed;
 *  - only SongSort's own page can call it (custom header + same-origin checks).
 */
import { lookup, type LookupAddress } from 'node:dns';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Plugin } from 'vite';
import { hostProblem, isBlockedIP } from '../src/downloader/address';
import { blockedContentType, sniff } from '../src/downloader/sniff';

const MAX_AUDIO_BYTES = 250 * 1024 * 1024;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 15 * 60_000;
const USER_AGENT = 'SongSort/1.0 (personal music organizer; +https://github.com/syncX9713/songsort)';

/** For automated tests only: one extra origin (e.g. http://127.0.0.1:5199) that may be fetched. Never set in normal use. */
const TEST_ORIGIN = process.env.SONGSORT_TEST_ORIGIN || null;

type Code = 'blocked-url' | 'unreachable' | 'http' | 'too-large' | 'timeout' | 'interrupted' | 'rejected';

class HelperError extends Error {
  constructor(
    public code: Code,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

function sendError(res: ServerResponse, err: HelperError) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = err.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ code: err.code, message: err.message }));
}

function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HelperError('blocked-url', 'That is not a valid web link.');
  }
  if (TEST_ORIGIN && u.origin === TEST_ORIGIN) return u;
  if (u.protocol !== 'https:') throw new HelperError('blocked-url', 'Only secure links (https://) are supported.');
  if (u.username || u.password) throw new HelperError('blocked-url', 'Links that contain a user name or password are not allowed.');
  if (u.port && u.port !== '443') throw new HelperError('blocked-url', 'Links to unusual network ports are not supported.');
  const p = hostProblem(u.hostname);
  if (p) throw new HelperError('blocked-url', p);
  return u;
}

/** DNS lookup that refuses names pointing at blocked addresses. Used for the actual connection. */
function safeLookup(
  hostname: string,
  options: { all?: boolean },
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) {
  lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as LookupAddress[];
    if (!list.length) return callback(Object.assign(new Error('No address'), { code: 'ENOTFOUND' }), '');
    if (list.some((a) => isBlockedIP(a.address))) {
      return callback(Object.assign(new Error('Blocked address'), { code: 'EBLOCKED' }), '');
    }
    if (options?.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

function networkMessage(err: NodeJS.ErrnoException): HelperError {
  const c = err.code ?? '';
  if (c === 'EBLOCKED') return new HelperError('blocked-url', 'This link points to this computer or to a private network, which is not allowed.', 403);
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return new HelperError('unreachable', 'That website could not be found. Check the link.', 502);
  if (c === 'ETIMEDOUT' || c === 'ESOCKETTIMEDOUT') return new HelperError('timeout', 'The website took too long to answer.', 504);
  if (/CERT|SSL|TLS|SELF_SIGNED/.test(c) || /certificate/i.test(err.message)) {
    return new HelperError('unreachable', 'The website’s security certificate is not valid, so SongSort will not download from it.', 502);
  }
  return new HelperError('unreachable', 'The website could not be reached.', 502);
}

function request(u: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const isTest = TEST_ORIGIN && u.origin === TEST_ORIGIN;
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      u,
      {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'audio/*, application/octet-stream;q=0.9, */*;q=0.5', 'Accept-Encoding': 'identity' },
        ...(isTest ? {} : { lookup: safeLookup as never }),
        signal,
      },
      resolve,
    );
    req.setTimeout(CONNECT_TIMEOUT_MS, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(networkMessage(e as NodeJS.ErrnoException)));
    req.end();
  });
}

function statusMessage(status: number): string {
  if (status === 404 || status === 410) return `The file was not found on the website (error ${status}). The link may be old or mistyped.`;
  if (status === 401 || status === 403) return `The website refused access (error ${status}). It may need you to sign in, or it doesn’t allow downloads.`;
  if (status === 429) return 'The website is receiving too many requests right now (error 429). Try again later.';
  if (status >= 500) return `The website had a problem (error ${status}). Try again later.`;
  return `The website answered with error ${status}.`;
}

function filenameFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* ignore */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  return plain ? (plain[2] ?? plain[1]).trim() : undefined;
}

const AUDIO_PATH = /\.(mp3|aac|m4a|mp4|wav|flac|ogg|oga|opus|wma|aif|aiff)$/i;

async function handleFetch(req: IncomingMessage, res: ServerResponse) {
  const params = new URL(req.url ?? '', 'http://helper').searchParams;
  const expect = params.get('expect');
  if (expect !== 'audio' && expect !== 'page' && expect !== 'auto') throw new HelperError('blocked-url', 'Bad request.');
  let url = checkUrl(params.get('url') ?? '');
  const looksAudio = AUDIO_PATH.test(url.pathname);

  const ac = new AbortController();
  const total = setTimeout(() => ac.abort(), TOTAL_TIMEOUT_MS);
  req.on('close', () => ac.abort()); // the page went away: stop downloading
  try {
    let upstream: IncomingMessage | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      upstream = await request(url, ac.signal);
      const s = upstream.statusCode ?? 0;
      if (s >= 300 && s < 400 && upstream.headers.location) {
        upstream.resume();
        if (hop === MAX_REDIRECTS) throw new HelperError('blocked-url', 'The link redirects too many times.');
        let next: URL;
        try {
          next = new URL(upstream.headers.location, url);
        } catch {
          throw new HelperError('blocked-url', 'The website redirected to an invalid address.');
        }
        try {
          url = checkUrl(next.href);
        } catch (e) {
          throw new HelperError('blocked-url', `The website redirected to an address that isn’t allowed. ${(e as Error).message}`, 403);
        }
        continue;
      }
      break;
    }
    const up = upstream!;
    const status = up.statusCode ?? 0;
    if (status !== 200) {
      up.resume();
      throw new HelperError('http', statusMessage(status), 502);
    }
    const contentType = up.headers['content-type'] ?? null;
    const declared = Number(up.headers['content-length'] || '') || undefined;
    const blocked = blockedContentType(contentType);
    let isPage = expect === 'page' || (expect === 'auto' && !looksAudio && blocked === 'a web page');
    if (blocked && !(isPage && blocked === 'a web page')) {
      up.resume();
      throw new HelperError('rejected', `The website says this file is ${blocked}, not audio.`, 415);
    }
    let limit = isPage ? MAX_PAGE_BYTES : MAX_AUDIO_BYTES;
    if (declared && declared > limit) {
      up.destroy();
      throw new HelperError('too-large', isPage ? 'That web page is too large to read.' : `The file is too large (${Math.round(declared / 1048576)} MB). SongSort accepts songs up to ${MAX_AUDIO_BYTES / 1048576} MB.`, 413);
    }

    up.setTimeout(IDLE_TIMEOUT_MS, () => up.destroy(Object.assign(new Error('idle'), { code: 'ETIMEDOUT' })));

    // Collect the first 64 KB and check what it really is before sending anything on.
    const headChunks: Buffer[] = [];
    let headLen = 0;
    let ended = false;
    await new Promise<void>((resolve, reject) => {
      const onData = (c: Buffer) => {
        headChunks.push(c);
        headLen += c.length;
        if (headLen >= 65536) {
          up.pause();
          cleanup();
          resolve();
        }
      };
      const onEnd = () => {
        ended = true;
        cleanup();
        resolve();
      };
      const onError = (e: Error) => {
        cleanup();
        reject((e as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? new HelperError('timeout', 'The website stopped sending data.', 504) : new HelperError('interrupted', 'The download was interrupted.', 502));
      };
      const cleanup = () => {
        up.off('data', onData);
        up.off('end', onEnd);
        up.off('error', onError);
      };
      up.on('data', onData);
      up.on('end', onEnd);
      up.on('error', onError);
    });
    const head = Buffer.concat(headChunks);
    const kind = sniff(new Uint8Array(head.buffer, head.byteOffset, Math.min(head.length, 65536)));
    if (expect === 'auto' && !looksAudio && kind.type === 'blocked' && /web page/.test(kind.what)) {
      isPage = true;
      limit = MAX_PAGE_BYTES;
    }
    if (isPage) {
      if (!(kind.type === 'blocked' && /web page|XML/.test(kind.what))) {
        up.destroy();
        throw new HelperError('rejected', 'The link did not lead to a web page or an audio file.', 415);
      }
    } else if (kind.type !== 'audio') {
      up.destroy();
      const what =
        kind.type === 'blocked' ? `It is actually ${kind.what}.` : kind.type === 'unsupported' ? `It is ${kind.what}, which SongSort does not support.` : 'Its contents do not match any supported audio format.';
      throw new HelperError('rejected', what, 415);
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Final-Url', url.href);
    if (contentType) res.setHeader('X-Upstream-Type', String(contentType).replace(/[^\x20-\x7e]/g, ''));
    if (declared) res.setHeader('X-Upstream-Length', String(declared));
    const fname = filenameFrom(up.headers['content-disposition']);
    if (fname) res.setHeader('X-Filename', encodeURIComponent(fname));

    let sent = head.length;
    if (sent > limit) {
      up.destroy();
      throw new HelperError('too-large', 'The file is too large.', 413);
    }
    res.write(head);
    if (ended) {
      res.end();
      return;
    }
    await new Promise<void>((resolve) => {
      up.on('data', (c: Buffer) => {
        sent += c.length;
        if (!res.write(c)) {
          up.pause();
          res.once('drain', () => up.resume());
        }
        if (sent > limit) {
          up.destroy();
          res.destroy(); // the page counts bytes too and reports "too large"
          resolve();
        }
      });
      up.on('end', () => {
        res.end();
        resolve();
      });
      up.on('error', () => {
        res.destroy(); // the page reports "interrupted"
        resolve();
      });
      up.resume();
    });
  } finally {
    clearTimeout(total);
  }
}

function allowedCaller(req: IncomingMessage): boolean {
  if (req.headers['x-songsort'] !== '1') return false; // a custom header: other websites can't send it without our consent
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin && req.headers.host && new URL(origin).host !== req.headers.host) return false;
  return true;
}

function middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const path = (req.url ?? '').split('?')[0];
  const base = path.replace(/^.*?\/api\//, '/api/');
  if (!/\/api\/(health|fetch)$/.test(path)) return next();
  if (req.method !== 'GET') return sendError(res, new HelperError('blocked-url', 'Not allowed.', 405));
  if (!allowedCaller(req)) return sendError(res, new HelperError('blocked-url', 'Not allowed.', 403));
  if (base === '/api/health') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ songsort: true }));
    return;
  }
  handleFetch(req, res).catch((err) => {
    sendError(res, err instanceof HelperError ? err : new HelperError('unreachable', 'The download failed.', 502));
  });
}

export function downloadHelper(): Plugin {
  return {
    name: 'songsort-download-helper',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
