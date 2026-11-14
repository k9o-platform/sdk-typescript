/**
 * Function lifecycle SDK — `client.functions.*`.
 *
 * Backed by the gateway functions and invoke routes.
 *
 * Wire mapping:
 *   - `deploy({ name, runtime, tier, artifactKey, version })` → POST /@<slug>/functions
 *   - `list()`                                → GET    /@<slug>/functions
 *   - `get(name)`                             → GET    /@<slug>/functions/<name>
 *   - `delete(name)`                          → DELETE /@<slug>/functions/<name>
 *   - `invoke(name, payload)`                 → POST   /@<slug>/functions/<name>/invoke
 *   - `triggers.list(name)`                   → GET    /@<slug>/functions/<name>/triggers
 *   - `triggers.create(name, {...})`          → POST   /@<slug>/functions/<name>/triggers
 *   - `triggers.update(name, id, {...})`      → PATCH  /@<slug>/functions/<name>/triggers/<id>
 *   - `triggers.delete(name, id)`             → DELETE /@<slug>/functions/<name>/triggers/<id>   (204, no body)
 *
 * Deploy requires PROJECT_ADMIN and returns with status `deploying`; the
 * function is ready when status flips to `active`.
 */

import { request, type HttpClientConfig } from "./http.ts";
import { KError } from "./kerror.ts";
import { projectPath } from "./url-grammar.ts";
import type { Envelope, PaginatedEnvelope } from "./envelope.ts";

/**
 * Function record returned by gateway endpoints.
 */
export type FunctionRecord = {
  /** `fn_<base62>`. */
  id: string;
  name: string;
  runtime: DeployFunctionInput["runtime"];
  tier: "gateway" | "sandbox";
  entryPoint: string;
  version: string;
  status: "deploying" | "active" | "error" | "retired";
  /** Who manages the function: a developer deploy, or an extension (`extension:<id>`). */
  source: string;
  description: string | null;
  createdAt: string;
  deployedAt: string | null;
  retiredAt: string | null;
  errorDetail: string | null;
};

/**
 * Deploy input. The function's bytes are uploaded first (the gateway's
 * function-artifact upload returns the `artifactKey`); deploy references
 * that artifact.
 */
export type DeployFunctionInput = {
  /** Function name (1 to 128 characters). */
  name: string;
  /**
   * Functions run in the sandbox. A customer deploys bun, python, go, java, kotlin, dotnet, swift, php, ruby, rust or
   * zig; `tinygo` and `assemblyscript` run only on the gateway tier, which a customer cannot deploy to. They stay in the
   * type because platform operators and `FunctionRecord` can carry them.
   */
  runtime: "bun" | "python" | "go" | "java" | "kotlin" | "dotnet" | "swift" | "php" | "ruby" | "rust" | "tinygo" | "zig" | "assemblyscript";
  /**
   * Use `sandbox` (an OCI image archive). `gateway` (WebAssembly in the gateway) exists for the platform operator's own
   * use and is refused for a customer deploy.
   */
  tier: "gateway" | "sandbox";
  /** Content-addressed key of the uploaded artifact. */
  artifactKey: string;
  /** Version label for this deploy (1 to 64 characters). */
  version: string;
  description?: string | undefined;
};

/** Optional invoke controls; property names are the gateway's. */
export type InvokeFunctionOptions = {
  /** Run asynchronously instead of waiting for the result. */
  background?: boolean | undefined;
  delegation?: { token: string; invokeSessionId?: string | undefined } | undefined;
  onBehalfOf?: string | undefined;
  confinedTo?: string | undefined;
};

/** The record events a trigger can fire on. */
export type TriggerEvent = "insert" | "update" | "delete" | "upsert";

/** An event trigger: runs the function when a record event happens on a collection. */
export type FunctionTrigger = {
  /** UUID. */
  id: string;
  functionName: string;
  collection: string | null;
  events: ReadonlyArray<TriggerEvent>;
  /** A policy-grammar predicate over the record, or `null` to fire on every matching event. */
  filter: Record<string, unknown> | null;
  enabled: boolean;
  logOkInvocations: boolean;
  createdAt: string;
};

