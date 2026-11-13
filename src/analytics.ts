/**
 * Datasets SDK: `client.analytics.*` and `client.rollups.*`. A dataset is a typed, partitioned table you append to and
 * query with SQL; a rollup folds a stream into a dataset over fixed windows.
 *
 * Wire mapping (project plane, `/@<slug>/...`):
 *   - analytics.list()                               GET    analytics
 *   - analytics.query({ sql, datasets })             POST   analytics/query
 *   - analytics.create / get / delete (slug)         POST / GET / DELETE   analytics/<slug>
 *   - analytics.materialize(slug, source)            POST   analytics/<slug>/materialize
 *   - analytics.read(slug, { partitionFilter, cursor, limit })   POST   analytics/<slug>/read
 *   - analytics.write(slug, rows, { onError })       POST   analytics/<slug>/write
 *   - analytics.upload(slug, file, options)          POST   analytics/<slug>/upload   (multipart)
 *   - analytics.downloadOriginal(slug)               GET    analytics/<slug>/upload/original   (bytes)
 *   - analytics.rollups.create / list / delete / reattest      analytics/<slug>/rollups[/<id>[/reattest]]
 *   - analytics.schedules.create / list / delete / reattest    analytics/<slug>/schedules[/<id>[/reattest]]
 *   - rollups.list()                                 GET    rollups
 *   - rollups.read(slug, { from, to, dims })         GET    rollups/<slug>/read
 *   - rollups.subscribe(slug, options)               GET    rollups/<slug>/subscribe   (SSE)
 *
 * Callers must be members of the project; project service tokens and extension tokens cannot call these routes.
 * `reattest` (rollups and schedules) is for people only: a service, workload or extension token gets
 * 403 `K9O_RBAC_DENY` with `context.reason` `human_only`. A personal access token acts as its person.
 */

import { request, requestStream, type HttpClientConfig } from "./http.ts";
import { projectPath } from "./url-grammar.ts";
import type { SseFrame } from "./internal/sse.ts";
import { openFeed, type FeedOptions, type RealtimeResync } from "./realtime.ts";
import type { Envelope, PaginatedEnvelope } from "./envelope.ts";

// ----------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------

/** A column: `type` is `string`, `int32`, `int64`, `float64`, `bool`, `date`, `timestamp`, `json`, `bytes` or `decimal(p,s)`. */
export type DatasetColumn = { name: string; type: string };

export type DatasetStorageTarget = { kind: "managed" } | { kind: "byos"; bindingId: string };

export type CreateDatasetInput = {
  displayName: string;
  /** 1 to 512 columns. */
  columns: ReadonlyArray<DatasetColumn>;
  /** Up to 16 partition keys. A timestamp key needs a transform such as `created_at:day`; `region` is added automatically. */
  partitionBy?: ReadonlyArray<string> | undefined;
  /** `per-subject` for personal data, `shared` otherwise. */
  residencyClass: "per-subject" | "shared";
  storageTarget?: DatasetStorageTarget | undefined;
};

/**
 * A dataset as the gateway returns it: slug, display name, schema, partition keys (`region` first), residency class,
 * storage target and creation time. The answer may carry more fields (such as its endpoints), so the type is open.
 */
export type Dataset = {
  id?: string;
  slug: string;
  displayName?: string;
  /** The columns, `{ name, type }`. */
  schema?: DatasetColumn[];
  /** Partition keys; `region` is always first. */
  partitionKeys?: string[];
  retiredAt?: string | null;
  residencyClass?: "per-subject" | "shared";
  storageTarget?: DatasetStorageTarget;
  createdAt?: string;
  [field: string]: unknown;
};

export type DatasetQueryInput = {
  /** A read-only `SELECT`, at most 100000 characters. Reference each dataset as `dataset.<slug>`. */
  sql: string;
  /** The dataset slugs the query reads, 1 to 64. */
  datasets: ReadonlyArray<string>;
};

export type DatasetReadOptions = {
  /** Constraints on the declared partition keys. */
  partitionFilter?: Record<string, unknown> | undefined;
  /** `meta.cursor.next` of the previous page. */
  cursor?: string | undefined;
  /** Rows per page (clamped to a page maximum by the gateway). */
  limit?: number | undefined;
};

