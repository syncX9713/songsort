import type { ExactGroup, PotentialGroup, ScannedFile, ScanResult, SongKey, UnreadableFile } from './types';

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

/** Lower-case, strip accents and punctuation, collapse spaces. "Café & Co." -> "cafe and co" */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Best guess at a song name from a file name, used only when the file has no title tag.
 * "01 - Tere Liye (1).mp3" -> "Tere Liye"
 */
export function titleFromFileName(fileName: string): string {
  let base = fileName.replace(/\.[^.]+$/, '');
  base = base.replace(/^copy of\s+/i, '');
  // Remove copy markers that file managers add: "(1)", "[2]", " - Copy", " copy (3)", "_1"
  let prev = '';
  while (prev !== base) {
    prev = base;
    base = base
      .replace(/\s*\(\d{1,3}\)\s*$/, '')
      .replace(/\s*\[\d{1,3}\]\s*$/, '')
      .replace(/[\s_-]+copy(\s*\(\d{1,3}\))?\s*$/i, '')
      .replace(/_\d{1,2}\s*$/, '');
  }
  // Remove a leading track number: "01 ", "01. ", "01 - ", "07_", "01Song"
  base = base.replace(/^\d{1,3}(\s*[-._)]\s*|\s+|(?=[^\d\s]))/, '');
  base = base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return base || fileName;
}

const GENERIC_TITLE = /^(track|audio track|piste|pista|titel|untitled|unknown|no title|new recording)?\s*\d*$/;
const GENERIC_ARTIST = new Set(['', 'unknown', 'unknown artist', 'various', 'various artists', 'va', 'artist']);

const WEBSITE = /(www\.|https?:|\.(com|net|org|pk|in|info|biz|me|cc)\b)/i;

/** Title tags that are clearly not a song name: empty/generic, a website, or the same text as the artist tag. */
function isPlaceholderTitle(f: ScannedFile): boolean {
  const raw = f.meta.title;
  if (!raw) return true;
  const t = normalizeText(raw);
  if (t.length < 2 || GENERIC_TITLE.test(t) || WEBSITE.test(raw)) return true;
  return !!f.meta.artist && normalizeText(f.meta.artist) === t;
}

/** How many files may share one title tag before we suspect it is a ripper's or uploader's watermark. */
const SHARED_TITLE_LIMIT = 4;

/**
 * Decide, per file, whether the title tag can be trusted. Untrustworthy titles fall back to the file name.
 * Catches collections where every file was tagged with the same text (e.g. a website or uploader name).
 */
function resolveTitles(files: ScannedFile[]) {
  const useFileName = (f: ScannedFile) => {
    f.titleFromFileName = true;
    f.displayTitle = titleFromFileName(f.name);
  };
  const byTitle = new Map<string, ScannedFile[]>();
  for (const f of files) {
    if (isPlaceholderTitle(f)) {
      useFileName(f);
      continue;
    }
    f.titleFromFileName = false;
    f.displayTitle = f.meta.title!;
    const k = normalizeText(f.meta.title!);
    const list = byTitle.get(k);
    if (list) list.push(f);
    else byTitle.set(k, [f]);
  }
  for (const list of byTitle.values()) {
    if (list.length < SHARED_TITLE_LIMIT) continue;
    // Real copies of one song tend to have similar file names; a watermark spans many unrelated names.
    const names = new Set(list.map((f) => normalizeText(titleFromFileName(f.name))));
    if (names.size >= list.length * 0.75) list.forEach(useFileName);
  }
}

/** Copies whose names look like "(1)", "Copy", "_1" are less likely to be the original. */
function looksLikeCopy(name: string): boolean {
  const base = name.replace(/\.[^.]+$/, '');
  return /\(\d{1,3}\)\s*$|\[\d{1,3}\]\s*$|copy(\s*\(\d+\))?\s*$|^copy of |_\d{1,2}\s*$/i.test(base);
}

export function songKeyForFile(fileId: number, exactGroupOfFile: Map<number, ExactGroup>): SongKey {
  const g = exactGroupOfFile.get(fileId);
  return g ? `x:${g.id}` : `f:${fileId}`;
}

