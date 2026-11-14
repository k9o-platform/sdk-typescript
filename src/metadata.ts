/**
 * Metadata SDK: `client.metadata.*`. Metadata is a set of columns you declare on a collection (or on another data
 * surface) so that they can be filtered, searched and followed live through one API, with the same access rules as
 * the data itself.
 *
 * Wire mapping (project plane):
 *   - `filter({ surfaces, where?, limit?, cursor? })`          -> POST /@<slug>/metadata/query
 *   - `set(collection, id, metadata)`                          -> PATCH /@<slug>/metadata/collection/<collection>/<id>
 *   - `search({ surface, field, q, limit? })`                  -> POST /@<slug>/metadata/search
 *   - `vectors.nearest({ surface, column, embedding, ... })`   -> POST /@<slug>/metadata/vectors/nearest
 *   - `subscribe(surface, options?)`                           -> GET  /@<slug>/metadata/subscribe?surface=  (SSE)
 *   - `index.get(collection)`                                  -> GET  /@<slug>/metadata/index/<collection>
 *   - `index.declare(collection, columns)`                     -> PUT  /@<slug>/metadata/index/<collection>
 *
 * Columns are declared first (`index.declare`); `set` writes declared columns only, and `filter`, `search` and
 * `vectors.nearest` read declared columns only. Column names given to `filter` (`where[].field`), `search` (`field`)
 * and `vectors.nearest` (`column`) are sent as `metadata.<name>`; the prefix is added when you leave it out.
 * Rows come back with bare column names under `metadata`.
 *
 * Errors arrive as `KError` with the gateway's code. The ones to expect:
 *   - 400 `K9O_UNKNOWN_SURFACE`: the surface is not `collection:<name>`, `telemetry:<event>` or `storage:<bucket>`.
 *   - 400 `K9O_METADATA_FIELD_NOT_INDEXED`: the column is not declared (`context.field`; the recommendation shows how to declare it).
 *   - 400 `K9O_ENCRYPTED_COLUMN_OPERATION_UNSUPPORTED`: an encrypted column supports only `eq` (not null) and `in`, no search or nearest.
 *   - 400 `K9O_INVALID_FIELD_VALUE`, `K9O_INVALID_CURSOR`: a bad body field or cursor.
 *   - 403 `K9O_ACCESS_DENIED`, `K9O_EXTENSION_PERMISSION_DENIED`: no access to the surface.
 *   - 404 `K9O_COLLECTION_NOT_FOUND` (declare on a missing collection), `K9O_NOT_FOUND` (set on a missing record).
 *   - 413 `K9O_QUERY_RESULT_TOO_LARGE`: more than 10000 rows across the surfaces (`context.cap`, `context.surfaces`).
 *   - 501 `K9O_NOT_IMPLEMENTED`: `storage:` surfaces are accepted by the SDK, and the gateway answers 501 for them.
 */

import { request, type HttpClientConfig } from "./http.ts";
import { KError } from "./kerror.ts";
import { projectPath } from "./url-grammar.ts";
import type { Envelope } from "./envelope.ts";
import { openFeed, type RealtimeEvent, type RealtimeSubscription, type SubscribeOptions } from "./realtime.ts";

/**
 * Comparison operators of a `where` clause. `and`, `or` and `not` are part of the grammar, but the gateway refuses them
 * today (400 `K9O_INVALID_FIELD_VALUE` on a collection surface, `K9O_METADATA_FIELD_NOT_INDEXED` on telemetry).
 */
export type MetadataOp =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "startsWith" | "endsWith" | "in" | "notIn"
  | "and" | "or" | "not";

/**
 * One condition. On a `collection:` surface `field` is a declared column (`priority` or `metadata.priority`; the prefix is
 * added when missing) and each field may appear once. On a `telemetry:` surface the fields are `createdAt` (with
 * `gt`, `gte`, `lt`, `lte`) and `actorId` (with `eq`).
 */
export type MetadataWhere = {
  field: string;
  op: MetadataOp;
  value?: unknown;
};

/**
 * One result row. A `collection:` row has `recordId`; a `telemetry:` row has `eventId`. `metadata` holds the declared
 * columns that are present on the row, under their bare names (an undeclared column never appears).
 */
export type MetadataRow = {
  surface: string;
  scope: string;
  recordId?: string | undefined;
  eventId?: string | undefined;
  metadata: Record<string, unknown>;
};

/** A page of rows. `cursor` is the cursor of the next page, or `null` when there is none. */
export type MetadataPage = Envelope<MetadataRow[]> & { cursor: string | null };

