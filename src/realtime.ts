/**
 * Realtime Subscriptions SDK — `client.realtime.*`.
 *
 * Realtime Subscriptions ALL-LIVE primitive.
 *
 * `client.realtime.subscribe(topic, options?)` returns an async iterable
 * yielding `RealtimeEvent`s — the caller writes idiomatic
 * `for await (const event of client.realtime.subscribe(topic)) { ... }`.
 *
 * Transport: SSE over `GET /@<slug>/realtime/subscribe`. The gateway
 * closes each connection after a while; the subscription reconnects with
 * `Last-Event-ID` (the last event's `eventId`) and resumes, on whichever
 * replica it lands. A resume can re-send a few events already delivered;
 * they are dropped here by `eventId`, so each event is yielded once.
 * When the gateway can't resume (`event: resync`), the caller re-reads
 * current state from the data plane: `onResync` is called and the
 * subscription carries on live, or, without `onResync`, it ends.
 *
 * Wire mapping (project-plane):
 *   - subscribe → GET  /@<slug>/realtime/subscribe?topic=<t>&filter=<jsonb>  (SSE)
 *   - replay    → POST /@<slug>/realtime/replay  { topic, fromSequence?, untilSequence?, limit?, afterAuditEventId? }
 *
 * `filter` + RLS compose (filter narrows, RLS gates). Surfaces
 * K9O_INVALID_FILTER, K9O_SUBSCRIPTION_LIMIT_EXCEEDED and K9O_TIER_FEATURE_GATED.
 */

import { request, requestStream, type HttpClientConfig } from "./http.ts";
import type { Envelope } from "./envelope.ts";
import { KError } from "./kerror.ts";
import { projectPath } from "./url-grammar.ts";
import { parseSseFrames, type SseFrame } from "./internal/sse.ts";

// ----------------------------------------------------------------------
// Topic catalogue 
// ----------------------------------------------------------------------

/**
 * The 6 closed subscription topic families . Concrete
 * topic strings carry a dynamic segment (collection name, resource id,
 * event family) — use `realtimeTopic.*` builders to construct them.
 */
export type RealtimeTopicFamily =
  | "collections"
  | "studio.workflows.runs"
  | "studio.queries.executed"
  | "studio.dashboards.refresh"
  | "forge.functions.invocations"
  | "audit.org";

/** A concrete topic string, e.g. `studio.dashboards.refresh.dsh_abc`. */
export type RealtimeTopic = string;

/**
 * Typed builders for the 6 topic families . Prefer these
 * over hand-built strings for compile-time family safety.
 */
export const realtimeTopic = {
  /** `collections.<collection>.*` — row insert / update / delete events. */
  collection(collection: string): RealtimeTopic {
    return `collections.${collection}.*`;
  },
  /** `studio.workflows.runs.*` — run started / step_changed / approval_pending / completed. */
  workflowRuns(): RealtimeTopic {
    return "studio.workflows.runs.*";
  },
  /** `studio.queries.executed.<query-id>` — query execute events. */
  queryExecuted(queryId: string): RealtimeTopic {
    return `studio.queries.executed.${queryId}`;
  },
  /** `studio.dashboards.refresh.<dashboard-id>` — widget data refresh. */
  dashboardRefresh(dashboardId: string): RealtimeTopic {
    return `studio.dashboards.refresh.${dashboardId}`;
  },
  /** `forge.functions.invocations.<function-id>` — invoked / completed / failed. */
  functionInvocations(functionId: string): RealtimeTopic {
    return `forge.functions.invocations.${functionId}`;
  },
  /** `audit.org.<event-family>` — org-plane audit events. */
  auditOrg(eventFamily: string): RealtimeTopic {
    return `audit.org.${eventFamily}`;
  },
} as const;

// ----------------------------------------------------------------------
// Event + filter shapes
// ----------------------------------------------------------------------

/** Per-topic filter predicate . */
export type RealtimeFilter = Record<string, unknown>;

/** A single realtime event, as the gateway frames it (wire spelling). */
export type RealtimeEvent<T = unknown> = {
  topic: RealtimeTopic;
  /** Event type within the topic family (e.g. `row_inserted`, `workflow.run.completed`). */
  eventType: string;
  payload: T;
  occurredAt: string;
  /** The event's id, the same on every gateway replica (`evt_…`). */
  eventId: string;
};

