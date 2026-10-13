/**
 * Computes the pieces of a "mirror" overlay rendered behind the editor
 * textarea: text runs carrying zero or more highlights (remote selections,
 * comment anchors) and zero-width carets (remote cursors). Rendering the same
 * text with the same font/wrapping makes highlights line up with the
 * textarea without measuring glyphs.
 */

export interface Highlight {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly color: string;
  readonly kind: "selection" | "comment" | "active-comment";
}

export interface Caret {
  readonly id: string;
  readonly at: number;
  readonly color: string;
  readonly label: string;
}

export type OverlayPiece =
  | { readonly kind: "text"; readonly text: string; readonly highlights: readonly Highlight[] }
  | { readonly kind: "caret"; readonly caret: Caret };

export function buildOverlay(text: string, highlights: readonly Highlight[], carets: readonly Caret[]): OverlayPiece[] {
  const len = text.length;
  const valid = highlights
    .map((h) => ({ ...h, from: clamp(h.from, len), to: clamp(h.to, len) }))
    .filter((h) => h.to > h.from);
  const caretsAt = new Map<number, Caret[]>();
  for (const c of carets) {
    const at = clamp(c.at, len);
    const list = caretsAt.get(at) ?? [];
    list.push({ ...c, at });
    caretsAt.set(at, list);
  }
  const bounds = new Set<number>([0, len]);
  for (const h of valid) {
    bounds.add(h.from);
    bounds.add(h.to);
  }
  for (const at of caretsAt.keys()) bounds.add(at);
  const points = [...bounds].sort((a, b) => a - b);
  const pieces: OverlayPiece[] = [];
  for (let i = 0; i < points.length; i++) {
    const start = points[i] as number;
    for (const caret of caretsAt.get(start) ?? []) pieces.push({ kind: "caret", caret });
    const end = points[i + 1];
    if (end === undefined || end === start) continue;
    const active = valid.filter((h) => h.from <= start && h.to >= end);
    const prev = pieces[pieces.length - 1];
    const piece = { kind: "text" as const, text: text.slice(start, end), highlights: active };
    // Merge adjacent runs with identical highlight sets.
    if (prev && prev.kind === "text" && sameIds(prev.highlights, active)) {
      pieces[pieces.length - 1] = { ...prev, text: prev.text + piece.text };
    } else {
      pieces.push(piece);
    }
  }
  return pieces;
}

function clamp(n: number, len: number): number {
  return Math.max(0, Math.min(len, Math.round(n)));
}

function sameIds(a: readonly Highlight[], b: readonly Highlight[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((h, i) => h.id === b[i]?.id);
}

/** Converts a #rrggbb colour into rgba() with the given alpha. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = Number.parseInt(m[1] as string, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