export type MetadataFilterInput = {
  /** One or more surfaces: `collection:<name>`, `telemetry:<event-prefix>` or `storage:<bucket>`. */
  surfaces: ReadonlyArray<string>;
  /** Conditions applied to every surface named. */
  where?: ReadonlyArray<MetadataWhere> | undefined;
  /** Rows per surface, 1 to 1000. The gateway defaults to 100. */
  limit?: number | undefined;
  /** The `cursor` of the previous page. Allowed with exactly one surface. */
  cursor?: string | undefined;
};

export type MetadataSearchInput = {
  /** A `collection:<name>` surface. */
  surface: string;
  /** The declared text column: `body` or `metadata.body`. */
  field: string;
  /** The words to look for. Matching is by word stem, so "finance" does not match "financial". */
  q: string;
  /** 1 to 1000. The gateway defaults to 50. Search has no second page. */
  limit?: number | undefined;
};

export type MetadataMetric = "cosine" | "euclidean" | "dot";

export type MetadataNearestInput = {
  /** A `collection:<name>` surface. */
  surface: string;
  /** The declared vector column: `embedding` or `metadata.embedding`. */
  column: string;
  /** The query embedding: a non-empty array of finite numbers. */
  embedding: ReadonlyArray<number>;
  /** How many rows to return, 1 to 1000. The gateway defaults to 10. */
  k?: number | undefined;
  /** Default `cosine`. */
  metric?: MetadataMetric | undefined;
  /** Conditions that rows must also meet; the same grammar as `filter`. */
  where?: ReadonlyArray<MetadataWhere> | undefined;
};

/** The row returned by `set`: the whole updated record, including columns that are not declared. */
export type MetadataRecord = Record<string, unknown>;

/** The payload of a metadata change event: which record changed. The new values are not in the event; read the record by `id`. */
export type MetadataChange = {
  collection: string;
  id: string;
};

export type MetadataSubscribeOptions = Pick<SubscribeOptions, "signal" | "onResync" | "idleTimeoutMs" | "retryDelayMs"> & {
  /** Start from this feed position instead of from now. Ignored once the subscription has resumed by itself or been resynced. */
  fromSequence?: number | undefined;
};

export type MetadataIndexColumn = {
  column: string;
  /** Default false. */
  indexed?: boolean | undefined;
};

/** A collection's declaration: its declared columns, ordered by name. */
export type MetadataIndex = {
  collection: string;
  columns: Array<{ column: string; indexed: boolean }>;
};

const OPS: ReadonlyArray<string> = [
  "eq", "neq", "gt", "gte", "lt", "lte", "contains", "startsWith", "endsWith", "in", "notIn", "and", "or", "not",
];
const METRICS: ReadonlyArray<string> = ["cosine", "euclidean", "dot"];
const SLICES: ReadonlyArray<string> = ["collection", "telemetry", "storage"];
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const PREFIX = "metadata.";
const MAX_COLUMNS = 64;
const MAX_LIMIT = 1000;
/** On a telemetry surface these where fields are bare, never prefixed. */
const TELEMETRY_FIELDS: ReadonlyArray<string> = ["createdAt", "actorId"];

function invalid(message: string, context: Record<string, unknown> = {}): KError {
  return new KError({ code: "K9O_INVALID_FIELD_VALUE", message, context, recommendation: null });
}

function sliceOf(surface: string): string {
  return surface.slice(0, surface.indexOf(":"));
}

function checkSurface(surface: unknown, name: string): string {
  if (typeof surface !== "string") throw invalid(`${name} must be a string such as collection:posts`, { surface });
  const at = surface.indexOf(":");
  const slice = at < 0 ? "" : surface.slice(0, at);
  const scope = at < 0 ? "" : surface.slice(at + 1);
  if (!SLICES.includes(slice) || !SCOPE.test(scope) || (slice === "collection" && !IDENT.test(scope))) {
    throw new KError({
      code: "K9O_UNKNOWN_SURFACE",
      message: `${name} "${surface}" is not a surface: use collection:<name>, telemetry:<event> or storage:<bucket>`,
      context: { surface },
      recommendation: null,
    });
  }
  return surface;
}

function checkCollectionSurface(surface: unknown, name: string): string {
  const s = checkSurface(surface, name);
  if (sliceOf(s) !== "collection") throw invalid(`${name} must be a collection surface (collection:<name>)`, { surface: s });
  return s;
}

function checkLimit(value: unknown, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_LIMIT)) {
    throw invalid(`${name} must be a whole number from 1 to ${MAX_LIMIT}`, { [name]: value });
  }
}

