/**
 * client.metadata.*: method, path, query and body of every call, the metadata. prefix, client-side validation that sends
 * nothing, error decoding, and subscribe over the shared change-feed reader. Fixtures follow the gateway's documented answers.
 */

import { describe, expect, it } from "bun:test";
import { createClient, KError, type MetadataChange, type RealtimeEvent } from "../src/index.ts";

type Seen = { url: string; method: string; body?: unknown };

function client(respond: () => { status?: number; body: unknown }) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    seen.push({
      url: String(input),
      method: String(init?.method),
      ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const r = respond();
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const c = createClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "portal", apiKey: "k", fetch: fetchImpl });
  return { c, seen };
}

const BASE = "https://acme.api.k9o.io/@portal/metadata";

const p1 = { surface: "collection:posts", scope: "posts", recordId: "p1", metadata: { title: "Quarterly report", body: "...", tags: ["pinned", "finance"], priority: 3, embedding: "[1,0,0]" } };
const telemetry = {
  surface: "telemetry:collection.metadata_index_declared", scope: "collection.metadata_index_declared", eventId: "aud_1",
  metadata: { id: "aud_1", type: "collection.metadata_index_declared", actorId: "usr_1", occurredAt: "2026-10-26T20:00:00.000Z" },
};
const queryAnswer = { data: [p1, telemetry], meta: { requestId: "r1", cursor: { next: null } } };

async function rejects(p: Promise<unknown>): Promise<KError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(KError);
    return e as KError;
  }
  throw new Error("expected a rejection");
}

