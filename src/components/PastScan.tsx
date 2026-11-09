import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { formatBytes, formatDuration, plural } from '../lib/format';
import { getScanDetails, type SavedFile, type ScanDetails, type ScanSummary } from '../lib/history';
import { caps } from '../lib/platform';
import { FOLDER_DUPLICATES, FOLDER_POTENTIAL, FOLDER_UNIQUE } from '../lib/types';
import { Icon } from './ui';

type Tab = 'unique' | 'exact' | 'potential' | 'unreadable';
const PAGE = 60;

interface Props {
  summary: ScanSummary;
  onBack: () => void;
  onRescan: () => void;
  onDelete: () => void;
  rescanBusy: boolean;
}

/** A saved, read-only report of an earlier scan. The music files themselves are not kept. */
export function PastScan({ summary: s, onBack, onRescan, onDelete, rescanBusy }: Props) {
  const [details, setDetails] = useState<ScanDetails | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>(s.exactGroups ? 'exact' : s.potentialGroups ? 'potential' : 'unique');

  useEffect(() => {
    let alive = true;
    if (s.hasDetails) getScanDetails(s.id).then((d) => alive && setDetails(d));
    else setDetails(null);
    return () => {
      alive = false;
    };
  }, [s.id, s.hasDetails]);

  const byId = useMemo(() => new Map((details?.files ?? []).map((f) => [f.id, f])), [details]);
  const canRescan = s.canRescan && caps.pickDirectory;

  return (
    <div className="results past">
      <button type="button" className="btn btn-link back" onClick={onBack}>
        ← Back
      </button>
      <section className="done-banner">
        <div className="done-icon past-icon"><Icon name="clock" size={24} /></div>
        <div>
          <h1 className="past-title" title={s.source}>{s.source}</h1>
          <p className="muted">Scanned {new Date(s.at).toLocaleString()} · {plural(s.files, 'file')} · {formatBytes(s.totalBytes)}</p>
        </div>
      </section>

      {s.organized ? (
        <p className="callout callout-ok">
          <Icon name="check" />
          <span>
            Organized {new Date(s.organized.at).toLocaleString()}: {plural(s.organized.copied, 'file')}{' '}
            {s.organized.mode === 'zip' ? 'saved as' : 'copied to'} <strong>{s.organized.where}</strong> —{' '}
            {s.organized.counts[FOLDER_UNIQUE]} unique, {s.organized.counts[FOLDER_DUPLICATES]} duplicates,{' '}
            {s.organized.counts[FOLDER_POTENTIAL]} potential duplicates
            {s.organized.failed > 0 ? ` (${s.organized.failed} could not be copied)` : ''}.
          </span>
        </p>
      ) : (
        <p className="callout callout-info">
          <Icon name="info" />
          <span>This music has not been organized yet.</span>
        </p>
      )}

      <p className="muted small">
        This is a saved report. SongSort never keeps your music, so songs can't be played or copied from here.
        {canRescan
          ? ' Use “Scan again” to check the same folder now.'
          : ' To organize this music, select it again on the start screen.'}
      </p>

      <div className="past-actions">
        {canRescan && (
          <button type="button" className="btn btn-primary" onClick={onRescan} disabled={rescanBusy}>
            <Icon name="folder" size={18} /> {rescanBusy ? 'Opening folder…' : 'Scan again'}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onDelete}>
          <Icon name="x" size={18} /> Delete this report
        </button>
      </div>

      <section className="stats" aria-label="Scan summary">
        <Stat label="Files scanned" value={s.files.toLocaleString()} />
        <Stat label="Unique songs" value={s.unique.toLocaleString()} tone="green" />
        <Stat label="Exact duplicates" value={s.extraCopies.toLocaleString()} sub={s.exactGroups ? `extra copies in ${plural(s.exactGroups, 'group')}` : 'none found'} tone="red" />
        <Stat label="Potential duplicates" value={s.potentialGroups.toLocaleString()} sub={s.potentialGroups ? `groups to review${s.potentialFiles ? ` (${s.potentialFiles} files)` : ''}` : 'none found'} tone="amber" />
        <Stat label="Space you could save" value={formatBytes(s.savableBytes)} tone="blue" />
      </section>

      {details === undefined && <p className="empty">Loading report…</p>}
      {details === null && (
        <p className="empty">Only the totals were saved for this scan (it was made with an earlier version of SongSort).</p>
      )}
      {details && (
        <>
          <div className="tabs" role="tablist" aria-label="Report">
            <TabButton id="unique" tab={tab} setTab={setTab} tone="green" count={details.uniqueIds.length}>Unique Songs</TabButton>
            <TabButton id="exact" tab={tab} setTab={setTab} tone="red" count={details.exact.length}>Exact Duplicates</TabButton>
            <TabButton id="potential" tab={tab} setTab={setTab} tone="amber" count={details.potential.length}>Potential Duplicates</TabButton>
            {details.unreadable.length > 0 && (
              <TabButton id="unreadable" tab={tab} setTab={setTab} tone="gray" count={details.unreadable.length}>Could not read</TabButton>
            )}
          </div>
          <div className="tab-body" role="tabpanel">
            {tab === 'unique' && <UniqueReport ids={details.uniqueIds} byId={byId} />}
            {tab === 'exact' && <ExactReport groups={details.exact} byId={byId} />}
            {tab === 'potential' && <PotentialReport groups={details.potential} byId={byId} />}
            {tab === 'unreadable' && (
              <div className="list">
                {details.unreadable.map((u) => (
                  <div className="file-row" key={u.path}>
                    <div className="file-main">
                      <div className="file-title">{u.path.split('/').pop()}</div>
                      <div className="file-path">{u.path}</div>
                      <div className="file-error">{u.error}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function TabButton({ id, tab, setTab, count, tone, children }: { id: Tab; tab: Tab; setTab: (t: Tab) => void; count: number; tone: string; children: ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'is-active' : ''}`} onClick={() => setTab(id)}>
      {children} <span className={`count count-${tone}`}>{count.toLocaleString()}</span>
    </button>
  );
}

function Row({ f, badge }: { f: SavedFile; badge?: ReactNode }) {
  const sub = [f.artist, f.album].filter(Boolean).join(' · ');
  return (
    <div className="file-row">
      <div className="file-main">
        <div className="file-title">
          {f.title}
          {f.fromFileName && <span className="hint"> (from file name)</span>}
        </div>
        {sub && <div className="file-sub">{sub}</div>}
        <div className="file-path" title={f.path}>{f.path}</div>
        {badge}
      </div>
      <div className="file-meta">
        <span className="fmt">{f.ext.toUpperCase()}</span>
        <span>{formatBytes(f.size)}</span>
        {f.duration !== undefined && <span>{formatDuration(f.duration)}</span>}
        {f.bitrate !== undefined && <span>{f.bitrate} kbps</span>}
      </div>
    </div>
  );
}

function usePaged<T>(items: T[]) {
  const [shown, setShown] = useState(PAGE);
  const more =
    items.length > shown ? (
      <button type="button" className="btn btn-ghost show-more" onClick={() => setShown((n) => n + PAGE * 2)}>
        Show more ({(items.length - shown).toLocaleString()} left)
      </button>
    ) : null;
  return { visible: items.slice(0, shown), more };
}

function UniqueReport({ ids, byId }: { ids: number[]; byId: Map<number, SavedFile> }) {
  const [q, setQ] = useState('');
  const files = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return ids
      .map((id) => byId.get(id)!)
      .filter((f) => {
        const hay = `${f.title} ${f.artist ?? ''} ${f.album ?? ''} ${f.path}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
  }, [ids, byId, q]);
  const { visible, more } = usePaged(files);
  return (
    <div className="list">
      {ids.length > 8 && (
        <input className="search" type="search" value={q} placeholder="Search songs, artists or folders" aria-label="Search songs" onChange={(e) => setQ(e.target.value)} />
      )}
      {files.length === 0 && <p className="empty">{q ? 'No songs match your search.' : 'No unique songs in this scan.'}</p>}
      {visible.map((f) => <Row key={f.id} f={f} />)}
      {more}
    </div>
  );
}

function ExactReport({ groups, byId }: { groups: ScanDetails['exact']; byId: Map<number, SavedFile> }) {
  const { visible, more } = usePaged(groups);
  if (groups.length === 0) return <p className="empty">No identical copies were found.</p>;
  return (
    <div className="list">
      <p className="tab-intro">Byte-for-byte identical files. The suggested copy to keep is marked.</p>
      {visible.map((g, i) => {
        const keep = byId.get(g.keep)!;
        return (
          <article className="group group-exact" key={i}>
            <header className="group-head">
              <h3>{keep.title}</h3>
              <div className="muted small">{g.fileIds.length} identical copies · {formatBytes(keep.size)} each</div>
            </header>
            <div className="group-rows">
              {g.fileIds.map((id) => (
                <Row
                  key={id}
                  f={byId.get(id)!}
                  badge={<span className={`badge ${id === g.keep ? 'badge-keep' : 'badge-dup'}`}>{id === g.keep ? 'Suggested to keep' : 'Duplicate copy'}</span>}
                />
              ))}
            </div>
          </article>
        );
      })}
      {more}
    </div>
  );
}

function PotentialReport({ groups, byId }: { groups: ScanDetails['potential']; byId: Map<number, SavedFile> }) {
  const { visible, more } = usePaged(groups);
  if (groups.length === 0) return <p className="empty">No similar songs were found.</p>;
  return (
    <div className="list">
      <p className="callout callout-warn">
        <Icon name="alert" />
        <span><strong>Not confirmed duplicates.</strong> These files have similar song details but different contents.</span>
      </p>
      {visible.map((g, i) => {
        const first = byId.get(g.songs[0][0])!;
        return (
          <article className="group group-potential" key={i}>
            <header className="group-head">
              <h3>{first.title}</h3>
              <div className="muted small">{g.songs.length} similar files</div>
            </header>
            <ul className="reasons">{g.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            <div className="group-rows">
              {g.songs.map((song) => (
                <Row
                  key={song[0]}
                  f={byId.get(song[0])!}
                  badge={song.length > 1 ? <span className="hint">+ {plural(song.length - 1, 'identical copy', 'identical copies')}</span> : undefined}
                />
              ))}
            </div>
          </article>
        );
      })}
      {more}
    </div>
  );
}
