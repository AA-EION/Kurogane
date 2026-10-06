export function Brand({ large }: { large?: boolean }) {
  return (
    <div className={`brand ${large ? 'large' : ''}`}>
      <svg viewBox="0 0 40 40" className="brand-mark" aria-hidden>
        <path d="M20 3 L36 12 L36 28 L20 37 L4 28 L4 12 Z" className="bm-edge" />
        <path d="M20 3 L36 12 L20 21 L4 12 Z" className="bm-top" />
        <path d="M20 21 L36 12 L36 28 L20 37 Z" className="bm-right" />
        <path d="M20 21 L20 37 L4 28 L4 12 Z" className="bm-left" />
      </svg>
      <div className="brand-signature">
      <div className="brand-text">
        <span className="brand-name">KUROGANE</span>
        <span className="brand-kanji">黒鉄</span>
      </div>
      <span className="brand-maker">Issen Software Group</span>
      </div>
    </div>
  );
}
