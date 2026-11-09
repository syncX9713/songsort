/** A tiny, private log of earlier scans, kept only in this browser (no music, just the numbers). */
export interface ScanSummary {
  at: number;
  source: string;
  files: number;
  totalBytes: number;
  unique: number;
  exactGroups: number;
  extraCopies: number;
  potentialGroups: number;
  savableBytes: number;
}

const KEY = 'songsort.history.v1';
const MAX = 10;

export function loadHistory(): ScanSummary[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as ScanSummary[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveToHistory(s: ScanSummary): ScanSummary[] {
  const list = [s, ...loadHistory()].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable (private mode): history is optional */
  }
  return list;
}

export function clearHistory() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
