/**
 * Small fzf-style fuzzy matcher: characters must appear in order; score
 * rewards consecutive runs, word-boundary hits and prefix matches.
 */
export interface Match {
  score: number;
  indices: number[];
}

const BOUNDARY = /[\s._\-/:@]/;

export function fuzzyMatch(query: string, text: string): Match | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  // Exact substring gets a strong, contiguous match.
  const sub = t.indexOf(q);
  if (sub >= 0) {
    const indices = Array.from({ length: q.length }, (_, i) => sub + i);
    const boundary = sub === 0 || BOUNDARY.test(t[sub - 1]);
    return { score: 100 + q.length * 8 + (boundary ? 30 : 0) - sub * 0.5 - (t.length - q.length) * 0.1, indices };
  }
  let ti = 0;
  let score = 0;
  let run = 0;
  const indices: number[] = [];
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (; ti < t.length; ti++) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
    }
    if (found < 0) return null;
    const prevIdx = indices[indices.length - 1];
    run = prevIdx !== undefined && found === prevIdx + 1 ? run + 1 : 0;
    score += 4 + run * 6;
    if (found === 0 || BOUNDARY.test(t[found - 1])) score += 10;
    if (prevIdx !== undefined) score -= Math.min(found - prevIdx - 1, 6);
    indices.push(found);
    ti = found + 1;
  }
  return { score: score - (t.length - q.length) * 0.05, indices };
}

/** Best match across several fields; returns the field index too. */
export function bestOf(query: string, fields: (string | null | undefined)[]): (Match & { field: number }) | null {
  let best: (Match & { field: number }) | null = null;
  fields.forEach((f, i) => {
    if (!f) return;
    const m = fuzzyMatch(query, f);
    if (m && (!best || m.score - i * 2 > best.score)) best = { ...m, score: m.score - i * 2, field: i };
  });
  return best;
}
