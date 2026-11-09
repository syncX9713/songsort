import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage, formatBytes, plural } from '../lib/format';
import {
  copyToFolder,
  exportZip,
  OUTPUT_FOLDERS,
  summarizePlan,
  triggerDownload,
  type OrganizeProgress,
  type OrganizeReport,
  type PlanItem,
} from '../lib/organize';
import { caps } from '../lib/platform';
import { describePickerError } from '../lib/select';
import { OUTPUT_ROOT } from '../lib/types';
import { Icon, ProgressBar } from './ui';

type State =
  | { kind: 'choose'; error?: string }
  | { kind: 'running'; mode: 'folder' | 'zip'; progress: OrganizeProgress | null; destName?: string }
  | { kind: 'done'; report: OrganizeReport; destName?: string; blob?: Blob }
  | { kind: 'error'; message: string };

/** Above this, building a ZIP inside a phone browser's memory may fail. */
const BIG_ZIP = 1.5 * 1024 ** 3;

/** In development builds an automated test can supply a destination folder instead of the native picker. */
function testDestination(): FileSystemDirectoryHandle | undefined {
  if (!import.meta.env.DEV) return undefined;
  return (window as unknown as { __songsortTestDestination?: FileSystemDirectoryHandle }).__songsortTestDestination;
}

