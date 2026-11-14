/**
 * Audit log query SDK — `client.audit.*`.
 *
 * Backed by the gateway audit-log routes.
 *
 * Wire mapping:
 *   - `query({ eventType, actorId, after, before, limit, cursor })`
 *     → GET /@<slug>/audit-log?...
 *
 * Option names are the gateway's query parameter names. The endpoint
 * accepts cursor-paginated reverse-chronological queries. `eventType` is
 * the audit-event name (e.g. `data.write.access.insert`).
 *
 * Returns audit events with full context payload.
 *
 *   - `tail(options)`  -> GET  /@<slug>/realtime/subscribe?topic=audit.project.*   (SSE, live)
 *   - `replay(...)`    -> POST /@<slug>/realtime/replay                            (catch-up from a known event)
 */

import { request, type HttpClientConfig } from "./http.ts";
import { projectPath } from "./url-grammar.ts";
import type { Envelope } from "./envelope.ts";
import { KError } from "./kerror.ts";
import { openFeed, sleep, SeenEventIds, type FeedOptions, type RealtimeResync, type RealtimeSubscription } from "./realtime.ts";

/** Audit event record. */
export type AuditEvent = {
  id: string;
  /** Dotted namespace (e.g. `data.write.access.insert`). */
  type: string;
  actorId: string | null;
  targetKind: string | null;
  targetId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  requestId: string | null;
  traceId: string | null;
};

export type AuditQueryOpts = {
  /** Filter by event type. */
  eventType?: string | undefined;
  /** Filter by actor. */
  actorId?: string | undefined;
  /** ISO 8601 lower bound: only events after this instant. */
  after?: string | undefined;
  /** ISO 8601 upper bound: only events before this instant. */
  before?: string | undefined;
  /** Page size (per-tier max bounded server-side). */
  limit?: number | undefined;
  /** Cursor from prior response. */
  cursor?: string | undefined;
};

function requireProjectSlug(config: HttpClientConfig): string {
  if (typeof config.projectSlug !== "string" || config.projectSlug.length === 0) {
    throw new Error("audit operations require projectSlug bound on the client");
  }
  return config.projectSlug;
}

/**
 * One event of the live audit tail: five fields. Read the full row with `audit.query`.
 * The tail and replay unwrap the gateway's frame, so the five fields sit at the top of the event, not under `payload`.
 */
export type AuditTailEvent = {
  /** The audit event's id (`evt_...`). It is not the id of the stream frame that carried it. */
  auditEventId: string;
  /** The audit event type, for example `data.write.access.insert`. */
  type: string;
  actorType: string;
  occurredAt: string;
  /** `null` when the event has no outcome. */
  outcome: string | null;
  /** The stream frame's own id (`evt_...`), used to drop a resent frame. Present on events from the live tail, absent on replay. */
  eventId?: string | undefined;
  /** Present only on an event that arrived through a replay: its position in the audit log (a string, as the gateway sends it). */
  sequence?: string | undefined;
};

/** One page of `audit.replay`. */
export type AuditReplayPage = {
  events: AuditTailEvent[];
  /** Where the next page starts, as the gateway reports it; `null` when there is none. Page on with `afterAuditEventId` set to the last event. */
  nextCursor: string | number | null;
  /** True when more events follow this page. */
  hasMore: boolean;
};

export type AuditTailOptions = Pick<FeedOptions, "signal" | "idleTimeoutMs" | "retryDelayMs" | "dedupeMax" | "dedupeTtlMs"> & {
  /**
   * Audit event types to follow. None: every type (`audit.project.*`). One: the server filters (`audit.project.<type>`).
   * Several: the tail follows every type and the SDK keeps the ones listed.
   */
  types?: ReadonlyArray<string> | undefined;
  /**
   * Called when the gateway cannot resume the tail (`event: resync`, action `replay-ledger`), before the SDK catches up.
   * The SDK then replays the audit log from the last event you received and carries on live; with no event received yet
   * there is nothing to replay from. Without `onResync` the same catch-up still happens.
   */
  onResync?: ((resync: RealtimeResync) => void | Promise<void>) | undefined;
};