export type CreateTriggerInput = {
  /** An existing collection: `^[a-zA-Z_][a-zA-Z0-9_]*$`, 1 to 128 characters. */
  collection: string;
  /** 1 to 4 of `insert`, `update`, `delete`, `upsert`. */
  events: ReadonlyArray<TriggerEvent>;
  /** Fire only when the record matches; omit or `null` to fire on every event. */
  filter?: Record<string, unknown> | null | undefined;
  /** Default `true`. */
  enabled?: boolean | undefined;
  /** Record successful invocations too (default `false`: only failures are logged). */
  logOkInvocations?: boolean | undefined;
};

/** Fields to change; at least one. `collection` cannot be changed. */
export type UpdateTriggerInput = {
  /** Replaces the whole list. */
  events?: ReadonlyArray<TriggerEvent> | undefined;
  /** An object replaces the filter; `null` clears it. */
  filter?: Record<string, unknown> | null | undefined;
  enabled?: boolean | undefined;
  logOkInvocations?: boolean | undefined;
};

const TRIGGER_EVENTS: ReadonlySet<string> = new Set(["insert", "update", "delete", "upsert"]);
const TRIGGER_COLLECTION_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function invalid(message: string, context: Record<string, unknown> = {}): KError {
  return new KError({ code: "K9O_INVALID_FIELD_VALUE", message, context, recommendation: null });
}

function checkEvents(events: unknown): void {
  if (!Array.isArray(events) || events.length < 1 || events.length > 4 || events.some((e) => typeof e !== "string" || !TRIGGER_EVENTS.has(e))) {
    throw invalid("events must list 1 to 4 of insert, update, delete, upsert", { events });
  }
}

function requireName(name: unknown, what: string): string {
  if (typeof name !== "string" || name.length === 0) throw invalid(`${what} must be a non-empty string`);
  return name;
}

function requireProjectSlug(config: HttpClientConfig): string {
  if (typeof config.projectSlug !== "string" || config.projectSlug.length === 0) {
    throw new Error("functions operations require projectSlug bound on the client");
  }
  return config.projectSlug;
}

