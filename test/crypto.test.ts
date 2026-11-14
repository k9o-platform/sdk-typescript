/** client.crypto: encrypt, decrypt, rewrap against a stubbed transport (the gateway route is not live yet). */
import { describe, expect, it } from "bun:test";
import { createClient, KError, keyRefMatches } from "../src/index.ts";

type Seen = { method: string; url: string; body: Record<string, any>; auth: string | null };

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** `seen` holds the calls to encrypt, decrypt and rewrap; the custody checks (`GET /crypto/mode`) are in `modes`. */
function harness(handler: (seen: Seen) => Response, retry = false, modeReply: (n: number) => Response = () => modeOk("PLATFORM_MANAGED", "e1")) {
  const seen: Seen[] = [];
  const modes: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    const h = new Headers(init?.headers as HeadersInit);
    const s = { method: String(init?.method), url: String(input), body: JSON.parse(String(init?.body ?? "null")), auth: h.get("authorization") };
    if (s.url.includes("/crypto/mode")) {
      modes.push(s);
      return modeReply(modes.length);
    }
    seen.push(s);
    return handler(s);
  }) as unknown as typeof globalThis.fetch;
  const c = createClient({
    baseUrl: "https://acme.api.k9o.io", projectSlug: "portal", apiKey: "tok", fetch: fetchImpl,
    ...(retry ? { retryConfig: { maxRetries: 3, backoff: "none" as const } } : {}),
  });
  return { c, seen, modes };
}

const modeOk = (custodyMode: string, epoch: string) => json(200, { data: { custodyMode, epoch }, meta: {} });
const b64 = (s: string) => btoa(s);
const ok = (items: unknown[]) => json(200, { data: { items }, meta: {} });

async function caught(p: Promise<unknown>): Promise<KError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(KError);
    return e as KError;
  }
  throw new Error("expected a rejection");
}

describe("crypto.encrypt", () => {
  it("POSTs crypt and base64 plaintext (bytes and UTF-8 strings) with context, and returns results in item order", async () => {
    const { c, seen } = harness(() => ok([{ ciphertext: "Y3Q6MQ==" }, { ciphertext: "Y3Q6Mg==" }]));
    const r = await c.crypto.encrypt({
      crypt: "orders-2026",
      items: [{ plaintext: "héllo", context: "order:1" }, { plaintext: new Uint8Array([0, 255, 16]) }],
    });
    expect(seen).toHaveLength(1);
    expect([seen[0]!.method, seen[0]!.url, seen[0]!.auth]).toEqual(["POST", "https://acme.api.k9o.io/@portal/crypto/encrypt", "Bearer tok"]);
    expect(seen[0]!.body).toEqual({
      crypt: "orders-2026",
      items: [{ plaintext: b64(String.fromCharCode(...new TextEncoder().encode("héllo"))), context: "order:1" }, { plaintext: "AP8Q" }],
      custodyEpoch: "e1",
    });
    expect(r.data.items).toEqual([{ ok: true, ciphertext: "Y3Q6MQ==" }, { ok: true, ciphertext: "Y3Q6Mg==" }]);
  });

  it("accepts an ArrayBuffer and an empty plaintext", async () => {
    const { c, seen } = harness(() => ok([{ ciphertext: "x" }, { ciphertext: "y" }]));
    await c.crypto.encrypt({ crypt: "k", items: [{ plaintext: new Uint8Array([1, 2]).buffer }, { plaintext: "" }] });
    expect(seen[0]!.body["items"]).toEqual([{ plaintext: "AQI=" }, { plaintext: "" }]);
  });

  it("an item can fail on its own; unknown fields are kept", async () => {
    const { c } = harness(() => ok([{ ciphertext: "x", keyVersion: 7 }, { code: "K9O_RATE_LIMITED", message: "slow", hint: 1 }]));
    const r = await c.crypto.encrypt({ crypt: "k", items: [{ plaintext: "a" }, { plaintext: "b" }] });
    expect(r.data.items[0]).toEqual({ ok: true, ciphertext: "x", keyVersion: 7 });
    expect(r.data.items[1]).toEqual({ ok: false, code: "K9O_RATE_LIMITED", message: "slow", hint: 1 });
  });

  it("a different number of results than items is an internal error, not a silent misalignment", async () => {
    const { c } = harness(() => ok([{ ciphertext: "x" }]));
    const e = await caught(c.crypto.encrypt({ crypt: "k", items: [{ plaintext: "a" }, { plaintext: "b" }] }));
    expect(e.code).toBe("K9O_INTERNAL_ERROR");
  });
});