/** A row read from a dataset; `_k9o_row_id` is stable. */
export type DatasetRow = { _k9o_row_id?: string; [column: string]: unknown };

export type DatasetWriteOptions = {
  /** `skip` (default) skips bad rows and reports them; `reject` refuses the whole write (400 `K9O_INGEST_SCHEMA_MISMATCH`). */
  onError?: "skip" | "reject" | undefined;
};

/** What a write or an upload reports: `ingested`, `skipped`, up to 100 `skippedDetails`, the partitions touched and the bytes written. */
export type DatasetIngestResult = {
  ingested?: number;
  skipped?: number;
  skippedDetails?: unknown[];
  [field: string]: unknown;
};

export type MaterializeSource = { fromCollection: string; fromQuery?: undefined } | { fromQuery: string; fromCollection?: undefined };

/** What materialize reports: `rowsRead`, `ingested`, `rejected` and the partitions touched. */
export type MaterializeResult = { rowsRead?: number; ingested?: number; rejected?: number; [field: string]: unknown };

export type DatasetUploadOptions = {
  /** `csv` or `json`. Required. */
  format: "csv" | "json";
  /** `true` returns the detected columns and a 50-row preview without writing. Needs `datasets:create`. */
  dryRun?: boolean | undefined;
  onError?: "skip" | "reject" | undefined;
  /** CSV only. */
  delimiter?: string | undefined;
  /** CSV only. */
  encoding?: string | undefined;
  /** CSV only. */
  hasHeader?: boolean | undefined;
  /**
   * Creates the dataset and loads the file in one call when the slug does not exist yet (same fields as `create`).
   * Needs `datasets:create`.
   */
  manifest?: CreateDatasetInput | undefined;
  /** The file name sent with the upload. Default `upload.csv` or `upload.json`. */
  fileName?: string | undefined;
  /** The file's MIME type. Default `text/csv` or `application/json`. */
  contentType?: string | undefined;
};

/** The stored upload, as bytes (not a JSON envelope). */
export type DownloadedFile = {
  bytes: Uint8Array;
  /** `text/csv`, `application/json` or `application/octet-stream`. */
  contentType: string | null;
  /** From `Content-Disposition`, when sent. */
  fileName: string | null;
};

export type ReattestDays = 7 | 30 | 90 | 365;

export type RollupMeasure = {
  name: string;
  /** `count`, or `last`, `sum`, `avg`, `min`, `max`, `count_distinct`, `p50`, `p95`, `p99` over `column`. */
  agg: string;
  column?: string | undefined;
};

export type CreateRollupInput = {
  slug: string;
  /** The stream the rollup folds. */
  source: string;
  /** Up to 16. */
  dimensions?: ReadonlyArray<string> | undefined;
  /** 1 to 64. */
  measures: ReadonlyArray<RollupMeasure>;
  /** Window length, at least 60. */
  windowSeconds: number;
  /** Days until the rollup pauses unless re-attested: 7, 30, 90 (default) or 365. */
  reattestIntervalDays?: ReattestDays | undefined;
  /** Per-subject data: cells below the cohort threshold are suppressed. Give this or `nonPersonal: true`, not both. */
  subjectField?: string | undefined;
  nonPersonal?: boolean | undefined;
};

/** `attestationStatus` is `active`, `expiring_soon` or `expired` (an expired rollup is paused, not deleted). */
export type Rollup = {
  id?: string;
  slug?: string;
  attestedAt?: string;
  expiresAt?: string;
  attestationStatus?: "active" | "expiring_soon" | "expired" | (string & {});
  [field: string]: unknown;
};

/** What `analytics.rollups.list` and `rollups.list` answer: the rollups under `rollups`. */
export type RollupList = { rollups: Rollup[] };

/** What `analytics.schedules.list` answers: the schedules under `schedules`. */
export type ScheduleList = { schedules: DatasetSchedule[] };

