/** encrypt picks its route from the mode answer's `route` field. */
import { describe, expect, it } from "bun:test";
import { createClient, KError } from "../src/index.ts";

type Seen = { method: string; url: string; body: Record<string, any> };
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function harness(mode: Record<string, unknown>) {
  const seen: Seen[] = [];
  const modes: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    const s = { method: String(init?.method), url: String(input), body: JSON.parse(String(init?.body ?? "null")) };
    if (s.url.includes("/crypto/mode")) {
      modes.push(s);
      return json(200, { data: mode, meta: {} });
    }
    seen.push(s);
    return json(200, { data: { items: [{ ciphertext: "server-ct" }] }, meta: {} });
  }) as unknown as typeof globalThis.fetch;
  const c = createClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "portal", apiKey: "tok", fetch: fetchImpl });
  const calls: unknown[] = [];
  c.crypto.useClientCore({
    encrypt: async (_crypt: string, items: any[]) => (calls.push(items), { items: items.map(() => ({ ok: true as const, ciphertext: "client-ct" })) }),
    decrypt: async () => ({ items: [] }),
    rewrap: async () => ({ items: [] }),
  } as any);
  return { c, seen, modes, calls };
}

const req = { crypt: "k", items: [{ plaintext: "a" }] };

async function caught(p: Promise<unknown>): Promise<KError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(KError);
    return e as KError;
  }
  throw new Error("expected a rejection");
}

describe("encrypt route from the mode answer", () => {
  it("(a) BYOK and HYOK with no route use the client core and send no server encrypt", async () => {
    for (const m of ["BYOK", "HYOK"]) {
      const { c, seen, calls } = harness({ custodyMode: m, epoch: "e1" });
      const r = await c.crypto.encrypt(req);
      expect(seen).toHaveLength(0);
      expect(calls).toHaveLength(1);
      expect(r.data.items).toEqual([{ ok: true, ciphertext: "client-ct" }]);
    }
  });

  it("route client on BYOK uses the client core", async () => {
    const { c, seen, calls } = harness({ custodyMode: "BYOK", epoch: "e1", route: "client" });
    await c.crypto.encrypt(req);
    expect([seen.length, calls.length]).toEqual([0, 1]);
  });

  it("(b) BYOK with route server sends the server encrypt with the epoch and does not call the core", async () => {
    for (const m of ["BYOK", "HYOK"]) {
      const { c, seen, calls } = harness({ custodyMode: m, epoch: "e9", route: "server" });
      const r = await c.crypto.encrypt(req);
      expect(calls).toHaveLength(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe("https://acme.api.k9o.io/@portal/crypto/encrypt");
      expect(seen[0]!.body["custodyEpoch"]).toBe("e9");
      expect(r.data.items).toEqual([{ ok: true, ciphertext: "server-ct" }]);
    }
  });

  it("(c) an unknown route is refused on BYOK, sending nothing and calling no core", async () => {
    for (const route of ["bogus", 5, 123, null, "", "Server", true, { a: 1 }]) {
      const { c, seen, calls } = harness({ custodyMode: "BYOK", epoch: "e1", route });
      const e = await caught(c.crypto.encrypt(req));
      expect(e.code).toBe("K9O_CRYPTO_CUSTODY_UNKNOWN");
      expect(e.context["custodyMode"]).toBe("BYOK");
      if (typeof route === "string") expect(e.context["route"]).toBe(route);
      else expect("route" in e.context).toBe(false);
      expect(seen).toHaveLength(0);
      expect(calls).toHaveLength(0);
    }
  });

  it("(d) BYOK with route server and no epoch is refused, nothing sent", async () => {
    for (const epoch of [undefined, ""]) {
      const { c, seen, calls } = harness({ custodyMode: "BYOK", ...(epoch === undefined ? {} : { epoch }), route: "server" });
      const e = await caught(c.crypto.encrypt(req));
      expect(e.code).toBe("K9O_CRYPTO_CUSTODY_UNKNOWN");
      expect(seen).toHaveLength(0);
      expect(calls).toHaveLength(0);
    }
  });

  it("(e) PLATFORM_MANAGED is unchanged, with or without route server; an unknown route is refused", async () => {
    for (const route of [undefined, "server"]) {
      const { c, seen, calls } = harness({ custodyMode: "PLATFORM_MANAGED", epoch: "e1", ...(route === undefined ? {} : { route }) });
      await c.crypto.encrypt(req);
      expect([seen.length, calls.length, seen[0]!.body["custodyEpoch"]]).toEqual([1, 0, "e1"]);
    }
    const { c, seen, calls } = harness({ custodyMode: "PLATFORM_MANAGED", epoch: "e1", route: "bogus" });
    const e = await caught(c.crypto.encrypt(req));
    expect(e.code).toBe("K9O_CRYPTO_CUSTODY_UNKNOWN");
    expect([seen.length, calls.length]).toEqual([0, 0]);
  });

  it("the mode is read fresh before every encrypt: two encrypts, two mode requests", async () => {
    const { c, modes } = harness({ custodyMode: "BYOK", epoch: "e1", route: "server" });
    await c.crypto.encrypt(req);
    await c.crypto.encrypt(req);
    expect(modes).toHaveLength(2);
  });
});
