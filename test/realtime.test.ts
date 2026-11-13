/**
 * client.realtime.subscribe(): reconnect with Last-Event-ID, dedupe by eventId, resync, heartbeat, idle timeout.
 * Frames follow a capture from the gateway's change feed.
 */

import { describe, expect, it } from "bun:test";
import { createClient, KError, realtimeTopic, type RealtimeEvent } from "../src/index.ts";

const enc = new TextEncoder();
const TOPIC = "collections.docs_feed_probe.row_inserted";

function frame(id: string, extra: Record<string, unknown> = {}): string {
  const data = {
    topic: TOPIC,
    eventType: "row_inserted",
    payload: { collection: "docs_feed_probe", id: `rec_${id}` },
    occurredAt: "2026-10-27T10:20:38.969Z",
    eventId: id,
    ...extra,
  };
  return `id: ${id}\nevent: row_inserted\ndata: ${JSON.stringify(data)}\n\n`;
}

const RESYNC = `event: resync\ndata: ${JSON.stringify({ reason: "cursor-unknown", action: "reread-source" })}\n\n`;
const HEAD = "retry: 10\n:ok\n\n";

type Conn = { lastEventId: string | null; url: string };
type Script = { status?: number; text?: string; hang?: boolean; error?: boolean };

/** A fetch that serves one scripted answer per connection; an exhausted script hangs until aborted. */
function scripted(scripts: Script[], conns: Conn[]): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    // The client's one-off regional host probe is not a feed connection.
    if (headers["accept"] !== "text/event-stream") return new Response("", { status: 200 });
    conns.push({ url: String(input), lastEventId: headers["last-event-id"] ?? null });
    const s = scripts[conns.length - 1] ?? { hang: true };
    if (s.error) throw new TypeError("connection reset");
    if ((s.status ?? 200) !== 200) {
      return new Response(JSON.stringify({ error: { code: "K9O_UPSTREAM_UNAVAILABLE", message: "x" } }), {
        status: s.status,
        headers: { "content-type": "application/json" },
      });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        if (s.text) c.enqueue(enc.encode(s.text));
        if (!s.hang) c.close();
        else init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof globalThis.fetch;
}

const PROJ = { baseUrl: "https://acme.api.k9o.io", projectSlug: "portal" };

async function take(sub: AsyncIterable<RealtimeEvent>, n: number, close: () => void): Promise<RealtimeEvent[]> {
  const out: RealtimeEvent[] = [];
  for await (const e of sub) {
    out.push(e);
    if (out.length === n) close();
  }
  return out;
}