describe("metadata.filter", () => {
  it("posts surfaces, prefixes collection fields and returns rows with the next cursor", async () => {
    const { c, seen } = client(() => ({ body: { data: [p1], meta: { cursor: { next: "cur_1" } } } }));
    const r = await c.metadata.filter({
      surfaces: ["collection:posts"],
      where: [{ field: "priority", op: "gte", value: 2 }, { field: "metadata.title", op: "startsWith", value: "Q" }],
      limit: 1,
      cursor: "cur_0",
    });
    expect(seen).toEqual([{
      method: "POST",
      url: `${BASE}/query`,
      body: {
        surfaces: ["collection:posts"],
        where: [{ field: "metadata.priority", op: "gte", value: 2 }, { field: "metadata.title", op: "startsWith", value: "Q" }],
        limit: 1,
        cursor: "cur_0",
      },
    }]);
    expect(r.cursor).toBe("cur_1");
    expect(r.data[0]!.recordId).toBe("p1");
    expect(r.data[0]!.metadata["priority"]).toBe(3);
  });

  it("sends only the surfaces when nothing else is given, and reports a null cursor", async () => {
    const { c, seen } = client(() => ({ body: queryAnswer }));
    const r = await c.metadata.filter({ surfaces: ["collection:posts", "telemetry:collection.metadata_index_declared"] });
    expect(seen[0]!.body).toEqual({ surfaces: ["collection:posts", "telemetry:collection.metadata_index_declared"] });
    expect(r.cursor).toBeNull();
    expect(r.data[1]!.eventId).toBe("aud_1");
  });

  it("leaves createdAt and actorId bare when a telemetry surface is named", async () => {
    const { c, seen } = client(() => ({ body: queryAnswer }));
    await c.metadata.filter({
      surfaces: ["telemetry:collection."],
      where: [{ field: "createdAt", op: "gt", value: "2026-10-26T00:00:00Z" }, { field: "actorId", op: "eq", value: "usr_1" }],
    });
    expect((seen[0]!.body as { where: unknown }).where).toEqual([
      { field: "createdAt", op: "gt", value: "2026-10-26T00:00:00Z" },
      { field: "actorId", op: "eq", value: "usr_1" },
    ]);
  });

  it("lets a storage surface through and decodes the 501", async () => {
    const { c, seen } = client(() => ({
      status: 501,
      body: { code: "K9O_NOT_IMPLEMENTED", message: "storage metadata is not available", context: { surface: "storage:photos" } },
    }));
    const e = await rejects(c.metadata.filter({ surfaces: ["storage:photos"] }));
    expect(seen[0]!.body).toEqual({ surfaces: ["storage:photos"] });
    expect([e.code, e.status, e.context["surface"]]).toEqual(["K9O_NOT_IMPLEMENTED", 501, "storage:photos"]);
  });

  it("decodes the 413 and the 400 not-indexed answers", async () => {
    const big = client(() => ({
      status: 413,
      body: { code: "K9O_QUERY_RESULT_TOO_LARGE", message: "too many rows", context: { cap: 10000, surfaces: ["collection:posts"] }, recommendation: "Add where or lower limit." },
    }));
    const e413 = await rejects(big.c.metadata.filter({ surfaces: ["collection:posts"] }));
    expect([e413.code, e413.status, e413.context["cap"], e413.recommendation]).toEqual(["K9O_QUERY_RESULT_TOO_LARGE", 413, 10000, "Add where or lower limit."]);

    const nope = client(() => ({
      status: 400,
      body: { code: "K9O_METADATA_FIELD_NOT_INDEXED", message: "not declared", context: { surface: "collection:posts", field: "metadata.secret" }, recommendation: { action: "declare it" } },
    }));
    const e400 = await rejects(nope.c.metadata.filter({ surfaces: ["collection:posts"], where: [{ field: "secret", op: "eq", value: 1 }] }));
    expect([e400.code, e400.status, e400.context["field"], e400.recommendation]).toEqual(["K9O_METADATA_FIELD_NOT_INDEXED", 400, "metadata.secret", "declare it"]);
  });

  it("refuses bad input before sending anything", async () => {
    const { c, seen } = client(() => ({ body: queryAnswer }));
    const bad: Array<Parameters<typeof c.metadata.filter>[0]> = [
      { surfaces: [] },
      { surfaces: ["posts"] },
      { surfaces: ["table:posts"] },
      { surfaces: ["collection:"] },
      { surfaces: ["collection:1posts"] },
      { surfaces: ["collection:posts", "telemetry:x"], cursor: "c" },
      { surfaces: ["collection:posts"], limit: 0 },
      { surfaces: ["collection:posts"], limit: 1001 },
      { surfaces: ["collection:posts"], limit: 1.5 },
      { surfaces: ["collection:posts"], where: [{ field: "a", op: "like" as never }] },
      { surfaces: ["collection:posts"], where: [{ field: "", op: "eq" }] },
      { surfaces: ["collection:posts"], where: "x" as never },
    ];
    for (const input of bad) await rejects(c.metadata.filter(input));
    const unknown = await rejects(c.metadata.filter({ surfaces: ["posts"] }));
    expect(unknown.code).toBe("K9O_UNKNOWN_SURFACE");
    expect(seen).toEqual([]);
  });
});

describe("metadata.set", () => {
  it("patches the record with the bare columns and returns the whole row", async () => {
    const row = { id: "p2", title: "Team offsite 2027", priority: 9, secret: "s2" };
    const { c, seen } = client(() => ({ body: { data: row, meta: { requestId: "r2" } } }));
    const r = await c.metadata.set("posts", "p 2", { title: "Team offsite 2027", "metadata.priority": 9 });
    expect(seen).toEqual([{
      method: "PATCH",
      url: `${BASE}/collection/posts/p%202`,
      body: { metadata: { title: "Team offsite 2027", priority: 9 } },
    }]);
    expect(r.data).toEqual(row);
  });

  it("refuses bad input before sending anything", async () => {
    const { c, seen } = client(() => ({ body: { data: {}, meta: {} } }));
    await rejects(c.metadata.set("bad-name", "p1", { a: 1 }));
    await rejects(c.metadata.set("posts", "", { a: 1 }));
    await rejects(c.metadata.set("posts", "p1", {}));
    await rejects(c.metadata.set("posts", "p1", [] as never));
    expect(seen).toEqual([]);
  });

  it("decodes the not-declared answer", async () => {
    const { c } = client(() => ({ status: 400, body: { code: "K9O_METADATA_FIELD_NOT_INDEXED", message: "x", context: { field: "metadata.nope" } } }));
    expect((await rejects(c.metadata.set("posts", "p1", { nope: 1 }))).code).toBe("K9O_METADATA_FIELD_NOT_INDEXED");
  });
});

