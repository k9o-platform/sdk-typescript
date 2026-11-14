/** client.keys: list, get, rotate; the rotate error paths; Retry-After surfaced as retryAfterSec. */
import { describe, expect, it } from "bun:test";
import { createClient, KError, stepUpChallengeOf, type StepUpChallenge } from "../src/index.ts";

type Seen = { method: string; url: string; body: string | undefined; auth: string | null; proof: string | null };

function harness(handler: (seen: Seen) => Response, projectSlug: string | null = "portal") {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    const h = new Headers(init?.headers as HeadersInit);
    const s = { method: String(init?.method), url: String(input), body: typeof init?.body === "string" ? init.body : undefined, auth: h.get("authorization"), proof: h.get("x-k9o-step-up-proof") };
    seen.push(s);
    return handler(s);
  }) as unknown as typeof globalThis.fetch;
  const c = createClient({ baseUrl: "https://acme.api.k9o.io", ...(projectSlug !== null ? { projectSlug } : {}), apiKey: "tok", fetch: fetchImpl });
  return { c, seen };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const KEY = {
  id: "vkey_0b6f5c3e-2d41-4c52-9a77-1f0e6a1d8c11", version: 3, status: "active", custodyMode: "BYOK",
  createdAt: "2026-10-20T09:00:00.000Z", rotatedAt: "2026-10-25T11:30:00.000Z",
  byokRef: { provider: "aws-kms", region: "eu-central-1", externalKeyFingerprint: "q3Zc1b8mXk0pT7dA" }, hyokRef: null,
};
const HYOK = { ...KEY, id: "vkey_9", custodyMode: "HYOK", byokRef: null, hyokRef: { clusterId: "hsm_1", clusterName: "berlin-hsm", externalKeyFingerprint: "aB3dE5fG7hJ9kL1m" } };

async function caught(p: Promise<unknown>): Promise<KError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(KError);
    return e as KError;
  }
  throw new Error("expected a rejection");
}

describe("keys.list", () => {
  it("GETs vault/keys with no query by default and returns { items } only", async () => {
    const { c, seen } = harness(() => json(200, { data: { items: [KEY], nextCursor: null }, meta: {} }));
    const r = await c.keys.list();
    expect(seen).toEqual([{ method: "GET", url: "https://acme.api.k9o.io/@portal/vault/keys", body: undefined, auth: "Bearer tok", proof: null }]);
    expect(r.data).toEqual({ items: [KEY] });
  });

  it("sends status=all and decodes BYOK and HYOK references with every field", async () => {
    const { c, seen } = harness(() => json(200, { data: { items: [KEY, HYOK], nextCursor: "next-1" }, meta: {} }));
    const r = await c.keys.list({ status: "all" });
    expect(seen[0]!.url).toBe("https://acme.api.k9o.io/@portal/vault/keys?status=all");
    const [byok, hyok] = r.data.items;
    expect(Object.keys(byok!).sort()).toEqual(["byokRef", "createdAt", "custodyMode", "hyokRef", "id", "rotatedAt", "status", "version"]);
    expect(byok!.byokRef).toEqual({ provider: "aws-kms", region: "eu-central-1", externalKeyFingerprint: "q3Zc1b8mXk0pT7dA" });
    expect(byok!.hyokRef).toBeNull();
    expect(hyok!.hyokRef).toEqual({ clusterId: "hsm_1", clusterName: "berlin-hsm", externalKeyFingerprint: "aB3dE5fG7hJ9kL1m" });
    expect(hyok!.byokRef).toBeNull();
    expect(Object.keys(r.data)).toEqual(["items"]); // the list is not paged: a nextCursor the gateway sends is dropped
  });

  it("reads fields an older answer leaves out as null and keeps the extra ones", async () => {
    const old = { id: "vkey_old", projectId: "proj_1", purpose: "data-encryption", status: "active", custodyMode: "PLATFORM_MANAGED", version: 1, createdAt: "2026-09-02T23:19:43Z" };
    const { c } = harness(() => json(200, { data: { items: [old] }, meta: {} }));
    const r = await c.keys.list();
    expect(r.data.items[0]).toMatchObject({ id: "vkey_old", rotatedAt: null, byokRef: null, hyokRef: null, purpose: "data-encryption" });
    const one = harness(() => json(200, { data: old, meta: {} }));
    expect((await one.c.keys.get("vkey_old")).data.byokRef).toBeNull();
  });

  it("refuses an unknown status before sending", async () => {
    const { c, seen } = harness(() => json(200, { data: { items: [], nextCursor: null }, meta: {} }));
    await expect(c.keys.list({ status: "revoked" as never })).rejects.toThrow(TypeError);
    expect(seen).toHaveLength(0);
  });

  it("surfaces 403 for a caller without the role and 502 from the key service", async () => {
    const denied = harness(() => json(403, { code: "K9O_ACCESS_DENIED", message: "no", context: {} }));
    expect((await caught(denied.c.keys.list())).status).toBe(403);
    const down = harness(() => json(502, { code: "K9O_UPSTREAM_UNAVAILABLE", message: "down", context: {} }));
    expect((await caught(down.c.keys.list())).code).toBe("K9O_UPSTREAM_UNAVAILABLE");
  });

  it("needs projectSlug on the client", async () => {
    const { c } = harness(() => json(200, { data: {}, meta: {} }), null);
    await expect(c.keys.list()).rejects.toThrow(/projectSlug/);
  });
});