describe("crypto.decrypt", () => {
  it("POSTs ciphertext and context and decodes plaintext to bytes, with text when it is UTF-8", async () => {
    const { c, seen } = harness(() => ok([{ plaintext: "aMOpbGxv" }, { plaintext: "AP8Q" }, { code: "K9O_ENVELOPE_INTEGRITY_FAILURE", message: "cannot open" }]));
    const r = await c.crypto.decrypt({ crypt: "orders-2026", items: [{ ciphertext: "ct1", context: "order:1" }, { ciphertext: "ct2" }, { ciphertext: "ct3" }] });
    expect(seen[0]!.url).toBe("https://acme.api.k9o.io/@portal/crypto/decrypt");
    expect(seen[0]!.body).toEqual({ crypt: "orders-2026", items: [{ ciphertext: "ct1", context: "order:1" }, { ciphertext: "ct2" }, { ciphertext: "ct3" }] });
    const [a, b, f] = r.data.items as any[];
    expect(a.ok).toBe(true);
    expect(a.text).toBe("héllo");
    expect(Array.from(b.plaintext)).toEqual([0, 255, 16]);
    expect(b.text).toBeUndefined(); // not valid UTF-8
    expect(f).toEqual({ ok: false, code: "K9O_ENVELOPE_INTEGRITY_FAILURE", message: "cannot open" });
  });

  it("round-trips a UTF-8 string through the wire encoding", async () => {
    let wire = "";
    const { c } = harness((s) => {
      if (s.url.endsWith("/encrypt")) { wire = s.body["items"][0].plaintext; return ok([{ ciphertext: "ct" }]); }
      return ok([{ plaintext: wire }]);
    });
    await c.crypto.encrypt({ crypt: "k", items: [{ plaintext: "grüße 😀" }] });
    const r = await c.crypto.decrypt({ crypt: "k", items: [{ ciphertext: "ct" }] });
    expect((r.data.items[0] as any).text).toBe("grüße 😀");
  });

  it("surfaces 400 K9O_ENVELOPE_INTEGRITY_FAILURE with an empty context", async () => {
    const { c } = harness(() => json(400, { code: "K9O_ENVELOPE_INTEGRITY_FAILURE", message: "cannot open", context: {} }));
    const e = await caught(c.crypto.decrypt({ crypt: "k", items: [{ ciphertext: "ct" }] }));
    expect([e.status, e.code, e.context]).toEqual([400, "K9O_ENVELOPE_INTEGRITY_FAILURE", {}]);
  });

  it("surfaces 409 K9O_SEALED_UNDER_RETIRED_KEY with resealableUntil", async () => {
    const { c } = harness(() => json(409, { code: "K9O_SEALED_UNDER_RETIRED_KEY", message: "retired", context: { resealableUntil: "2026-11-03T00:00:00Z" } }));
    const e = await caught(c.crypto.decrypt({ crypt: "k", items: [{ ciphertext: "ct" }] }));
    expect([e.status, e.code, e.context["resealableUntil"]]).toEqual([409, "K9O_SEALED_UNDER_RETIRED_KEY", "2026-11-03T00:00:00Z"]);
  });
});

describe("crypto.rewrap", () => {
  it("POSTs to /crypto/rewrap and returns new ciphertexts in order", async () => {
    const { c, seen } = harness(() => ok([{ ciphertext: "new1" }, { ciphertext: "new2" }]));
    const r = await c.crypto.rewrap({ crypt: "k", items: [{ ciphertext: "old1", context: "c" }, { ciphertext: "old2" }] });
    expect(seen[0]!.url).toBe("https://acme.api.k9o.io/@portal/crypto/rewrap");
    expect(seen[0]!.body).toEqual({ crypt: "k", items: [{ ciphertext: "old1", context: "c" }, { ciphertext: "old2" }] });
    expect(r.data.items.map((i) => (i as any).ciphertext)).toEqual(["new1", "new2"]);
  });
});

