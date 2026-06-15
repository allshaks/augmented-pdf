/**
 * Pure helpers for comparing PDF++ selection ranges on a page.
 * selId format: "beginIndex,beginOffset,endIndex,endOffset" — indices into pdf.js text items,
 * offsets are char offsets within them. A position is the pair (index, offset).
 */

export type SelTuple = [number, number, number, number];

export function parseSelId(selId: string): SelTuple | null {
  const parts = selId.split(",").map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null;
  return parts as SelTuple;
}

function cmp(i1: number, o1: number, i2: number, o2: number): number {
  return i1 - i2 || o1 - o2;
}

export function identical(a: SelTuple, b: SelTuple): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * True if two selections on the SAME page share interior (genuine overlap or containment),
 * excluding identical ranges and mere adjacency (touching at a single point).
 */
export function overlaps(a: SelTuple, b: SelTuple): boolean {
  if (identical(a, b)) return false;
  // a.begin < b.end  AND  b.begin < a.end  (strict → adjacency doesn't count)
  const aBeginBeforeBEnd = cmp(a[0], a[1], b[2], b[3]) < 0;
  const bBeginBeforeAEnd = cmp(b[0], b[1], a[2], a[3]) < 0;
  return aBeginBeforeBEnd && bBeginBeforeAEnd;
}