export function Organize({ plan, onClose }: { plan: PlanItem[]; onClose: () => void }) {
  const [state, setState] = useState<State>({ kind: 'choose' });
  const abortRef = useRef<AbortController | null>(null);
  const summary = useMemo(() => summarizePlan(plan), [plan]);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state.kind !== 'running') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.kind, onClose]);

  // Warn before closing the tab in the middle of copying.
  useEffect(() => {
    if (state.kind !== 'running') return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [state.kind]);

  const toFolder = async () => {
    let dest: FileSystemDirectoryHandle;
    try {
      const injected = testDestination();
      dest = injected ?? (await window.showDirectoryPicker!({ id: 'songsort-destination', mode: 'readwrite' }));
    } catch (err) {
      const msg = describePickerError(err);
      setState({ kind: 'choose', error: msg ?? undefined });
      return;
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ kind: 'running', mode: 'folder', progress: null, destName: dest.name });
    try {
      const report = await copyToFolder(dest, plan, (progress) => setState({ kind: 'running', mode: 'folder', progress, destName: dest.name }), ac.signal);
      setState({ kind: 'done', report, destName: dest.name });
    } catch (err) {
      setState({ kind: 'error', message: `Could not write to “${dest.name}”: ${errorMessage(err)} Try another destination, or download a ZIP instead.` });
    }
  };

  const toZip = async () => {
    let handle: FileSystemFileHandle | undefined;
    if (caps.saveFilePicker && !testDestination()) {
      try {
        handle = await window.showSaveFilePicker!({
          suggestedName: `${OUTPUT_ROOT}.zip`,
          id: 'songsort-zip',
          types: [{ description: 'ZIP file', accept: { 'application/zip': ['.zip'] } }],
        });
      } catch (err) {
        const msg = describePickerError(err);
        setState({ kind: 'choose', error: msg ?? undefined });
        return;
      }
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ kind: 'running', mode: 'zip', progress: null });
    try {
      const { report, blob } = await exportZip(plan, (progress) => setState({ kind: 'running', mode: 'zip', progress }), ac.signal, handle);
      if (blob) triggerDownload(blob, `${OUTPUT_ROOT}.zip`);
      setState({ kind: 'done', report, blob, destName: handle?.name });
    } catch (err) {
      setState({ kind: 'error', message: `${errorMessage(err)} Your original files are untouched.` });
    }
  };

  const cancel = () => abortRef.current?.abort();

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && state.kind !== 'running' && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="org-title" tabIndex={-1} ref={dialogRef}>
        <header className="modal-head">
          <h2 id="org-title"><Icon name="folder" /> Organize My Music</h2>
          {state.kind !== 'running' && (
            <button type="button" className="btn-icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
          )}
        </header>

        {state.kind === 'choose' && (
          <div className="modal-body">
            <div className="tree" aria-label="Folders that will be created">
              <div className="tree-root"><Icon name="folder" size={18} /> {OUTPUT_ROOT}</div>
              {OUTPUT_FOLDERS.map((f) => (
                <div className="tree-item" key={f}>
                  <Icon name="folder" size={18} /> <span className="tree-name">{f}</span>
                  <span className="muted small">{plural(summary.counts[f], 'file')} · {formatBytes(summary.bytes[f])}</span>
                </div>
              ))}
            </div>
            <p className="callout callout-ok"><Icon name="shield" /> <span>Files are <strong>copied</strong>. Your originals stay exactly where they are — nothing is moved or deleted.</span></p>
            {summary.renamed > 0 && (
              <p className="muted small">
                {summary.renamed === 1 ? '1 file has' : `${summary.renamed.toLocaleString()} files have`} the same name as another file going to the same folder,
                so {summary.renamed === 1 ? 'it' : 'they'} will be saved as “name (2).mp3”. Nothing is overwritten.
              </p>
            )}
            <p className="muted small">You will need about {formatBytes(summary.totalBytes)} of free space.</p>

            {caps.writeDirectory ? (
              <div className="org-actions">
                <button type="button" className="btn btn-primary btn-big" onClick={toFolder}>
                  <Icon name="folder" /> Choose destination folder
                </button>
                <button type="button" className="btn btn-ghost" onClick={toZip}>
                  <Icon name="download" /> Save as a ZIP file instead
                </button>
                <p className="muted small">A new “{OUTPUT_ROOT}” folder is created inside the folder you choose — for example on a USB drive or external disk.</p>
              </div>
            ) : (
              <div className="org-actions">
                <button type="button" className="btn btn-primary btn-big" onClick={toZip}>
                  <Icon name="download" /> Download as ZIP
                </button>
                <p className="callout callout-info">
                  <Icon name="info" />
                  <span>
                    {caps.isMobile
                      ? 'Phone browsers cannot create folders on your device, so you will get one ZIP file containing the three folders. Open it with your Files app to unzip.'
                      : 'This browser cannot write folders directly (Chrome and Edge on a computer can). You will get one ZIP file containing the three folders.'}
                  </span>
                </p>
                {summary.totalBytes > BIG_ZIP && (
                  <p className="callout callout-warn">
                    <Icon name="alert" />
                    <span>This ZIP will be about {formatBytes(summary.totalBytes)}. Phones and some browsers can run out of memory with very large ZIP files. If it fails, scan a smaller set of songs at a time.</span>
                  </p>
                )}
              </div>
            )}
            {state.error && <p className="callout callout-error" role="alert"><Icon name="alert" /> {state.error}</p>}
          </div>
        )}

        {state.kind === 'running' && (
          <div className="modal-body" aria-live="polite">
            <p>
              <strong>{state.mode === 'folder' ? `Copying into “${state.destName}/${OUTPUT_ROOT}”` : 'Creating your ZIP file'}</strong>
            </p>
            <ProgressBar value={state.progress && state.progress.bytesTotal ? state.progress.bytesDone / state.progress.bytesTotal : 0} label="Organizing" />
            <div className="run-stats">
              <span>{state.progress ? `${Math.min(state.progress.filesDone + 1, state.progress.filesTotal).toLocaleString()} of ${state.progress.filesTotal.toLocaleString()} files` : 'Starting…'}</span>
              <span className="muted">{state.progress ? `${formatBytes(state.progress.bytesDone)} of ${formatBytes(state.progress.bytesTotal)}` : ''}</span>
            </div>
            {state.progress?.current && <div className="file-path current">{state.progress.current}</div>}
            <button type="button" className="btn btn-ghost" onClick={cancel}><Icon name="x" size={18} /> Cancel</button>
          </div>
        )}

        {state.kind === 'done' && <DoneView state={state} onClose={onClose} />}

        {state.kind === 'error' && (
          <div className="modal-body">
            <p className="callout callout-error" role="alert"><Icon name="alert" /> {state.message}</p>
            <div className="org-actions">
              <button type="button" className="btn btn-primary" onClick={() => setState({ kind: 'choose' })}>Try again</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DoneView({ state, onClose }: { state: Extract<State, { kind: 'done' }>; onClose: () => void }) {
  const r = state.report;
  const location =
    r.mode === 'folder'
      ? `“${state.destName}/${r.outputName}”`
      : state.blob
        ? `the ZIP file “${r.outputName}” (check your Downloads)`
        : `“${state.destName ?? r.outputName}”`;
  return (
    <div className="modal-body">
      {r.cancelled ? (
        <p className="callout callout-warn" role="status">
          <Icon name="alert" />
          <span>
            Cancelled.{' '}
            {r.mode === 'folder'
              ? `${plural(r.copied, 'file')} had already been copied into ${location}. The file that was being copied was removed.`
              : 'No ZIP file was saved.'}{' '}
            Your originals are untouched.
          </span>
        </p>
      ) : (
        <div className="success">
          <div className="done-icon big"><Icon name="check" size={32} /></div>
          <h3>{r.failed.length ? 'Finished, with some problems' : 'Your music is organized!'}</h3>
          <p>
            {plural(r.copied, 'file')} ({formatBytes(r.bytes)}) saved to {location}.
          </p>
          <ul className="done-counts">
            {OUTPUT_FOLDERS.map((f) => (
              <li key={f}><Icon name="folder" size={16} /> {f}: <strong>{r.counts[f].toLocaleString()}</strong></li>
            ))}
          </ul>
          {r.renamed > 0 && <p className="muted small">{plural(r.renamed, 'file')} got “(2)”-style names to avoid overwriting files with the same name.</p>}
        </div>
      )}
      {r.failed.length > 0 && (
        <div className="callout callout-error">
          <Icon name="alert" />
          <div>
            <strong>{plural(r.failed.length, 'file')} could not be copied:</strong>
            <ul className="fail-list">
              {r.failed.slice(0, 50).map((f) => <li key={f.path}><span className="file-path">{f.path}</span> — {f.error}</li>)}
            </ul>
          </div>
        </div>
      )}
      <div className="org-actions">
        {state.blob && !r.cancelled && (
          <button type="button" className="btn btn-ghost" onClick={() => triggerDownload(state.blob!, `${OUTPUT_ROOT}.zip`)}>
            <Icon name="download" /> Download the ZIP again
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
