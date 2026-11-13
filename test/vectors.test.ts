import { describe, expect, it } from "bun:test";
import { createClient, KError, type NearestVectorsResult } from "../src/index.ts";

type Seen = { url: string; method: string; body?: unknown };

function client(respond: () => { status?: number; body: unknown }, projectSlug: string | null = "portal") {
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
  const c = createClient({ baseUrl: "https://acme.api.k9o.io", ...(projectSlug !== null ? { projectSlug } : {}), apiKey: "k", fetch: fetchImpl });
  return { c, seen };
}

const BASE = "https://acme.api.k9o.io/@portal";

const searchResponse = {
  data: {
    results: [
      { id: "rec_1", score: 0.98, _source: { handle: "doc-a", chunkIndex: 0 }, contentHash: "h1", text: "alpha", metadata: { model: "m1", lang: "en" }, model: "m1", chunk: 0 },
      { id: "rec_2", score: 0.5, _source: { handle: "doc-b", chunkIndex: 3, extra: true }, contentHash: null, text: null, metadata: {}, model: null, chunk: 3 },
    ],
    collection: "_notes",
  },
  meta: {},
};

async function rejects(p: Promise<unknown>): Promise<KError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(KError);
    return e as KError;
  }
  throw new Error("expected a rejection");
}

describe("client.vectors.nearest", () => {
  it("posts the body to the search path and returns typed results", async () => {
    const { c, seen } = client(() => ({ body: searchResponse }));
    const r = await c.vectors.nearest("_notes", {
      queryVector: [0.1, 0.2, 0.3], topK: 2, minScore: 0.4, metric: "euclidean", filters: { "metadata.lang": "en", chunk: 1 },
    });
    expect(seen).toEqual([{
      method: "POST",
      url: `${BASE}/vectors/_notes/search`,
      body: { queryVector: [0.1, 0.2, 0.3], topK: 2, minScore: 0.4, metric: "euclidean", filters: { "metadata.lang": "en", chunk: 1 } },
    }]);
    const data: NearestVectorsResult = r.data;
    expect(data.collection).toBe("_notes");
    expect(data.results.map((x) => x.id)).toEqual(["rec_1", "rec_2"]);
    const first = data.results[0]!;
    const score: number = first.score;
    const text: string | null = first.text;
    const chunk: number | null = first.chunk;
    expect([score, text, chunk, first._source.handle, first.contentHash, first.model]).toEqual([0.98, "alpha", 0, "doc-a", "h1", "m1"]);
    expect(data.results[1]!.text).toBeNull();
    expect(data.results[1]!._source["extra"]).toBe(true);
  });

  it("sends only the vector when no options are given", async () => {
    const { c, seen } = client(() => ({ body: searchResponse }));
    await c.vectors.nearest("_notes", { queryVector: [1] });
    expect(seen[0]!.body).toEqual({ queryVector: [1] });
  });

  it("accepts the bounds", async () => {
    const { c, seen } = client(() => ({ body: searchResponse }));
    await c.vectors.nearest("_notes", { queryVector: new Array<number>(16000).fill(0.5), topK: 1000 });
    await c.vectors.nearest("_notes", { queryVector: [1], topK: 1, minScore: -1, metric: "dot" });
    await c.vectors.nearest("_notes", { queryVector: [1], metric: "cosine" });
    expect(seen).toHaveLength(3);
  });

  it("refuses bad input before sending anything", async () => {
    const { c, seen } = client(() => ({ body: searchResponse }));
    const cases: Array<[string, unknown, unknown]> = [
      ["notes", { queryVector: [1] }, "name"],
      ["", { queryVector: [1] }, "name"],
      ["_n", { queryVector: [] }, "empty"],
      ["_n", { queryVector: new Array<number>(16001).fill(1) }, "long"],
      ["_n", { queryVector: [1, Number.NaN] }, "nan"],
      ["_n", { queryVector: [1, "2"] }, "string"],
      ["_n", { queryVector: "1,2" }, "not array"],
      ["_n", { queryVector: [1], topK: 0 }, "topK 0"],
      ["_n", { queryVector: [1], topK: 1001 }, "topK 1001"],
      ["_n", { queryVector: [1], topK: 1.5 }, "topK frac"],
      ["_n", { queryVector: [1], metric: "l2" }, "metric"],
      ["_n", { queryVector: [1], minScore: Number.NaN }, "minScore"],
      ["_n", { queryVector: [1], filters: [] }, "filters array"],
      ["_n", null, "null input"],
    ];
    for (const [name, input, label] of cases) {
      const e = await rejects(c.vectors.nearest(name, input as never));
      expect([label, e.code]).toEqual([label, "K9O_INVALID_FIELD_VALUE"]);
    }
    expect(seen).toHaveLength(0);
  });

  it("requires a bound project", async () => {
    const { c, seen } = client(() => ({ body: searchResponse }), null);
    await expect(c.vectors.nearest("_n", { queryVector: [1] })).rejects.toThrow(/projectSlug/);
    expect(seen).toHaveLength(0);
  });

  it("surfaces the gateway's 404 for a collection that was never upserted", async () => {
    const body = { code: "K9O_COLLECTION_NOT_FOUND", message: "Collection '_none' does not exist in this project", context: {}, recommendation: null };
    const { c } = client(() => ({ status: 404, body }));
    const e = await rejects(c.vectors.nearest("_none", { queryVector: [1] }));
    expect(e.code).toBe("K9O_COLLECTION_NOT_FOUND");
    expect(e.status).toBe(404);
  });

  it("surfaces a dimension mismatch", async () => {
    const body = { code: "K9O_INVALID_VECTOR_DIMENSION", message: "wrong dimension", context: {}, recommendation: null };
    const { c } = client(() => ({ status: 400, body }));
    expect((await rejects(c.vectors.nearest("_n", { queryVector: [1, 2] }))).code).toBe("K9O_INVALID_VECTOR_DIMENSION");
  });
});

