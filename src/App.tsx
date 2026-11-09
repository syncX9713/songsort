import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Home } from './components/Home';
import { Organize } from './components/Organize';
import { Results } from './components/Results';
import { Scanning } from './components/Scanning';
import { Icon } from './components/ui';
import { errorMessage } from './lib/format';
import { clearHistory, loadHistory, saveToHistory, type ScanSummary } from './lib/history';
import { buildPlan, summarizePlan } from './lib/organize';
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
import { FOLDER_DUPLICATES, type Decisions, type ScanResult } from './lib/types';

type Stage = 'home' | 'scanning' | 'results';
const noDecisions = (): Decisions => ({ exactKeep: {}, potential: {} });

export default function App() {
  const [stage, setStage] = useState<Stage>('home');
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [listing, setListing] = useState<{ found: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [decisions, setDecisions] = useState<Decisions>(noDecisions);
  const [organizing, setOrganizing] = useState(false);
  const [history, setHistory] = useState<ScanSummary[]>(loadHistory);
  const abortRef = useRef<AbortController | null>(null);

  const plan = useMemo(() => (result ? buildPlan(result, decisions) : []), [result, decisions]);

  const addSelection = useCallback((s: Selection) => {
    setError(null);
    setSelection((prev) => mergeSelections(prev, s));
  }, []);

  /* ---- choosing music ---- */

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
    const ac = new AbortController();
    abortRef.current = ac;
    setListing({ found: 0 });
    try {
      const sel = await fromDirectoryHandle(handle, (found) => setListing({ found }), ac.signal);
      addSelection(sel);
    } catch (err) {
      if (!ac.signal.aborted) setError(`Could not read “${handle.name}”: ${errorMessage(err)}`);
    } finally {
      setListing(null);
    }
  };

  const onFiles = (files: FileList) => addSelection(fromFileList(files));

  // Development-only hook so automated tests can feed files without the native picker.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__songsort = {
      addFiles: (entries: { file: File; path: string }[], label: string) => addSelection(fromPathEntries(entries, label)),
    };
  }, [addSelection]);

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
      const s = summarizePlan(buildPlan(res, dec));
      setHistory(
        saveToHistory({
          at: res.scannedAt,
          source: label,
          files: res.files.length + res.unreadable.length,
          totalBytes: res.files.reduce((a, f) => a + f.size, 0),
          unique: res.uniqueIds.length,
          exactGroups: res.exactGroups.length,
          extraCopies: res.exactGroups.reduce((a, g) => a + g.fileIds.length - 1, 0),
          potentialGroups: res.potentialGroups.length,
          savableBytes: s.bytes[FOLDER_DUPLICATES],
        }),
      );
    } catch (err) {
      setStage('home');
      if (!ac.signal.aborted) setError(`The scan stopped: ${errorMessage(err)}`);
    }
  };

  const newScan = () => {
    const touched = Object.keys(decisions.exactKeep).length + Object.keys(decisions.potential).length > 0;
    if (touched && !window.confirm('Start a new scan? Your choices for this scan will be lost.')) return;
    setResult(null);
    setDecisions(noDecisions());
    setSelection(emptySelection());
    setStage('home');
  };

  const goHome = () => {
    if (stage === 'results') newScan();
  };

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="brand" onClick={goHome} disabled={stage !== 'results'} aria-label="SongSort home">
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
            onPickDirectory={pickDirectory}
            onFiles={onFiles}
            onCancelListing={() => abortRef.current?.abort()}
            onClear={() => {
              setSelection(emptySelection());
              setError(null);
            }}
            onScan={startScan}
            onClearHistory={() => {
              clearHistory();
              setHistory([]);
            }}
          />
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
      </main>

      {organizing && result && <Organize plan={plan} onClose={() => setOrganizing(false)} />}

      <footer className="footer">SongSort runs entirely in your browser. No uploads, no accounts, nothing deleted.</footer>
    </div>
  );
}