/** Preferred order for keeping: higher quality first, then the copy that does not look like a copy. */
function qualityScore(f: ScannedFile): number {
  let score = 0;
  if (f.meta.lossless || ['flac', 'wav', 'aif', 'aiff'].includes(f.ext)) score += 1_000_000;
  score += (f.meta.bitrate ?? 0) * 100;
  score += f.size / 1_000_000; // tie-breaker: bigger file
  return score;
}

function chooseDefaultCopy(files: ScannedFile[]): number {
  const sorted = [...files].sort((a, b) => {
    const ca = looksLikeCopy(a.name) ? 1 : 0;
    const cb = looksLikeCopy(b.name) ? 1 : 0;
    if (ca !== cb) return ca - cb;
    const da = a.path.split('/').length;
    const db = b.path.split('/').length;
    if (da !== db) return da - db;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.path.localeCompare(b.path);
  });
  return sorted[0].id;
}

/* ------------------------------------------------------------------ */
/* Union-find                                                          */
/* ------------------------------------------------------------------ */

class DisjointSet {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/* ------------------------------------------------------------------ */
/* Main analysis                                                       */
/* ------------------------------------------------------------------ */

/** Songs whose lengths differ by more than this are treated as different versions (e.g. live vs studio). */
const DURATION_TOLERANCE_SECONDS = 6;

interface Song {
  key: SongKey;
  rep: ScannedFile;
  fileIds: number[];
}

export function analyze(
  files: ScannedFile[],
  unreadable: UnreadableFile[],
  sourceLabel: string,
  hashedCount: number,
): ScanResult {
  const filesById = new Map(files.map((f) => [f.id, f]));
  resolveTitles(files);

  /* ---- Level 1: exact duplicates (identical SHA-256) ---- */
  const byHash = new Map<string, ScannedFile[]>();
  for (const f of files) {
    if (!f.hash) continue;
    const list = byHash.get(f.hash);
    if (list) list.push(f);
    else byHash.set(f.hash, [f]);
  }
  const exactGroups: ExactGroup[] = [];
  const exactGroupOfFile = new Map<number, ExactGroup>();
  let n = 0;
  for (const [hash, list] of byHash) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.path.localeCompare(b.path));
    const g: ExactGroup = { id: `e${++n}`, hash, fileIds: list.map((f) => f.id), defaultKeep: chooseDefaultCopy(list) };
    exactGroups.push(g);
    for (const f of list) exactGroupOfFile.set(f.id, g);
  }

  /* ---- Collapse exact copies into "songs" ---- */
  const songs: Song[] = [];
  const seenGroups = new Set<string>();
  for (const f of files) {
    const g = exactGroupOfFile.get(f.id);
    if (g) {
      if (seenGroups.has(g.id)) continue;
      seenGroups.add(g.id);
      songs.push({ key: `x:${g.id}`, rep: filesById.get(g.defaultKeep)!, fileIds: g.fileIds });
    } else {
      songs.push({ key: `f:${f.id}`, rep: f, fileIds: [f.id] });
    }
  }

  /* ---- Level 2: potential duplicates (same song details, different content) ---- */
  const ds = new DisjointSet(songs.length);
  const strongBuckets = new Map<string, number[]>(); // title + artist
  const titleBuckets = new Map<string, { idx: number; strong: boolean }[]>();

  songs.forEach((s, idx) => {
    const title = normalizeText(matchTitle(s.rep));
    if (title.length < 2 || GENERIC_TITLE.test(title)) return; // too vague to compare
    const artistRaw = s.rep.meta.artist ? normalizeText(s.rep.meta.artist) : '';
    const strong = !s.rep.titleFromFileName && !GENERIC_ARTIST.has(artistRaw);
    if (strong) {
      const k = `${title}|${artistRaw}`;
      const b = strongBuckets.get(k);
      if (b) b.push(idx);
      else strongBuckets.set(k, [idx]);
    }
    const tb = titleBuckets.get(title);
    if (tb) tb.push({ idx, strong });
    else titleBuckets.set(title, [{ idx, strong }]);
  });

  for (const members of strongBuckets.values()) {
    for (let i = 1; i < members.length; i++) ds.union(members[0], members[i]);
  }
  // Files without an artist (or without tags at all) match anything with the same title.
  for (const members of titleBuckets.values()) {
    const weak = members.filter((m) => !m.strong);
    if (weak.length === 0) continue;
    for (const m of members) if (m.idx !== weak[0].idx) ds.union(weak[0].idx, m.idx);
  }
  linkSimilarNames(songs, ds);

  const components = new Map<number, number[]>();
  songs.forEach((_, idx) => {
    const root = ds.find(idx);
    const c = components.get(root);
    if (c) c.push(idx);
    else components.set(root, [idx]);
  });

  const potentialGroups: PotentialGroup[] = [];
  let p = 0;
  for (const members of components.values()) {
    if (members.length < 2) continue;
    for (const cluster of splitByDuration(members.map((i) => songs[i]))) {
      if (cluster.length < 2) continue;
      const best = [...cluster].sort((a, b) => qualityScore(b.rep) - qualityScore(a.rep))[0];
      potentialGroups.push({
        id: `p${++p}`,
        songKeys: cluster.map((s) => s.key),
        reasons: describeMatch(cluster.map((s) => s.rep)),
        suggestedKeep: best.key,
      });
    }
  }

  /* ---- Unique: no duplicate of any kind ---- */
  const inPotential = new Set(potentialGroups.flatMap((g) => g.songKeys));
  const uniqueIds = files
    .filter((f) => !exactGroupOfFile.has(f.id) && !inPotential.has(`f:${f.id}`))
    .map((f) => f.id);

  return {
    sourceLabel,
    scannedAt: Date.now(),
    files,
    filesById,
    exactGroups,
    potentialGroups,
    uniqueIds,
    unreadable,
    hashedCount,
  };
}