export type AuditReplayOptions = {
  /** Topic to replay: `audit.project.*` (default) or `audit.project.<type>`. */
  topic?: string | undefined;
  /** Replay the events after this one (the last `auditEventId` you received). Wins over `fromSequence`. */
  afterAuditEventId?: string | undefined;
  /** Replay from this position in the audit log. */
  fromSequence?: number | string | undefined;
  /** Stop at this position. */
  untilSequence?: number | string | undefined;
  /** Batch size, 1 to 10000. Default 1000 (the gateway without a limit answers every event). */
  limit?: number | undefined;
};

/** A live audit tail: an async iterable of events, with `close()` to stop it. */
export type AuditTail = AsyncIterable<AuditTailEvent> & {
  /** Stop the tail and release the connection. */
  close(): void;
};

export const AUDIT_TAIL_TOPIC = "audit.project.*";
const REPLAY_BATCH = 1000;
const REPLAY_MAX = 10_000;
const DEFAULT_RESYNC_BACKOFF_MS = 1000;

function tailTopic(types: ReadonlyArray<string> | undefined): { topic: string; keep: ReadonlySet<string> | null } {
  if (types === undefined || types.length === 0) return { topic: AUDIT_TAIL_TOPIC, keep: null };
  for (const t of types) {
    if (typeof t !== "string" || t.length === 0 || t.includes("*") || /\s/.test(t)) {
      throw new TypeError("audit.tail: each type must be an audit event type such as data.write.access.insert");
    }
  }
  const unique = [...new Set(types)];
  return unique.length === 1 ? { topic: `audit.project.${unique[0]}`, keep: null } : { topic: AUDIT_TAIL_TOPIC, keep: new Set(unique) };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Flatten one gateway event into the five fields. The gateway wraps them: the stream frame is
 * `{ topic, eventType, payload: { auditEventId, type, actorType, occurredAt, outcome }, occurredAt, eventId }`, and a replay
 * item adds `sequence`. `eventId` is the frame's own id, not the audit event's.
 */
function toTailEvent(o: Record<string, unknown>): AuditTailEvent | null {
  const inner = isObj(o["payload"]) ? o["payload"] : o;
  const id = inner["auditEventId"];
  const type = typeof inner["type"] === "string" ? inner["type"] : o["eventType"];
  if (typeof id !== "string" || id.length === 0 || typeof type !== "string") return null;
  const when = typeof inner["occurredAt"] === "string" ? inner["occurredAt"] : o["occurredAt"];
  const ev: AuditTailEvent = {
    auditEventId: id,
    type,
    actorType: typeof inner["actorType"] === "string" ? inner["actorType"] : "",
    occurredAt: typeof when === "string" ? when : "",
    outcome: typeof inner["outcome"] === "string" ? inner["outcome"] : null,
  };
  if (typeof o["eventId"] === "string" && o["eventId"].length > 0) ev.eventId = o["eventId"];
  const seq = o["sequence"] ?? inner["sequence"];
  if (typeof seq === "string") ev.sequence = seq;
  else if (typeof seq === "number") ev.sequence = String(seq);
  return ev;
}

function replayPage(data: unknown): AuditReplayPage {
  const list = Array.isArray(data) ? data : isObj(data) ? (data["events"] ?? data["items"]) : undefined;
  const events = (Array.isArray(list) ? list : [])
    .filter(isObj)
    .map(toTailEvent)
    .filter((e): e is AuditTailEvent => e !== null);
  const cursor = isObj(data) ? data["nextCursor"] : undefined;
  return {
    events,
    nextCursor: typeof cursor === "string" || typeof cursor === "number" ? cursor : null,
    hasMore: isObj(data) && data["hasMore"] === true,
  };
}

export function makeAuditNamespace(config: HttpClientConfig) {
  return {
    /**
     * Query the audit log. Returns reverse-chronological events matching
     * all supplied filters (AND composition).
     *
     * Requires the `AUDIT_READER` role at minimum. This endpoint is
     * project-scoped.
     */
    async query(opts?: AuditQueryOpts): Promise<Envelope<ReadonlyArray<AuditEvent>>> {
      const slug = requireProjectSlug(config);
      return request(config, {
        method: "GET",
        path: projectPath(slug, "audit-log"),
        query: opts,
      });
    },

    /**
     * Follow the project's audit log live. Needs ORG_OWNER, ORG_ADMIN, PROJECT_ADMIN or PROJECT_AUDITOR (checked again
     * every 60 seconds while the stream is open); an extension cannot subscribe. Each event carries `auditEventId`,
     * `type`, `actorType`, `occurredAt` and `outcome`: read the full row with `query`. `warden.checkpoint` events are not
     * in the live tail (the audit log and `replay` carry them).
     *
     * A new connection first delivers the recent backlog (the last several minutes), then live events. It reconnects with `Last-Event-ID` and yields each event once. When the gateway cannot resume (`event: resync`,
     * action `replay-ledger`), the SDK connects afresh first, replays the audit log from the last event you received, then merges the replay, the frames buffered meanwhile and the live ones, each once, so nothing is lost. Close it with `close()`, `signal`, or by leaving the loop. A 4xx answer is thrown once.
     *
     * ```ts
     * for await (const e of client.audit.tail({ types: ["data.write.access.insert"] })) {
     *   console.log(e.auditEventId, e.type, e.outcome);
     * }
     * ```
     */
    tail(options: AuditTailOptions = {}): AuditTail {
      const slug = requireProjectSlug(config);
      const { topic, keep } = tailTopic(options.types);
      const own = new AbortController();
      if (options.signal?.aborted) own.abort();
      else options.signal?.addEventListener("abort", () => own.abort(), { once: true });

      async function* run(): AsyncGenerator<AuditTailEvent, void, void> {
        const seen = new SeenEventIds(options.dedupeMax, options.dedupeTtlMs);
        let last: string | undefined;
        const wanted = (e: AuditTailEvent) => keep === null || keep.has(e.type);
        // Once per audit event id and once per frame id, across replay, buffer and live.
        const firstTime = (e: AuditTailEvent) => {
          const a = seen.firstTime(e.auditEventId);
          const b = e.eventId === undefined || e.eventId === "" ? true : seen.firstTime(e.eventId);
          return a && b;
        };
        let afterResync = false;
        let resyncRun = 0;
        while (!own.signal.aborted) {
          let resync: RealtimeResync | null = null;
          // Always a fresh connection here (no Last-Event-ID): the first one, or the one after a resync.
          const feed: RealtimeSubscription<AuditTailEvent> = openFeed<AuditTailEvent>(
            config,
            {
              path: "realtime/subscribe",
              query: { topic },
              decode: (frame, parsed) => {
                const ev = toTailEvent(parsed);
                // The frame's own id (data.eventId, else the SSE id) dedupes and resumes; the audit event id is only for the caller.
                return ev === null ? null : { eventId: ev.eventId ?? frame.id ?? "", event: ev };
              },
            },
            {
              signal: own.signal,
              ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
              ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
              ...(options.dedupeMax !== undefined ? { dedupeMax: options.dedupeMax } : {}),
              ...(options.dedupeTtlMs !== undefined ? { dedupeTtlMs: options.dedupeTtlMs } : {}),
              // End this connection at the resync; the next one opens fresh.
              onResync: async (r) => {
                resync = r;
                feed.close();
                await options.onResync?.(r);
              },
            },
          );
          // Read the connection in the background, so frames are buffered while the replay runs.
          const buffer: AuditTailEvent[] = [];
          let finished = false;
          let failure: { error: unknown } | null = null;
          let wake: (() => void) | undefined;
          let gotEvent = false;
          const pump = (async () => {
            try {
              for await (const ev of feed as unknown as AsyncIterable<AuditTailEvent>) {
                buffer.push(ev);
                gotEvent = true;
                wake?.();
              }
            } catch (error) {
              failure = { error };
            } finally {
              finished = true;
              wake?.();
            }
          })();
          try {
            if (afterResync && last !== undefined) {
              // Catch up from the ledger: page through the replay until the gateway says nothing follows.
              for (;;) {
                if (own.signal.aborted) return;
                const res: Envelope<unknown> = await request<unknown>(config, {
                  method: "POST",
                  path: projectPath(slug, "realtime/replay"),
                  body: { topic, afterAuditEventId: last, limit: REPLAY_BATCH },
                });
                const page = replayPage(res.data);
                if (page.events.length === 0) break;
                const next = page.events[page.events.length - 1]!.auditEventId;
                const progressed = next !== last;
                last = next;
                for (const ev of page.events) {
                  if (!firstTime(ev) || !wanted(ev)) continue;
                  yield ev;
                }
                if (!page.hasMore || !progressed) break;
              }
            }
            afterResync = false;
            for (;;) {
              if (buffer.length > 0) {
                const ev = buffer.shift()!;
                if (!firstTime(ev)) continue;
                last = ev.auditEventId;
                if (!wanted(ev)) continue;
                yield ev;
                continue;
              }
              if (finished) break;
              await new Promise<void>((resolve) => {
                wake = () => {
                  wake = undefined;
                  resolve();
                };
              });
            }
            const f = failure as { error: unknown } | null;
            if (f !== null) throw f.error;
          } finally {
            feed.close();
            await pump;
          }
          if (resync === null || own.signal.aborted) return;
          afterResync = true;
          // A fresh connection answered with resync again and no event in between: wait, never spin.
          resyncRun = gotEvent ? 1 : resyncRun + 1;
          if (resyncRun >= 2) await sleep(options.retryDelayMs ?? DEFAULT_RESYNC_BACKOFF_MS, own.signal);
        }
      }

      return {
        [Symbol.asyncIterator]() {
          const it = run();
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
    },

    /**
     * One batch of audit events after a known one, from the audit log in order (`warden.checkpoint` included).
     * Pass `afterAuditEventId` (the last `auditEventId` you received) or `fromSequence`. The answer is `{ events, nextCursor, hasMore }`;
     * each event has the tail's five fields (flattened out of the gateway's `payload`) plus its `sequence`, a string.
     * Page on with `afterAuditEventId` set to the last event while `hasMore` is true. Needs the audit log's access (403 `K9O_RBAC_DENY` otherwise); an `afterAuditEventId`
     * not in the log answers 400 `K9O_INVALID_CURSOR`. At most 1000 events per call unless you pass a `limit` (1 to 10000).
     */
    async replay(opts: AuditReplayOptions = {}): Promise<Envelope<AuditReplayPage>> {
      const slug = requireProjectSlug(config);
      if (opts.afterAuditEventId === undefined && opts.fromSequence === undefined) {
        throw new TypeError("audit.replay: pass afterAuditEventId or fromSequence");
      }
      if (opts.afterAuditEventId !== undefined && !/^evt_[0-9A-Za-z]{1,40}$/.test(opts.afterAuditEventId)) {
        throw new TypeError("audit.replay: afterAuditEventId must look like evt_ followed by letters and digits");
      }
      if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > REPLAY_MAX)) {
        throw new KError({
          code: "K9O_INVALID_FIELD_VALUE",
          message: "audit.replay: limit must be an integer from 1 to 10000",
          context: { field: "limit" },
          recommendation: "Pass a limit from 1 to 10000, or leave it out for 1000.",
        });
      }
      const res = await request<unknown>(config, {
        method: "POST",
        path: projectPath(slug, "realtime/replay"),
        body: {
          topic: opts.topic ?? AUDIT_TAIL_TOPIC,
          ...(opts.afterAuditEventId !== undefined ? { afterAuditEventId: opts.afterAuditEventId } : {}),
          ...(opts.afterAuditEventId === undefined && opts.fromSequence !== undefined ? { fromSequence: opts.fromSequence } : {}),
          ...(opts.untilSequence !== undefined ? { untilSequence: opts.untilSequence } : {}),
          limit: opts.limit ?? REPLAY_BATCH,
        },
      });
      return { data: replayPage(res.data), meta: res.meta };
    },
  };
}
