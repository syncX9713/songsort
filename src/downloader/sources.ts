/**
 * Legitimate sources, read through their official public APIs (no keys needed, nothing secret in the page).
 */
import { hostProblem } from './address';
import { MAX_AUDIO_BYTES } from './checkFile';
import { isTestOrigin, type Platform } from './links';

/** What we know about where a song comes from. Only facts the source states — nothing invented. */
export interface SourceInfo {
  site: string;
  pageUrl: string;
  title?: string;
  artist?: string;
  album?: string;
  license?: string;
  licenseUrl?: string;
}

/** A downloadable audio file offered by a source. */
export interface Candidate {
  url: string;
  name: string;
  formatHint?: string;
  size?: number;
  duration?: number;
  /** Internet Archive: the file as uploaded (not a copy the Archive made). */
  original?: boolean;
  note?: string;
}

export class SourceError extends Error {}

const AUDIO_EXT = /\.(mp3|aac|m4a|wav|flac|ogg|oga|opus|wma|aif|aiff)$/i;

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    throw new SourceError('The website could not be reached. Check your internet connection.');
  }
  if (!r.ok) throw new SourceError(`The website answered with error ${r.status}.`);
  return r.json();
}

const LICENSES: [RegExp, string][] = [
  [/publicdomain\/zero/, 'CC0 (public domain)'],
  [/publicdomain\/mark/, 'Public domain'],
  [/licenses\/by-nc-nd/, 'CC BY-NC-ND'],
  [/licenses\/by-nc-sa/, 'CC BY-NC-SA'],
  [/licenses\/by-nc/, 'CC BY-NC'],
  [/licenses\/by-nd/, 'CC BY-ND'],
  [/licenses\/by-sa/, 'CC BY-SA'],
  [/licenses\/by\//, 'CC BY'],
];
const licenseName = (u?: string) => (u ? (LICENSES.find(([re]) => re.test(u))?.[1] ?? 'See license') : undefined);

function parseLength(v: unknown): number | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const s = String(v);
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  return parts.reduce((a, n) => a * 60 + n, 0);
}

/* ------------------------------------------------------------------ */
/* Internet Archive                                                    */
/* ------------------------------------------------------------------ */

interface IAFile {
  name: string;
  source?: string;
  format?: string;
  size?: string;
  length?: string;
  title?: string;
  creator?: string;
  album?: string;
  private?: string;
}

export async function loadArchive(id: string, file: string | undefined, signal: AbortSignal): Promise<{ info: SourceInfo; candidates: Candidate[] }> {
  const meta = (await getJson(`https://archive.org/metadata/${encodeURIComponent(id)}`, signal)) as {
    server?: string;
    dir?: string;
    is_dark?: boolean;
    files?: IAFile[];
    metadata?: Record<string, unknown>;
  };
  if (!meta.files || !meta.metadata) throw new SourceError('This Internet Archive item was not found.');
  if (meta.is_dark || String(meta.metadata['access-restricted-item']) === 'true') {
    throw new SourceError('This Internet Archive item can only be borrowed, not downloaded.');
  }
  const str = (v: unknown) => (Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : undefined);
  const info: SourceInfo = {
    site: 'Internet Archive',
    pageUrl: `https://archive.org/details/${encodeURIComponent(id)}`,
    title: str(meta.metadata.title),
    artist: str(meta.metadata.creator),
    license: licenseName(str(meta.metadata.licenseurl)),
    licenseUrl: str(meta.metadata.licenseurl),
  };
  // The Archive's own file server (from its API), so no redirects are needed.
  const server = meta.server && /^[a-z0-9.-]+\.archive\.org$/i.test(meta.server) && meta.dir?.startsWith('/') ? `https://${meta.server}${meta.dir}` : null;
  const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
  let files = meta.files.filter((f) => AUDIO_EXT.test(f.name) && f.private !== 'true');
  if (file) files = files.filter((f) => f.name === file);
  const candidates: Candidate[] = files
    .map((f) => {
      const size = f.size ? Number(f.size) : undefined;
      return {
        url: server ? `${server}/${encodePath(f.name)}` : `https://archive.org/download/${encodeURIComponent(id)}/${encodePath(f.name)}`,
        name: f.name.split('/').pop()!,
        formatHint: f.format,
        size,
        duration: parseLength(f.length),
        original: f.source === 'original',
        note: size && size > MAX_AUDIO_BYTES ? 'Too large for SongSort' : f.source === 'original' ? 'Original upload' : 'Copy made by the Internet Archive',
      };
    })
    .sort((a, b) => Number(b.original) - Number(a.original) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!candidates.length) throw new SourceError(file ? 'That file is not part of this Internet Archive item, or it is not audio.' : 'This Internet Archive item has no downloadable audio files.');
  return { info, candidates };
}