/* ------------------------------------------------------------------ */
/* Similar-name matching                                               */
/* ------------------------------------------------------------------ */

/**
 * The song-name part of a file name. Many collections name files "FILM = SONG":
 * "07 MOHRA = SUBAH SE LEKAR.mp3" -> "SUBAH SE LEKAR"; "08 KABHI KABHI = TITLE SONG.mp3" -> "KABHI KABHI".
 */
export function songNameFromFileName(fileName: string): string {
  const t = titleFromFileName(fileName);
  const i = t.lastIndexOf('=');
  if (i < 0) return t;
  const before = t.slice(0, i).trim();
  const after = t.slice(i + 1).trim();
  if (!after) return before || t;
  if (before && /^title\s*(song|track|music)?$/i.test(after)) return before;
  return after;
}

/** The name used for matching: the title tag when it can be trusted, otherwise the song part of the file name. */
function matchTitle(f: ScannedFile): string {
  return f.titleFromFileName ? songNameFromFileName(f.name) : f.meta.title!;
}

/**
 * A spelling-insensitive "skeleton" of a word, so different romanizations line up:
 * mein/main -> "mn", keh/kahe -> "k", phoolon/phoolo -> "fln"/"fl", milke/milkar -> "mlk"/"mlkr".
 */
function skeleton(word: string): string {
  return word
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/q/g, 'k')
    .replace(/w/g, 'v')
    .replace(/z/g, 'j')
    .replace(/[aeiouyh]/g, '')
    .replace(/(.)\1+/g, '$1');
}

interface Word { raw: string; sk: string }

function wordsOf(title: string): Word[] {
  return normalizeText(title)
    .split(' ')
    .filter((w) => w.length > 1) // drop stray letters such as the "s" in "song!!s"
    .map((raw) => ({ raw, sk: skeleton(raw) }));
}

function wordsMatch(a: Word, b: Word): boolean {
  if (a.sk === b.sk) return true;
  const [s, l] = a.sk.length < b.sk.length ? [a.sk, b.sk] : [b.sk, a.sk];
  return s.length >= 2 && l.length === s.length + 1 && l.startsWith(s); // milke ~ milkar, phoolo ~ phoolon
}

/** Nearly all words of the shorter name appear (spelled loosely) in the longer one. */
function similarNames(a: Word[], b: Word[]): boolean {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length < 2) return false;
  const used = new Array<boolean>(l.length).fill(false);
  let matched = 0;
  let meaningful = false;
  for (const w of s) {
    const j = l.findIndex((u, k) => !used[k] && wordsMatch(w, u));
    if (j < 0) continue;
    used[j] = true;
    matched++;
    if (w.raw.length >= 4) meaningful = true; // not just short filler words like "ki", "na", "jo"
  }
  return meaningful && matched >= 2 && matched / s.length >= 0.8 && matched / l.length >= 0.5;
}