export type CreateDatasetScheduleInput = {
  fromCollection: string;
  /** At least 60. */
  intervalSeconds: number;
  reattestIntervalDays?: ReattestDays | undefined;
};

/** A recurring materialization, with `lastRunAt`, `lastRunStatus`, `nextRunAt` and its attestation state. */
export type DatasetSchedule = {
  id?: string;
  lastRunAt?: string | null;
  lastRunStatus?: string | null;
  nextRunAt?: string | null;
  attestedAt?: string;
  expiresAt?: string;
  attestationStatus?: string;
  [field: string]: unknown;
};

export type ReattestOptions = {
  /** A new interval: 7, 30, 90 or 365. Default: keep the current one. */
  reattestIntervalDays?: ReattestDays | undefined;
};

export type DeleteResult = { id: string; deleted: boolean };

export type RollupReadOptions = {
  /** ISO 8601 or a Date. Default: 24 hours ago. */
  from?: string | Date | undefined;
  /** ISO 8601 or a Date. Default: now. At most 50000 cells between `from` and `to`. */
  to?: string | Date | undefined;
  /** A projection of the dimensions; only `count`, `sum`, `min` and `max` measures combine. */
  dims?: string | ReadonlyArray<string> | undefined;
};

/** A cell below the cohort threshold arrives as `{ status: "suppressed", reason: "cohort_below_k" }`. */
export type RollupCell = { status?: string; reason?: string; [field: string]: unknown };

/**
 * The payload of one cell on a rollup's stream. A closed cell has `cellKey`, `bucket`, `dims`, `measures` and `final: true`;
 * a cell below the cohort threshold has `status: "suppressed"` and `reason: "cohort_below_k"` instead of values.
 */
export type RollupStreamCell = {
  cellKey: string;
  bucket: string;
  dims: Record<string, unknown>;
  final?: boolean | undefined;
  measures?: Record<string, unknown> | undefined;
  /** `"suppressed"` for a cell below the cohort threshold; absent on a closed cell. */
  status?: "suppressed" | (string & {}) | undefined;
  /** For a suppressed cell: `cohort_below_k`. */
  reason?: string | undefined;
  [field: string]: unknown;
};

/** `rollup` (its definition), `k` (the cohort threshold), `cells`, and `coverage` (the range, the last fold and whether it is complete). */
export type RollupReadResult = { rollup?: Record<string, unknown>; k?: number; cells?: RollupCell[]; coverage?: Record<string, unknown>; [field: string]: unknown };

/** One cell from a rollup's stream (`event: cell`). */
export type RollupCellEvent = {
  /** The frame's own id, used to drop a cell a resume re-sends. */
  eventId: string;
  eventType: "cell";
  /** The cell. */
  payload: RollupStreamCell;
  /** True when the cell is suppressed (below the cohort threshold): `payload.reason` says why and it carries no values. */
  suppressed: boolean;
  occurredAt?: string | undefined;
  topic?: string | undefined;
};

export type RollupSubscribeOptions = Pick<FeedOptions, "signal" | "idleTimeoutMs" | "retryDelayMs" | "dedupeMax" | "dedupeTtlMs"> & {
  /** Start from this position; applies to the first connection only. */
  fromSequence?: number | string | undefined;
  /** Called when the position is lost (`resync`): re-read with `rollups.read`. The stream then continues live; without it, it ends. */
  onResync?: ((resync: RealtimeResync) => void | Promise<void>) | undefined;
};

export type RollupSubscription = AsyncIterable<RollupCellEvent> & { close(): void };

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

const REATTEST_DAYS: ReadonlyArray<number> = [7, 30, 90, 365];
const COLUMN_TYPE = /^(string|int32|int64|float64|bool|date|timestamp|json|bytes|decimal\(\s*\d+\s*,\s*\d+\s*\))$/;

function requireProjectSlug(config: HttpClientConfig): string {
  if (typeof config.projectSlug !== "string" || config.projectSlug.length === 0) {
    throw new Error("analytics operations require projectSlug bound on the client");
  }
  return config.projectSlug;
}