/* ------------------------------------------------------------------ */
/* Wikimedia Commons                                                   */
/* ------------------------------------------------------------------ */

/** Commons returns some fields as HTML. Read only the text (DOMParser never runs scripts). */
function textOf(html: unknown): string | undefined {
  if (typeof html !== 'string') return undefined;
  const t = new DOMParser().parseFromString(html, 'text/html').body.textContent?.replace(/\s+/g, ' ').trim();
  return t || undefined;
}

export async function loadCommons(title: string, signal: AbortSignal): Promise<{ info: SourceInfo; candidates: Candidate[] }> {
  const api = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url|size|mime|extmetadata&format=json&origin=*`;
  const j = (await getJson(api, signal)) as { query?: { pages?: Record<string, { missing?: string; imageinfo?: { url: string; size: number; mime: string; extmetadata?: Record<string, { value: unknown }> }[] }> } };
  const page = Object.values(j.query?.pages ?? {})[0];
  const ii = page?.imageinfo?.[0];
  if (!page || page.missing !== undefined || !ii) throw new SourceError('This Wikimedia Commons file was not found.');
  let fileUrl: URL;
  try {
    fileUrl = new URL(ii.url);
  } catch {
    throw new SourceError('Wikimedia Commons returned an invalid file address.');
  }
  if (fileUrl.protocol !== 'https:' || fileUrl.hostname !== 'upload.wikimedia.org') throw new SourceError('Wikimedia Commons returned an unexpected file address.');
  fileUrl.search = '';
  const em = ii.extmetadata ?? {};
  const info: SourceInfo = {
    site: 'Wikimedia Commons',
    pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
    title: textOf(em.ObjectName?.value),
    artist: textOf(em.Artist?.value),
    license: textOf(em.LicenseShortName?.value),
    licenseUrl: textOf(em.LicenseUrl?.value),
  };
  return {
    info,
    candidates: [{ url: fileUrl.href, name: decodeURIComponent(fileUrl.pathname.split('/').pop()!), size: ii.size, original: true, note: 'Original upload' }],
  };
}

/* ------------------------------------------------------------------ */
/* Web pages that offer downloads (artist sites, free music libraries)  */
/* ------------------------------------------------------------------ */

export function audioLinksFromPage(html: string, pageUrl: string): Candidate[] {
  const doc = new DOMParser().parseFromString(html, 'text/html'); // parsed only; never displayed or run
  const baseHref = doc.querySelector('base[href]')?.getAttribute('href');
  let base: URL;
  try {
    base = new URL(baseHref ?? '', pageUrl);
  } catch {
    base = new URL(pageUrl);
  }
  const found = new Map<string, Candidate>();
  const add = (raw: string | null, label: string | null | undefined, isAudioElement: boolean) => {
    if (!raw || found.size >= 50) return;
    let u: URL;
    try {
      u = new URL(raw, base);
    } catch {
      return;
    }
    if (!isTestOrigin(u) && (u.protocol !== 'https:' || hostProblem(u.hostname) || u.username || (u.port && u.port !== '443'))) return;
    if (!isAudioElement && !AUDIO_EXT.test(u.pathname)) return;
    u.hash = '';
    if (found.has(u.href)) return;
    const fileName = decodeURIComponent(u.pathname.split('/').pop() || 'audio');
    const text = label?.replace(/\s+/g, ' ').trim();
    found.set(u.href, { url: u.href, name: fileName, note: text && text !== fileName ? text.slice(0, 120) : undefined });
  };
  doc.querySelectorAll('a[href]').forEach((a) => add(a.getAttribute('href'), a.textContent, false));
  doc.querySelectorAll('audio[src]').forEach((a) => add(a.getAttribute('src'), a.getAttribute('title'), true));
  doc.querySelectorAll('audio source[src], source[type^="audio/"]').forEach((s) => add(s.getAttribute('src'), null, true));
  return [...found.values()];
}

export function pageTitle(html: string): string | undefined {
  const t = new DOMParser().parseFromString(html, 'text/html').title.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 200) : undefined;
}

/* ------------------------------------------------------------------ */
/* Streaming platforms: identify the song, link to official options     */
/* ------------------------------------------------------------------ */

export interface PlatformResult {
  platform: Platform;
  url: string;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  /** Official store page where the song can be bought, when known. */
  buyUrl?: string;
  buyLabel?: string;
  /** Official short preview provided by the platform for this purpose (Apple). */
  previewUrl?: string;
  /** What the title/artist really are on this platform (e.g. a YouTube video title and channel). */
  titleLabel?: string;
  artistLabel?: string;
}

async function oembed(endpoint: string, signal: AbortSignal): Promise<{ title?: string; author_name?: string } | null> {
  try {
    return (await getJson(endpoint, signal)) as { title?: string; author_name?: string };
  } catch {
    return null;
  }
}

export async function loadPlatform(platform: Platform, url: URL, signal: AbortSignal): Promise<PlatformResult> {
  const r: PlatformResult = { platform, url: url.href };
  const host = url.hostname.replace(/^(www|m)\./, '');
  const enc = encodeURIComponent(url.href);
  if (/youtube\.com|youtu\.be/.test(host)) {
    const o = await oembed(`https://www.youtube.com/oembed?url=${enc}&format=json`, signal);
    if (o) {
      r.title = o.title;
      r.artist = o.author_name;
      r.titleLabel = 'Video title';
      r.artistLabel = 'Channel';
    }
  } else if (/spotify/.test(host)) {
    const o = await oembed(`https://open.spotify.com/oembed?url=${enc}`, signal);
    if (o) r.title = o.title;
  } else if (/soundcloud/.test(host)) {
    const o = await oembed(`https://soundcloud.com/oembed?format=json&url=${enc}`, signal);
    if (o) {
      r.title = o.title;
      r.artist = o.author_name;
      r.titleLabel = 'Title';
      r.artistLabel = 'Uploaded by';
    }
  } else if (/apple\.com/.test(host)) {
    const trackId = url.searchParams.get('i') ?? /\/song\/[^/]+\/(\d+)/.exec(url.pathname)?.[1] ?? null;
    const country = /^\/([a-z]{2})\//.exec(url.pathname)?.[1] ?? 'us';
    if (trackId && /^\d+$/.test(trackId)) {
      try {
        const j = (await getJson(`https://itunes.apple.com/lookup?id=${trackId}&country=${country}&entity=song`, signal)) as {
          results?: { kind?: string; trackName?: string; artistName?: string; collectionName?: string; trackTimeMillis?: number; previewUrl?: string; trackViewUrl?: string; trackPrice?: number; currency?: string }[];
        };
        const song = j.results?.find((x) => x.kind === 'song');
        if (song) {
          r.title = song.trackName;
          r.artist = song.artistName;
          r.album = song.collectionName;
          r.duration = song.trackTimeMillis ? song.trackTimeMillis / 1000 : undefined;
          if (song.previewUrl?.startsWith('https://')) r.previewUrl = song.previewUrl;
          if (song.trackViewUrl?.startsWith('https://')) {
            const buy = new URL(song.trackViewUrl);
            buy.searchParams.set('app', 'itunes');
            r.buyUrl = buy.href;
            r.buyLabel = song.trackPrice && song.trackPrice > 0 ? `Buy on the iTunes Store (${song.trackPrice} ${song.currency ?? ''})`.trim() : 'View on the iTunes Store';
          }
        }
      } catch {
        /* details are optional */
      }
    }
  }
  return r;
}

/** Search pages on official stores, so the user can buy a legitimate download. */
export function storeSearchLinks(query: string): { label: string; url: string }[] {
  const q = encodeURIComponent(query);
  return [
    { label: 'Search on Bandcamp', url: `https://bandcamp.com/search?q=${q}&item_type=t` },
    { label: 'Search on the iTunes Store', url: `https://music.apple.com/search?term=${q}` },
    { label: 'Search on Amazon Music (MP3 store)', url: `https://www.amazon.com/s?k=${q}&i=digital-music` },
  ];
}