/** Why the gateway couldn't resume, from its `event: resync` frame. */
export type RealtimeResync = { reason: string; action: string };

export type SubscribeOptions = {
  filter?: RealtimeFilter;
  /** Abort the subscription (closes the underlying transport). */
  signal?: AbortSignal;
  /**
   * Called when the gateway can't resume the feed (`event: resync`): events may have been missed, so re-read current
   * state from the data plane. The subscription then carries on live from a fresh connection. Without it, the
   * subscription ends instead.
   */
  onResync?: ((resync: RealtimeResync) => void | Promise<void>) | undefined;
  /** How many recent event ids to remember for dropping a resume's re-sent events. Default 1000. */
  dedupeMax?: number;
  /** How long to remember an event id. Default 60 s (well beyond the gateway's resume lookback). */
  dedupeTtlMs?: number;
  /** Reconnect when no bytes (events, comments or heartbeats) arrive for this long, in milliseconds. Default 45000. */
  idleTimeoutMs?: number | undefined;
  /** Wait this long, in milliseconds, before reconnecting. Default: the server's hint, else 1000. Backs off to 30000 on repeated failures. */
  retryDelayMs?: number | undefined;
};

/** Options of `realtime.replay`. */
export type RealtimeReplayOptions = {
  /** Replay from this position in the topic's ledger. */
  fromSequence?: number | string | undefined;
  /** Stop at this position. */
  untilSequence?: number | string | undefined;
  /** Events per call, 1 to 10000. Without it the gateway chooses. */
  limit?: number | undefined;
  /** `audit.project.*` topics only: replay the events after this one (the last `auditEventId` you received). */
  afterAuditEventId?: string | undefined;
};

/** An event from `realtime.replay`: the realtime event shape; the ledger adds `sequence` and carries no stream `eventId`. */
export type RealtimeReplayEvent<T = unknown> = Omit<RealtimeEvent<T>, "eventId"> & {
  eventId?: string | undefined;
  /** The event's position in the ledger (a string, as the gateway sends it). */
  sequence?: string | undefined;
};

/** One answer of `realtime.replay`. */
export type RealtimeReplayPage<T = unknown> = {
  topic: string;
  events: RealtimeReplayEvent<T>[];
  /** Where the next call starts (the last event's `sequence`); `null` when there is none. */
  nextCursor: string | number | null;
  /** True when more events follow this page. */
  hasMore: boolean;
  /** Set (to `reread-source`) when the topic keeps no ledger: read current state from the data plane instead. */
  resync?: string | undefined;
};

const REPLAY_MAX = 10_000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function replayPageFrom<T>(data: unknown, topic: string): RealtimeReplayPage<T> {
  const o = isObj(data) ? data : {};
  const events: RealtimeReplayEvent<T>[] = [];
  for (const item of Array.isArray(o["events"]) ? o["events"] : []) {
    if (!isObj(item) || typeof item["eventType"] !== "string") continue;
    const ev: RealtimeReplayEvent<T> = {
      topic: typeof item["topic"] === "string" ? item["topic"] : topic,
      eventType: item["eventType"],
      payload: item["payload"] as T,
      occurredAt: typeof item["occurredAt"] === "string" ? item["occurredAt"] : "",
    };
    if (typeof item["eventId"] === "string" && item["eventId"] !== "") ev.eventId = item["eventId"];
    const seq = item["sequence"];
    if (typeof seq === "string") ev.sequence = seq;
    else if (typeof seq === "number") ev.sequence = String(seq);
    events.push(ev);
  }
  const cursor = o["nextCursor"];
  const page: RealtimeReplayPage<T> = {
    topic: typeof o["topic"] === "string" ? o["topic"] : topic,
    events,
    nextCursor: typeof cursor === "string" || typeof cursor === "number" ? cursor : null,
    hasMore: o["hasMore"] === true,
  };
  if (typeof o["resync"] === "string") page.resync = o["resync"];
  return page;
}

