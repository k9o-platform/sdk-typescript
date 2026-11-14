import { describe, expect, it } from "bun:test";
import { createClient, KError } from "../src/index.ts";

function client(status: number, payload: unknown, projectSlug: string | null = "portal") {
  const seen: { url: string; method: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    seen.push({ url: String(input), method: String(init?.method) });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const c = createClient({ baseUrl: "https://acme.api.k9o.io", ...(projectSlug !== null ? { projectSlug } : {}), apiKey: "k", fetch: fetchImpl });
  return { c, seen };
}

describe("client.custody.status", () => {
  it("reads the platform answer; a missing hsm is null", async () => {
    const { c, seen } = client(200, { data: { mode: "PLATFORM_MANAGED", attached: false, provider: null, lastJob: null }, meta: {} });
    const r = await c.custody.status();
    expect(seen).toEqual([{ method: "GET", url: "https://acme.api.k9o.io/@portal/custody/status" }]);
    expect(r.data).toEqual({ mode: "PLATFORM_MANAGED", attached: false, provider: null, lastJob: null, hsm: null });
  });

  it("reads an attached HSM", async () => {
    const hsm = {
      vendor: "aws-cloudhsm", clusterId: "cluster-1234567890abcdef", region: "de01",
      attestation: { status: null, verifiedAt: null }, keys: null,
    };
    const { c } = client(200, { data: { mode: "HYOK", attached: true, provider: "hsm", lastJob: null, hsm }, meta: {} });
    const r = await c.custody.status();
    expect(r.data.provider).toBe("hsm");
    expect(r.data.hsm).toEqual(hsm);
  });

  it("returns lastJob as sent", async () => {
    const lastJob = { kind: "external_transition", status: "completed", completedAt: "2026-10-26T12:00:00.000Z" };
    const { c } = client(200, { data: { mode: "HYOK", attached: true, provider: "external_kms", lastJob }, meta: {} });
    expect((await c.custody.status()).data.lastJob).toEqual(lastJob as never);
  });

  it("maps 403 and 502 to KError", async () => {
    for (const [status, code] of [[403, "K9O_RBAC_DENY"], [502, "K9O_UPSTREAM_UNAVAILABLE"]] as const) {
      const { c } = client(status, { code, message: "no", context: {}, recommendation: null });
      try {
        await c.custody.status();
        throw new Error("expected a rejection");
      } catch (e) {
        expect(e).toBeInstanceOf(KError);
        expect((e as KError).code).toBe(code);
      }
    }
  });

  it("needs a bound project", async () => {
    const { c, seen } = client(200, {}, null);
    await expect(c.custody.status()).rejects.toThrow("projectSlug");
    expect(seen.length).toBe(0);
  });
});
