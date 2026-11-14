/**
 * Vector collections SDK: `client.vectors.*`. A vector collection stores embeddings you computed yourself, next to the
 * text and metadata they came from, and answers nearest-neighbour searches over them.
 *
 * Wire mapping (project plane):
 *   - `nearest(collection, { queryVector, topK?, minScore?, metric?, filters? })` -> POST /@<slug>/vectors/<collection>/search
 *   - `upsert(collection, rows)`                                                   -> POST /@<slug>/vectors/<collection>/upsert
 *
 * Both send the vector in the request body, so they take real embeddings of any common size (up to 16000 numbers).
 * The collection name must start with `_`. The first upsert creates the collection and fixes its dimension; every
 * later vector must have the same length. Searching a collection that was never upserted answers 404
 * `K9O_COLLECTION_NOT_FOUND`.
 */

import { request, type HttpClientConfig } from "./http.ts";
import { KError } from "./kerror.ts";
import { projectPath } from "./url-grammar.ts";
import type { Envelope } from "./envelope.ts";

export type VectorMetric = "cosine" | "euclidean" | "dot";

/** Where a vector came from: a source handle and the index of the chunk within it. */
export type VectorSource = {
  handle: string;
  chunkIndex: number;
  [key: string]: unknown;
};

/** Equality filters: a path (`id`, `contentHash`, `source.<key>` or `metadata.<key>`) and the value it must equal. */
export type VectorFilters = Record<string, string | number | boolean>;

export type NearestVectorsInput = {
  /** The embedding to search with: 1 to 16000 numbers, the same length as the stored vectors. */
  queryVector: ReadonlyArray<number>;
  /** How many results to return, 1 to 1000. The gateway defaults to 10. */
  topK?: number | undefined;
  /** Keep only results whose `score` is at least this. Default: no threshold. */
  minScore?: number | undefined;
  /** Default `cosine`. */
  metric?: VectorMetric | undefined;
  /** Equality filters on `id`, `contentHash`, `source.<key>` and `metadata.<key>`; every one must match. */
  filters?: VectorFilters | undefined;
};

export type NearestVector = {
  id: string;
  /** Higher is more similar. `cosine`: 1 minus the distance; `euclidean`: 1 / (1 + distance); `dot`: the inner product. */
  score: number;
  _source: VectorSource;
  contentHash: string | null;
  text: string | null;
  metadata: Record<string, unknown>;
  /** From `metadata.model`, when set. */
  model: string | null;
  /** From `_source.chunkIndex`, when set. */
  chunk: number | null;
};

export type NearestVectorsResult = {
  /** Closest first. */
  results: NearestVector[];
  collection: string;
};

export type VectorRow = {
  /** 1 to 256 characters. Default: generated. Upserting an existing id overwrites that row. */
  id?: string | undefined;
  /** 1 to 16000 numbers; every row in one request has the same length. */
  vector: ReadonlyArray<number>;
  _source: VectorSource;
  /** At most 128 characters. */
  contentHash?: string | undefined;
  /** At most 100000 characters. Stored sealed when the row belongs to a subject. */
  text?: string | undefined;
  /** Default `{}`. Only keep values here that you filter on; they are stored in plain text. */
  metadata?: Record<string, unknown> | undefined;
  /**
   * The one end user the row belongs to (`["eu_..."]`). Required on a per-subject collection (the default for a new
   * collection); refused on a collection declared shared.
   */
  subjectIds?: ReadonlyArray<string> | undefined;
};

export type UpsertVectorsResult = {
  upserted: number;
  collection: string;
};

const METRICS: ReadonlyArray<string> = ["cosine", "euclidean", "dot"];
const MAX_VECTOR = 16000;
const MAX_ROWS = 1000;

function invalid(message: string, context: Record<string, unknown> = {}): KError {
  return new KError({ code: "K9O_INVALID_FIELD_VALUE", message, context, recommendation: null });
}

function checkVector(vector: unknown, name: string): void {
  if (!Array.isArray(vector) || vector.length < 1 || vector.length > MAX_VECTOR) {
    throw invalid(`${name} must be an array of 1 to ${MAX_VECTOR} numbers`);
  }
  if (!vector.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw invalid(`${name} must contain only finite numbers`);
  }
}

export function makeVectorsNamespace(config: HttpClientConfig) {
  const path = (collection: unknown, tail: string): string => {
    if (typeof collection !== "string" || !collection.startsWith("_")) {
      throw invalid("a vector collection name must start with _", { collection });
    }
    if (typeof config.projectSlug !== "string" || config.projectSlug.length === 0) {
      throw new Error("vectors operations require projectSlug bound on the client");
    }
    return projectPath(config.projectSlug, `vectors/${encodeURIComponent(collection)}/${tail}`);
  };
  return {
    /** The rows nearest to `queryVector`, closest first. Answers 404 when the collection has never been upserted. */
    async nearest(collection: string, input: NearestVectorsInput): Promise<Envelope<NearestVectorsResult>> {
      const where = path(collection, "search");
      if (input === null || typeof input !== "object") throw invalid("input must be an object");
      checkVector(input.queryVector, "queryVector");
      if (input.topK !== undefined && (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 1000)) {
        throw invalid("topK must be a whole number from 1 to 1000", { topK: input.topK });
      }
      if (input.minScore !== undefined && (typeof input.minScore !== "number" || !Number.isFinite(input.minScore))) {
        throw invalid("minScore must be a number", { minScore: input.minScore });
      }
      if (input.metric !== undefined && !METRICS.includes(input.metric)) {
        throw invalid(`metric must be one of: ${METRICS.join(", ")}`, { metric: input.metric });
      }
      if (input.filters !== undefined && (input.filters === null || typeof input.filters !== "object" || Array.isArray(input.filters))) {
        throw invalid("filters must be an object of path to value");
      }
      return request(config, { method: "POST", path: where, body: input });
    },

    /** Insert or overwrite up to 1000 rows in one request. The first upsert creates the collection. */
    async upsert(collection: string, rows: ReadonlyArray<VectorRow>): Promise<Envelope<UpsertVectorsResult>> {
      const where = path(collection, "upsert");
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS) {
        throw invalid(`rows must be an array of 1 to ${MAX_ROWS} rows`);
      }
      rows.forEach((row, index) => {
        if (row === null || typeof row !== "object") throw invalid(`rows[${index}] must be an object`);
        checkVector(row.vector, `rows[${index}].vector`);
      });
      return request(config, { method: "POST", path: where, body: { rows } });
    },
  };
}