describe("client.vectors.upsert", () => {
  const rows = [
    { id: "a", vector: [1, 0, 0], _source: { handle: "doc", chunkIndex: 0 }, text: "one", metadata: { lang: "en" }, contentHash: "h", subjectIds: ["eu_abc123"] },
    { vector: [0, 1, 0], _source: { handle: "doc", chunkIndex: 1 }, subjectIds: ["eu_abc123"] },
  ];

  it("posts { rows } to the upsert path and returns the count", async () => {
    const { c, seen } = client(() => ({ body: { data: { upserted: 2, collection: "_notes" }, meta: {} } }));
    const r = await c.vectors.upsert("_notes", rows);
    expect(seen).toEqual([{ method: "POST", url: `${BASE}/vectors/_notes/upsert`, body: { rows } }]);
    const upserted: number = r.data.upserted;
    expect([upserted, r.data.collection]).toEqual([2, "_notes"]);
  });

  it("allows rows without subjectIds (a shared collection) and leaves that check to the gateway", async () => {
    const { c, seen } = client(() => ({ body: { data: { upserted: 1, collection: "_shared" }, meta: {} } }));
    await c.vectors.upsert("_shared", [{ vector: [1], _source: { handle: "h", chunkIndex: 0 } }]);
    expect(seen[0]!.body).toEqual({ rows: [{ vector: [1], _source: { handle: "h", chunkIndex: 0 } }] });
  });

  it("accepts 1 and 1000 rows", async () => {
    const { c, seen } = client(() => ({ body: { data: { upserted: 1, collection: "_n" }, meta: {} } }));
    const one = { vector: [1], _source: { handle: "h", chunkIndex: 0 } };
    await c.vectors.upsert("_n", [one]);
    await c.vectors.upsert("_n", new Array(1000).fill(one));
    expect(seen).toHaveLength(2);
  });

  it("refuses bad input before sending anything", async () => {
    const { c, seen } = client(() => ({ body: { data: {}, meta: {} } }));
    const ok = { vector: [1], _source: { handle: "h", chunkIndex: 0 } };
    const cases: Array<[string, unknown, string]> = [
      ["notes", [ok], "name"],
      ["_n", [], "no rows"],
      ["_n", new Array(1001).fill(ok), "1001 rows"],
      ["_n", "rows", "not array"],
      ["_n", [null], "null row"],
      ["_n", [{ ...ok, vector: [] }], "empty vector"],
      ["_n", [ok, { ...ok, vector: new Array<number>(16001).fill(1) }], "long vector"],
      ["_n", [{ ...ok, vector: [Number.POSITIVE_INFINITY] }], "infinite"],
    ];
    for (const [name, input, label] of cases) {
      const e = await rejects(c.vectors.upsert(name, input as never));
      expect([label, e.code]).toEqual([label, "K9O_INVALID_FIELD_VALUE"]);
    }
    expect(seen).toHaveLength(0);
  });

  it("surfaces the gateway's subject attribution refusal", async () => {
    const body = { code: "K9O_VECTOR_SUBJECT_ATTRIBUTION_REQUIRED", message: "subjectIds required", context: {}, recommendation: null };
    const { c } = client(() => ({ status: 400, body }));
    const e = await rejects(c.vectors.upsert("_n", [{ vector: [1], _source: { handle: "h", chunkIndex: 0 } }]));
    expect([e.code, e.status]).toEqual(["K9O_VECTOR_SUBJECT_ATTRIBUTION_REQUIRED", 400]);
  });
});
