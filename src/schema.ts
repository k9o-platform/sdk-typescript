/**
 * Schema SDK: `client.schema.*`.
 *
 * Wire mapping (project plane):
 *   - `collections.list({ limit?, cursor? })` -> GET /@<slug>/schema/collections
 *   - `collections.get(name)`                 -> GET /@<slug>/schema/collections/<name>
 *
 * The list is cursor-paginated, ordered by collection name: pass `meta.cursor.next` of one page as `cursor` of the
 * next, until it is null.
 */

import { request, type HttpClientConfig } from "./http.ts";
import { KError } from "./kerror.ts";
import { projectPath } from "./url-grammar.ts";
import type { Envelope, PaginatedEnvelope } from "./envelope.ts";

/** One collection (table) of the project's data. */
export type CollectionSummary = {
  name: string;
  /** Live row count, excluding soft-deleted rows. Ignores row-level security. */
  rowCount: number;
  rowCountIsExact: boolean;
  columnCount: number;
  indexCount: number;
  lastMigrationSlug: string | null;
  lastMigrationAppliedAt: string | null;
};

/** One column of a collection. */
export type CollectionColumn = {
  name: string;
  type: string;
  nullable: boolean;
  isPrimary: boolean;
  isUnique: boolean;
  default: string | null;
  vectorDimension: number | null;
  /** True for a column the platform reserves (its name begins with `_`). */
  reserved: boolean;
  /** True when this column holds the owner of each row (the end user the row belongs to). */
  isOwnerColumn: boolean;
  /** Field-level protection of the column, or null when it is not protected. */
  protection: {
    encrypted: boolean;
    store: "inline" | "vault";
    blindIndexed: boolean;
    searchable: boolean;
    revealGated: boolean;
  } | null;
};

export type CollectionIndex = {
  name: string;
  columns: ReadonlyArray<string>;
  type: string;
  unique: boolean;
  status: "active" | "building" | "invalid";
};

/** A column that joins to another collection. */
export type CollectionRelationship = {
  column: string;
  joinAlias: string;
  /** `!inner` or `!left`. */
  joinType: string;
  targetCollection: string;
};

/** One collection with its columns, indexes and relationships. */
export type CollectionDetail = {
  name: string;
  rowCount: number;
  rowCountIsExact: boolean;
  lastMigrationSlug: string | null;
  lastMigrationAppliedAt: string | null;
  /** The column that holds each row's owner, or null for a collection shared by all users. */
  ownerColumn: string | null;
  gateScope: "owner" | "none";
  /** `owner`: end users see their own rows; `deny`: end users see none; `open`: end users see every row. */
  endUserScope: "owner" | "deny" | "open";
  columns: ReadonlyArray<CollectionColumn>;
  relationships: ReadonlyArray<CollectionRelationship>;
  indexes: ReadonlyArray<CollectionIndex>;
};

export type ListCollectionsOptions = {
  /** 1 to 200; the gateway defaults to 50. */
  limit?: number | undefined;
  /** `meta.cursor.next` of the previous page. */
  cursor?: string | undefined;
};

export function makeSchemaNamespace(config: HttpClientConfig) {
  return {
    collections: {
      /** List the project's collections by name, one page at a time. */
      async list(opts: ListCollectionsOptions = {}): Promise<PaginatedEnvelope<ReadonlyArray<CollectionSummary>>> {
        if (typeof config.projectSlug !== "string" || config.projectSlug.length === 0) {
          throw new Error("schema operations require projectSlug bound on the client");
        }
        if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 200)) {
          throw new KError({
            code: "K9O_INVALID_FIELD_VALUE",
            message: "limit must be a whole number from 1 to 200",
            context: { limit: opts.limit },
            recommendation: null,
          });
        }
        return (await request(config, { method: "GET", path: projectPath(config.projectSlug, "schema/collections"), query: opts })) as PaginatedEnvelope<ReadonlyArray<CollectionSummary>>;
      },

      /** One collection with its columns, indexes and relationships. An unknown name is a 404 `K9O_COLLECTION_NOT_FOUND`. */
      async get(name: string): Promise<Envelope<CollectionDetail>> {
        if (typeof config.projectSlug !== "string" || config.projectSlug.length === 0) {
          throw new Error("schema operations require projectSlug bound on the client");
        }
        if (typeof name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) {
          throw new KError({
            code: "K9O_INVALID_FIELD_VALUE",
            message: "collection name must match ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$",
            context: { name },
            recommendation: null,
          });
        }
        return request(config, { method: "GET", path: projectPath(config.projectSlug, `schema/collections/${encodeURIComponent(name)}`) });
      },
    },
  };
}