describe("crypto validation (nothing is sent)", () => {
  it("refuses a bad crypt, item count, missing fields and long context with K9O_INVALID_FIELD_VALUE", async () => {
    const { c, seen } = harness(() => ok([]));
    const bad: Array<() => Promise<unknown>> = [
      () => c.crypto.encrypt({ crypt: "", items: [{ plaintext: "a" }] }),
      () => c.crypto.encrypt({ crypt: "Upper", items: [{ plaintext: "a" }] }),
      () => c.crypto.encrypt({ crypt: "has_underscore", items: [{ plaintext: "a" }] }),
      () => c.crypto.encrypt({ crypt: "a".repeat(65), items: [{ plaintext: "a" }] }),
      () => c.crypto.encrypt({ crypt: "k", items: [] }),
      () => c.crypto.decrypt({ crypt: "k", items: Array.from({ length: 101 }, () => ({ ciphertext: "x" })) }),
      () => c.crypto.encrypt({ crypt: "k", items: [{} as never] }),
      () => c.crypto.decrypt({ crypt: "k", items: [{ plaintext: "a" } as never] }),
      () => c.crypto.rewrap({ crypt: "k", items: [{ ciphertext: "" }] }),
      () => c.crypto.encrypt({ crypt: "k", items: [{ plaintext: "a", context: "x".repeat(257) }] }),
      () => c.crypto.encrypt({ crypt: "k", items: [{ plaintext: "a", context: "é".repeat(129) }] }), // 258 bytes
      () => c.crypto.encrypt({ crypt: "k", items: [{ plaintext: 5 as never }] }),
    ];
    for (const run of bad) expect((await caught(run())).code).toBe("K9O_INVALID_FIELD_VALUE");
    expect(seen).toHaveLength(0);
  });

  it("accepts the limits: 100 items, 256 context bytes, 64-char crypt, 64 KiB item", async () => {
    const { c, seen } = harness((s) => ok(s.body["items"].map(() => ({ ciphertext: "x" }))));
    await c.crypto.encrypt({ crypt: "a".repeat(64), items: Array.from({ length: 100 }, () => ({ plaintext: "a", context: "x".repeat(256) })) });
    await c.crypto.encrypt({ crypt: "k", items: [{ plaintext: new Uint8Array(65536) }] });
    expect(seen).toHaveLength(2);
  });

  it("refuses an item over 64 KiB and a call over 1 MiB with K9O_PAYLOAD_TOO_LARGE", async () => {
    const { c, seen } = harness(() => ok([]));
    const e1 = await caught(c.crypto.encrypt({ crypt: "k", items: [{ plaintext: new Uint8Array(65537) }] }));
    expect(e1.code).toBe("K9O_PAYLOAD_TOO_LARGE");
    const items = Array.from({ length: 17 }, () => ({ plaintext: new Uint8Array(65536) })); // 17 x 64 KiB = 1.0625 MiB
    const e2 = await caught(c.crypto.encrypt({ crypt: "k", items }));
    expect(e2.code).toBe("K9O_PAYLOAD_TOO_LARGE");
    expect(seen).toHaveLength(0);
  });

  it("needs projectSlug on the client", async () => {
    const c = createClient({ baseUrl: "https://acme.api.k9o.io", apiKey: "tok", fetch: (async () => new Response("", { status: 200 })) as never });
    await expect(c.crypto.encrypt({ crypt: "k", items: [{ plaintext: "a" }] })).rejects.toThrow(/projectSlug/);
  });
});

describe("crypto errors and retries", () => {
  const req = { crypt: "k", items: [{ plaintext: "a" }] };

  it("surfaces 413, 429 with retryAfterSec, 503 and the BYOK and HYOK codes as KError", async () => {
    const cases: Array<[number, string, Record<string, string>]> = [
      [413, "K9O_PAYLOAD_TOO_LARGE", {}],
      [404, "K9O_CRYPT_NOT_FOUND", {}],
      [409, "K9O_CRYPT_RETIRED", {}],
      [429, "K9O_RATE_LIMITED", { "retry-after": "7" }],
      [503, "K9O_KEY_SERVICE_UNAVAILABLE", {}],
      [503, "K9O_BYOK_KEY_UNREACHABLE", {}],
      [503, "K9O_HYOK_CLUSTER_UNREACHABLE", {}],
    ];
    for (const [status, code, headers] of cases) {
      const { c } = harness(() => json(status, { code, message: "x", context: {} }, headers));
      const e = await caught(c.crypto.encrypt(req));
      expect([e.status, e.code]).toEqual([status, code]);
      if (status === 429) expect(e.retryAfterSec).toBe(7);
    }
  });

  it("a 404 (route not live on the gateway yet) is a KError", async () => {
    const { c } = harness(() => json(404, { code: "K9O_NOT_FOUND", message: "no route", context: {} }));
    expect((await caught(c.crypto.encrypt(req))).status).toBe(404);
  });

  it("never retries encrypt, decrypt or rewrap after a 5xx or 429, even with retryConfig set", async () => {
    for (const status of [500, 502, 503, 429]) {
      const { c, seen } = harness(() => json(status, { code: status === 429 ? "K9O_RATE_LIMITED" : "K9O_KEY_SERVICE_UNAVAILABLE", message: "x", context: {} }), true);
      await caught(c.crypto.encrypt(req));
      await caught(c.crypto.decrypt({ crypt: "k", items: [{ ciphertext: "ct" }] }));
      await caught(c.crypto.rewrap({ crypt: "k", items: [{ ciphertext: "ct" }] }));
      expect(seen).toHaveLength(3);
    }
  });
});

