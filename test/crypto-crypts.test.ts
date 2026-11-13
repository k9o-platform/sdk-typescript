/** client.crypto.crypts against a stubbed transport. */
import { describe, expect, it } from "bun:test";
import { createClient, KError } from "../src/index.ts";

type Seen = { method: string; url: string; body: Record<string, unknown> | null };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CRYPT = { name: "payments", status: "active", createdAt: "2026-11-03T00:00:00.000Z", retiredAt: null };

function harness(handler: (s: Seen) => Response) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    const s = { method: String(init?.method), url: String(input), body: init?.body === undefined ? null : JSON.parse(String(init.body)) };
    seen.push(s);
    return handler(s);
  }) as unknown as typeof globalThis.fetch;
  return { c: createClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "portal", apiKey: "tok", fetch: fetchImpl }), seen };
}

async function caught(p: Promise<unknown>): Promise<KError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(KError); return e as KError; }
  throw new Error("expected a KError");
}

describe("crypto.crypts", () => {
  it("lists", async () => {
    const { c, seen } = harness(() => json(200, { data: { crypts: [CRYPT] }, meta: {} }));
    const r = await c.crypto.crypts.list();
    expect(r.data.crypts).toEqual([CRYPT as never]);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe("https://acme.api.k9o.io/@portal/crypto/crypts");
  });
  it("lists none", async () => {
    const { c } = harness(() => json(200, { data: { crypts: [] }, meta: {} }));
    expect((await c.crypto.crypts.list()).data.crypts).toEqual([]);
  });
  it("creates with only the name", async () => {
    const { c, seen } = harness(() => json(201, { data: CRYPT, meta: {} }));
    const r = await c.crypto.crypts.create("payments");
    expect(r.data.name).toBe("payments");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe("https://acme.api.k9o.io/@portal/crypto/crypts");
    expect(seen[0]!.body).toEqual({ name: "payments" });
  });
  it("retires with no body", async () => {
    const retired = { ...CRYPT, status: "retired", retiredAt: "2026-11-03T01:00:00.000Z" };
    const { c, seen } = harness(() => json(200, { data: retired, meta: {} }));
    const r = await c.crypto.crypts.retire("payments");
    expect(r.data.status).toBe("retired");
    expect(r.data.retiredAt).toBe("2026-11-03T01:00:00.000Z");
    expect(seen[0]!.url).toBe("https://acme.api.k9o.io/@portal/crypto/crypts/payments/retire");
    expect(seen[0]!.body).toBeNull();
  });
  it("refuses a bad name before sending", async () => {
    const { c, seen } = harness(() => json(201, { data: CRYPT, meta: {} }));
    for (const bad of ["", "Payments", "a/b", "actions", "x".repeat(65), "../x"]) {
      expect((await caught(c.crypto.crypts.create(bad))).code).toBe("K9O_INVALID_FIELD_VALUE");
      expect((await caught(c.crypto.crypts.retire(bad))).code).toBe("K9O_INVALID_FIELD_VALUE");
    }
    expect(seen.length).toBe(0);
  });
  it("passes the gateway's refusals through", async () => {
    const { c } = harness(() => json(409, { code: "K9O_CRYPT_ALREADY_EXISTS", message: "exists", context: {} }));
    expect((await caught(c.crypto.crypts.create("payments"))).code).toBe("K9O_CRYPT_ALREADY_EXISTS");
  });
  it("fails closed on a malformed crypt", async () => {
    const { c } = harness(() => json(201, { data: { ...CRYPT, status: "weird" }, meta: {} }));
    expect((await caught(c.crypto.crypts.create("payments"))).code).toBe("K9O_INTERNAL_ERROR");
    const l = harness(() => json(200, { data: {}, meta: {} }));
    expect((await caught(l.c.crypto.crypts.list())).code).toBe("K9O_INTERNAL_ERROR");
  });
});