function checkSequence(name: string, v: number | string | undefined): void {
  if (v === undefined) return;
  const ok = typeof v === "number" ? Number.isSafeInteger(v) && v >= 0 : typeof v === "string" && /^[0-9]+$/.test(v);
  if (!ok) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `realtime.replay: ${name} must be a non-negative integer`,
      context: { field: name },
      recommendation: `Pass ${name} as a whole number or a string of digits.`,
    });
  }
}

const DEFAULT_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;

/**
 * The ids of recently yielded events, bounded by count and by age, so the events a resume re-sends are dropped.
 * Exported for tests.
 */
export class SeenEventIds {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly max: number = 1000,
    private readonly ttlMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}
  /** True the first time an id is offered (and remembers it); false for a duplicate still remembered. */
  firstTime(id: string): boolean {
    const t = this.now();
    for (const [k, at] of this.seen) {
      if (t - at <= this.ttlMs && this.seen.size <= this.max) break;
      this.seen.delete(k); // oldest first: Map keeps insertion order
    }
    if (this.seen.has(id)) return false;
    this.seen.set(id, t);
    if (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value as string);
    return true;
  }
  get size(): number {
    return this.seen.size;
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * A live subscription. It is itself an async iterable (`for await`) and
 * exposes `close()` for explicit teardown.
 */
export type RealtimeSubscription<T = unknown> = AsyncIterable<RealtimeEvent<T>> & {
  /** Stop the subscription + release the underlying transport. */
  close(): void;
};

/** Where a feed is read from: a project-relative path and its query. `initialQuery` is sent only until the feed has a position of its own. */
export type FeedTarget = {
  path: string;
  query: Record<string, string | number | boolean | undefined>;
  initialQuery?: Record<string, string | number | boolean | undefined> | undefined;
  /**
   * How a data frame becomes an event, for a feed whose frames differ from the realtime shape. Return the event's id
   * (`""` when it has none: it is then neither remembered nor used to resume) and the value to yield, or `null` to skip the frame.
   * Default: the realtime shape (`eventType` and `eventId` in the data, else the frame's `id`).
   */
  decode?: ((frame: SseFrame, parsed: Record<string, unknown>) => { eventId: string; event: unknown } | null) | undefined;
};

function decodeRealtimeFrame(frame: SseFrame, parsed: Record<string, unknown>): { eventId: string; event: unknown } | null {
  if (typeof parsed["eventType"] !== "string") return null;
  const wireId = parsed["eventId"];
  const eventId = typeof wireId === "string" ? wireId : (frame.id ?? "");
  return { eventId, event: { ...parsed, eventId } };
}

/** The reconnect, abort and resync options every feed shares. */
export type FeedOptions = Pick<SubscribeOptions, "signal" | "onResync" | "idleTimeoutMs" | "retryDelayMs" | "dedupeMax" | "dedupeTtlMs">;

function requireProjectSlug(config: HttpClientConfig): string {
  if (typeof config.projectSlug !== "string" || config.projectSlug.length === 0) {
    throw new Error("realtime operations require projectSlug bound on the client");
  }
  return config.projectSlug;
}

function resyncInfo(frame: SseFrame): RealtimeResync {
  let parsed: unknown = null;
  try {
    parsed = frame.data === null ? null : JSON.parse(frame.data);
  } catch {
    /* keep the defaults */
  }
  const o = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { reason?: unknown; action?: unknown };
  return {
    reason: typeof o.reason === "string" ? o.reason : "cursor-unknown",
    action: typeof o.action === "string" ? o.action : "reread-source",
  };
}

/**
 * The tail loop over SSE. When a connection ends (the gateway bounds each one, or the network drops, or it goes quiet)
 * the next one opens after a delay with `Last-Event-ID` set to the last event delivered; events already delivered are
 * dropped by `eventId`. A `resync` frame that opens a connection made without `Last-Event-ID` only reports the head of
 * the stream and is skipped. Any other `resync` frame calls `onResync` and carries on live from a fresh connection, or ends the
 * subscription when there is none. A 4xx answer throws; a 5xx or a network error is retried.
 */
async function* sseTransport<T>(
  config: HttpClientConfig,
  target: FeedTarget,
  options: FeedOptions,
  stop: AbortSignal,
): AsyncGenerator<RealtimeEvent<T>, void, void> {
  const slug = requireProjectSlug(config);
  const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const baseRetry = options.retryDelayMs;

  let lastEventId: string | undefined;
  let seen = new SeenEventIds(options.dedupeMax, options.dedupeTtlMs);
  let serverRetry = DEFAULT_RECONNECT_MS;
  let failures = 0;
  // Start-position hints (such as `fromSequence`) apply until the first resync or the first delivered event.
  let useInitial = true;

  while (!stop.aborted) {
    const sendsInitial = useInitial && lastEventId === undefined && target.initialQuery !== undefined;
    const query = { ...target.query, ...(sendsInitial ? target.initialQuery : {}) };
    const conn = new AbortController();
    const onStop = () => conn.abort();
    stop.addEventListener("abort", onStop, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => conn.abort(), idleMs);
    };
    let gotFrame = false;
    let resynced = false;
    let sawData = false;
    try {
      bump();
      let response: Response | undefined;
      try {
        response = await requestStream(config, {
          method: "GET",
          path: projectPath(slug, target.path),
          query,
          accept: "text/event-stream",
          signal: conn.signal,
          ...(lastEventId !== undefined ? { headers: { "last-event-id": lastEventId } } : {}),
        });
      } catch (e) {
        if (stop.aborted) return;
        // A client error will not get better by asking again.
        if (e instanceof KError && e.status !== null && e.status >= 400 && e.status < 500) throw e;
        response = undefined;
      }
      if (response !== undefined) {
        try {
          for await (const frame of parseSseFrames(response.body as ReadableStream<Uint8Array>, {
            signal: conn.signal,
            onChunk: bump,
          })) {
            if (stop.aborted) return;
            if (frame.retry !== undefined) serverRetry = Math.min(frame.retry, MAX_RECONNECT_MS);
            if (frame.event === "resync") {
              // A `resync` that opens a connection sent without `Last-Event-ID` or a start position, before any data frame,
              // only reports the head of the stream (the events follow on this connection): keep reading, no `onResync`,
              // no reconnect. A connection sent with `fromSequence` asked for a position, so its `resync` is real.
              if (lastEventId === undefined && !sendsInitial && !sawData) {
                gotFrame = true;
                failures = 0;
                continue;
              }
              gotFrame = true;
              failures = 0;
              resynced = true;
              useInitial = false;
              lastEventId = undefined;
              seen = new SeenEventIds(options.dedupeMax, options.dedupeTtlMs);
              // The position is lost: with nobody to re-read, the subscription ends here.
              if (options.onResync === undefined) return;
              await options.onResync(resyncInfo(frame));
              break;
            }
            if (frame.data === null) continue;
            sawData = true;
            let parsed: unknown;
            try {
              parsed = JSON.parse(frame.data);
            } catch {
              continue;
            }
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
            const decoded = (target.decode ?? decodeRealtimeFrame)(frame, parsed as Record<string, unknown>);
            if (decoded === null) continue;
            const { eventId } = decoded;
            gotFrame = true;
            failures = 0;
            // Resume from the SSE `id:` (the cursor the gateway issues); the event's own id is for dedupe only.
            const cursor = frame.id !== undefined && frame.id !== "" ? frame.id : eventId;
            if (cursor !== "") {
              lastEventId = cursor;
              useInitial = false;
            }
            if (eventId !== "" && !seen.firstTime(eventId)) continue; // re-sent by a resume's lookback: already yielded
            yield decoded.event as RealtimeEvent<T>;
          }
        } catch (e) {
          if (stop.aborted) return;
          // A callback that throws is the caller's error; a broken connection is treated like the server closing it.
          if (resynced) throw e;
          void e;
        }
      }
    } finally {
      clearTimeout(idle);
      stop.removeEventListener("abort", onStop);
      conn.abort();
    }
    if (stop.aborted) return;
    if (!gotFrame) failures += 1;
    const base = baseRetry ?? serverRetry;
    const wait = resynced || failures === 0 ? base : Math.min(base * 2 ** (failures - 1), MAX_RECONNECT_MS);
    await sleep(wait, stop);
  }
}