export function makeFunctionsNamespace(config: HttpClientConfig) {
  const triggerPath = (name: string, tail = ""): string =>
    projectPath(requireProjectSlug(config), `functions/${encodeURIComponent(requireName(name, "function name"))}/triggers${tail}`);
  return {
    /**
     * Event triggers: run a function when a record is inserted, updated, deleted or upserted in a collection.
     * Needs the project admin role. For triggers on a timetable see `client.schedules`.
     */
    triggers: {
      /** Every trigger of the function, newest first. Not paginated. */
      async list(name: string): Promise<Envelope<ReadonlyArray<FunctionTrigger>>> {
        return request(config, { method: "GET", path: triggerPath(name) });
      },

      /** Create an event trigger. Answers 201 with the trigger. */
      async create(name: string, input: CreateTriggerInput): Promise<Envelope<FunctionTrigger>> {
        if (input === null || typeof input !== "object") throw invalid("input must be an object");
        if (typeof input.collection !== "string" || input.collection.length > 128 || !TRIGGER_COLLECTION_RE.test(input.collection)) {
          throw invalid("collection must match ^[a-zA-Z_][a-zA-Z0-9_]*$ (1 to 128 characters)", { collection: input.collection });
        }
        checkEvents(input.events);
        return request(config, { method: "POST", path: triggerPath(name), body: input });
      },

      /** Change a trigger. Send at least one of `events`, `filter`, `enabled`, `logOkInvocations`. */
      async update(name: string, triggerId: string, patch: UpdateTriggerInput): Promise<Envelope<FunctionTrigger>> {
        if (patch === null || typeof patch !== "object") throw invalid("patch must be an object");
        const keys = ["events", "filter", "enabled", "logOkInvocations"] as const;
        if (!keys.some((k) => patch[k] !== undefined)) throw invalid("patch needs at least one of: events, filter, enabled, logOkInvocations");
        if (patch.events !== undefined) checkEvents(patch.events);
        return request(config, {
          method: "PATCH",
          path: triggerPath(name, `/${encodeURIComponent(requireName(triggerId, "trigger id"))}`),
          body: patch,
        });
      },

      /** Delete a trigger. Answers 204 with no body, so `data` is `undefined`; deleting again is a 404. */
      async delete(name: string, triggerId: string): Promise<Envelope<void>> {
        return request(config, { method: "DELETE", path: triggerPath(name, `/${encodeURIComponent(requireName(triggerId, "trigger id"))}`) });
      },
    },

    /**
     * Upload a function artifact and get back its content-addressed `artifactKey`, to pass to `deploy`.
     * `POST /@<projectSlug>/functions/artifacts` with the raw bytes: a WebAssembly module for the gateway tier (for the platform operator; a project's deploy to it is refused) (up to
     * 16 MiB) or an OCI image archive for the sandbox tier (up to 256 MiB). Uploading the same bytes again returns the same key.
     */
    async uploadArtifact(bytes: Uint8Array | ArrayBuffer | Blob, kind: "wasm" | "tar"): Promise<Envelope<{ artifactKey: string }>> {
      const slug = requireProjectSlug(config);
      return request(config, {
        method: "POST",
        path: projectPath(slug, "functions/artifacts"),
        rawBody: bytes,
        headers: { "content-type": kind === "wasm" ? "application/wasm" : "application/x-tar" },
      });
    },

    /** Deploy or redeploy a function from an uploaded artifact. Returns the function record with status. */
    async deploy(input: DeployFunctionInput): Promise<Envelope<FunctionRecord>> {
      const slug = requireProjectSlug(config);
      return request(config, {
        method: "POST",
        path: projectPath(slug, "functions"),
        body: input,
      });
    },

    /** List deployed functions (cursor pagination). */
    async list(opts?: { limit?: number; cursor?: string; status?: FunctionRecord["status"]; tier?: FunctionRecord["tier"]; source?: string }): Promise<PaginatedEnvelope<ReadonlyArray<FunctionRecord>>> {
      const slug = requireProjectSlug(config);
      return (await request(config, {
        method: "GET",
        path: projectPath(slug, "functions"),
        query: opts,
      })) as PaginatedEnvelope<ReadonlyArray<FunctionRecord>>;
    },

    /** Get a function by name. */
    async get(name: string): Promise<Envelope<FunctionRecord>> {
      const slug = requireProjectSlug(config);
      return request(config, {
        method: "GET",
        path: projectPath(slug, `functions/${encodeURIComponent(name)}`),
      });
    },

    /** Retire a function. Returns the retired record; the function name enters a 24h cooldown. */
    async delete(name: string): Promise<Envelope<FunctionRecord>> {
      const slug = requireProjectSlug(config);
      return request(config, {
        method: "DELETE",
        path: projectPath(slug, `functions/${encodeURIComponent(name)}`),
      });
    },

    /**
     * Invoke a function. The `payload` is sent as the `payload` field of
     * the request body and passed to the function runtime verbatim; the
     * gateway returns whatever the function returns wrapped in the standard
     * envelope. Invoke authority is per function. This method covers the
     * request-response variant only.
     */
    async invoke<TResult = unknown, TPayload = unknown>(name: string, payload?: TPayload, options?: InvokeFunctionOptions): Promise<Envelope<TResult>> {
      const slug = requireProjectSlug(config);
      return request(config, {
        method: "POST",
        path: projectPath(slug, `functions/${encodeURIComponent(name)}/invoke`),
        body: { ...(payload !== undefined ? { payload } : {}), ...(options ?? {}) },
      });
    },
  };
}
