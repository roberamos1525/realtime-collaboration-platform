import { z } from "zod";
import { MAX_SITE_LENGTH } from "./id.js";

/** Upper bound on characters carried by a single insert operation. */
export const MAX_INSERT_LENGTH = 20_000;
/** Upper bound on spans carried by a single delete operation. */
export const MAX_DELETE_SPANS = 5_000;

/**
 * Inserts `text` after the element identified by `after` (or at the document
 * start when `after` is null). Character `i` of the text receives the id
 * `{ site, clock: clock + i }` and is logically inserted after character
 * `i - 1`, so a run behaves exactly like a chain of single-character inserts.
 */
export interface InsertOp {
  readonly kind: "insert";
  readonly site: string;
  /** Per-site contiguous sequence number, used for dedupe and FIFO delivery. */
  readonly seq: number;
  readonly clock: number;
  readonly after: string | null;
  readonly text: string;
}

/** A run of consecutive character ids created by one site. */
export interface IdSpan {
  readonly site: string;
  readonly clock: number;
  readonly length: number;
}

/** Marks the characters covered by `spans` as deleted (tombstoned). */
export interface DeleteOp {
  readonly kind: "delete";
  readonly site: string;
  readonly seq: number;
  readonly clock: number;
  readonly spans: readonly IdSpan[];
}

export type RgaOp = InsertOp | DeleteOp;

const siteSchema = z
  .string()
  .min(1)
  .max(MAX_SITE_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, "invalid site id");
const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const keySchema = z
  .string()
  .max(64)
  .regex(/^\d+@[A-Za-z0-9_-]+$/, "invalid element key");

export const insertOpSchema = z.object({
  kind: z.literal("insert"),
  site: siteSchema,
  seq: positiveInt,
  clock: positiveInt,
  after: keySchema.nullable(),
  text: z.string().min(1).max(MAX_INSERT_LENGTH),
});

export const idSpanSchema = z.object({
  site: siteSchema,
  clock: positiveInt,
  length: z.number().int().positive().max(MAX_INSERT_LENGTH),
});

export const deleteOpSchema = z.object({
  kind: z.literal("delete"),
  site: siteSchema,
  seq: positiveInt,
  clock: positiveInt,
  spans: z.array(idSpanSchema).min(1).max(MAX_DELETE_SPANS),
});

export const rgaOpSchema = z.discriminatedUnion("kind", [insertOpSchema, deleteOpSchema]);

/** Number of characters an operation touches. */
export function opSize(op: RgaOp): number {
  if (op.kind === "insert") return op.text.length;
  let total = 0;
  for (const span of op.spans) total += span.length;
  return total;
}

/** Highest Lamport timestamp consumed by the operation. */
export function opMaxClock(op: RgaOp): number {
  return op.kind === "insert" ? op.clock + op.text.length - 1 : op.clock;
}
