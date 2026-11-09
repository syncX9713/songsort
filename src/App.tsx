import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Downloader } from './components/Downloader';
import { Home } from './components/Home';
import { Organize } from './components/Organize';
import { PastScan } from './components/PastScan';
import { Results } from './components/Results';
import { Scanning } from './components/Scanning';
import { Icon } from './components/ui';
import { errorMessage } from './lib/format';
import {
  clearScans,
  deleteScan,
  getScanHandles,
  listScans,
  markOrganized,
  regainAccess,
  saveScan,
  storageAvailable,
  type ScanSummary,
} from './lib/history';
import { buildPlan, type OrganizeReport } from './lib/organize';
import { scanFiles, type ScanProgress } from './lib/scan';
import {
  describePickerError,
  emptySelection,
  fromDirectoryHandle,
  fromFileList,
  fromPathEntries,
  mergeSelections,
  type Selection,
} from './lib/select';
import type { Decisions, ScanResult } from './lib/types';

type Stage = 'home' | 'scanning' | 'results' | 'past' | 'download';
const noDecisions = (): Decisions => ({ exactKeep: {}, potential: {} });

export default function App() {
  const [stage, setStage] = useState<Stage>('home');
  const [selection, setSelection] = useState<Selection>(emptySelection);
  /** Folders picked with the File System Access API, kept so the scan can be repeated later. */
  const [folderHandles, setFolderHandles] = useState<FileSystemDirectoryHandle[]>([]);
  /** True once anything was added that cannot be re-opened later (individual files, classic folder input). */
  const [hasOtherSources, setHasOtherSources] = useState(false);
  const [listing, setListing] = useState<{ found: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [decisions, setDecisions] = useState<Decisions>(noDecisions);
  const [organizing, setOrganizing] = useState(false);
  const [history, setHistory] = useState<ScanSummary[] | null>(null);
  const [historyAvailable, setHistoryAvailable] = useState(true);
  const [currentScanId, setCurrentScanId] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [rescanBusy, setRescanBusy] = useState(false);
  const [downloadLink, setDownloadLink] = useState<{ url: string; n: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const plan = useMemo(() => (result ? buildPlan(result, decisions) : []), [result, decisions]);

  const refreshHistory = useCallback(async () => setHistory(await listScans()), []);

  useEffect(() => {
    storageAvailable().then(setHistoryAvailable);
    refreshHistory();
  }, [refreshHistory]);

  const addSelection = useCallback((s: Selection) => {
    setError(null);
    setSelection((prev) => mergeSelections(prev, s));
  }, []);

  const resetSelection = () => {
    setSelection(emptySelection());
    setFolderHandles([]);
    setHasOtherSources(false);
  };

  /* ---- choosing music ---- */

  const loadFolders = useCallback(
    async (handles: FileSystemDirectoryHandle[]) => {
      const ac = new AbortController();
      abortRef.current = ac;
      setListing({ found: 0 });
      let found = 0;
      try {
        for (const handle of handles) {
          try {
            const sel = await fromDirectoryHandle(handle, (n) => setListing({ found: found + n }), ac.signal);
            found += sel.files.length;
            addSelection(sel);
            setFolderHandles((prev) => (prev.includes(handle) ? prev : [...prev, handle]));
          } catch (err) {
            if (ac.signal.aborted) return;
            setError(
              `Could not open “${handle.name}”: ${errorMessage(err)} If it is on a USB or external drive, connect the drive and try again.`,
            );
          }
        }
      } finally {
        setListing(null);
      }
    },
    [addSelection],
  );

  const pickDirectory = async () => {
    setError(null);
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await window.showDirectoryPicker!({ id: 'songsort-source', mode: 'read' });
    } catch (err) {
      const msg = describePickerError(err);
      if (msg) setError(msg);
      return;
    }
    await loadFolders([handle]);
  };

  const onFiles = (files: FileList) => {
    setHasOtherSources(true);
    addSelection(fromFileList(files));
  };

  // Development-only hooks so automated tests can feed files and folders without the native pickers.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__songsort = {
      addFiles: (entries: { file: File; path: string }[], label: string) => {
        setHasOtherSources(true);
        addSelection(fromPathEntries(entries, label));
      },
      addFolder: (handle: FileSystemDirectoryHandle) => loadFolders([handle]),
    };
  }, [addSelection, loadFolders]);

  /* ---- scanning ---- */

  const startScan = async () => {
    const ac = new AbortController();
    abortRef.current = ac;
    setError(null);
    setProgress(null);
    setStage('scanning');
    const label = selection.labels.join(', ') || 'Selected music';
    try {
      const res = await scanFiles(selection.files, label, setProgress, ac.signal);
      const dec = noDecisions();
      setResult(res);
      setDecisions(dec);
      setStage('results');
      window.scrollTo({ top: 0 });
      const reopenable = !hasOtherSources && folderHandles.length > 0 ? folderHandles : null;
      setCurrentScanId(await saveScan(res, dec, reopenable));
      refreshHistory();
    } catch (err) {
      setStage('home');
      if (!ac.signal.aborted) setError(`The scan stopped: ${errorMessage(err)}`);
    }
  };

  const onOrganized = async (report: OrganizeReport, where: string) => {
    if (!currentScanId) return;
    await markOrganized(currentScanId, {
      at: Date.now(),
      mode: report.mode,
      where,
      copied: report.copied,
      failed: report.failed.length,
      counts: report.counts,
    });
    refreshHistory();
  };

  const newScan = () => {
    const touched = Object.keys(decisions.exactKeep).length + Object.keys(decisions.potential).length > 0;
    if (touched && !window.confirm('Start a new scan? Your choices for this scan will be lost.')) return;
    setResult(null);
    setDecisions(noDecisions());
    setCurrentScanId(null);
    resetSelection();
    setStage('home');
  };

  /* ---- previous scans ---- */

  const viewScan = (id: string) => {
    setViewingId(id);
    setStage('past');
    window.scrollTo({ top: 0 });
  };

  const rescan = async (id: string) => {
    setError(null);
    setRescanBusy(true);
    try {
      const handles = await getScanHandles(id);
      if (!handles?.length) {
        setError('This scan cannot be repeated automatically. Please select the music again.');
        setStage('home');
        return;
      }
      let allowed: FileSystemDirectoryHandle[];
      try {
        allowed = await regainAccess(handles);
      } catch (err) {
        allowed = [];
        setError(`The browser did not reopen the folder: ${errorMessage(err)}`);
      }
      resetSelection();
      setResult(null);
      setStage('home');
      window.scrollTo({ top: 0 });
      if (allowed.length === 0) {
        setError((e) => e ?? 'Access to the folder was not allowed, so it could not be scanned again.');
        return;
      }
      await loadFolders(allowed);
    } finally {
      setRescanBusy(false);
    }
  };

  const removeScan = async (id: string) => {
    if (!window.confirm('Delete this saved report? Your music files are not affected.')) return;
    await deleteScan(id);
    if (currentScanId === id) setCurrentScanId(null);
    await refreshHistory();
    if (stage === 'past') setStage(result ? 'results' : 'home');
  };

  const clearAll = async () => {
    if (!window.confirm('Delete all saved scan reports? Your music files are not affected.')) return;
    await clearScans();
    setCurrentScanId(null);
    refreshHistory();
  };

  const goHome = () => {
    if (stage === 'results') newScan();
    else if (stage === 'past' || stage === 'download') setStage(result ? 'results' : 'home');
  };

  const viewing = history?.find((h) => h.id === viewingId) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="brand" onClick={goHome} disabled={stage === 'home' || stage === 'scanning'} aria-label="SongSort home">
          <span className="brand-mark"><Icon name="music" size={20} /></span>
          <span className="brand-name">SongSort</span>
        </button>
        <span className="topbar-note"><Icon name="shield" size={16} /> Works offline on your device</span>
      </header>

      <main className="main">
        {stage === 'home' && (
          <Home
            selection={selection}
            listing={listing}
            error={error}
            history={history}
            historyAvailable={historyAvailable}
            rescanBusy={rescanBusy}
            onPickDirectory={pickDirectory}
            onFiles={onFiles}
            onCancelListing={() => abortRef.current?.abort()}
            onClear={() => {
              resetSelection();
              setError(null);
            }}
            onScan={startScan}
            onClearHistory={clearAll}
            onViewScan={viewScan}
            onRescan={rescan}
            onDownloadLink={(url) => {
              setDownloadLink((d) => ({ url, n: (d?.n ?? 0) + 1 }));
              setStage('download');
              window.scrollTo({ top: 0 });
            }}
          />
        )}
        {stage === 'download' && (
          <Downloader key={downloadLink?.n ?? 0} initialUrl={downloadLink?.url} onBack={() => setStage(result ? 'results' : 'home')} />
        )}
        {stage === 'scanning' && (
          <Scanning progress={progress} total={selection.files.length} onCancel={() => abortRef.current?.abort()} />
        )}
        {stage === 'results' && result && (
          <Results
            result={result}
            decisions={decisions}
            plan={plan}
            onDecisions={setDecisions}
            onOrganize={() => setOrganizing(true)}
            onNewScan={newScan}
          />
        )}
        {stage === 'past' && viewing && (
          <PastScan
            key={viewing.id}
            summary={viewing}
            rescanBusy={rescanBusy}
            onBack={() => setStage(result ? 'results' : 'home')}
            onRescan={() => rescan(viewing.id)}
            onDelete={() => removeScan(viewing.id)}
          />
        )}
      </main>

      {organizing && result && <Organize plan={plan} onClose={() => setOrganizing(false)} onFinished={onOrganized} />}

      <footer className="footer">SongSort runs entirely in your browser. No uploads, no accounts, nothing deleted.</footer>
    </div>
  );
}