describe("metadata.search", () => {
  const answer = {
    data: [{ surface: "collection:posts", scope: "posts", recordId: "p3", metadata: { title: "Budget draft", body: "draft budget, finance review" } }],
    meta: { cursor: { next: null } },
  };

  it("posts surface, prefixed field, q and limit", async () => {
    const { c, seen } = client(() => ({ body: answer }));
    const r = await c.metadata.search({ surface: "collection:posts", field: "body", q: "finance", limit: 5 });
    expect(seen).toEqual([{ method: "POST", url: `${BASE}/search`, body: { surface: "collection:posts", field: "metadata.body", q: "finance", limit: 5 } }]);
    expect(r.data.map((x) => x.recordId)).toEqual(["p3"]);
    expect(r.cursor).toBeNull();
  });

  it("keeps an existing prefix and omits limit", async () => {
    const { c, seen } = client(() => ({ body: answer }));
    await c.metadata.search({ surface: "collection:posts", field: "metadata.body", q: "x" });
    expect(seen[0]!.body).toEqual({ surface: "collection:posts", field: "metadata.body", q: "x" });
  });

  it("refuses bad input before sending anything", async () => {
    const { c, seen } = client(() => ({ body: answer }));
    await rejects(c.metadata.search({ surface: "telemetry:x", field: "body", q: "a" }));
    await rejects(c.metadata.search({ surface: "storage:b", field: "body", q: "a" }));
    await rejects(c.metadata.search({ surface: "collection:posts", field: "", q: "a" }));
    await rejects(c.metadata.search({ surface: "collection:posts", field: "body", q: "" }));
    await rejects(c.metadata.search({ surface: "collection:posts", field: "body", q: "a", limit: 2000 }));
    expect(seen).toEqual([]);
  });

  it("decodes the encrypted-column answer", async () => {
    const { c } = client(() => ({ status: 400, body: { code: "K9O_ENCRYPTED_COLUMN_OPERATION_UNSUPPORTED", message: "x", context: { column: "body", op: "textSearch" } } }));
    expect((await rejects(c.metadata.search({ surface: "collection:posts", field: "body", q: "a" }))).code).toBe("K9O_ENCRYPTED_COLUMN_OPERATION_UNSUPPORTED");
  });
});

