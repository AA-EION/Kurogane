import { useStore } from '../store';
import { Icon } from './Icon';

/** Shown on a brand-new vault: three ways to get data in. */
export function EmptyState() {
  const { openModal } = useStore();
  return (
    <div className="empty">
      <div className="empty-card">
        <div className="empty-art" aria-hidden>
          <svg viewBox="0 0 120 80">
            <path d="M60 8 L104 30 L60 52 L16 30 Z" className="e-floor" />
            <path d="M60 22 L80 32 L60 42 L40 32 Z" className="e-top" />
            <path d="M40 32 L60 42 L60 58 L40 48 Z" className="e-left" />
            <path d="M60 42 L80 32 L80 48 L60 58 Z" className="e-right" />
          </svg>
        </div>
        <h2>Map your infrastructure</h2>
        <p>Start with a company (who owns things), then add its machines, the services running on them, the domains your proxy publishes, and the accounts for each.</p>
        <div className="empty-actions">
          <button className="choice" onClick={() => openModal({ type: 'tenant' })}>
            <Icon name="plus" size={22} />
            <b>Add your first company</b>
            <span>e.g. the company you work for, a client, or “Personal”.</span>
          </button>
          <button className="choice" onClick={() => openModal({ type: 'import' })}>
            <Icon name="upload" size={22} />
            <b>Import a spreadsheet</b>
            <span>Download the Excel template, fill it in, upload it.</span>
          </button>
        </div>
        <ol className="empty-steps">
          <li><b>Company</b> → <b>Machine</b> (VPS, server, router, AP, NVR…) with its IPs</li>
          <li><b>Services</b> on each machine with their ports (Docker, VM, SMB…)</li>
          <li><b>Reverse proxy</b> + domains → the map draws Internet → proxy → service</li>
          <li><b>Accounts</b> per machine and per service — copy, reveal, SSH/RDP in one click</li>
        </ol>
      </div>
    </div>
  );
}