/**
 * The reconnecting change-feed reader behind `realtime.subscribe` and `metadata.subscribe`: reconnects with
 * `Last-Event-ID`, drops events already delivered, and calls `onResync` when the position is lost.
 */
export function openFeed<T = unknown>(config: HttpClientConfig, target: FeedTarget, options: FeedOptions = {}): RealtimeSubscription<T> {
  requireProjectSlug(config);
  const own = new AbortController();
  const outer = options.signal;
  if (outer?.aborted) own.abort();
  else outer?.addEventListener("abort", () => own.abort(), { once: true });
  return {
    [Symbol.asyncIterator]() {
      const it = sseTransport<T>(config, target, options, own.signal);
      return {
        next: () => it.next(),
        return: async () => {
          own.abort();
          await it.return(undefined);
          return { done: true, value: undefined };
        },
        throw: async (err) => {
          own.abort();
          await it.return(undefined);
          throw err;
        },
      };
    },
    close() {
      own.abort();
    },
  };
}

export function makeRealtimeNamespace(config: HttpClientConfig) {
  return {
    /**
     * Subscribe to a topic. Returns a `RealtimeSubscription` — an async
     * iterable of `RealtimeEvent`s over SSE.
     *
     * ```ts
     * const sub = client.realtime.subscribe(
     *   realtimeTopic.dashboardRefresh("dsh_abc"),
     * );
     * for await (const event of sub) {
     *   if (event.eventType === "dashboard.widget.data_refreshed") rerender(event.payload);
     * }
     * ```
     *
     * It reconnects and resumes by itself, and yields each event once. Pass `onResync` to re-read current state
     * when the gateway can't resume; without it, the loop ends there.
     */
    subscribe<T = unknown>(topic: RealtimeTopic, options: SubscribeOptions = {}): RealtimeSubscription<T> {
      const query: FeedTarget["query"] = { topic };
      if (options.filter) query.filter = JSON.stringify(options.filter);
      return openFeed<T>(config, { path: "realtime/subscribe", query }, options);
    },

    /**
     * One call of the topic's ledger catch-up (`POST /@<slug>/realtime/replay`). The topic is required.
     * The answer is `{ topic, events, nextCursor, hasMore, resync? }`; events have the realtime shape (`topic`, `eventType`,
     * `payload`, `occurredAt`) plus the ledger's `sequence`. Page on with `fromSequence` while `hasMore` is true.
     * Only `audit.project.*` topics keep a ledger (they need the audit log's access: 403 `K9O_RBAC_DENY` otherwise; an unknown
     * `afterAuditEventId` answers 400 `K9O_INVALID_CURSOR`). For the other topics the answer has no events and `resync: "reread-source"`:
     * read current state, then `subscribe`. `limit` is 1 to 10000.
     *
     * ```ts
     * const page = await client.realtime.replay("audit.project.*", { fromSequence: 0, limit: 100 });
     * ```
     */
    async replay<T = unknown>(topic: RealtimeTopic, options: RealtimeReplayOptions = {}): Promise<Envelope<RealtimeReplayPage<T>>> {
      const slug = requireProjectSlug(config);
      if (typeof topic !== "string" || topic.length === 0 || topic.length > 200) {
        throw new TypeError("realtime.replay: topic must be a non-empty string of at most 200 characters");
      }
      checkSequence("fromSequence", options.fromSequence);
      checkSequence("untilSequence", options.untilSequence);
      if (options.afterAuditEventId !== undefined && !/^evt_[0-9A-Za-z]{1,40}$/.test(options.afterAuditEventId)) {
        throw new TypeError("realtime.replay: afterAuditEventId must look like evt_ followed by letters and digits");
      }
      if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > REPLAY_MAX)) {
        throw new KError({
          code: "K9O_INVALID_FIELD_VALUE",
          message: "realtime.replay: limit must be an integer from 1 to 10000",
          context: { field: "limit" },
          recommendation: "Pass a limit from 1 to 10000, or leave it out.",
        });
      }
      const res = await request<unknown>(config, {
        method: "POST",
        path: projectPath(slug, "realtime/replay"),
        body: {
          topic,
          ...(options.fromSequence !== undefined ? { fromSequence: options.fromSequence } : {}),
          ...(options.untilSequence !== undefined ? { untilSequence: options.untilSequence } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
          ...(options.afterAuditEventId !== undefined ? { afterAuditEventId: options.afterAuditEventId } : {}),
        },
      });
      return { data: replayPageFrom<T>(res.data, topic), meta: res.meta };
    },
  };
}
