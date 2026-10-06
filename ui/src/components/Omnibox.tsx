import { useEffect, useMemo, useRef, useState } from 'react';
import type { HitKind, SearchEntry, SearchHit } from '../search/index';
import { search } from '../search/index';
import { Icon } from './Drawer';

const KIND_ICON: Record<HitKind, string> = {
  tenant: 'shield', host: 'server', service: 'container', proxy: 'proxy', route: 'globe', network: 'switch', credential: 'key', ip: 'router',
};

function Highlight({ text, indices, active }: { text: string; indices: number[]; active: boolean }) {
  if (!active || !indices.length) return <>{text}</>;
  const set = new Set(indices);
  return (
    <>
      {[...text].map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : <span key={i}>{ch}</span>))}
    </>
  );
}

/** Cmd/Ctrl+K palette: fuzzy search across companies, IPs, ports, domains and services. */
export function Omnibox({ index, onPick, onClose }: { index: SearchEntry[]; onPick: (target: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const hits: SearchHit[] = useMemo(() => search(index, q), [index, q]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setCursor(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const pick = (h?: SearchHit) => {
    if (!h) return;
    onPick(h.target);
    onClose();
  };

  return (
    <div className="omni-backdrop" onMouseDown={onClose}>
      <div className="omni" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Search">
        <div className="omni-input">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            value={q}
            placeholder="Search companies, hosts, IPs, ports, domains, services…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setCursor((c) => Math.min(c + 1, hits.length - 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setCursor((c) => Math.max(c - 1, 0)));
              else if (e.key === 'Enter') pick(hits[cursor]);
              else if (e.key === 'Escape') onClose();
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd>esc</kbd>
        </div>
        {q && (
          <ul className="omni-list" ref={listRef}>
            {hits.length === 0 && <li className="omni-empty">No matches for “{q}”</li>}
            {hits.map((h, i) => (
              <li
                key={`${h.kind}:${h.title}:${h.target}:${i}`}
                data-i={i}
                className={i === cursor ? 'active' : ''}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(h)}
              >
                <span className={`omni-kind k-${h.kind}`}>
                  <Icon name={KIND_ICON[h.kind]} size={15} />
                </span>
                <span className="omni-main">
                  <span className="omni-title">
                    <Highlight text={h.title} indices={h.indices} active={h.field === 0} />
                  </span>
                  <span className="omni-sub">{h.subtitle}</span>
                </span>
                <span className="omni-tag">{h.kind}</span>
              </li>
            ))}
          </ul>
        )}
        {!q && (
          <div className="omni-hints">
            <span>Try</span>
            {['10.10.0.21', '8081', 'git.corp', 'alpha', 'cloudflare', 'postgres'].map((s) => (
              <button key={s} onClick={() => setQ(s)} className="mono">{s}</button>
            ))}
          </div>
        )}
        <footer className="omni-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> focus on canvas</span>
        </footer>
      </div>
    </div>
  );
}
