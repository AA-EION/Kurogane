import { GLYPHS } from '../canvas/glyphs';

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d={GLYPHS[name] ?? GLYPHS.server} />
    </svg>
  );
}