/** Similar names only count when the lengths are this close, because the names alone are a weaker signal. */
const SIMILAR_NAME_SECONDS = 2;

/**
 * Link songs whose names are spelled differently but clearly similar, and whose lengths are nearly identical.
 * Only used when at least one file has no trustworthy title tag (well-tagged files are compared by their tags).
 */
function linkSimilarNames(songs: Song[], ds: DisjointSet) {
  const items = songs
    .map((s, idx) => ({
      idx,
      weak: s.rep.titleFromFileName,
      dur: s.rep.meta.duration,
      words: wordsOf(matchTitle(s.rep)),
    }))
    .filter((x): x is typeof x & { dur: number } => x.dur !== undefined && x.words.length >= 2)
    .sort((a, b) => a.dur - b.dur);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length && items[j].dur - items[i].dur <= SIMILAR_NAME_SECONDS; j++) {
      const a = items[i];
      const b = items[j];
      if (!a.weak && !b.weak) continue;
      if (ds.find(a.idx) === ds.find(b.idx)) continue;
      if (similarNames(a.words, b.words)) ds.union(a.idx, b.idx);
    }
  }
}

function splitByDuration(songs: Song[]): Song[][] {
  const known = songs.filter((s) => s.rep.meta.duration !== undefined).sort((a, b) => a.rep.meta.duration! - b.rep.meta.duration!);
  const unknown = songs.filter((s) => s.rep.meta.duration === undefined);
  if (known.length === 0) return [unknown];
  const clusters: Song[][] = [[known[0]]];
  for (let i = 1; i < known.length; i++) {
    const prev = known[i - 1].rep.meta.duration!;
    if (known[i].rep.meta.duration! - prev > DURATION_TOLERANCE_SECONDS) clusters.push([known[i]]);
    else clusters[clusters.length - 1].push(known[i]);
  }
  if (unknown.length > 0) {
    clusters.sort((a, b) => b.length - a.length);
    clusters[0].push(...unknown);
  }
  return clusters;
}

function describeMatch(reps: ScannedFile[]): string[] {
  const reasons: string[] = [];
  const byFileName = reps.some((r) => r.titleFromFileName);
  const names = new Set(reps.map((r) => normalizeText(matchTitle(r))));
  if (names.size > 1) {
    reasons.push(
      byFileName
        ? 'Similar song names in the file names, spelled differently — check carefully.'
        : 'Similar song titles, spelled differently — check carefully.',
    );
  } else if (byFileName) {
    reasons.push('Matched by file name, because some files have no usable song name stored inside them.');
  } else {
    reasons.push('Same song title.');
  }

  const artists = reps.map((r) => (r.meta.artist ? normalizeText(r.meta.artist) : ''));
  const namedArtists = new Set(artists.filter(Boolean));
  if (namedArtists.size === 1 && artists.every(Boolean)) reasons.push('Same artist.');
  else if (namedArtists.size > 1) reasons.push('Different artist names are listed — check carefully.');
  else if (namedArtists.size === 1) reasons.push('Artist is missing on some files.');

  const durations = reps.map((r) => r.meta.duration).filter((d): d is number => d !== undefined);
  if (durations.length === reps.length) {
    const diff = Math.max(...durations) - Math.min(...durations);
    reasons.push(diff < 1.5 ? 'Same length.' : `Lengths differ by about ${Math.round(diff)} seconds.`);
  } else {
    reasons.push('Length is unknown for some files.');
  }

  const albums = new Set(reps.map((r) => (r.meta.album ? normalizeText(r.meta.album) : '')));
  if (albums.size === 1 && !albums.has('')) reasons.push('Same album.');
  else if (albums.size > 1 && !albums.has('')) reasons.push('Different albums.');

  const formats = [...new Set(reps.map((r) => r.ext.toUpperCase()))];
  reasons.push(formats.length === 1 ? `Same format (${formats[0]}).` : `Different formats: ${formats.join(', ')}.`);
  reasons.push('The files are not identical copies (their contents differ).');
  return reasons;
}