/** The name on the wire: `metadata.<name>`, adding the prefix when it is missing. */
function prefixed(name: unknown, label: string): string {
  if (typeof name !== "string" || name.length === 0 || name === PREFIX) throw invalid(`${label} must be a column name`, { [label]: name });
  return name.startsWith(PREFIX) ? name : `${PREFIX}${name}`;
}

function wireWhere(where: unknown, telemetry: boolean): MetadataWhere[] | undefined {
  if (where === undefined) return undefined;
  if (!Array.isArray(where)) throw invalid("where must be an array of { field, op, value }");
  return where.map((clause: unknown, index) => {
    if (clause === null || typeof clause !== "object" || Array.isArray(clause)) throw invalid(`where[${index}] must be an object`);
    const c = clause as MetadataWhere;
    if (typeof c.op !== "string" || !OPS.includes(c.op)) throw invalid(`where[${index}].op must be one of: ${OPS.join(", ")}`, { op: c.op });
    const bare = telemetry && typeof c.field === "string" && TELEMETRY_FIELDS.includes(c.field);
    return { ...c, field: bare ? c.field : prefixed(c.field, `where[${index}].field`) };
  });
}

export function makeMetadataNamespace(config: HttpClientConfig) {
  const path = (tail: string): string => {
    if (typeof config.projectSlug !== "string" || config.projectSlug.length === 0) {
      throw new Error("metadata operations require projectSlug bound on the client");
    }
    return projectPath(config.projectSlug, `metadata/${tail}`);
  };
  const collectionName = (collection: unknown): string => {
    if (typeof collection !== "string" || !IDENT.test(collection)) throw invalid("collection must be a collection name", { collection });
    return collection;
  };
  const page = (envelope: Envelope<MetadataRow[]>): MetadataPage => {
    const c = (envelope.meta as { cursor?: { next?: unknown } | undefined } | undefined)?.cursor?.next;
    return { ...envelope, cursor: typeof c === "string" ? c : null };
  };

  return {
    /**
     * Rows of one or more surfaces whose declared columns meet `where`, in request order. Pages with `cursor` when exactly
     * one surface is named (`page.cursor`, `null` on the last page). More than 10000 rows in all answers 413
     * `K9O_QUERY_RESULT_TOO_LARGE`; a `storage:` surface answers 501 `K9O_NOT_IMPLEMENTED`.
     */
    async filter(input: MetadataFilterInput): Promise<MetadataPage> {
      const where = path("query");
      if (input === null || typeof input !== "object") throw invalid("input must be an object");
      if (!Array.isArray(input.surfaces) || input.surfaces.length < 1) throw invalid("surfaces must be a non-empty array");
      const surfaces = input.surfaces.map((s, i) => checkSurface(s, `surfaces[${i}]`));
      checkLimit(input.limit, "limit");
      if (input.cursor !== undefined) {
        if (typeof input.cursor !== "string" || input.cursor.length === 0) throw invalid("cursor must be the cursor of a previous page");
        if (surfaces.length !== 1) throw invalid("cursor is allowed only with exactly one surface", { field: "cursor" });
      }
      const wire = wireWhere(input.where, surfaces.some((s) => sliceOf(s) === "telemetry"));
      const body = {
        surfaces,
        ...(wire !== undefined ? { where: wire } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      };
      return page(await request<MetadataRow[]>(config, { method: "POST", path: where, body }));
    },

    /**
     * Write declared columns of one record: `set("posts", "p2", { title: "New", priority: 9 })`. Keys are bare column names
     * (a leading `metadata.` is dropped); a column that is not declared answers 400 `K9O_METADATA_FIELD_NOT_INDEXED`.
     * Returns the whole updated record. The write runs through the record API's rules, so a write that needs approval
     * is queued as it is there.
     */
    async set(collection: string, id: string, metadata: Record<string, unknown>): Promise<Envelope<MetadataRecord>> {
      const name = collectionName(collection);
      if (typeof id !== "string" || id.length === 0) throw invalid("id must be a record id", { id });
      if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata) || Object.keys(metadata).length === 0) {
        throw invalid("metadata must be an object with at least one column");
      }
      const bare: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(metadata)) bare[key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key] = value;
      return request<MetadataRecord>(config, {
        method: "PATCH",
        path: path(`collection/${encodeURIComponent(name)}/${encodeURIComponent(id)}`),
        body: { metadata: bare },
      });
    },

    /**
     * Full-text search over one declared text column of a collection. Returns the first page only (there is no cursor
     * input), no rank.
     */
    async search(input: MetadataSearchInput): Promise<MetadataPage> {
      const where = path("search");
      if (input === null || typeof input !== "object") throw invalid("input must be an object");
      const surface = checkCollectionSurface(input.surface, "surface");
      const field = prefixed(input.field, "field");
      if (typeof input.q !== "string" || input.q.length === 0) throw invalid("q must be a non-empty string");
      checkLimit(input.limit, "limit");
      const body = { surface, field, q: input.q, ...(input.limit !== undefined ? { limit: input.limit } : {}) };
      return page(await request<MetadataRow[]>(config, { method: "POST", path: where, body }));
    },

    vectors: {
      /**
       * The rows whose declared vector column is nearest to `embedding`, closest first. Rows carry no score. At most 50
       * rows come back whatever `k` is, until the gateway forwards a larger page size.
       */
      async nearest(input: MetadataNearestInput): Promise<MetadataPage> {
        const where = path("vectors/nearest");
        if (input === null || typeof input !== "object") throw invalid("input must be an object");
        const surface = checkCollectionSurface(input.surface, "surface");
        const column = prefixed(input.column, "column");
        if (!Array.isArray(input.embedding) || input.embedding.length < 1) throw invalid("embedding must be a non-empty array of numbers");
        if (!input.embedding.every((n) => typeof n === "number" && Number.isFinite(n))) throw invalid("embedding must contain only finite numbers");
        checkLimit(input.k, "k");
        if (input.metric !== undefined && !METRICS.includes(input.metric)) {
          throw invalid(`metric must be one of: ${METRICS.join(", ")}`, { metric: input.metric });
        }
        const wire = wireWhere(input.where, false);
        const body = {
          surface,
          column,
          embedding: input.embedding,
          ...(input.k !== undefined ? { k: input.k } : {}),
          ...(input.metric !== undefined ? { metric: input.metric } : {}),
          ...(wire !== undefined ? { where: wire } : {}),
        };
        return page(await request<MetadataRow[]>(config, { method: "POST", path: where, body }));
      },
    },

    /**
     * Follow changes of a `collection:<name>` surface live. Each event is `row_inserted`, `row_updated` or `row_deleted`
     * with `payload: { collection, id }` only, so read the record by id for its values. It is the change-feed reader of
     * `realtime.subscribe`: it reconnects with `Last-Event-ID`, drops events it already delivered and calls `onResync`
     * when the position is lost. `fromSequence` starts from a known position. Changes to undeclared columns are reported too.
     */
    subscribe(surface: string, options: MetadataSubscribeOptions = {}): RealtimeSubscription<MetadataChange> {
      const target = checkCollectionSurface(surface, "surface");
      const from = options.fromSequence;
      if (from !== undefined && (!Number.isInteger(from) || from < 0)) throw invalid("fromSequence must be a whole number, 0 or more", { fromSequence: from });
      return openFeed<MetadataChange>(
        config,
        { path: "metadata/subscribe", query: { surface: target }, ...(from !== undefined ? { initialQuery: { fromSequence: from } } : {}) },
        options,
      );
    },

    index: {
      /** The columns declared on a collection, ordered by name. */
      async get(collection: string): Promise<Envelope<MetadataIndex>> {
        const name = collectionName(collection);
        return request<MetadataIndex>(config, { method: "GET", path: path(`index/${encodeURIComponent(name)}`) });
      },

      /**
       * Declare the columns of a collection that metadata may use. The columns must already exist on the collection.
       * The list replaces the previous declaration (an empty list clears it); at most 64 columns, no `id`, no duplicates.
       * Needs the project-admin role and the migrations permission.
       */
      async declare(collection: string, columns: ReadonlyArray<MetadataIndexColumn>): Promise<Envelope<MetadataIndex>> {
        const name = collectionName(collection);
        if (!Array.isArray(columns)) throw invalid("columns must be an array of { column, indexed? }");
        if (columns.length > MAX_COLUMNS) throw invalid(`at most ${MAX_COLUMNS} columns can be declared`, { count: columns.length });
        const seen = new Set<string>();
        columns.forEach((c, index) => {
          if (c === null || typeof c !== "object") throw invalid(`columns[${index}] must be an object`);
          if (typeof c.column !== "string" || !IDENT.test(c.column) || c.column === "id") {
            throw invalid(`columns[${index}].column must be a column name other than id`, { column: c.column });
          }
          if (c.indexed !== undefined && typeof c.indexed !== "boolean") throw invalid(`columns[${index}].indexed must be true or false`);
          if (seen.has(c.column)) throw invalid(`column "${c.column}" is listed twice`, { column: c.column });
          seen.add(c.column);
        });
        return request<MetadataIndex>(config, { method: "PUT", path: path(`index/${encodeURIComponent(name)}`), body: { columns } });
      },
    },
  };
}

export type MetadataChangeEvent = RealtimeEvent<MetadataChange>;