const flow409 = (route: "client" | "server", epoch = "e2", custodyMode = "BYOK") =>
  json(409, { code: "K9O_ZK_STORE_FLOW_REQUIRED", message: "wrong side", context: { custodyMode, route, epoch } });

type Call = { op: string; crypt: string; items: any[] };
function fakeCore() {
  const calls: Call[] = [];
  const core = {
    encrypt: async (crypt: string, items: any[]) => (calls.push({ op: "encrypt", crypt, items }), { items: items.map(() => ({ ok: true as const, ciphertext: "client-ct" })) }),
    decrypt: async (crypt: string, items: any[]) => (calls.push({ op: "decrypt", crypt, items }), { items: items.map(() => ({ ok: true as const, plaintext: new Uint8Array([104, 105]), text: "hi" })) }),
    rewrap: async (crypt: string, items: any[]) => (calls.push({ op: "rewrap", crypt, items }), { items: items.map(() => ({ ok: true as const, ciphertext: "client-ct2" })) }),
  };
  return { core, calls };
}

describe("crypto.mode and the encrypt router", () => {
  const req = { crypt: "k", items: [{ plaintext: "a", context: "c" }] };

  it("crypto.mode GETs /crypto/mode and returns { custodyMode, epoch }", async () => {
    const { c, modes } = harness(() => ok([]), false, () => modeOk("HYOK", "ep-9"));
    const r = await c.crypto.mode();
    expect(r.data).toEqual({ custodyMode: "HYOK", epoch: "ep-9" });
    expect([modes[0]!.method, modes[0]!.url, modes[0]!.auth]).toEqual(["GET", "https://acme.api.k9o.io/@portal/crypto/mode", "Bearer tok"]);
  });

  it("mode() and mode(crypt) return route 'server' / 'client' when sent, and leave it off when absent or unknown", async () => {
    const reply = (route?: unknown) => () => json(200, { data: { custodyMode: "HYOK", epoch: "e1", ...(route === undefined ? {} : { route }) }, meta: {} });
    for (const route of ["server", "client"] as const) {
      const { c } = harness(() => ok([]), false, reply(route));
      expect((await c.crypto.mode()).data.route).toBe(route);
      expect((await c.crypto.mode("customer-notes")).data.route).toBe(route);
    }
    for (const route of [undefined, "edge", null, 7]) {
      const { c } = harness(() => ok([]), false, reply(route));
      for (const r of [await c.crypto.mode(), await c.crypto.mode("customer-notes")]) {
        expect(r.data.route).toBeUndefined();
        expect("route" in r.data).toBe(false);
        expect(r.data.custodyMode).toBe("HYOK");
      }
    }
  });

  it("encrypt's mode GET names the crypt (?crypt=); crypto.mode() sends no query", async () => {
    const { c, modes } = harness(() => ok([{ ciphertext: "ct" }]));
    await c.crypto.encrypt({ crypt: "customer-notes", items: [{ plaintext: "a", context: "c" }] });
    expect(modes[0]!.url).toBe("https://acme.api.k9o.io/@portal/crypto/mode?crypt=customer-notes");
    await c.crypto.mode();
    expect(modes[1]!.url).toBe("https://acme.api.k9o.io/@portal/crypto/mode");
  });

  it("mode(crypt) sends ?crypt=; mode() sends none; a bad crypt is refused before any request", async () => {
    const { c, modes } = harness(() => ok([]));
    await c.crypto.mode("customer-notes");
    expect(modes[0]!.url).toBe("https://acme.api.k9o.io/@portal/crypto/mode?crypt=customer-notes");
    await c.crypto.mode();
    expect(modes[1]!.url).toBe("https://acme.api.k9o.io/@portal/crypto/mode");
    for (const bad of ["Bad_Name", "", "actions", "a".repeat(65)]) {
      const e = await caught(c.crypto.mode(bad));
      expect(e.code).toBe("K9O_INVALID_FIELD_VALUE");
      expect(e.message).toContain("crypt must be 1 to 64 characters");
    }
    expect(modes).toHaveLength(2);
  });

  it("(a) platform-managed: one mode GET, then one POST that carries custodyEpoch", async () => {
    for (const mode of ["PLATFORM_MANAGED", "CONFIDENTIAL_WORKLOAD", "SKR"]) {
      const { c, seen, modes } = harness(() => ok([{ ciphertext: "ct" }]), false, () => modeOk(mode, "e7"));
      await c.crypto.encrypt(req);
      expect(modes).toHaveLength(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.body).toEqual({ crypt: "k", items: [{ plaintext: "YQ==", context: "c" }], custodyEpoch: "e7" });
    }
  });

  it("(b) two encrypts make two mode GETs (no cache); a batch is one check", async () => {
    const { c, seen, modes } = harness((s) => ok(s.body["items"].map(() => ({ ciphertext: "ct" }))));
    await c.crypto.encrypt(req);
    await c.crypto.encrypt({ crypt: "k", items: [{ plaintext: "a" }, { plaintext: "b" }, { plaintext: "c" }] });
    expect(modes).toHaveLength(2);
    expect(seen).toHaveLength(2);
  });

  it("(c) BYOK and HYOK with no client core: K9O_ZK_CLIENT_CORE_UNAVAILABLE (501) and no call to /crypto/encrypt", async () => {
    for (const mode of ["BYOK", "HYOK"]) {
      const { c, seen, modes } = harness(() => ok([{ ciphertext: "ct" }]), false, () => modeOk(mode, "e1"));
      const e = await caught(c.crypto.encrypt(req));
      expect([e.code, e.status, e.context]).toEqual(["K9O_ZK_CLIENT_CORE_UNAVAILABLE", 501, { custodyMode: mode, requirement: "kibo-client-core" }]);
      expect(e.message).toContain("Kibo client core");
      expect(modes).toHaveLength(1);
      expect(seen).toHaveLength(0);
    }
  });

  it("(c) BYOK with a registered core: the core encrypts bytes, nothing goes to /crypto/encrypt", async () => {
    const { c, seen } = harness(() => ok([]), false, () => modeOk("BYOK", "e1"));
    const { core, calls } = fakeCore();
    c.crypto.useClientCore(core);
    const r = await c.crypto.encrypt(req);
    expect(seen).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.crypt).toBe("k");
    expect(Array.from(calls[0]!.items[0].plaintext)).toEqual([97]);
    expect(calls[0]!.items[0].context).toBe("c");
    expect(r.data.items).toEqual([{ ok: true, ciphertext: "client-ct" }]);
  });

  it("(d) epoch race: the 409 for the client route makes a second mode check and a re-route", async () => {
    const { c, seen, modes } = harness(() => flow409("client"), false, (n) => (n === 1 ? modeOk("PLATFORM_MANAGED", "e1") : modeOk("BYOK", "e2")));
    const { core, calls } = fakeCore();
    c.crypto.useClientCore(core);
    const r = await c.crypto.encrypt(req);
    expect(modes).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body["custodyEpoch"]).toBe("e1");
    expect(calls).toHaveLength(1);
    expect(r.data.items[0]).toEqual({ ok: true, ciphertext: "client-ct" });
  });

  it("(d) a second 409 is raised after one re-route", async () => {
    const { c, seen, modes } = harness(() => flow409("client"), false, (n) => modeOk("PLATFORM_MANAGED", `e${n}`));
    const e = await caught(c.crypto.encrypt(req));
    expect([e.status, e.code]).toEqual([409, "K9O_ZK_STORE_FLOW_REQUIRED"]);
    expect(modes).toHaveLength(2);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body["custodyEpoch"]).toBe("e2");
  });

  it("(d) a re-routed platform call after a 409 succeeds", async () => {
    let n = 0;
    const { c, seen } = harness(() => (++n === 1 ? flow409("server") : ok([{ ciphertext: "ct" }])));
    const r = await c.crypto.encrypt(req);
    expect(seen).toHaveLength(2);
    expect((r.data.items[0] as any).ciphertext).toBe("ct");
  });

  it("(g) an unknown, missing or malformed custodyMode answer raises K9O_CRYPTO_CUSTODY_UNKNOWN with nothing sent", async () => {
    const replies: Array<[() => Response, string | undefined]> = [
      [() => modeOk("QUANTUM", "e1"), "QUANTUM"],
      [() => modeOk("", "e1"), undefined],
      [() => json(200, { data: {}, meta: {} }), undefined],
      [() => json(200, { data: { custodyMode: "PLATFORM_MANAGED" }, meta: {} }), "PLATFORM_MANAGED"],
      [() => modeOk("SKR", ""), "SKR"],
    ];
    for (const [reply, seenMode] of replies) {
      const { c, seen } = harness(() => ok([{ ciphertext: "ct" }]), false, () => reply());
      const { core, calls } = fakeCore();
      c.crypto.useClientCore(core);
      const e = await caught(c.crypto.encrypt(req));
      expect(e.code).toBe("K9O_CRYPTO_CUSTODY_UNKNOWN");
      expect(e.status).toBeNull();
      expect(e.context["custodyMode"]).toBe(seenMode);
      expect(seen).toHaveLength(0);
      expect(calls).toHaveLength(0);
    }
  });

  it("(g) a failing mode call rethrows the original error unchanged and sends nothing", async () => {
    const replies: Array<[() => Response, number, string]> = [
      [() => json(404, { code: "K9O_NOT_FOUND", message: "no route", context: {} }), 404, "K9O_NOT_FOUND"],
      [() => json(503, { code: "K9O_KEY_SERVICE_UNAVAILABLE", message: "x", context: {} }), 503, "K9O_KEY_SERVICE_UNAVAILABLE"],
    ];
    for (const [reply, status, code] of replies) {
      const { c, seen } = harness(() => ok([{ ciphertext: "ct" }]), false, () => reply());
      const { core, calls } = fakeCore();
      c.crypto.useClientCore(core);
      const e = await caught(c.crypto.encrypt(req));
      expect(e.code).toBe(code);
      expect(e.status).toBe(status);
      expect(seen).toHaveLength(0);
      expect(calls).toHaveLength(0);
    }
  });

  it("(g) a network failure of the mode call is rethrown as it is, not wrapped", async () => {
    const c = createClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "portal", apiKey: "tok", fetch: (async () => { throw new TypeError("down"); }) as never });
    expect((await caught(c.crypto.encrypt(req))).code).not.toBe("K9O_CRYPTO_CUSTODY_UNKNOWN");
  });

  it("invalid input is refused before any mode check", async () => {
    const { c, modes } = harness(() => ok([]));
    await caught(c.crypto.encrypt({ crypt: "", items: [{ plaintext: "a" }] }));
    expect(modes).toHaveLength(0);
  });
});