function need(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${what} must be a non-empty string`);
  return encodeURIComponent(value);
}

function checkDays(days: unknown, where: string): void {
  if (days !== undefined && !REATTEST_DAYS.includes(days as number)) {
    throw new TypeError(`${where}: reattestIntervalDays must be 7, 30, 90 or 365`);
  }
}

function checkCreate(input: CreateDatasetInput, where: string): void {
  if (typeof input?.displayName !== "string" || input.displayName.length < 1 || input.displayName.length > 200) {
    throw new TypeError(`${where}: displayName must be 1 to 200 characters`);
  }
  if (!Array.isArray(input.columns) || input.columns.length < 1 || input.columns.length > 512) {
    throw new TypeError(`${where}: columns must hold 1 to 512 entries`);
  }
  for (const c of input.columns) {
    if (typeof c?.name !== "string" || c.name.length < 1 || c.name.length > 128) throw new TypeError(`${where}: a column name must be 1 to 128 characters`);
    if (typeof c.type !== "string" || !COLUMN_TYPE.test(c.type)) {
      throw new TypeError(`${where}: column type must be string, int32, int64, float64, bool, date, timestamp, json, bytes or decimal(p,s)`);
    }
  }
  if (input.partitionBy !== undefined && (!Array.isArray(input.partitionBy) || input.partitionBy.length > 16)) {
    throw new TypeError(`${where}: partitionBy holds at most 16 keys`);
  }
  if (input.residencyClass !== "per-subject" && input.residencyClass !== "shared") {
    throw new TypeError(`${where}: residencyClass must be "per-subject" or "shared"`);
  }
}

function iso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}

/**
 * A cell frame is `{ topic, eventType: "cell", payload, occurredAt, eventId }`; the payload is the cell. The frame's `id:` is the
 * resume cursor (the feed reader sends it as `Last-Event-ID`); `eventId` is what drops a re-sent cell.
 */
function rollupCellDecode(frame: SseFrame, parsed: Record<string, unknown>): { eventId: string; event: RollupCellEvent } | null {
  if (frame.event !== undefined && frame.event !== "cell" && frame.event !== "message") return null;
  const wire = parsed["eventId"];
  const eventId = typeof wire === "string" ? wire : (frame.id ?? "");
  const inner = parsed["payload"];
  const payload = (typeof inner === "object" && inner !== null && !Array.isArray(inner) ? inner : parsed) as RollupStreamCell;
  const event: RollupCellEvent = { eventId, eventType: "cell", payload, suppressed: payload.status === "suppressed" };
  if (typeof parsed["occurredAt"] === "string") event.occurredAt = parsed["occurredAt"];
  if (typeof parsed["topic"] === "string") event.topic = parsed["topic"];
  return { eventId, event };
}

/** The file-name parameter of a `Content-Disposition` header. */
function dispositionName(h: string | null): string | null {
  if (h === null) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(h);
  if (star?.[1] !== undefined) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(h);
  return plain?.[1]?.trim() ?? null;
}

function toBlob(data: Blob | Uint8Array | ArrayBuffer | string, type: string): Blob {
  if (data instanceof Blob) return data.type === type || data.type !== "" ? data : new Blob([data], { type });
  if (typeof data === "string") return new Blob([data], { type });
  return new Blob([data as unknown as ArrayBuffer], { type });
}

// ----------------------------------------------------------------------
// Namespaces
// ----------------------------------------------------------------------

export function makeAnalyticsNamespace(config: HttpClientConfig) {
  const path = (sub: string) => projectPath(requireProjectSlug(config), sub);
  const ds = (slug: string) => `analytics/${need(slug, "dataset slug")}`;

  return {
    /** The project's active datasets, newest first. Needs `datasets:list`. */
    async list(): Promise<Envelope<Dataset[]>> {
      return request<Dataset[]>(config, { method: "GET", path: path("analytics") });
    },

    /**
     * Run a read-only SQL `SELECT` over datasets. Reference each as `dataset.<slug>` and list the slugs in `datasets`.
     * Errors: 400 `K9O_QUERY_INVALID` (a table that is not a declared dataset), 404 `K9O_DATASET_NOT_FOUND`,
     * 500 `K9O_QUERY_EXECUTION_FAILED`, 503 `K9O_ANALYTICS_UNAVAILABLE` (the region's analytics storage is not ready).
     */
    async query(input: DatasetQueryInput): Promise<Envelope<unknown>> {
      if (typeof input?.sql !== "string" || input.sql.trim().length === 0 || input.sql.length > 100_000) {
        throw new TypeError("analytics.query: sql must be 1 to 100000 characters");
      }
      if (!Array.isArray(input.datasets) || input.datasets.length < 1 || input.datasets.length > 64) {
        throw new TypeError("analytics.query: datasets must list 1 to 64 slugs");
      }
      return request<unknown>(config, { method: "POST", path: path("analytics/query"), body: { sql: input.sql, datasets: input.datasets } });
    },

    /**
     * Create a dataset at `slug` (never reissued, even after delete). At most 200 per project
     * (429 `K9O_DATASET_LIMIT_EXCEEDED`). Needs `datasets:create` (PROJECT_ADMIN or PROJECT_AUTHOR by default).
     */
    async create(slug: string, input: CreateDatasetInput): Promise<Envelope<Dataset>> {
      const base = ds(slug);
      checkCreate(input, "analytics.create");
      return request<Dataset>(config, {
        method: "POST",
        path: path(base),
        body: {
          displayName: input.displayName,
          columns: input.columns,
          residencyClass: input.residencyClass,
          ...(input.partitionBy !== undefined ? { partitionBy: input.partitionBy } : {}),
          ...(input.storageTarget !== undefined ? { storageTarget: input.storageTarget } : {}),
        },
      });
    },

    /** One active dataset. A deleted or unknown slug is 404 `K9O_DATASET_NOT_FOUND`. */
    async get(slug: string): Promise<Envelope<Dataset>> {
      return request<Dataset>(config, { method: "GET", path: path(ds(slug)) });
    },

    /** Retire a dataset: it reads as absent from then on and its slug is never reissued. Answers `{ slug, status: "retired" }`. */
    async delete(slug: string): Promise<Envelope<{ slug: string; status: string }>> {
      return request<{ slug: string; status: string }>(config, { method: "DELETE", path: path(ds(slug)) });
    },

    /**
     * Copy rows into a dataset from exactly one source: `{ fromCollection }` or `{ fromQuery }` (a saved Studio query id).
     * The source is read with your own row-level access. Per-subject data cannot go into a `shared` dataset
     * (400 `K9O_DATASET_RESIDENCY_SOURCE_MISMATCH`).
     */
    async materialize(slug: string, source: MaterializeSource): Promise<Envelope<MaterializeResult>> {
      const base = ds(slug);
      const hasC = typeof source?.fromCollection === "string" && source.fromCollection.length > 0;
      const hasQ = typeof source?.fromQuery === "string" && source.fromQuery.length > 0;
      if (hasC === hasQ) throw new TypeError("analytics.materialize: pass exactly one of fromCollection or fromQuery");
      return request<MaterializeResult>(config, {
        method: "POST",
        path: path(`${base}/materialize`),
        body: hasC ? { fromCollection: source.fromCollection } : { fromQuery: source.fromQuery },
      });
    },

    /**
     * Page through a dataset's rows. `meta.cursor.next` continues (`null` on the last page); the first page's `meta.schema`
     * describes the columns.
     */
    async read(slug: string, options: DatasetReadOptions = {}): Promise<PaginatedEnvelope<DatasetRow[]>> {
      const base = ds(slug);
      if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
        throw new TypeError("analytics.read: limit must be a positive integer");
      }
      return request<DatasetRow[]>(config, {
        method: "POST",
        path: path(`${base}/read`),
        body: {
          ...(options.partitionFilter !== undefined ? { partitionFilter: options.partitionFilter } : {}),
          ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        },
      }) as Promise<PaginatedEnvelope<DatasetRow[]>>;
    },

    /**
     * Append rows: an array of objects (sent as a JSON array) or a string of newline-delimited JSON. Each row is checked
     * against the dataset's schema. Platform telemetry datasets cannot be written.
     */
    async write(slug: string, rows: ReadonlyArray<Record<string, unknown>> | string, options: DatasetWriteOptions = {}): Promise<Envelope<DatasetIngestResult>> {
      const base = ds(slug);
      if (options.onError !== undefined && options.onError !== "skip" && options.onError !== "reject") {
        throw new TypeError('analytics.write: onError must be "skip" or "reject"');
      }
      const query = options.onError !== undefined ? { onError: options.onError } : undefined;
      if (typeof rows === "string") {
        if (rows.trim().length === 0) throw new TypeError("analytics.write: rows is empty");
        return request<DatasetIngestResult>(config, {
          method: "POST",
          path: path(`${base}/write`),
          rawBody: new TextEncoder().encode(rows),
          headers: { "content-type": "application/x-ndjson" },
          ...(query ? { query } : {}),
        });
      }
      if (!Array.isArray(rows) || rows.length === 0) throw new TypeError("analytics.write: rows must be a non-empty array or an NDJSON string");
      return request<DatasetIngestResult>(config, { method: "POST", path: path(`${base}/write`), body: rows, ...(query ? { query } : {}) });
    },

    /**
     * Upload a CSV or JSON file (up to 25 MiB) into a dataset. With `manifest` on a slug that does not exist yet, the
     * dataset is created and loaded in one call. `dryRun: true` returns the detected columns and a 50-row preview and
     * writes nothing. The original file is kept: see `downloadOriginal`.
     */
    async upload(slug: string, file: Blob | Uint8Array | ArrayBuffer | string, options: DatasetUploadOptions): Promise<Envelope<DatasetIngestResult>> {
      const base = ds(slug);
      if (options?.format !== "csv" && options?.format !== "json") throw new TypeError('analytics.upload: format must be "csv" or "json"');
      if (options.onError !== undefined && options.onError !== "skip" && options.onError !== "reject") {
        throw new TypeError('analytics.upload: onError must be "skip" or "reject"');
      }
      if (options.manifest !== undefined) checkCreate(options.manifest, "analytics.upload manifest");
      const type = options.contentType ?? (options.format === "csv" ? "text/csv" : "application/json");
      const form = new FormData();
      form.append("file", toBlob(file, type), options.fileName ?? `upload.${options.format}`);
      if (options.manifest !== undefined) form.append("manifest", JSON.stringify(options.manifest));
      return request<DatasetIngestResult>(config, {
        method: "POST",
        path: path(`${base}/upload`),
        body: form,
        query: {
          format: options.format,
          dryRun: options.dryRun,
          onError: options.onError,
          delimiter: options.delimiter,
          encoding: options.encoding,
          hasHeader: options.hasHeader,
        },
      });
    },

    /** The original file of the dataset's stored upload, as bytes. 404 `K9O_NOT_FOUND` when none is stored. */
    async downloadOriginal(slug: string): Promise<DownloadedFile> {
      const base = ds(slug);
      const res = await requestStream(config, { method: "GET", path: path(`${base}/upload/original`), accept: "*/*" });
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        contentType: res.headers.get("content-type"),
        fileName: dispositionName(res.headers.get("content-disposition")),
      };
    },

    /**
     * Continuous rollups of a dataset. A rollup pauses once its `reattestIntervalDays` (default 90) have passed without a
     * re-attestation; `reattest` is for people only.
     */
    rollups: {
      /** Create a rollup that folds `source` into the dataset over fixed windows. Needs `datasets:write`. 409 `K9O_ALREADY_EXISTS` for a repeated slug. */
      async create(datasetSlug: string, input: CreateRollupInput): Promise<Envelope<Rollup>> {
        const base = ds(datasetSlug);
        if (typeof input?.slug !== "string" || input.slug.length < 1 || input.slug.length > 63) throw new TypeError("analytics.rollups.create: slug must be 1 to 63 characters");
        if (typeof input.source !== "string" || input.source.length < 1) throw new TypeError("analytics.rollups.create: source is required");
        if (!Array.isArray(input.measures) || input.measures.length < 1 || input.measures.length > 64) throw new TypeError("analytics.rollups.create: measures must hold 1 to 64 entries");
        if (input.dimensions !== undefined && input.dimensions.length > 16) throw new TypeError("analytics.rollups.create: dimensions holds at most 16 entries");
        if (!Number.isInteger(input.windowSeconds) || input.windowSeconds < 60) throw new TypeError("analytics.rollups.create: windowSeconds must be an integer of at least 60");
        const hasSubject = typeof input.subjectField === "string" && input.subjectField.length > 0;
        const nonPersonal = input.nonPersonal === true;
        if (hasSubject === nonPersonal) throw new TypeError("analytics.rollups.create: pass exactly one of subjectField or nonPersonal: true");
        checkDays(input.reattestIntervalDays, "analytics.rollups.create");
        return request<Rollup>(config, {
          method: "POST",
          path: path(`${base}/rollups`),
          body: {
            slug: input.slug,
            source: input.source,
            measures: input.measures,
            windowSeconds: input.windowSeconds,
            ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {}),
            ...(input.reattestIntervalDays !== undefined ? { reattestIntervalDays: input.reattestIntervalDays } : {}),
            ...(hasSubject ? { subjectField: input.subjectField } : { nonPersonal: true }),
          },
        });
      },

      /** The dataset's rollups with `attestedAt`, `expiresAt` and `attestationStatus`. */
      async list(datasetSlug: string): Promise<Envelope<RollupList>> {
        return request<RollupList>(config, { method: "GET", path: path(`${ds(datasetSlug)}/rollups`) });
      },

      /** Delete a rollup. Answers `{ id, deleted: true }`. */
      async delete(datasetSlug: string, rollupId: string): Promise<Envelope<DeleteResult>> {
        const base = ds(datasetSlug);
        return request<DeleteResult>(config, { method: "DELETE", path: path(`${base}/rollups/${need(rollupId, "rollupId")}`) });
      },

      /**
       * Confirm the rollup is still wanted: its attestation restarts now, optionally with a new interval (7, 30, 90 or
       * 365 days), and an expired rollup resumes. HUMAN ONLY: a service, workload or extension token gets
       * 403 `K9O_RBAC_DENY` with `context.reason` `human_only`; a personal access token acts as its person.
       */
      async reattest(datasetSlug: string, rollupId: string, options: ReattestOptions = {}): Promise<Envelope<Rollup>> {
        const base = ds(datasetSlug);
        checkDays(options.reattestIntervalDays, "analytics.rollups.reattest");
        return request<Rollup>(config, {
          method: "POST",
          path: path(`${base}/rollups/${need(rollupId, "rollupId")}/reattest`),
          body: options.reattestIntervalDays !== undefined ? { reattestIntervalDays: options.reattestIntervalDays } : {},
        });
      },
    },

    /**
     * Recurring materializations from a collection into a dataset. A schedule stops running once its
     * `reattestIntervalDays` have passed without a re-attestation; `reattest` is for people only.
     */
    schedules: {
      /** Create a schedule. Each run reads the collection with its creator's current access. 409 when one exists for this dataset and collection. */
      async create(datasetSlug: string, input: CreateDatasetScheduleInput): Promise<Envelope<DatasetSchedule>> {
        const base = ds(datasetSlug);
        if (typeof input?.fromCollection !== "string" || input.fromCollection.length < 1) throw new TypeError("analytics.schedules.create: fromCollection is required");
        if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < 60) throw new TypeError("analytics.schedules.create: intervalSeconds must be an integer of at least 60");
        checkDays(input.reattestIntervalDays, "analytics.schedules.create");
        return request<DatasetSchedule>(config, {
          method: "POST",
          path: path(`${base}/schedules`),
          body: {
            fromCollection: input.fromCollection,
            intervalSeconds: input.intervalSeconds,
            ...(input.reattestIntervalDays !== undefined ? { reattestIntervalDays: input.reattestIntervalDays } : {}),
          },
        });
      },

      /** The dataset's schedules with `lastRunAt`, `lastRunStatus`, `nextRunAt` and their attestation state. */
      async list(datasetSlug: string): Promise<Envelope<ScheduleList>> {
        return request<ScheduleList>(config, { method: "GET", path: path(`${ds(datasetSlug)}/schedules`) });
      },

      /** Delete a schedule. Answers `{ id, deleted: true }`. */
      async delete(datasetSlug: string, scheduleId: string): Promise<Envelope<DeleteResult>> {
        const base = ds(datasetSlug);
        return request<DeleteResult>(config, { method: "DELETE", path: path(`${base}/schedules/${need(scheduleId, "scheduleId")}`) });
      },

      /**
       * Confirm the schedule is still wanted: its attestation restarts now, optionally with a new interval, and a paused
       * schedule resumes. HUMAN ONLY: a service, workload or extension token gets 403 `K9O_RBAC_DENY` with
       * `context.reason` `human_only`; a personal access token acts as its person.
       */
      async reattest(datasetSlug: string, scheduleId: string, options: ReattestOptions = {}): Promise<Envelope<DatasetSchedule>> {
        const base = ds(datasetSlug);
        checkDays(options.reattestIntervalDays, "analytics.schedules.reattest");
        return request<DatasetSchedule>(config, {
          method: "POST",
          path: path(`${base}/schedules/${need(scheduleId, "scheduleId")}/reattest`),
          body: options.reattestIntervalDays !== undefined ? { reattestIntervalDays: options.reattestIntervalDays } : {},
        });
      },
    },
  };
}

export function makeRollupsNamespace(config: HttpClientConfig) {
  const path = (sub: string) => projectPath(requireProjectSlug(config), sub);

  return {
    /** Every rollup in the project whose dataset you can read, with its read and subscribe endpoints. Needs `datasets:list`. */
    async list(): Promise<Envelope<RollupList>> {
      return request<RollupList>(config, { method: "GET", path: path("rollups") });
    },

    /**
     * The rollup's cells for a time range (default the last 24 hours, at most 50000 cells). Cells below the cohort
     * threshold come back as `{ status: "suppressed", reason: "cohort_below_k" }`; `coverage` says whether the range is complete.
     * Needs `datasets:read` on the rollup's dataset and `datasets:query`.
     */
    async read(rollupSlug: string, options: RollupReadOptions = {}): Promise<Envelope<RollupReadResult>> {
      const slug = need(rollupSlug, "rollup slug");
      const dims = options.dims === undefined ? undefined : typeof options.dims === "string" ? options.dims : options.dims.join(",");
      return request<RollupReadResult>(config, {
        method: "GET",
        path: path(`rollups/${slug}/read`),
        query: {
          from: options.from === undefined ? undefined : iso(options.from),
          to: options.to === undefined ? undefined : iso(options.to),
          dims,
        },
      });
    },

    /**
     * Follow a rollup: one `cell` event per closed cell, over server-sent events; `payload` is the cell
     * (`cellKey`, `bucket`, `dims`, `measures`, `final`), and a cell below the cohort threshold has `suppressed: true`
     * with `payload.status` `suppressed` and `payload.reason` `cohort_below_k`. The stream sends a heartbeat every 15 seconds and
     * a connection lasts at most 300 seconds; the reader then reconnects with `Last-Event-ID` (the frame's `id:`, or
     * `fromSequence` on the first connection), and drops the last few seconds the gateway re-sends by `eventId`.
     * `onResync` is called with action `reread-source` when the position cannot be resumed: re-read with `read`.
     * The stream ends when the access token expires. 429 `K9O_SUBSCRIPTION_LIMIT_EXCEEDED` when you have too many open streams.
     */
    subscribe(rollupSlug: string, options: RollupSubscribeOptions = {}): RollupSubscription {
      const slug = need(rollupSlug, "rollup slug");
      const { fromSequence, ...feed } = options;
      return openFeed(
        config,
        {
          path: `rollups/${slug}/subscribe`,
          query: {},
          ...(fromSequence !== undefined ? { initialQuery: { fromSequence } } : {}),
          decode: (frame, parsed) => rollupCellDecode(frame, parsed),
        },
        feed,
      ) as unknown as RollupSubscription;
    },
  };
}
