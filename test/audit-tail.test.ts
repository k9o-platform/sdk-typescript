/** client.audit.tail and client.audit.replay: scripted SSE streams (dedupe, resume, replay-ledger resync, idle timeout) and the replay route. */
import { describe, expect, it } from "bun:test";
import { createClient, KError, type AuditTailEvent } from "../src/index.ts";

const enc = new TextEncoder();
const FIVE = ["actorType", "auditEventId", "occurredAt", "outcome", "type"];
const WHEN = "2026-10-27T10:20:38.969Z";

/** The stream frame's own id: not the audit event's id. */
const fid = (auditId: string) => auditId.replace("evt_", "evt_frame_");

/** A frame as the gateway sends it: the audit fields sit under `payload`, the SSE id is the publisher's, the event name is the audit type. */
function frame(auditId: string, type = "data.write.access.insert", payload: Record<string, unknown> = {}): string {
  const data = {
    topic: `audit.project.${type}`, eventType: type,
    payload: { auditEventId: auditId, type, actorType: "user", occurredAt: WHEN, outcome: null, ...payload },
    occurredAt: WHEN, eventId: fid(auditId),
  };
  return `id: ${fid(auditId)}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** One item of a replay answer, as the gateway sends it. */
function item(seq: string, auditId: string, type = "data.write.access.insert", outcome: string | null = null) {
  return { sequence: seq, topic: `audit.project.${type}`, eventType: type, payload: { auditEventId: auditId, type, actorType: "user", occurredAt: WHEN, outcome }, occurredAt: WHEN };
}
const page = (events: unknown[], hasMore = false, nextCursor: unknown = null) => ({ topic: "audit.project.*", events, nextCursor, hasMore });
const RESYNC = `event: resync\ndata: ${JSON.stringify({ reason: "cursor-unknown", action: "replay-ledger" })}\n\n`;
const HEAD = "retry: 10\n:ok\n\n";
const JUNK = 'data: {"x":1}\n\n'; // a data frame that is not an audit event


type Conn = { path: string; query: Record<string, string>; lastEventId: string | null };
type Script = { status?: number; text?: string; hang?: boolean };
type Replay = { body: unknown };

function setup(scripts: Script[], replayAnswers: unknown[] = []) {
  const conns: Conn[] = [];
  const replays: Replay[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const url = new URL(String(input));
    if (url.pathname.endsWith("/realtime/replay")) {
      replays.push({ body: JSON.parse(String(init?.body)) });
      const data = replayAnswers[replays.length - 1] ?? [];
      return new Response(JSON.stringify({ data, meta: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (headers["accept"] !== "text/event-stream") return new Response("", { status: 200 });
    conns.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), lastEventId: headers["last-event-id"] ?? null });
    const s = scripts[conns.length - 1] ?? { hang: true };
    if ((s.status ?? 200) !== 200) {
      return new Response(JSON.stringify({ code: "K9O_RBAC_DENY", message: "no", context: {} }), { status: s.status, headers: { "content-type": "application/json" } });
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
  const c = createClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "portal", apiKey: "tok", fetch: fetchImpl });
  return { c, conns, replays };
}

async function take(sub: AsyncIterable<AuditTailEvent> & { close(): void }, n: number): Promise<AuditTailEvent[]> {
  const out: AuditTailEvent[] = [];
  for await (const e of sub) {
    out.push(e);
    if (out.length === n) sub.close();
  }
  return out;
}

describe("audit.tail", () => {
  it("subscribes to audit.project.* and yields events with exactly the five fields", async () => {
    const { c, conns } = setup([{ text: HEAD + frame("evt_a") }]);
    const got = await take(c.audit.tail({ retryDelayMs: 5 }), 1);
    expect(conns[0]!.path).toBe("/@portal/realtime/subscribe");
    expect(conns[0]!.query).toEqual({ topic: "audit.project.*" });
    expect(conns[0]!.lastEventId).toBeNull();
    expect(Object.keys(got[0]!).sort()).toEqual([...FIVE, "eventId"].sort());
    expect(got[0]).toEqual({ auditEventId: "evt_a", type: "data.write.access.insert", actorType: "user", occurredAt: WHEN, outcome: null, eventId: fid("evt_a") });
  });

  it("one type subscribes to audit.project.<type>; several follow everything and keep the listed types", async () => {
    const one = setup([{ text: frame("evt_a", "auth.sign_in") }]);
    await take(one.c.audit.tail({ types: ["auth.sign_in"], retryDelayMs: 5 }), 1);
    expect(one.conns[0]!.query).toEqual({ topic: "audit.project.auth.sign_in" });

    const many = setup([{ text: frame("evt_a", "auth.sign_in") + frame("evt_b", "data.write.access.insert") + frame("evt_c", "policy.published") + frame("evt_d", "data.write.access.insert") }]);
    const got = await take(many.c.audit.tail({ types: ["data.write.access.insert", "policy.published"], retryDelayMs: 5 }), 3);
    expect(many.conns[0]!.query).toEqual({ topic: "audit.project.*" });
    expect(got.map((e) => e.auditEventId)).toEqual(["evt_b", "evt_c", "evt_d"]);

    const none = setup([{ text: frame("evt_a") }]);
    await take(none.c.audit.tail({ types: [], retryDelayMs: 5 }), 1);
    expect(none.conns[0]!.query).toEqual({ topic: "audit.project.*" });
  });

  it("refuses a bad type before connecting", () => {
    const { c, conns } = setup([]);
    for (const bad of ["", "a.*", "a b"]) expect(() => c.audit.tail({ types: [bad] })).toThrow(TypeError);
    expect(conns).toHaveLength(0);
  });

  it("reconnects with Last-Event-ID after the stream ends and drops a resent event (dedupe)", async () => {
    const { c, conns } = setup([{ text: HEAD + frame("evt_a") + frame("evt_b") }, { text: frame("evt_b") + frame("evt_c") }]);
    const got = await take(c.audit.tail({ retryDelayMs: 5 }), 3);
    expect(got.map((e) => e.auditEventId)).toEqual(["evt_a", "evt_b", "evt_c"]);
    expect(conns).toHaveLength(2);
    expect(conns[1]!.lastEventId).toBe(fid("evt_b")); // the SSE id, not the audit event id
  });

  it("drops a duplicate inside one connection and ignores heartbeats", async () => {
    const { c } = setup([{ text: HEAD + frame("evt_a") + ":hb\n\n" + frame("evt_a") + ":hb\n\n" + frame("evt_b") }]);
    const got = await take(c.audit.tail({ retryDelayMs: 5 }), 2);
    expect(got.map((e) => e.auditEventId)).toEqual(["evt_a", "evt_b"]);
  });

  it("on a replay-ledger resync, calls onResync, replays after the last audit event, yields the catch-up once, and continues live", async () => {
    const seenResync: Array<{ reason: string; action: string }> = [];
    const { c, conns, replays } = setup(
      [{ text: frame("evt_a") + frame("evt_b") + RESYNC }, { text: frame("evt_d") + frame("evt_e") }],
      [page([item("11", "evt_c", "warden.checkpoint"), item("12", "evt_d")])],
    );
    const got = await take(c.audit.tail({ retryDelayMs: 5, onResync: (r) => void seenResync.push(r) }), 5);
    expect(got.map((e) => e.auditEventId)).toEqual(["evt_a", "evt_b", "evt_c", "evt_d", "evt_e"]); // evt_d is in both the replay and the new stream: once
    expect(got[2]).toEqual({ auditEventId: "evt_c", type: "warden.checkpoint", actorType: "user", occurredAt: WHEN, outcome: null, sequence: "11" });
    expect(seenResync).toEqual([{ reason: "cursor-unknown", action: "replay-ledger" }]);
    expect(replays.map((r) => r.body)).toEqual([{ topic: "audit.project.*", afterAuditEventId: "evt_b", limit: 1000 }]); // the audit id, not the frame id
    expect(conns).toHaveLength(2);
    expect(conns[1]!.lastEventId).toBeNull(); // the new connection starts live, after the catch-up
  });

  it("pages the catch-up while hasMore, each page after the last event of the one before", async () => {
    const { c, replays } = setup(
      [{ text: frame("evt_a") + RESYNC }, { text: frame("evt_z") }],
      [page([item("2", "evt_b"), item("3", "evt_c")], true, "3"), page([item("4", "evt_d")], false)],
    );
    const got = await take(c.audit.tail({ retryDelayMs: 5 }), 5);
    expect(got.map((e) => e.auditEventId)).toEqual(["evt_a", "evt_b", "evt_c", "evt_d", "evt_z"]);
    expect(replays.map((r) => (r.body as { afterAuditEventId: string }).afterAuditEventId)).toEqual(["evt_a", "evt_c"]);
  });

  it("decodes the raw frame captured live", async () => {
    const raw =
      "retry: 1000\n:ok\n\n" +
      "id: evt_TqfKnZdBRtggfnwJvuvroU\n" +
      "event: data.write.forge.scheduled_trigger.created\n" +
      'data: {"topic":"audit.project.data.write.forge.scheduled_trigger.created","eventType":"data.write.forge.scheduled_trigger.created","payload":{"auditEventId":"evt_UNs3pW7TSadU","type":"data.write.forge.scheduled_trigger.created","actorType":"user","occurredAt":"2026-10-27T19:31:40.636Z","outcome":null},"occurredAt":"2026-10-27T19:31:40.636Z","eventId":"evt_TqfKnZdBRtggfnwJvuvroU"}\n\n';
    const { c, conns } = setup([{ text: raw }, { text: "" }]);
    const got = await take(c.audit.tail({ retryDelayMs: 5 }), 1);
    expect(got).toEqual([{
      auditEventId: "evt_UNs3pW7TSadU", type: "data.write.forge.scheduled_trigger.created", actorType: "user",
      occurredAt: "2026-10-27T19:31:40.636Z", outcome: null, eventId: "evt_TqfKnZdBRtggfnwJvuvroU",
    }]);
    expect(conns).toHaveLength(1);
  });

  it("catches up on a resync even without onResync, and a resync before any event has nothing to replay", async () => {
    const withoutCb = setup([{ text: frame("evt_a") + RESYNC }, { text: frame("evt_b") }], [page([])]);
    const got = await take(withoutCb.c.audit.tail({ retryDelayMs: 5 }), 2);
    expect(got.map((e) => e.auditEventId)).toEqual(["evt_a", "evt_b"]);
    expect(withoutCb.replays).toHaveLength(1);

    const early = setup([{ text: RESYNC }, { text: frame("evt_a") }]);
    const got2 = await take(early.c.audit.tail({ retryDelayMs: 5 }), 1);
    expect(got2.map((e) => e.auditEventId)).toEqual(["evt_a"]);
    expect(early.replays).toHaveLength(0);
    expect(early.conns).toHaveLength(2);
  });

  it("an event published after the replay's last event but before the fresh stream's first frame is in the backlog and yielded once", async () => {
    // evt_e lands after the replay ends (evt_d) and before the fresh stream's first frame: the backlog carries it.
    const { c } = setup(
      [{ text: frame("evt_a") + RESYNC }, { text: frame("evt_c") + frame("evt_d") + frame("evt_e") + frame("evt_f") }],
      [page([item("2", "evt_b"), item("3", "evt_c"), item("4", "evt_d")])],
    );
    const got = await take(c.audit.tail({ retryDelayMs: 5 }), 6);
    expect(got.map((e) => e.auditEventId)).toEqual(["evt_a", "evt_b", "evt_c", "evt_d", "evt_e", "evt_f"]);
  });

  it("opens the fresh connection before the replay, and yields frames buffered during the replay after the replay events, deduped", async () => {
    const order: string[] = [];
    const conns: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/realtime/replay")) {
        order.push("replay-start");
        await gate; // the fresh stream's frames arrive while this waits
        order.push("replay-end");
        return new Response(JSON.stringify({ data: page([item("2", "evt_b"), item("3", "evt_c")]), meta: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if ((init?.headers as Record<string, string>)?.["accept"] !== "text/event-stream") return new Response("", { status: 200 });
      conns.push(1);
      order.push(`connect-${conns.length}`);
      const text = conns.length === 1 ? frame("evt_a") + RESYNC : frame("evt_c") + frame("evt_d");
      const stream = new ReadableStream<Uint8Array>({
        start(ctl) {
          ctl.enqueue(enc.encode(text));
          if (conns.length === 2) setTimeout(release, 30);
          else ctl.close();
          if (conns.length > 1) init?.signal?.addEventListener("abort", () => ctl.error(new DOMException("aborted", "AbortError")), { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof globalThis.fetch;
    const c = createClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "portal", apiKey: "tok", fetch: fetchImpl });
    const got = await take(c.audit.tail({ retryDelayMs: 5 }), 4);
    expect(got.map((e) => e.auditEventId)).toEqual(["evt_a", "evt_b", "evt_c", "evt_d"]); // evt_c once
    expect(order.slice(0, 3)).toEqual(["connect-1", "connect-2", "replay-start"]); // connected before the replay ran
  });

  it("a resync that opens a fresh connection only reports the head: the backlog after it is read on the same connection", async () => {
    const seenResync: unknown[] = [];
    const { c, conns, replays } = setup([{ text: HEAD + RESYNC + frame("evt_a") + frame("evt_b"), hang: true }]);
    const got = await take(c.audit.tail({ retryDelayMs: 5, onResync: (r) => void seenResync.push(r) }), 2);
    expect(got.map((e) => e.auditEventId)).toEqual(["evt_a", "evt_b"]);
    expect(conns).toHaveLength(1);
    expect(replays).toHaveLength(0);
    expect(seenResync).toHaveLength(0);
  });

  it("a double resync backs off instead of spinning", async () => {
    const { c, conns } = setup([{ text: frame("evt_a") + RESYNC }, { text: JUNK + RESYNC }, { text: JUNK + RESYNC }, { text: frame("evt_b") }], [page([]), page([]), page([])]);
    const t0 = Date.now();
    const got = await take(c.audit.tail({ retryDelayMs: 60 }), 2);
    expect(got.map((e) => e.auditEventId)).toEqual(["evt_a", "evt_b"]);
    expect(conns).toHaveLength(4);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100); // two backoffs after the second and third resync
  });

  it("a replay page that makes no progress ends the catch-up", async () => {
    const { c, replays } = setup(
      [{ text: frame("evt_a") + RESYNC }, { text: frame("evt_z") }],
      [page([item("2", "evt_a")], true, "2"), page([item("2", "evt_a")], true, "2")],
    );
    const got = await take(c.audit.tail({ retryDelayMs: 5 }), 2);
    expect(got.map((e) => e.auditEventId)).toEqual(["evt_a", "evt_z"]);
    expect(replays).toHaveLength(1);
  });

  it("catch-up keeps the type filter and replays the one-type topic", async () => {
    const { c, replays } = setup(
      [{ text: frame("evt_a", "auth.sign_in") + RESYNC }, { text: frame("evt_z", "auth.sign_in") }],
      [page([item("2", "evt_b", "auth.sign_in", "success")])],
    );
    const got = await take(c.audit.tail({ types: ["auth.sign_in"], retryDelayMs: 5 }), 3);
    expect(got.map((e) => e.auditEventId)).toEqual(["evt_a", "evt_b", "evt_z"]);
    expect((replays[0]!.body as { topic: string }).topic).toBe("audit.project.auth.sign_in");
  });

  it("reopens a connection that goes quiet (idle timeout) with Last-Event-ID", async () => {
    const { c, conns } = setup([{ text: HEAD + frame("evt_a"), hang: true }, { text: frame("evt_b") }]);
    const t0 = Date.now();
    const got = await take(c.audit.tail({ idleTimeoutMs: 60, retryDelayMs: 5 }), 2);
    expect(got.map((e) => e.auditEventId)).toEqual(["evt_a", "evt_b"]);
    expect(conns[1]!.lastEventId).toBe(fid("evt_a"));
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("throws a 403 once (no retry) as a KError", async () => {
    const { c, conns } = setup([{ status: 403 }]);
    let caught: unknown;
    try {
      await take(c.audit.tail({ retryDelayMs: 5 }), 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KError);
    expect([(caught as KError).status, (caught as KError).code]).toEqual([403, "K9O_RBAC_DENY"]);
    expect(conns).toHaveLength(1);
  });

  it("stops on signal abort and on close()", async () => {
    const a = setup([{ text: frame("evt_a"), hang: true }]);
    const ac = new AbortController();
    const seen: string[] = [];
    for await (const e of a.c.audit.tail({ signal: ac.signal, retryDelayMs: 5 })) {
      seen.push(e.auditEventId);
      ac.abort();
    }
    expect(seen).toEqual(["evt_a"]);
    const b = setup([{ hang: true }]);
    const sub = b.c.audit.tail({ retryDelayMs: 5 });
    setTimeout(() => sub.close(), 30);
    const none: string[] = [];
    for await (const e of sub) none.push(e.auditEventId);
    expect(none).toEqual([]);
  });

  it("needs projectSlug on the client", () => {
    const c = createClient({ baseUrl: "https://acme.api.k9o.io", apiKey: "tok", fetch: (async () => new Response("", { status: 200 })) as never });
    expect(() => c.audit.tail()).toThrow(/projectSlug/);
  });
});

describe("audit.replay", () => {
  it("POSTs the topic and afterAuditEventId to /realtime/replay and returns the typed page", async () => {
    const { c, replays } = setup([], [page([item("8", "evt_b", "x.y", "denied")], true, "8")]);
    const r = await c.audit.replay({ afterAuditEventId: "evt_a", limit: 50 });
    expect(replays[0]!.body).toEqual({ topic: "audit.project.*", afterAuditEventId: "evt_a", limit: 50 });
    expect(r.data).toEqual({
      events: [{ auditEventId: "evt_b", type: "x.y", actorType: "user", occurredAt: WHEN, outcome: "denied", sequence: "8" }],
      nextCursor: "8", hasMore: true,
    });
  });

  it("sends fromSequence 0 and decodes the live replay answer", async () => {
    const live = {
      topic: "audit.project.*",
      events: [{ sequence: "1", topic: "audit.project.data.write.pulse_stream.created", eventType: "data.write.pulse_stream.created", payload: { auditEventId: "evt_UGgF77wit3Xx", type: "data.write.pulse_stream.created", actorType: "user", occurredAt: "2026-10-27T19:00:00.000Z", outcome: null }, occurredAt: "2026-10-27T19:00:00.000Z" }],
      nextCursor: null, hasMore: false,
    };
    const { c, replays } = setup([], [live]);
    const r = await c.audit.replay({ fromSequence: 0, limit: 3 });
    expect(replays[0]!.body).toEqual({ topic: "audit.project.*", fromSequence: 0, limit: 3 });
    expect(r.data.events[0]).toEqual({ auditEventId: "evt_UGgF77wit3Xx", type: "data.write.pulse_stream.created", actorType: "user", occurredAt: "2026-10-27T19:00:00.000Z", outcome: null, sequence: "1" });
    expect(r.data.hasMore).toBe(false);
    expect(r.data.nextCursor).toBeNull();
  });

  it("afterAuditEventId wins over fromSequence, and untilSequence is sent", async () => {
    const { c, replays } = setup([], [page([]), page([])]);
    await c.audit.replay({ afterAuditEventId: "evt_a", fromSequence: 5 });
    await c.audit.replay({ topic: "audit.project.x.y", fromSequence: 9, untilSequence: 20 });
    expect(replays[0]!.body).toEqual({ topic: "audit.project.*", afterAuditEventId: "evt_a", limit: 1000 });
    expect(replays[1]!.body).toEqual({ topic: "audit.project.x.y", fromSequence: 9, untilSequence: 20, limit: 1000 });
  });

  it("checks its arguments before sending", async () => {
    const { c, replays } = setup([]);
    await expect(c.audit.replay({})).rejects.toThrow(TypeError);
    await expect(c.audit.replay({ afterAuditEventId: "not-an-id" })).rejects.toThrow(TypeError);
    expect(replays).toHaveLength(0);
  });

  it("sends limit 1000 by default, passes an explicit limit, and refuses 0 and 10001 before sending", async () => {
    const { c, replays } = setup([], [page([]), page([]), page([])]);
    await c.audit.replay({ afterAuditEventId: "evt_a" });
    await c.audit.replay({ afterAuditEventId: "evt_a", limit: 10_000 });
    await c.audit.replay({ fromSequence: 1, limit: 5 });
    expect(replays.map((r) => (r.body as { limit: number }).limit)).toEqual([1000, 10_000, 5]);
    for (const limit of [0, 10_001, 1.5]) {
      const e = await c.audit.replay({ fromSequence: 1, limit }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(KError);
      expect((e as KError).code).toBe("K9O_INVALID_FIELD_VALUE");
    }
    expect(replays).toHaveLength(3);
  });

  it("surfaces 400 K9O_INVALID_CURSOR and 403 K9O_RBAC_DENY", async () => {
    for (const [status, code] of [[400, "K9O_INVALID_CURSOR"], [403, "K9O_RBAC_DENY"]] as const) {
      const c = createClient({
        baseUrl: "https://acme.api.k9o.io", projectSlug: "portal", apiKey: "tok",
        fetch: (async (_u: unknown, init?: RequestInit) =>
          init?.method === "HEAD" ? new Response(null, { status: 200 }) : new Response(JSON.stringify({ code, message: "x", context: {} }), { status, headers: { "content-type": "application/json" } })) as never,
      });
      const e = await c.audit.replay({ afterAuditEventId: "evt_a" }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(KError);
      expect([(e as KError).status, (e as KError).code]).toEqual([status, code]);
    }
  });
});
