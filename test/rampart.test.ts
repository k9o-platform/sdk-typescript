import { describe, expect, it } from "bun:test";
import {
  createClient, KError, RampartReceiptError, RAMPART_RECEIPT_REASONS, RAMPART_ERROR_CODES, isRampartInputTooLong, jcsCanonicalize,
  type RampartJwk, type RampartReceiptReason,
} from "../src/index.ts";
import { sha256Hex } from "../src/sha256.ts";

const PROJECT_ID = "proj_01hxyz";
const ISSUER = "https://api.k9o.io/rampart";
const NOW = new Date("2026-10-27T12:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const INPUT = { text: "hello", n: 1, nested: { b: [1, 2], a: null } };

const b64u = (b: Uint8Array | string): string =>
  Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b).toString("base64url");

type Signer = { kid: string; jwk: RampartJwk; privateKey: CryptoKey };

async function newSigner(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { kty: "OKP", crv: "Ed25519", x: pub.x!, kid, alg: "EdDSA", use: "sig" } };
}

async function sign(
  s: Signer,
  over: { header?: Record<string, unknown>; claims?: Record<string, unknown>; input?: unknown } = {},
): Promise<string> {
  const header = { alg: "EdDSA", kid: s.kid, typ: "k9o.rampart.classify.v1", ...over.header };
  const claims = {
    iss: ISSUER, iat: NOW_S, exp: NOW_S + 3600,
    input_sha256: sha256Hex(jcsCanonicalize(over.input ?? INPUT)),
    classification: "suspicious", risk_bp: 6200, confidence_bp: 8100, categories: ["prompt_injection"],
    project_id: PROJECT_ID, calibration_version: "cal-1", ...over.claims,
  };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, s.privateKey, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${b64u(sig)}`;
}

type Seen = { url: string; method: string; body: unknown; auth: string | null };

function harness(handler: (url: string, init: RequestInit | undefined, seen: Seen[]) => Response, projectSlug: string | null = "portal") {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    const url = String(input);
    const h = new Headers(init?.headers as HeadersInit);
    seen.push({ url, method: String(init?.method), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, auth: h.get("authorization") });
    return handler(url, init, seen);
  }) as unknown as typeof globalThis.fetch;
  const c = createClient({ baseUrl: "https://acme.api.k9o.io", ...(projectSlug !== null ? { projectSlug } : {}), apiKey: "tok", fetch: fetchImpl });
  return { c, seen };
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const feed = (...keys: RampartJwk[]) => ({ keys, issuer: ISSUER, meta: { context: { requestId: "r" } } });

async function reason(p: Promise<unknown>): Promise<RampartReceiptReason> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RampartReceiptError);
    return (e as RampartReceiptError).reason;
  }
  throw new Error("expected a refusal");
}

describe("rampart.classify", () => {
  const data = {
    classification: "suspicious", riskScore: 6200, confidence: 8100, categories: ["prompt_injection"],
    calibrationVersion: "cal-1", classificationReceipt: "a.b.c",
  };

  it("posts to /@<slug>/rampart/classify with input and label and returns the verdict and the receipt as received", async () => {
    const { c, seen } = harness(() => json(200, { data: { ...data, projectId: PROJECT_ID }, meta: {} }));
    const r = await c.rampart.classify({ text: "hi" }, { label: "chat" });
    expect(seen).toEqual([{ method: "POST", url: "https://acme.api.k9o.io/@portal/rampart/classify", body: { input: { text: "hi" }, label: "chat" }, auth: "Bearer tok" }]);
    expect(r.data).toEqual({ ...data, projectId: PROJECT_ID });
    expect(r.data.classificationReceipt).toBe("a.b.c");
    expect(r.data.projectId).toBe(PROJECT_ID);
  });

  it("omits label when none is given", async () => {
    const { c, seen } = harness(() => json(200, { data, meta: {} }));
    await c.rampart.classify({ text: "hi" });
    expect(seen[0]!.body).toEqual({ input: { text: "hi" } });
  });

  it("surfaces the 503 as a KError with the gateway code and returns no verdict", async () => {
    const { c } = harness(() => json(503, { code: "K9O_RAMPART_CLASSIFIER_UNAVAILABLE", message: "down", context: { cause: "no_endpoint_configured" }, recommendation: null }));
    try {
      await c.rampart.classify({ text: "hi" });
      throw new Error("expected a rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(KError);
      expect((e as KError).code).toBe("K9O_RAMPART_CLASSIFIER_UNAVAILABLE");
      expect((e as KError).status).toBe(503);
    }
  });

  it("surfaces the 413 for an input past 16 windows as a typed KError and returns no verdict", async () => {
    const { c, seen } = harness(() => json(413, { code: "K9O_RAMPART_INPUT_TOO_LONG", message: "too long", context: { reason: "rampart_input_too_long" }, recommendation: null }));
    let caught: unknown;
    let verdict: unknown;
    try {
      verdict = await c.rampart.classify({ text: "x ".repeat(20000) });
    } catch (e) {
      caught = e;
    }
    expect(verdict).toBeUndefined();
    expect(caught).toBeInstanceOf(KError);
    expect(isRampartInputTooLong(caught)).toBe(true);
    expect((caught as KError).code).toBe(RAMPART_ERROR_CODES.inputTooLong);
    expect((caught as KError).status).toBe(413);
    expect((caught as KError).context["reason"]).toBe("rampart_input_too_long");
    expect(seen).toHaveLength(1); // a 413 is not retried
    expect(isRampartInputTooLong(new KError({ code: "K9O_RAMPART_CLASSIFIER_UNAVAILABLE", message: "x", status: 503 }))).toBe(false);
  });

  it("checks its arguments before sending", async () => {
    const { c, seen } = harness(() => json(200, { data, meta: {} }));
    for (const bad of [null, [], "x", 3, undefined]) {
      const e = await c.rampart.classify(bad as never).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(KError);
      expect((e as KError).code).toBe("K9O_INVALID_FIELD_VALUE"); // a bare string is refused here, whatever the gateway answers today
    }
    await expect(c.rampart.classify({}, { label: "" })).rejects.toThrow(TypeError);
    await expect(c.rampart.classify({}, { label: "x".repeat(129) })).rejects.toThrow(TypeError);
    expect(seen).toHaveLength(0);
    const noProject = harness(() => json(200, { data, meta: {} }), null);
    await expect(noProject.c.rampart.classify({})).rejects.toThrow(/projectSlug/);
  });
});

describe("rampart.jwks", () => {
  it("reads GET /rampart/jwks with no project prefix", async () => {
    const s = await newSigner("k1");
    const { c, seen } = harness(() => json(200, feed(s.jwk)));
    const r = await c.rampart.jwks();
    expect(seen.map((x) => [x.method, x.url])).toEqual([["GET", "https://acme.api.k9o.io/rampart/jwks"]]);
    expect(r.keys).toEqual([s.jwk]);
    expect(r.issuer).toBe(ISSUER);
  });

  it("leaves issuer out when the feed advertises none", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(200, { keys: [s.jwk], meta: {} }));
    const r = await c.rampart.jwks();
    expect(r.issuer).toBeUndefined();
    expect("issuer" in r).toBe(false);
  });

  it("refuses a body that is not a key feed", async () => {
    const { c } = harness(() => json(200, { data: [], meta: {} }));
    await expect(c.rampart.jwks()).rejects.toThrow(KError);
  });
});

describe("rampart.verifyReceipt", () => {
  const opts = (s: Signer, extra: Record<string, unknown> = {}) => ({ keys: { keys: [s.jwk], issuer: ISSUER }, projectId: PROJECT_ID, now: () => NOW, ...extra });

  it("accepts a good receipt and returns the verified claims", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(500, {}));
    const v = await c.rampart.verifyReceipt(await sign(s), INPUT, opts(s));
    expect(v).toEqual({
      classification: "suspicious", riskScore: 6200, confidence: 8100, categories: ["prompt_injection"], calibrationVersion: "cal-1",
      projectId: PROJECT_ID, inputSha256: sha256Hex(jcsCanonicalize(INPUT)), issuer: ISSUER, windows: 1, issuedAt: NOW_S, expiresAt: NOW_S + 3600, kid: "k1",
    });
  });

  it("matches the input by its canonical form, not by key order", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(500, {}));
    const reordered = { nested: { a: null, b: [1, 2] }, n: 1, text: "hello" };
    expect((await c.rampart.verifyReceipt(await sign(s), reordered, opts(s))).classification).toBe("suspicious");
  });

  it("takes the key list directly too", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(500, {}));
    expect((await c.rampart.verifyReceipt(await sign(s), INPUT, { ...opts(s), keys: [s.jwk], issuer: ISSUER })).kid).toBe("k1");
  });

  const verdict = { classification: "suspicious", riskScore: 1, confidence: 1, categories: [], calibrationVersion: "x" } as const;

  it("accepts the classify result object (envelope or its data) and compares the project it carries", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(500, {}));
    const receipt = await sign(s);
    const base = { keys: { keys: [s.jwk], issuer: ISSUER }, now: () => NOW };
    const envelope = { data: { ...verdict, classificationReceipt: receipt, projectId: PROJECT_ID }, meta: {} };
    expect((await c.rampart.verifyReceipt(envelope, INPUT, base)).projectId).toBe(PROJECT_ID);
    expect((await c.rampart.verifyReceipt(envelope.data, INPUT, base)).projectId).toBe(PROJECT_ID);
    const other = { data: { ...envelope.data, projectId: "proj_other" }, meta: {} };
    expect(await reason(c.rampart.verifyReceipt(other, INPUT, base))).toBe("project");
  });

  it("verifies what classify returned, end to end", async () => {
    const s = await newSigner("k1");
    const receipt = await sign(s);
    const { c } = harness((url) =>
      url.endsWith("/classify") ? json(200, { data: { ...verdict, classificationReceipt: receipt, projectId: PROJECT_ID }, meta: {} }) : json(200, feed(s.jwk)),
    );
    const r = await c.rampart.classify(INPUT);
    expect((await c.rampart.verifyReceipt(r, INPUT, { now: () => NOW })).issuer).toBe(ISSUER);
  });

  it("the projectId option wins over the one the classify result carries", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(500, {}));
    const result = { ...verdict, classificationReceipt: await sign(s), projectId: "proj_other" };
    expect((await c.rampart.verifyReceipt(result, INPUT, opts(s))).projectId).toBe(PROJECT_ID);
  });

  it("refuses a bare receipt string without a project id as project_unknown, and a result without projectId too", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(500, {}));
    const receipt = await sign(s);
    const base = { keys: { keys: [s.jwk], issuer: ISSUER }, now: () => NOW };
    expect(await reason(c.rampart.verifyReceipt(receipt, INPUT, base))).toBe("project_unknown");
    expect(await reason(c.rampart.verifyReceipt({ ...verdict, classificationReceipt: receipt }, INPUT, base))).toBe("project_unknown");
    expect((await c.rampart.verifyReceipt(receipt, INPUT, { ...base, projectId: PROJECT_ID })).projectId).toBe(PROJECT_ID);
  });

  it("refuses a result object without a receipt string as malformed", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(500, {}));
    expect(await reason(c.rampart.verifyReceipt({} as never, INPUT, opts(s)))).toBe("malformed");
  });

  it("takes the issuer from the key feed, never from the base URL", async () => {
    const s = await newSigner("k1");
    const fetchImpl = (async () => json(200, { keys: [s.jwk], issuer: "https://id.corp.internal/rampart", meta: {} })) as unknown as typeof globalThis.fetch;
    const c = createClient({ baseUrl: "https://acme.api-de01.corp.internal", projectSlug: "p", apiKey: "t", fetch: fetchImpl });
    const good = await sign(s, { claims: { iss: "https://id.corp.internal/rampart" } });
    expect((await c.rampart.verifyReceipt(good, INPUT, { projectId: PROJECT_ID, now: () => NOW })).issuer).toBe("https://id.corp.internal/rampart");
    // the issuer a base-URL derivation would have produced is refused
    const derived = await sign(s, { claims: { iss: "https://api.corp.internal/rampart" } });
    expect(await reason(c.rampart.verifyReceipt(derived, INPUT, { projectId: PROJECT_ID, now: () => NOW }))).toBe("issuer");
  });

  it("refuses with issuer when the feed advertises none and no option is given", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(200, { keys: [s.jwk], meta: {} }));
    const receipt = await sign(s);
    try {
      await c.rampart.verifyReceipt(receipt, INPUT, { projectId: PROJECT_ID, now: () => NOW });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as RampartReceiptError).reason).toBe("issuer");
      expect((e as RampartReceiptError).detail).toMatch(/no issuer is advertised/);
    }
    const injected = { keys: [s.jwk], projectId: PROJECT_ID, now: () => NOW };
    expect(await reason(c.rampart.verifyReceipt(receipt, INPUT, injected))).toBe("issuer");
  });

  it("the issuer option overrides the feed", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(200, feed(s.jwk)));
    const receipt = await sign(s, { claims: { iss: "https://other.example/rampart" } });
    expect(await reason(c.rampart.verifyReceipt(receipt, INPUT, { projectId: PROJECT_ID, now: () => NOW }))).toBe("issuer");
    const v = await c.rampart.verifyReceipt(receipt, INPUT, { projectId: PROJECT_ID, issuer: "https://other.example/rampart", now: () => NOW });
    expect(v.issuer).toBe("https://other.example/rampart");
    // and the option is binding against a matching feed
    const mine = await sign(s);
    expect(await reason(c.rampart.verifyReceipt(mine, INPUT, { projectId: PROJECT_ID, issuer: "https://other.example/rampart", now: () => NOW }))).toBe("issuer");
  });

  it("classifies nothing on its own: an input with a fraction or 2^53 is refused by verify as input_hash", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(500, {}));
    const receipt = await sign(s);
    for (const bad of [{ x: 1.5 }, { x: 2 ** 53 }, { x: [0.1] }]) {
      expect(await reason(c.rampart.verifyReceipt(receipt, bad, opts(s)))).toBe("input_hash");
    }
  });

  it("classify does not pre-validate the input; the server decides", async () => {
    const { c, seen } = harness(() => json(400, { code: "K9O_VALIDATION_FAILED", message: "bad input", context: {}, recommendation: null }));
    await expect(c.rampart.classify({ x: 1.5 })).rejects.toBeInstanceOf(KError);
    expect(seen).toHaveLength(1);
  });

  type Case = { receipt: string; input?: unknown; keys?: RampartJwk[] };
  const cases: Array<[string, RampartReceiptReason, (s: Signer) => Promise<Case>]> = [
    ["a kid the key set does not hold", "key_unknown", async (s) => ({ receipt: await sign(s, { header: { kid: "nope" } }) })],
    ["a key of another type", "key_unknown", async (s) => ({ receipt: await sign(s), keys: [{ ...s.jwk, kty: "RSA" }] })],
    ["alg HS256", "alg", async (s) => ({ receipt: await sign(s, { header: { alg: "HS256" } }) })],
    ["alg none", "alg", async (s) => ({ receipt: await sign(s, { header: { alg: "none" } }) })],
    ["typ JWT", "typ", async (s) => ({ receipt: await sign(s, { header: { typ: "JWT" } }) })],
    ["typ with another version", "typ", async (s) => ({ receipt: await sign(s, { header: { typ: "k9o.rampart.classify.v2" } }) })],
    ["no typ", "typ", async (s) => ({ receipt: await sign(s, { header: { typ: undefined } }) })],
    ["another issuer", "issuer", async (s) => ({ receipt: await sign(s, { claims: { iss: "https://evil.example/rampart" } }) })],
    ["another project", "project", async (s) => ({ receipt: await sign(s, { claims: { project_id: "proj_other" } }) })],
    ["a project id that is a slug", "project", async (s) => ({ receipt: await sign(s, { claims: { project_id: "portal" } }) })],
    ["an input with a fractional number", "input_hash", async (s) => ({ receipt: await sign(s), input: { text: "hello", n: 1.5 } })],
    ["an input with an integer above 2^53-1", "input_hash", async (s) => ({ receipt: await sign(s), input: { n: 2 ** 53 } })],
    ["expired past the skew", "expired", async (s) => ({ receipt: await sign(s, { claims: { iat: NOW_S - 7200, exp: NOW_S - 61 } }) })],
    ["issued in the future past the skew", "not_yet_valid", async (s) => ({ receipt: await sign(s, { claims: { iat: NOW_S + 61, exp: NOW_S + 3600 } }) })],
    ["another input", "input_hash", async (s) => ({ receipt: await sign(s), input: { text: "different" } })],
    ["an input that cannot be canonicalised", "input_hash", async (s) => ({ receipt: await sign(s), input: { text: Number.NaN } })],
    ["a tampered signature", "signature", async (s) => {
      const r = await sign(s);
      const [h, p, sig] = r.split(".") as [string, string, string];
      const flipped = Buffer.from(sig, "base64url");
      flipped[0] = flipped[0]! ^ 1;
      return { receipt: `${h}.${p}.${flipped.toString("base64url")}` };
    }],
    ["tampered claims", "signature", async (s) => {
      const r = await sign(s);
      const [h, p, sig] = r.split(".") as [string, string, string];
      const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
      claims["classification"] = "clear";
      return { receipt: `${h}.${b64u(JSON.stringify(claims))}.${sig}` };
    }],
    ["a short signature", "signature", async (s) => {
      const [h, p] = (await sign(s)).split(".") as [string, string];
      return { receipt: `${h}.${p}.AAAA` };
    }],
    ["a signature by another key under the same kid", "signature", async (s) => ({ receipt: await sign(await newSigner(s.kid)) })],
    ["two parts", "malformed", async () => ({ receipt: "only.two" })],
    ["four parts", "malformed", async () => ({ receipt: "a.b.c.d" })],
    ["characters outside base64url", "malformed", async () => ({ receipt: "!!!.@@@.###" })],
    ["a header that is not an object", "malformed", async () => ({ receipt: `${b64u("[]")}.${b64u("{}")}.AAAA` })],
    ["no kid", "malformed", async () => ({ receipt: `${b64u("{}")}.${b64u("{}")}.AAAA` })],
    ["a critical header parameter", "malformed", async (s) => ({ receipt: await sign(s, { header: { crit: ["x"] } }) })],
    ["a non-numeric exp", "malformed", async (s) => ({ receipt: await sign(s, { claims: { exp: "soon" } }) })],
    ["an unknown classification", "malformed", async (s) => ({ receipt: await sign(s, { claims: { classification: "fine" } }) })],
    ["a risk outside 0..10000", "malformed", async (s) => ({ receipt: await sign(s, { claims: { risk_bp: 10001 } }) })],
    ["a missing digest", "malformed", async (s) => ({ receipt: await sign(s, { claims: { input_sha256: undefined } }) })],
  ];
  for (const [name, expected, make] of cases) {
    it(`refuses ${name} with ${expected}`, async () => {
      const s = await newSigner("k1");
      const made = await make(s);
      const { c } = harness(() => json(500, {}));
      expect(await reason(c.rampart.verifyReceipt(made.receipt, "input" in made ? made.input : INPUT, { ...opts(s), keys: { keys: made.keys ?? [s.jwk], issuer: ISSUER } }))).toBe(expected);
    });
  }

  it("covers every reason of the closed set", () => {
    const covered = new Set(cases.map(([, r]) => r));
    covered.add("key_unavailable"); // covered by the key feed tests below
    covered.add("project_unknown"); // covered by the project tests above
    expect([...RAMPART_RECEIPT_REASONS].sort()).toEqual([...covered].sort());
  });

  it("applies the clock skew at both ends, 60 s by default, and takes another value", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(500, {}));
    const late = await sign(s, { claims: { iat: NOW_S - 3600, exp: NOW_S - 60 } });
    expect((await c.rampart.verifyReceipt(late, INPUT, opts(s))).kid).toBe("k1");
    expect(await reason(c.rampart.verifyReceipt(late, INPUT, opts(s, { clockSkewSeconds: 10 })))).toBe("expired");
    const early = await sign(s, { claims: { iat: NOW_S + 60, exp: NOW_S + 3600 } });
    expect((await c.rampart.verifyReceipt(early, INPUT, opts(s))).kid).toBe("k1");
    expect(await reason(c.rampart.verifyReceipt(early, INPUT, opts(s, { clockSkewSeconds: 0 })))).toBe("not_yet_valid");
  });

  it("takes the verdict from the signed claims whatever an unsigned body says", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(500, {}));
    const v = await c.rampart.verifyReceipt(await sign(s, { claims: { classification: "malicious", risk_bp: 9900 } }), INPUT, opts(s));
    expect([v.classification, v.riskScore]).toEqual(["malicious", 9900]);
  });

  it("does not use a key carried inside the receipt", async () => {
    const real = await newSigner("k1");
    const attacker = await newSigner("k1");
    const { c } = harness(() => json(500, {}));
    const receipt = await sign(attacker, { header: { jwk: attacker.jwk } });
    expect(await reason(c.rampart.verifyReceipt(receipt, INPUT, opts(real)))).toBe("signature");
  });

  describe("the key feed", () => {
    it("fetches the feed itself, keeps it, and does not fetch again for a known kid", async () => {
      const s = await newSigner("k1");
      const { c, seen } = harness(() => json(200, feed(s.jwk)));
      const receipt = await sign(s);
      for (let i = 0; i < 3; i++) await c.rampart.verifyReceipt(receipt, INPUT, { projectId: PROJECT_ID, now: () => NOW });
      expect(seen.filter((x) => x.url.endsWith("/rampart/jwks"))).toHaveLength(1);
    });

    it("refetches once on an unknown kid and then finds the rotated key", async () => {
      const old = await newSigner("k1");
      const rotated = await newSigner("k2");
      let published = [old.jwk];
      const { c, seen } = harness(() => json(200, feed(...published)));
      await c.rampart.verifyReceipt(await sign(old), INPUT, { projectId: PROJECT_ID, now: () => NOW });
      published = [old.jwk, rotated.jwk];
      const v = await c.rampart.verifyReceipt(await sign(rotated), INPUT, { projectId: PROJECT_ID, now: () => NOW });
      expect(v.kid).toBe("k2");
      expect(seen.filter((x) => x.url.endsWith("/rampart/jwks"))).toHaveLength(2);
    });

    it("refetches only once per call for a kid that never appears", async () => {
      const known = await newSigner("k1");
      const stranger = await newSigner("zz");
      const { c, seen } = harness(() => json(200, feed(known.jwk)));
      await c.rampart.verifyReceipt(await sign(known), INPUT, { projectId: PROJECT_ID, now: () => NOW });
      expect(await reason(c.rampart.verifyReceipt(await sign(stranger), INPUT, { projectId: PROJECT_ID, now: () => NOW }))).toBe("key_unknown");
      expect(seen.filter((x) => x.url.endsWith("/rampart/jwks"))).toHaveLength(2); // 1 initial + 1 refetch
    });

    it("does not fetch twice in one call when the first fetch already lacks the kid", async () => {
      const known = await newSigner("k1");
      const stranger = await newSigner("zz");
      const { c, seen } = harness(() => json(200, feed(known.jwk)));
      expect(await reason(c.rampart.verifyReceipt(await sign(stranger), INPUT, { projectId: PROJECT_ID, now: () => NOW }))).toBe("key_unknown");
      expect(seen.filter((x) => x.url.endsWith("/rampart/jwks"))).toHaveLength(1);
    });

    it("never fetches when you pass the key set", async () => {
      const s = await newSigner("k1");
      const { c, seen } = harness(() => json(200, feed(s.jwk)));
      await c.rampart.verifyReceipt(await sign(s), INPUT, opts(s));
      await reason(c.rampart.verifyReceipt(await sign(s, { header: { kid: "x" } }), INPUT, opts(s)));
      expect(seen).toHaveLength(0);
    });

    it("refuses with key_unavailable, not a pass, when the feed cannot be read", async () => {
      const s = await newSigner("k1");
      const { c } = harness(() => json(503, { code: "K9O_UPSTREAM_UNAVAILABLE", message: "down", context: {}, recommendation: null }));
      expect(await reason(c.rampart.verifyReceipt(await sign(s), INPUT, { projectId: PROJECT_ID, now: () => NOW }))).toBe("key_unavailable");
    });
  });
});

describe("rampart.verifyReceipt: windows claim", () => {
  const opts = (s: Signer) => ({ keys: { keys: [s.jwk], issuer: ISSUER }, projectId: PROJECT_ID, now: () => NOW });

  it("exposes the signed windows claim as a number", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(500, {}));
    const v = await c.rampart.verifyReceipt(await sign(s, { claims: { windows: 7 } }), INPUT, opts(s));
    expect(v.windows).toBe(7);
    expect(typeof v.windows).toBe("number");
  });

  it("reads a receipt without the claim as one window", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(500, {}));
    expect((await c.rampart.verifyReceipt(await sign(s), INPUT, opts(s))).windows).toBe(1);
  });

  it("tolerates claims it does not know", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(500, {}));
    const v = await c.rampart.verifyReceipt(await sign(s, { claims: { windows: 2, some_future_claim: { a: 1 } } }), INPUT, opts(s));
    expect(v.windows).toBe(2);
    expect(v.classification).toBe("suspicious");
  });

  it("refuses a windows claim that is not a positive integer", async () => {
    const s = await newSigner("k1");
    const { c } = harness(() => json(500, {}));
    for (const bad of [0, -1, 1.5, "2", null]) {
      const err = await c.rampart.verifyReceipt(await sign(s, { claims: { windows: bad } }), INPUT, opts(s)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RampartReceiptError);
      expect((err as RampartReceiptError).reason).toBe("malformed");
    }
  });
});
