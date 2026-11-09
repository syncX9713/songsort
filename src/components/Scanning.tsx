import { formatBytes } from '../lib/format';
import type { ScanProgress } from '../lib/scan';
import { Icon, ProgressBar } from './ui';

export function Scanning({ progress, total, onCancel }: { progress: ScanProgress | null; total: number; onCancel: () => void }) {
  const p = progress;
  let title = 'Getting ready…';
  let detail = '';
  let value = 0;
  let step = 1;
  if (p?.phase === 'details') {
    step = 1;
    title = 'Reading song details';
    detail = `${p.done.toLocaleString()} of ${p.total.toLocaleString()} files`;
    value = p.total ? p.done / p.total : 0;
  } else if (p?.phase === 'compare') {
    step = 2;
    title = 'Checking for identical files';
    detail = p.total
      ? `${p.done.toLocaleString()} of ${p.total.toLocaleString()} files · ${formatBytes(p.bytesDone)} of ${formatBytes(p.bytesTotal)}`
      : 'No files of the same size — nothing to compare';
    value = p.bytesTotal ? p.bytesDone / p.bytesTotal : 1;
  } else if (p?.phase === 'finishing') {
    step = 3;
    title = 'Grouping duplicates';
    value = 1;
  }

  return (
    <section className="panel scanning" aria-live="polite">
      <div className="scan-badge"><Icon name="music" size={28} /></div>
      <h2>Scanning {total.toLocaleString()} music files</h2>
      <ol className="steps">
        <li className={step > 1 ? 'done' : step === 1 ? 'active' : ''}>Song details</li>
        <li className={step > 2 ? 'done' : step === 2 ? 'active' : ''}>Identical files</li>
        <li className={step === 3 ? 'active' : ''}>Grouping</li>
      </ol>
      <div className="scan-status">
        <strong>{title}</strong>
        <span className="muted">{detail}</span>
      </div>
      <ProgressBar value={value} label={title} />
      <p className="muted small">
        Everything is read on this device. Large collections can take a few minutes — keep this tab open.
      </p>
      <button type="button" className="btn btn-ghost" onClick={onCancel}>
        <Icon name="x" size={18} /> Cancel scan
      </button>
    </section>
  );
}
