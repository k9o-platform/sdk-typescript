/** client.crypto.federatedToken against a stubbed transport. */
import { describe, expect, it } from "bun:test";
import { createClient, KError } from "../src/index.ts";

type Seen = { method: string; url: string; body: Record<string, unknown> | null };

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const GOOD = { token: "eyJhbGciOiJSUzI1NiJ9.e30.sig", expiresAt: "2026-11-02T22:15:00.000Z", issuer: "https://api.k9o.io/kms-federation/p1/", subject: "p1:crypt:payments:op:encrypt", audience: "sts.amazonaws.com", kid: "k1" };

function harness(handler: (s: Seen) => Response, retry = false) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    const s = { method: String(init?.method), url: String(input), body: init?.body === undefined ? null : JSON.parse(String(init.body)) };
    seen.push(s);
    return handler(s);
  }) as unknown as typeof globalThis.fetch;
  const c = createClient({
    baseUrl: "https://acme.api.k9o.io", projectSlug: "portal", apiKey: "tok", fetch: fetchImpl,
    ...(retry ? { retryConfig: { maxRetries: 3, backoff: "none" as const } } : {}),
  });
  return { c, seen };
}

async function caught(p: Promise<unknown>): Promise<KError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(KError);
    return e as KError;
  }
  throw new Error("expected a KError");
}

describe("crypto.federatedToken", () => {
  it("posts exactly { crypt, op } and returns the six fields", async () => {
    const { c, seen } = harness(() => json(200, { data: GOOD, meta: {} }));
    const r = await c.crypto.federatedToken({ crypt: "payments", op: "encrypt" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe("https://acme.api.k9o.io/@portal/crypto/federated-token");
    expect(seen[0]!.body).toEqual({ crypt: "payments", op: "encrypt" });
    expect(r.data).toEqual(GOOD);
  });

  it("refuses a bad crypt or op before sending anything", async () => {
    const { c, seen } = harness(() => json(200, { data: GOOD, meta: {} }));
    for (const crypt of ["", "Payments", "a b", "x".repeat(65)]) {
      const e = await caught(c.crypto.federatedToken({ crypt, op: "encrypt" }));
      expect(e.code).toBe("K9O_INVALID_FIELD_VALUE");
      expect(e.context["field"]).toBe("crypt");
    }
    const e = await caught(c.crypto.federatedToken({ crypt: "payments", op: "sign" as never }));
    expect(e.code).toBe("K9O_INVALID_FIELD_VALUE");
    expect(e.context["field"]).toBe("op");
    expect(seen).toHaveLength(0);
  });

  it("refuses the name actions and accepts actions-2", async () => {
    const { c, seen } = harness(() => json(200, { data: GOOD, meta: {} }));
    expect((await caught(c.crypto.federatedToken({ crypt: "actions", op: "encrypt" }))).code).toBe("K9O_INVALID_FIELD_VALUE");
    expect(seen).toHaveLength(0);
    await c.crypto.federatedToken({ crypt: "actions-2", op: "encrypt" });
    expect(seen).toHaveLength(1);
  });

  it.each([["decrypt"], ["rewrap"]] as const)("accepts op %s", async (op) => {
    const { c, seen } = harness(() => json(200, { data: GOOD, meta: {} }));
    await c.crypto.federatedToken({ crypt: "payments", op });
    expect(seen[0]!.body).toEqual({ crypt: "payments", op });
  });

  it("passes 409, 429 and 503 through, and never retries the POST", async () => {
    for (const [status, code] of [[409, "K9O_CUSTODY_SERVER_ROUTE"], [429, "K9O_RATE_LIMITED"], [503, "K9O_KEY_SERVICE_UNAVAILABLE"]] as const) {
      const { c, seen } = harness(() => json(status, { code, message: "no", context: {} }), true);
      const e = await caught(c.crypto.federatedToken({ crypt: "payments", op: "encrypt" }));
      expect(e.code).toBe(code);
      expect(e.status).toBe(status);
      expect(seen).toHaveLength(1);
    }
  });

  it("raises K9O_INTERNAL_ERROR when a field is missing, without echoing the token", async () => {
    for (const k of Object.keys(GOOD)) {
      const { token: _t, ...rest } = GOOD;
      const data = k === "token" ? rest : { ...GOOD, [k]: undefined };
      const { c } = harness(() => json(200, { data, meta: {} }));
      const e = await caught(c.crypto.federatedToken({ crypt: "payments", op: "encrypt" }));
      expect(e.code).toBe("K9O_INTERNAL_ERROR");
      expect(e.message).toContain(k);
      expect(e.message).not.toContain(GOOD.token);
    }
  });

  it("returns projectId and provider when the gateway names them, and none when it does not", async () => {
    const named = harness(() => json(200, { data: { ...GOOD, projectId: "proj_1", provider: "aws" }, meta: {} }));
    const a = await named.c.crypto.federatedToken({ crypt: "payments", op: "encrypt" });
    expect(a.data.projectId).toBe("proj_1");
    expect(a.data.provider).toBe("aws");
    const plain = harness(() => json(200, { data: GOOD, meta: {} }));
    const b = await plain.c.crypto.federatedToken({ crypt: "payments", op: "encrypt" });
    expect("projectId" in b.data).toBe(false);
    expect("provider" in b.data).toBe(false);
  });
});
