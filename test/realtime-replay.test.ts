/**
 * client.realtime.replay(): POST /@<slug>/realtime/replay with a required topic; body, validation, decoding, errors.
 */

import { describe, expect, it } from "bun:test";
import { createClient, KError } from "../src/index.ts";

type Call = { method: string; path: string; body: unknown };

function setup(answers: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const c = createClient({
    baseUrl: "https://acme.api.k9o.io",
    projectSlug: "portal",
    apiKey: "tok",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response("", { status: 200 });
      calls.push({ method: "POST", path: new URL(String(input)).pathname, body: JSON.parse(String(init.body)) });
      const a = answers[calls.length - 1] ?? { json: {} };
      return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
    }) as never,
  });
  return { c, calls };
}

const M = { requestId: "req_1" };
const WHEN = "2026-10-27T19:00:00.000Z";
const ledger = {
  data: {
    topic: "audit.project.*",
    events: [
      { sequence: "7", topic: "audit.project.auth.sign_in", eventType: "auth.sign_in", payload: { auditEventId: "evt_a", type: "auth.sign_in" }, occurredAt: WHEN },
      { sequence: 8, topic: "audit.project.auth.sign_in", eventType: "auth.sign_in", payload: { auditEventId: "evt_b" }, occurredAt: WHEN, eventId: "evt_f1" },
      { nope: true },
    ],
    nextCursor: "8",
    hasMore: true,
  },
  meta: { requestId: "req_1" },
};

describe("realtime.replay", () => {
  it("POSTs the topic and only the options given, and decodes realtime-shaped events", async () => {
    const { c, calls } = setup([{ json: ledger }]);
    const r = await c.realtime.replay("audit.project.*", { fromSequence: 7, untilSequence: "20", limit: 50 });
    expect(calls[0]).toEqual({ method: "POST", path: "/@portal/realtime/replay", body: { topic: "audit.project.*", fromSequence: 7, untilSequence: "20", limit: 50 } });
    expect(r.data.topic).toBe("audit.project.*");
    expect(r.data.events).toEqual([
      { topic: "audit.project.auth.sign_in", eventType: "auth.sign_in", payload: { auditEventId: "evt_a", type: "auth.sign_in" }, occurredAt: WHEN, sequence: "7" },
      { topic: "audit.project.auth.sign_in", eventType: "auth.sign_in", payload: { auditEventId: "evt_b" }, occurredAt: WHEN, eventId: "evt_f1", sequence: "8" },
    ]);
    expect(r.data.nextCursor).toBe("8");
    expect(r.data.hasMore).toBe(true);
    expect(r.meta).toEqual({ requestId: "req_1" });
  });

  it("sends only the topic by default, and afterAuditEventId when given", async () => {
    const { c, calls } = setup([{ json: { data: { events: [], nextCursor: null, hasMore: false }, meta: M } }, { json: { data: {}, meta: M } }]);
    await c.realtime.replay("audit.project.*");
    await c.realtime.replay("audit.project.*", { afterAuditEventId: "evt_a", fromSequence: 0 });
    expect(calls[0]!.body).toEqual({ topic: "audit.project.*" });
    expect(calls[1]!.body).toEqual({ topic: "audit.project.*", fromSequence: 0, afterAuditEventId: "evt_a" });
  });

  it("returns resync for a topic without a ledger", async () => {
    const { c } = setup([{ json: { data: { topic: "collections.orders.*", events: [], nextCursor: null, hasMore: false, resync: "reread-source" }, meta: M } }]);
    const r = await c.realtime.replay("collections.orders.*");
    expect(r.data).toEqual({ topic: "collections.orders.*", events: [], nextCursor: null, hasMore: false, resync: "reread-source" });
  });

  it("checks its arguments before sending", async () => {
    const { c, calls } = setup([]);
    for (const bad of ["", "x".repeat(201), undefined as unknown as string]) {
      await expect(c.realtime.replay(bad)).rejects.toThrow(TypeError);
    }
    await expect(c.realtime.replay("t", { afterAuditEventId: "bad" })).rejects.toThrow(TypeError);
    for (const limit of [0, 10_001, 1.5]) {
      const e = await c.realtime.replay("t", { limit }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(KError);
      expect((e as KError).code).toBe("K9O_INVALID_FIELD_VALUE");
    }
    for (const fromSequence of [-1, 1.5, "1a", ""]) {
      const e = await c.realtime.replay("t", { fromSequence }).catch((x: unknown) => x);
      expect((e as KError).code).toBe("K9O_INVALID_FIELD_VALUE");
    }
    expect(calls).toHaveLength(0);
  });

  it("accepts the limit bounds 1 and 10000", async () => {
    const { c, calls } = setup([{ json: { data: {}, meta: M } }, { json: { data: {}, meta: M } }]);
    await c.realtime.replay("t", { limit: 1 });
    await c.realtime.replay("t", { limit: 10_000 });
    expect(calls.map((x) => (x.body as { limit: number }).limit)).toEqual([1, 10_000]);
  });

  it("needs a project on the client", async () => {
    const c = createClient({ baseUrl: "https://acme.api.k9o.io", apiKey: "tok", fetch: (async () => new Response("{}")) as never });
    await expect((c as never as { realtime: { replay(t: string): Promise<unknown> } }).realtime.replay("t")).rejects.toThrow(/projectSlug/);
  });

  it("surfaces 400 K9O_INVALID_CURSOR and 403 K9O_RBAC_DENY", async () => {
    for (const [status, code] of [[400, "K9O_INVALID_CURSOR"], [403, "K9O_RBAC_DENY"]] as const) {
      const { c } = setup([{ status, json: { code, message: "x", context: {} } }]);
      const e = await c.realtime.replay("audit.project.*", { fromSequence: 1 }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(KError);
      expect((e as KError).code).toBe(code);
      expect((e as KError).status).toBe(status);
    }
  });
});