describe("metadata.vectors.nearest", () => {
  const answer = { data: [{ surface: "collection:posts", scope: "posts", recordId: "p1", metadata: { title: "Quarterly report", embedding: "[1,0,0]" } }], meta: { cursor: { next: null } } };

  it("posts the prefixed column, the embedding and the options", async () => {
    const { c, seen } = client(() => ({ body: answer }));
    const r = await c.metadata.vectors.nearest({
      surface: "collection:posts", column: "embedding", embedding: [1, 0, 0], k: 3, metric: "dot",
      where: [{ field: "priority", op: "gt", value: 1 }],
    });
    expect(seen).toEqual([{
      method: "POST",
      url: `${BASE}/vectors/nearest`,
      body: {
        surface: "collection:posts", column: "metadata.embedding", embedding: [1, 0, 0], k: 3, metric: "dot",
        where: [{ field: "metadata.priority", op: "gt", value: 1 }],
      },
    }]);
    expect(r.data[0]!.recordId).toBe("p1");
  });

  it("sends only the required fields by default", async () => {
    const { c, seen } = client(() => ({ body: answer }));
    await c.metadata.vectors.nearest({ surface: "collection:posts", column: "metadata.embedding", embedding: [0.5] });
    expect(seen[0]!.body).toEqual({ surface: "collection:posts", column: "metadata.embedding", embedding: [0.5] });
  });

  it("refuses bad input before sending anything", async () => {
    const { c, seen } = client(() => ({ body: answer }));
    const base = { surface: "collection:posts", column: "embedding", embedding: [1] };
    await rejects(c.metadata.vectors.nearest({ ...base, embedding: [] }));
    await rejects(c.metadata.vectors.nearest({ ...base, embedding: [1, Number.NaN] }));
    await rejects(c.metadata.vectors.nearest({ ...base, k: 0 }));
    await rejects(c.metadata.vectors.nearest({ ...base, metric: "l2" as never }));
    await rejects(c.metadata.vectors.nearest({ ...base, surface: "telemetry:x" }));
    await rejects(c.metadata.vectors.nearest({ ...base, column: "" }));
    expect(seen).toEqual([]);
  });
});

describe("metadata.index", () => {
  const index = { data: { collection: "posts", columns: [{ column: "body", indexed: false }, { column: "tags", indexed: true }] }, meta: {} };

  it("gets the declaration", async () => {
    const { c, seen } = client(() => ({ body: index }));
    const r = await c.metadata.index.get("posts");
    expect(seen).toEqual([{ method: "GET", url: `${BASE}/index/posts` }]);
    expect(r.data.columns[1]).toEqual({ column: "tags", indexed: true });
  });

  it("declares columns with PUT", async () => {
    const { c, seen } = client(() => ({ body: index }));
    await c.metadata.index.declare("posts", [{ column: "body" }, { column: "tags", indexed: true }]);
    expect(seen).toEqual([{ method: "PUT", url: `${BASE}/index/posts`, body: { columns: [{ column: "body" }, { column: "tags", indexed: true }] } }]);
  });

  it("clears the declaration with an empty list and accepts 64 columns", async () => {
    const { c, seen } = client(() => ({ body: index }));
    await c.metadata.index.declare("posts", []);
    await c.metadata.index.declare("posts", Array.from({ length: 64 }, (_, i) => ({ column: `c${i}` })));
    expect((seen[0]!.body as { columns: unknown[] }).columns).toEqual([]);
    expect((seen[1]!.body as { columns: unknown[] }).columns.length).toBe(64);
  });

  it("refuses more than 64 columns, id, repeats and bad names before sending anything", async () => {
    const { c, seen } = client(() => ({ body: index }));
    await rejects(c.metadata.index.declare("posts", Array.from({ length: 65 }, (_, i) => ({ column: `c${i}` }))));
    await rejects(c.metadata.index.declare("posts", [{ column: "id" }]));
    await rejects(c.metadata.index.declare("posts", [{ column: "a" }, { column: "a" }]));
    await rejects(c.metadata.index.declare("posts", [{ column: "a b" }]));
    await rejects(c.metadata.index.declare("posts", [{ column: "a", indexed: "yes" as never }]));
    await rejects(c.metadata.index.declare("bad-name", []));
    await rejects(c.metadata.index.get("bad-name"));
    expect(seen).toEqual([]);
  });

  it("decodes a missing collection and a refused role", async () => {
    const missing = client(() => ({ status: 404, body: { code: "K9O_COLLECTION_NOT_FOUND", message: "x" } }));
    expect((await rejects(missing.c.metadata.index.declare("ghost", []))).status).toBe(404);
    const denied = client(() => ({ status: 403, body: { code: "K9O_IAM_POLICY_DENIED", message: "x" } }));
    expect((await rejects(denied.c.metadata.index.declare("posts", []))).code).toBe("K9O_IAM_POLICY_DENIED");
  });
});