describe("crypto.decrypt and rewrap route by the ciphertext", () => {
  const req = { crypt: "k", items: [{ ciphertext: "ct", context: "c" }] };

  it("(e) decrypt 200: no core call and no mode check", async () => {
    const { c, modes } = harness(() => ok([{ plaintext: "aGk=" }]));
    const { core, calls } = fakeCore();
    c.crypto.useClientCore(core);
    const r = await c.crypto.decrypt(req);
    expect((r.data.items[0] as any).text).toBe("hi");
    expect(calls).toHaveLength(0);
    expect(modes).toHaveLength(0);
  });

  it("(e) decrypt 409 route client: the core opens it, after one call that carried only ciphertext", async () => {
    const { c, seen, modes } = harness(() => flow409("client"));
    const { core, calls } = fakeCore();
    c.crypto.useClientCore(core);
    const r = await c.crypto.decrypt(req);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toEqual({ crypt: "k", items: [{ ciphertext: "ct", context: "c" }] });
    expect(modes).toHaveLength(0);
    expect(calls).toEqual([{ op: "decrypt", crypt: "k", items: [{ ciphertext: "ct", context: "c" }] }]);
    expect((r.data.items[0] as any).text).toBe("hi");
  });

  it("(e) decrypt 409 route client with no core: K9O_ZK_CLIENT_CORE_UNAVAILABLE with the custody mode", async () => {
    const { c } = harness(() => flow409("client", "e2", "HYOK"));
    const e = await caught(c.crypto.decrypt(req));
    expect([e.code, e.status, e.context]).toEqual(["K9O_ZK_CLIENT_CORE_UNAVAILABLE", 501, { custodyMode: "HYOK", requirement: "kibo-client-core" }]);
  });

  it("(e) other 409s and other errors are raised unchanged, without calling the core", async () => {
    const replies: Array<[number, string, () => Response]> = [
      [409, "K9O_ZK_STORE_FLOW_REQUIRED", () => flow409("server")],
      [409, "K9O_SEALED_UNDER_RETIRED_KEY", () => json(409, { code: "K9O_SEALED_UNDER_RETIRED_KEY", message: "retired", context: { route: "client" } })],
      [400, "K9O_ENVELOPE_INTEGRITY_FAILURE", () => json(400, { code: "K9O_ENVELOPE_INTEGRITY_FAILURE", message: "cannot open", context: {} })],
    ];
    for (const [status, code, reply] of replies) {
      const { c } = harness(() => reply());
      const { core, calls } = fakeCore();
      c.crypto.useClientCore(core);
      const e = await caught(c.crypto.decrypt(req));
      expect([e.status, e.code]).toEqual([status, code]);
      expect(calls).toHaveLength(0);
    }
  });

  it("(f) rewrap: 200 uses the platform, 409 route client uses the core, other errors are unchanged", async () => {
    const a = harness(() => ok([{ ciphertext: "new" }]));
    const ca = fakeCore();
    a.c.crypto.useClientCore(ca.core);
    expect((await a.c.crypto.rewrap(req)).data.items[0]).toEqual({ ok: true, ciphertext: "new" });
    expect(ca.calls).toHaveLength(0);

    const b = harness(() => flow409("client"));
    const cb = fakeCore();
    b.c.crypto.useClientCore(cb.core);
    expect((await b.c.crypto.rewrap(req)).data.items[0]).toEqual({ ok: true, ciphertext: "client-ct2" });
    expect(cb.calls.map((x) => x.op)).toEqual(["rewrap"]);
    expect(b.modes).toHaveLength(0);

    const d = harness(() => flow409("client"));
    expect((await caught(d.c.crypto.rewrap(req))).code).toBe("K9O_ZK_CLIENT_CORE_UNAVAILABLE");

    const e2 = harness(() => json(409, { code: "K9O_SEALED_UNDER_RETIRED_KEY", message: "x", context: {} }));
    const ce = fakeCore();
    e2.c.crypto.useClientCore(ce.core);
    expect((await caught(e2.c.crypto.rewrap(req))).code).toBe("K9O_SEALED_UNDER_RETIRED_KEY");
    expect(ce.calls).toHaveLength(0);
  });
});

