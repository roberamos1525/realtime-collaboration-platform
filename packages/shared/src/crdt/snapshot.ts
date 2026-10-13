import { z } from "zod";

/**
 * Serialized replica state.
 *
 * Elements are stored in document order as runs: consecutive elements that
 * were created by the same site with consecutive clocks and share the same
 * deletion flag collapse into a single `[site, clock, text, deleted]` tuple.
 * Typing produces long runs, so snapshots are compact in practice.
 */
export interface RgaSnapshot {
  readonly version: 1;
  readonly clock: number;
  readonly vv: Readonly<Record<string, number>>;
  readonly runs: ReadonlyArray<readonly [site: string, clock: number, text: string, deleted: 0 | 1]>;
}

export const rgaSnapshotSchema = z.object({
  version: z.literal(1),
  clock: z.number().int().nonnegative(),
  vv: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), z.number().int().nonnegative()),
  runs: z.array(
    z.tuple([
      z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
      z.number().int().positive(),
      z.string().min(1),
      z.union([z.literal(0), z.literal(1)]),
    ]),
  ),
});

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

/** Parses and validates an untrusted snapshot value. */
export function parseSnapshot(value: unknown): RgaSnapshot {
  const result = rgaSnapshotSchema.safeParse(value);
  if (!result.success) {
    throw new SnapshotError(`invalid snapshot: ${result.error.issues[0]?.message ?? "unknown"}`);
  }
  return result.data as RgaSnapshot;
}

/** An empty document state. */
export function emptySnapshot(): RgaSnapshot {
  return { version: 1, clock: 0, vv: {}, runs: [] };
}
