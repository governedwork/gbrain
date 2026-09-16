/**
 * Shared row-shape types for the takes pipeline (stale rows + embedding
 * writes), peeled out of engine.ts so the engine classes and their takes
 * delegates stay within the module-size ratchet.
 */

/** v0.28 stale-takes row (mirrors StaleChunkRow shape). Embedding column intentionally omitted. */
export interface StaleTakeRow {
  take_id: number;
  page_slug: string;
  row_num: number | null;        // NULL for origin='db' (Phase 2.5 D2)
  origin?: string;
  external_id?: string | null;
  claim: string;
}

/** Vector write for an existing take row. */
export interface TakeEmbeddingInput {
  take_id: number;
  embedding: Float32Array;
}