// ----------------------------------------------------------------------
// subscribe
// ----------------------------------------------------------------------

const enc = new TextEncoder();
const HEAD = "retry: 10\n:ok\n\n";
const RESYNC = `event: resync\ndata: ${JSON.stringify({ reason: "cursor-evicted", head: 9, action: "reread-source" })}\n\n`;

/** A change frame as the gateway sends it: an `id`, no `eventId` in the data. */
function frame(id: string, eventType = "row_updated", recordId = "p2"): string {
  const data = { topic: `collections.posts.${eventType}`, eventType, payload: { collection: "posts", id: recordId }, occurredAt: "2026-10-27T10:20:38.969Z" };
  return `id: ${id}\nevent: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

type Conn = { url: string; lastEventId: string | null };
type Script = { text?: string; hang?: boolean };

function scripted(scripts: Script[], conns: Conn[]): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers["accept"] !== "text/event-stream") return new Response("", { status: 200 });
    conns.push({ url: String(input), lastEventId: headers["last-event-id"] ?? null });
    const s = scripts[conns.length - 1] ?? { hang: true };
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        if (s.text) ctl.enqueue(enc.encode(s.text));
        if (!s.hang) ctl.close();
        else init?.signal?.addEventListener("abort", () => ctl.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof globalThis.fetch;
}

const PROJ = { baseUrl: "https://acme.api.k9o.io", projectSlug: "portal" };

async function take(sub: AsyncIterable<RealtimeEvent<MetadataChange>>, n: number, close: () => void): Promise<RealtimeEvent<MetadataChange>[]> {
  const out: RealtimeEvent<MetadataChange>[] = [];
  for await (const e of sub) {
    out.push(e);
    if (out.length === n) close();
  }
  return out;
}

describe("metadata.subscribe", () => {
  it("opens the metadata feed with surface and fromSequence and yields {collection,id} payloads keyed by the frame id", async () => {
    const conns: Conn[] = [];
    const c = createClient({ ...PROJ, fetch: scripted([{ text: HEAD + frame("1:5") }], conns) });
    const sub = c.metadata.subscribe("collection:posts", { fromSequence: 4, retryDelayMs: 5 });
    const got = await take(sub, 1, () => sub.close());
    const url = new URL(conns[0]!.url);
    expect(url.pathname).toBe("/@portal/metadata/subscribe");
    expect(url.searchParams.get("surface")).toBe("collection:posts");
    expect(url.searchParams.get("fromSequence")).toBe("4");
    expect(conns[0]!.lastEventId).toBeNull();
    expect(got[0]!.eventType).toBe("row_updated");
    expect(got[0]!.eventId).toBe("1:5");
    const change: MetadataChange = got[0]!.payload;
    expect(change).toEqual({ collection: "posts", id: "p2" });
  });

  it("omits fromSequence when not given", async () => {
    const conns: Conn[] = [];
    const c = createClient({ ...PROJ, fetch: scripted([{ text: HEAD + frame("1:5") }], conns) });
    const sub = c.metadata.subscribe("collection:posts", { retryDelayMs: 5 });
    await take(sub, 1, () => sub.close());
    expect(new URL(conns[0]!.url).searchParams.has("fromSequence")).toBe(false);
  });

  it("reconnects with Last-Event-ID instead of fromSequence and drops a resent frame", async () => {
    const conns: Conn[] = [];
    const scripts: Script[] = [
      { text: HEAD + frame("1:5") + frame("1:6", "row_inserted", "p9") },
      { text: HEAD + frame("1:6", "row_inserted", "p9") + frame("1:7", "row_deleted", "p1") },
    ];
    const c = createClient({ ...PROJ, fetch: scripted(scripts, conns) });
    const sub = c.metadata.subscribe("collection:posts", { fromSequence: 4, retryDelayMs: 5 });
    const got = await take(sub, 3, () => sub.close());
    expect(got.map((e) => [e.eventId, e.eventType, e.payload.id])).toEqual([["1:5", "row_updated", "p2"], ["1:6", "row_inserted", "p9"], ["1:7", "row_deleted", "p1"]]);
    expect(conns[1]!.lastEventId).toBe("1:6");
    expect(new URL(conns[1]!.url).searchParams.has("fromSequence")).toBe(false);
  });

  it("an opening resync on a fresh connection is informational: the event after it is delivered, no onResync, no reconnect", async () => {
    const conns: Conn[] = [];
    const resyncs: unknown[] = [];
    const scripts: Script[] = [{ text: HEAD + RESYNC + frame("2:1"), hang: true }, { text: HEAD + frame("2:2") }];
    const c = createClient({ ...PROJ, fetch: scripted(scripts, conns) });
    const sub = c.metadata.subscribe("collection:posts", { retryDelayMs: 5, onResync: (i) => void resyncs.push(i) });
    const got = await take(sub, 1, () => sub.close());
    expect(got.map((e) => e.eventId)).toEqual(["2:1"]);
    expect(resyncs).toEqual([]);
    expect(conns).toHaveLength(1);
  });

  it("a resync that opens a connection sent with fromSequence is a real resync: onResync, then a fresh connection without fromSequence", async () => {
    const conns: Conn[] = [];
    const resyncs: unknown[] = [];
    const scripts: Script[] = [{ text: HEAD + RESYNC }, { text: HEAD + frame("2:1") }];
    const c = createClient({ ...PROJ, fetch: scripted(scripts, conns) });
    const sub = c.metadata.subscribe("collection:posts", { fromSequence: 3, retryDelayMs: 5, onResync: (i) => void resyncs.push(i) });
    const got = await take(sub, 1, () => sub.close());
    expect(got.map((e) => e.eventId)).toEqual(["2:1"]);
    expect(resyncs).toEqual([{ reason: "cursor-evicted", action: "reread-source" }]);
    expect(new URL(conns[0]!.url).searchParams.get("fromSequence")).toBe("3");
    expect(new URL(conns[1]!.url).searchParams.has("fromSequence")).toBe(false);
  });

  it("calls onResync and starts the next connection without Last-Event-ID or fromSequence", async () => {
    const conns: Conn[] = [];
    const scripts: Script[] = [{ text: HEAD + frame("1:9") + RESYNC }, { text: HEAD + frame("2:1") }];
    const resyncs: unknown[] = [];
    const c = createClient({ ...PROJ, fetch: scripted(scripts, conns) });
    const sub = c.metadata.subscribe("collection:posts", { fromSequence: 3, retryDelayMs: 5, onResync: (i) => void resyncs.push(i) });
    const got = await take(sub, 2, () => sub.close());
    expect(got.map((e) => e.eventId)).toEqual(["1:9", "2:1"]);
    expect(resyncs).toEqual([{ reason: "cursor-evicted", action: "reread-source" }]);
    expect(new URL(conns[0]!.url).searchParams.get("fromSequence")).toBe("3");
    expect(conns[1]!.lastEventId).toBeNull();
    expect(new URL(conns[1]!.url).searchParams.has("fromSequence")).toBe(false);
  });

  it("refuses non-collection surfaces and a bad fromSequence before connecting", () => {
    const conns: Conn[] = [];
    const c = createClient({ ...PROJ, fetch: scripted([], conns) });
    expect(() => c.metadata.subscribe("telemetry:x")).toThrow(KError);
    expect(() => c.metadata.subscribe("storage:b")).toThrow(KError);
    expect(() => c.metadata.subscribe("posts")).toThrow(KError);
    expect(() => c.metadata.subscribe("collection:posts", { fromSequence: -1 })).toThrow(KError);
    expect(() => c.metadata.subscribe("collection:posts", { fromSequence: 1.5 })).toThrow(KError);
    expect(conns).toEqual([]);
  });
});