describe("expectedKeyRefs", () => {
  const fetchByok = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/crypto/mode")) return modeOk("BYOK", "e9");
    if (String(input).endsWith("/crypto/encrypt")) return json(500, {});
    return json(409, { code: "K9O_ZK_STORE_FLOW_REQUIRED", message: "client", context: { route: "client", custodyMode: "BYOK" } });
  }) as unknown as typeof globalThis.fetch;
  const make = (expectedKeyRefs?: ReadonlyArray<string>) =>
    createClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "portal", apiKey: "tok", fetch: fetchByok, ...(expectedKeyRefs ? { expectedKeyRefs } : {}) });
  const refs = ["arn:aws:kms:eu-central-1:111122223333:key/abc"];
  const spyCore = (enforces: boolean, got: unknown[]) => ({
    ...(enforces ? { enforcesExpectedKeyRefs: true } : {}),
    encrypt: (_k: string, items: unknown[], o?: unknown) => (got.push(o), { items: items.map(() => ({ ok: true as const, ciphertext: "c" })) }),
    decrypt: (_k: string, items: unknown[], o?: unknown) => (got.push(o), { items: items.map(() => ({ ok: true as const, plaintext: new Uint8Array() })) }),
    rewrap: (_k: string, items: unknown[], o?: unknown) => (got.push(o), { items: items.map(() => ({ ok: true as const, ciphertext: "c" })) }),
  });

  it("passes the list to a core that declares it enforces it, on encrypt, decrypt and rewrap", async () => {
    const got: unknown[] = [];
    const c = make(refs);
    c.crypto.useClientCore(spyCore(true, got) as never);
    await c.crypto.encrypt({ crypt: "main", items: [{ plaintext: "a" }] });
    await c.crypto.decrypt({ crypt: "main", items: [{ ciphertext: "x" }] });
    await c.crypto.rewrap({ crypt: "main", items: [{ ciphertext: "x" }] });
    expect(got).toEqual([{ expectedKeyRefs: refs }, { expectedKeyRefs: refs }, { expectedKeyRefs: refs }]);
  });

  it("refuses before the core is called when the list is set and the core does not declare enforcement", async () => {
    const got: unknown[] = [];
    const c = make(refs);
    c.crypto.useClientCore(spyCore(false, got) as never);
    for (const call of [
      () => c.crypto.encrypt({ crypt: "main", items: [{ plaintext: "a" }] }),
      () => c.crypto.decrypt({ crypt: "main", items: [{ ciphertext: "x" }] }),
      () => c.crypto.rewrap({ crypt: "main", items: [{ ciphertext: "x" }] }),
    ]) {
      const e = await caught(call());
      expect(e.code).toBe("K9O_CRYPTO_KEY_PIN_UNENFORCED");
    }
    expect(got).toEqual([]);
  });

  it("passes no list, and needs no declaration, when none is set", async () => {
    const got: unknown[] = [];
    const c = make();
    c.crypto.useClientCore(spyCore(false, got) as never);
    await c.crypto.encrypt({ crypt: "main", items: [{ plaintext: "a" }] });
    expect(got).toEqual([{}]);
  });

  it("refuses an empty list, a wildcard and a blank entry when the client is built", () => {
    for (const bad of [[], ["*"], ["arn:aws:kms:*:1:key/*"], [""], ["has space"]]) {
      expect(() => make(bad)).toThrow(KError);
    }
  });

  it("compares keys by the named provider's rule, ignoring the version", () => {
    const gcp = "projects/p/locations/l/keyRings/r/cryptoKeys/k";
    expect(keyRefMatches(`${gcp}/cryptoKeyVersions/7`, [gcp], "gcp")).toBe(true);
    expect(keyRefMatches(`${gcp}/cryptoKeyVersions/7`, [`${gcp}/cryptoKeyVersions/8`], "gcp")).toBe(true);
    // Azure: the first five parts, lower case
    expect(keyRefMatches("https://V.vault.azure.net/keys/Orders/0123456789abcdef0123456789abcdef", ["https://v.vault.azure.net/keys/orders"], "azure")).toBe(true);
    expect(keyRefMatches("https://v.vault.azure.net/keys/orders/anyversion", ["https://v.vault.azure.net/keys/orders"], "azure")).toBe(true);
    expect(keyRefMatches("https://v.vault.azure.net/keys/other", ["https://v.vault.azure.net/keys/orders"], "azure")).toBe(false);
    // Vault: path and key without :version
    expect(keyRefMatches("transit/keys/orders:3", ["transit/keys/orders"], "vault")).toBe(true);
    expect(keyRefMatches("transit/keys/orders:3", ["transit/keys/other"], "vault")).toBe(false);
    // AWS: the whole reference
    expect(keyRefMatches("arn:aws:kms:eu-central-1:1:key/other", ["arn:aws:kms:eu-central-1:1:key/abc"], "aws")).toBe(false);
    expect(keyRefMatches("arn:aws:kms:eu-central-1:1:key/abc", ["arn:aws:kms:eu-central-1:1:key/abc"], "aws")).toBe(true);
  });

  it("never reads the provider from the reference: a Vault reference that looks like a URL is compared by the rule you name", () => {
    const ref = "https://vault.example.com:8200/transit/keys/orders:3";
    expect(keyRefMatches(ref, ["https://vault.example.com:8200/transit/keys/orders"], "vault")).toBe(true);
    // the Azure rule keeps only the first five parts and ignores case, so it answers differently for the same text
    expect(keyRefMatches(ref, ["https://vault.example.com:8200/transit/keys/other"], "azure")).toBe(true);
    expect(keyRefMatches(ref, ["https://vault.example.com:8200/transit/keys/other"], "vault")).toBe(false);
  });
});