describe("keys.get", () => {
  it("GETs vault/keys/<id> and returns the key", async () => {
    const { c, seen } = harness(() => json(200, { data: KEY, meta: {} }));
    const r = await c.keys.get(KEY.id);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`https://acme.api.k9o.io/@portal/vault/keys/${KEY.id}`);
    expect(r.data.version).toBe(3);
    expect(r.data.status).toBe("active");
  });

  it("surfaces 404 K9O_NOT_FOUND and refuses an empty id", async () => {
    const { c, seen } = harness(() => json(404, { code: "K9O_NOT_FOUND", message: "no key", context: {} }));
    const e = await caught(c.keys.get("vkey_missing"));
    expect([e.code, e.status]).toEqual(["K9O_NOT_FOUND", 404]);
    await expect(c.keys.get("")).rejects.toThrow(TypeError);
    expect(seen).toHaveLength(1);
  });
});

describe("keys.rotate", () => {
  it("POSTs vault/keys/<id>/rotate with no body and returns the new version", async () => {
    const { c, seen } = harness(() => json(200, { data: { keyId: KEY.id, previousVersion: 3, newVersion: 4, status: "rotated" }, meta: {} }));
    const r = await c.keys.rotate(KEY.id);
    expect(seen).toEqual([{ method: "POST", url: `https://acme.api.k9o.io/@portal/vault/keys/${KEY.id}/rotate`, body: undefined, auth: "Bearer tok", proof: null }]);
    expect(r.data).toEqual({ keyId: KEY.id, previousVersion: 3, newVersion: 4, status: "rotated" });
  });

  const STEP_UP = {
    scopeSetRoot: "ssr_9f2c", nonce: "n_7Hq2", minTier: "T3_KEY_POSSESSION", methods: ["webauthn", "dpop"], maxAgeSec: 120, singleUse: true, rpId: "acme.k9o.io",
  };
  const challenge401 = () => json(401, { code: "K9O_STEP_UP_REQUIRED", message: "step-up required", context: { stepUp: STEP_UP } });
  const ROTATED = { keyId: KEY.id, previousVersion: 3, newVersion: 4, status: "rotated" };
  const decodeProof = (h: string | null) => JSON.parse(atob((h ?? "").replace(/-/g, "+").replace(/_/g, "/")));

  it("without a hook, throws the challenge: reachable as error.context.stepUp and through stepUpChallengeOf", async () => {
    const { c, seen } = harness(challenge401);
    const e = await caught(c.keys.rotate(KEY.id));
    expect([e.code, e.status]).toEqual(["K9O_STEP_UP_REQUIRED", 401]);
    expect(e.context["stepUp"]).toEqual(STEP_UP);
    const typed: StepUpChallenge | null = stepUpChallengeOf(e);
    expect(typed).toEqual(STEP_UP);
    expect(stepUpChallengeOf(new Error("x"))).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("with a hook: challenge -> hook(challenge, method and URL) -> the same request with the proof header -> success", async () => {
    let n = 0;
    const { c, seen } = harness(() => (++n === 1 ? challenge401() : json(200, { data: ROTATED, meta: {} })));
    const calls: unknown[] = [];
    const r = await c.keys.rotate(KEY.id, {
      stepUp: (ch, call) => {
        calls.push([ch, call]);
        return { method: "dpop", proof: "eyJ0eXAiOiJkcG9wK2p3dCJ9.proof.sig" };
      },
    });
    expect(r.data).toEqual(ROTATED);
    const url = `https://acme.api.k9o.io/@portal/vault/keys/${KEY.id}/rotate`;
    expect(calls).toEqual([[STEP_UP, { method: "POST", url }]]);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.proof).toBeNull();
    expect([seen[1]!.method, seen[1]!.url, seen[1]!.auth]).toEqual(["POST", url, "Bearer tok"]);
    expect(seen[1]!.proof).not.toMatch(/[=+/]/); // base64url, no padding
    expect(decodeProof(seen[1]!.proof)).toEqual({ scopeSetRoot: "ssr_9f2c", nonce: "n_7Hq2", method: "dpop", proof: "eyJ0eXAiOiJkcG9wK2p3dCJ9.proof.sig" });
  });

  it("awaits an async hook", async () => {
    let n = 0;
    const { c, seen } = harness(() => (++n === 1 ? challenge401() : json(200, { data: ROTATED, meta: {} })));
    await c.keys.rotate(KEY.id, { stepUp: async () => ({ method: "webauthn", proof: "assertion" }) });
    expect(decodeProof(seen[1]!.proof)["method"]).toBe("webauthn");
  });

  it("a hook that throws ends the call with that error and sends nothing more", async () => {
    const { c, seen } = harness(challenge401);
    const boom = new Error("user cancelled");
    await expect(c.keys.rotate(KEY.id, { stepUp: () => { throw boom; } })).rejects.toBe(boom);
    expect(seen).toHaveLength(1);
  });

  it("a second 401 is thrown as it is and not retried", async () => {
    let n = 0;
    const { c, seen } = harness(() => (++n === 1 ? challenge401() : json(401, { code: "K9O_STEP_UP_PROOF_MALFORMED", message: "bad proof", context: {} })));
    let hooks = 0;
    const e = await caught(c.keys.rotate(KEY.id, { stepUp: () => { hooks += 1; return { method: "dpop", proof: "x" }; } }));
    expect([e.status, e.code]).toEqual([401, "K9O_STEP_UP_PROOF_MALFORMED"]);
    expect(seen).toHaveLength(2);
    expect(hooks).toBe(1);
    // Even a second challenge is not answered again.
    const again = harness(challenge401);
    let h2 = 0;
    const e2 = await caught(again.c.keys.rotate(KEY.id, { stepUp: () => { h2 += 1; return { method: "dpop", proof: "x" }; } }));
    expect(e2.code).toBe("K9O_STEP_UP_REQUIRED");
    expect([again.seen.length, h2]).toEqual([2, 1]);
  });

  it("a hook answer without method and proof is refused before the retry", async () => {
    const { c, seen } = harness(challenge401);
    const e = await caught(c.keys.rotate(KEY.id, { stepUp: (() => ({ method: "dpop" })) as never }));
    expect(e.code).toBe("K9O_INVALID_FIELD_VALUE");
    expect(seen).toHaveLength(1);
  });

  it("the hook is not called for other errors", async () => {
    const { c, seen } = harness(() => json(409, { code: "K9O_STATE_CONFLICT", message: "busy", context: { reason: "rotation_in_flight" } }));
    let hooks = 0;
    await caught(c.keys.rotate(KEY.id, { stepUp: () => { hooks += 1; return { method: "dpop", proof: "x" }; } }));
    expect([hooks, seen.length]).toEqual([0, 1]);
  });

  it("surfaces 409 rotation_in_flight", async () => {
    const { c } = harness(() => json(409, { code: "K9O_STATE_CONFLICT", message: "busy", context: { reason: "rotation_in_flight" } }));
    const e = await caught(c.keys.rotate(KEY.id));
    expect([e.code, e.status, e.context["reason"]]).toEqual(["K9O_STATE_CONFLICT", 409, "rotation_in_flight"]);
  });

  it("surfaces 429 rotation_rate_cap with retryAfterSec from the Retry-After header", async () => {
    const { c, seen } = harness(() => json(429, { code: "K9O_RATE_LIMITED", message: "cap", context: { reason: "rotation_rate_cap" } }, { "retry-after": "5400" }));
    const e = await caught(c.keys.rotate(KEY.id));
    expect([e.code, e.status, e.context["reason"], e.retryAfterSec]).toEqual(["K9O_RATE_LIMITED", 429, "rotation_rate_cap", 5400]);
    expect(seen).toHaveLength(1); // a rotation is never retried
  });

  it("prefers a wait given in the body over the header", async () => {
    const { c } = harness(() => json(429, { code: "K9O_RATE_LIMITED", message: "cap", context: {}, recommendation: { retryAfterSec: 60, note: "later" } }, { "retry-after": "5400" }));
    expect((await caught(c.keys.rotate(KEY.id))).retryAfterSec).toBe(60);
  });

  it("reads an HTTP-date Retry-After and ignores an unreadable one", async () => {
    const at = new Date(Date.now() + 120_000).toUTCString();
    const dated = harness(() => json(429, { code: "K9O_RATE_LIMITED", message: "cap", context: {} }, { "retry-after": at }));
    const sec = (await caught(dated.c.keys.rotate(KEY.id))).retryAfterSec;
    expect(sec).not.toBeNull();
    expect(sec!).toBeGreaterThan(100);
    expect(sec!).toBeLessThanOrEqual(121);
    const bad = harness(() => json(429, { code: "K9O_RATE_LIMITED", message: "cap", context: {} }, { "retry-after": "soon" }));
    expect((await caught(bad.c.keys.rotate(KEY.id))).retryAfterSec).toBeNull();
  });

  it("surfaces 403 (credential not a person's), 404 and 502", async () => {
    for (const [status, code] of [[403, "K9O_TRUST_ZONE_VIOLATION"], [404, "K9O_NOT_FOUND"], [502, "K9O_UPSTREAM_UNAVAILABLE"]] as const) {
      const { c } = harness(() => json(status, { code, message: "x", context: {} }));
      const e = await caught(c.keys.rotate(KEY.id));
      expect([e.status, e.code]).toEqual([status, code]);
    }
  });

  it("refuses an empty key id before sending", async () => {
    const { c, seen } = harness(() => json(200, { data: {}, meta: {} }));
    await expect(c.keys.rotate("")).rejects.toThrow(TypeError);
    expect(seen).toHaveLength(0);
  });
});