describe("realtime change feed", () => {
  it("(a) yields a frame with its eventId", async () => {
    const conns: Conn[] = [];
    const c = createClient({ ...PROJ, fetch: scripted([{ text: HEAD + frame("evt_WEb1vGdy8PPuUQYflikoE0") }], conns) });
    const sub = c.realtime.subscribe(TOPIC, { retryDelayMs: 5 });
    const got = await take(sub, 1, () => sub.close());
    expect(got[0]?.eventId).toBe("evt_WEb1vGdy8PPuUQYflikoE0");
    expect(got[0]?.eventType).toBe("row_inserted");
    expect(got[0]?.topic).toBe(TOPIC);
    expect(conns[0]?.lastEventId).toBeNull();
  });

  it("(b) reconnects after the stream ends with the last eventId, and (c) drops a resent duplicate", async () => {
    const conns: Conn[] = [];
    const scripts: Script[] = [
      { text: HEAD + frame("evt_a") + frame("evt_b") },
      { text: HEAD + frame("evt_a") + frame("evt_b") + frame("evt_c") },
    ];
    const c = createClient({ ...PROJ, fetch: scripted(scripts, conns) });
    const sub = c.realtime.subscribe(realtimeTopic.collection("docs_feed_probe"), { retryDelayMs: 5 });
    const got = await take(sub, 3, () => sub.close());
    expect(got.map((e) => e.eventId)).toEqual(["evt_a", "evt_b", "evt_c"]);
    expect(conns.length).toBeGreaterThanOrEqual(2);
    expect(conns[1]?.lastEventId).toBe("evt_b");
  });

  it("(d) a resync frame calls onResync, is not yielded, and the next connection has no Last-Event-ID", async () => {
    const conns: Conn[] = [];
    const scripts: Script[] = [
      { text: HEAD + frame("evt_a") },
      { text: HEAD + RESYNC, hang: true },
      { text: HEAD + frame("evt_a") },
    ];
    const resyncs: unknown[] = [];
    const c = createClient({ ...PROJ, fetch: scripted(scripts, conns) });
    const sub = c.realtime.subscribe(TOPIC, {
      retryDelayMs: 5,
      onResync: async (info) => {
        await Promise.resolve();
        resyncs.push(info);
      },
    });
    const got = await take(sub, 2, () => sub.close());
    // evt_a again after the resync is delivered, because the resync cleared the dedupe set.
    expect(got.map((e) => e.eventId)).toEqual(["evt_a", "evt_a"]);
    expect(got.every((e) => e.eventType === "row_inserted")).toBe(true);
    expect(resyncs).toEqual([{ reason: "cursor-unknown", action: "reread-source" }]);
    expect(conns[1]?.lastEventId).toBe("evt_a");
    expect(conns[2]?.lastEventId).toBeNull();
  });

  const EVICTED = `event: resync\ndata: ${JSON.stringify({ reason: "cursor-evicted", head: 9, action: "reread-source" })}\n\n`;

  it("an opening resync on a fresh connection is informational: the event after it is delivered on the same connection", async () => {
    const conns: Conn[] = [];
    const resyncs: unknown[] = [];
    const scripts: Script[] = [{ text: HEAD + EVICTED + frame("evt_a"), hang: true }, { text: HEAD + frame("evt_late") }];
    const c = createClient({ ...PROJ, fetch: scripted(scripts, conns) });
    const sub = c.realtime.subscribe(TOPIC, { retryDelayMs: 5, onResync: (i) => void resyncs.push(i) });
    const got = await take(sub, 1, () => sub.close());
    expect(got.map((e) => e.eventId)).toEqual(["evt_a"]);
    expect(resyncs).toEqual([]);
    expect(conns).toHaveLength(1);
  });

  it("an opening resync without onResync does not end the subscription", async () => {
    const conns: Conn[] = [];
    const c = createClient({ ...PROJ, fetch: scripted([{ text: HEAD + EVICTED + frame("evt_a"), hang: true }], conns) });
    const sub = c.realtime.subscribe(TOPIC, { retryDelayMs: 5 });
    const got = await take(sub, 1, () => sub.close());
    expect(got.map((e) => e.eventId)).toEqual(["evt_a"]);
    expect(conns).toHaveLength(1);
  });

  it("a resync after an event on the same connection is a real resync: onResync is called and the next connection is fresh", async () => {
    const conns: Conn[] = [];
    const resyncs: unknown[] = [];
    const scripts: Script[] = [{ text: HEAD + frame("evt_a") + EVICTED, hang: true }, { text: HEAD + frame("evt_b") }];
    const c = createClient({ ...PROJ, fetch: scripted(scripts, conns) });
    const sub = c.realtime.subscribe(TOPIC, { retryDelayMs: 5, onResync: (i) => void resyncs.push(i) });
    const got = await take(sub, 2, () => sub.close());
    expect(got.map((e) => e.eventId)).toEqual(["evt_a", "evt_b"]);
    expect(resyncs).toEqual([{ reason: "cursor-evicted", action: "reread-source" }]);
    expect(conns).toHaveLength(2);
    expect(conns[1]?.lastEventId).toBeNull();
  });

  it("a resync that opens a connection sent with Last-Event-ID is a real resync", async () => {
    const conns: Conn[] = [];
    const resyncs: unknown[] = [];
    const scripts: Script[] = [{ text: HEAD + frame("evt_a") }, { text: HEAD + EVICTED, hang: true }, { text: HEAD + frame("evt_b") }];
    const c = createClient({ ...PROJ, fetch: scripted(scripts, conns) });
    const sub = c.realtime.subscribe(TOPIC, { retryDelayMs: 5, onResync: (i) => void resyncs.push(i) });
    const got = await take(sub, 2, () => sub.close());
    expect(got.map((e) => e.eventId)).toEqual(["evt_a", "evt_b"]);
    expect(conns[1]?.lastEventId).toBe("evt_a");
    expect(resyncs).toEqual([{ reason: "cursor-evicted", action: "reread-source" }]);
    expect(conns[2]?.lastEventId).toBeNull();
  });

  it("(e) ignores heartbeat comments", async () => {
    const conns: Conn[] = [];
    const c = createClient({ ...PROJ, fetch: scripted([{ text: `${HEAD}:hb\n\n:hb\n\n${frame("evt_a")}:hb\n\n` }], conns) });
    const sub = c.realtime.subscribe(TOPIC, { retryDelayMs: 5 });
    const got = await take(sub, 1, () => sub.close());
    expect(got.map((e) => e.eventId)).toEqual(["evt_a"]);
  });

  it("skips frames without an eventType", async () => {
    const conns: Conn[] = [];
    const bad = `id: x\ndata: ${JSON.stringify({ topic: TOPIC, payload: {} })}\n\n`;
    const c = createClient({ ...PROJ, fetch: scripted([{ text: bad + frame("evt_a") }], conns) });
    const sub = c.realtime.subscribe(TOPIC, { retryDelayMs: 5 });
    const got = await take(sub, 1, () => sub.close());
    expect(got.map((e) => e.eventId)).toEqual(["evt_a"]);
  });

  it("(f) throws a 4xx once without retrying", async () => {
    const conns: Conn[] = [];
    const c = createClient({ ...PROJ, fetch: scripted([{ status: 403 }, { text: frame("evt_a") }], conns) });
    const sub = c.realtime.subscribe(TOPIC, { retryDelayMs: 5 });
    let err: unknown;
    try {
      for await (const _ of sub) void _;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KError);
    expect((err as KError).status).toBe(403);
    expect(conns.length).toBe(1);
  });

  it("(f) retries a 503 and a network error", async () => {
    const conns: Conn[] = [];
    const c = createClient({ ...PROJ, fetch: scripted([{ status: 503 }, { error: true }, { text: frame("evt_a") }], conns) });
    const sub = c.realtime.subscribe(TOPIC, { retryDelayMs: 5 });
    const got = await take(sub, 1, () => sub.close());
    expect(got.map((e) => e.eventId)).toEqual(["evt_a"]);
    expect(conns.length).toBe(3);
  });

  it("(g) close() and an aborted signal stop reconnecting", async () => {
    for (const how of ["close", "signal"] as const) {
      const conns: Conn[] = [];
      const ctl = new AbortController();
      const c = createClient({ ...PROJ, fetch: scripted([{ text: frame("evt_a") }], conns) });
      const sub = c.realtime.subscribe(TOPIC, { retryDelayMs: 5, signal: ctl.signal });
      const stop = () => (how === "close" ? sub.close() : ctl.abort());
      const got: string[] = [];
      for await (const e of sub) {
        got.push(e.eventId);
        stop();
      }
      const seen = conns.length;
      await new Promise((r) => setTimeout(r, 60));
      expect(got).toEqual(["evt_a"]);
      expect(conns.length).toBe(seen);
    }
  });

  it("(h) abandons a connection that sends no bytes and reconnects", async () => {
    const conns: Conn[] = [];
    const scripts: Script[] = [{ text: HEAD + frame("evt_a"), hang: true }, { text: frame("evt_b") }];
    const c = createClient({ ...PROJ, fetch: scripted(scripts, conns) });
    const sub = c.realtime.subscribe(TOPIC, { retryDelayMs: 5, idleTimeoutMs: 40 });
    const got = await take(sub, 2, () => sub.close());
    expect(got.map((e) => e.eventId)).toEqual(["evt_a", "evt_b"]);
    expect(conns[1]?.lastEventId).toBe("evt_a");
  });

  it("(h) heartbeats keep a quiet connection open", async () => {
    const conns: Conn[] = [];
    const enc2 = new TextEncoder();
    let ticks: ReturnType<typeof setInterval> | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (h["accept"] !== "text/event-stream") return new Response("", { status: 200 });
      conns.push({ url: String(input), lastEventId: null });
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          let n = 0;
          ticks = setInterval(() => {
            n += 1;
            c.enqueue(enc2.encode(n < 5 ? ":hb\n\n" : frame("evt_a")));
          }, 20);
          init?.signal?.addEventListener("abort", () => {
            clearInterval(ticks);
            c.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const c = createClient({ ...PROJ, fetch: fetchImpl });
    const sub = c.realtime.subscribe(TOPIC, { retryDelayMs: 5, idleTimeoutMs: 60 });
    const got = await take(sub, 1, () => sub.close());
    clearInterval(ticks);
    expect(got.length).toBe(1);
    expect(conns.length).toBe(1);
  });
});
