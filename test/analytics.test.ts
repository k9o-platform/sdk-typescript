/** client.analytics and client.rollups: every route's method, path, query, body and decoding, against a stubbed transport. */
import { describe, expect, it } from "bun:test";
import { createClient, KError, type RollupCellEvent } from "../src/index.ts";

type Seen = { method: string; path: string; query: Record<string, string>; json: unknown; form: FormData | null; text: string | undefined; headers: Headers };

function harness(handler: (seen: Seen) => Response, projectSlug: string | null = "portal") {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    const url = new URL(String(input));
    const body = init?.body;
    let text: string | undefined;
    let jsonBody: unknown;
    if (typeof body === "string") {
      text = body;
      try {
        jsonBody = JSON.parse(body);
      } catch {
        /* not JSON */
      }
    } else if (body instanceof Uint8Array) {
      text = new TextDecoder().decode(body);
    }
    const s: Seen = {
      method: String(init?.method),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      json: jsonBody,
      form: body instanceof FormData ? body : null,
      text,
      headers: new Headers(init?.headers as HeadersInit),
    };
    seen.push(s);
    return handler(s);
  }) as unknown as typeof globalThis.fetch;
  const c = createClient({ baseUrl: "https://acme.api.k9o.io", ...(projectSlug !== null ? { projectSlug } : {}), apiKey: "tok", fetch: fetchImpl });
  return { c, seen };
}

const ok = (data: unknown, meta: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ data, meta }), { status: 200, headers: { "content-type": "application/json" } });
const err = (status: number, code: string, context: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ code, message: code, context }), { status, headers: { "content-type": "application/json" } });

async function caught(p: Promise<unknown>): Promise<KError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(KError);
    return e as KError;
  }
  throw new Error("expected a rejection");
}

const BASE = "/@portal/analytics";
const NEW_DATASET = {
  displayName: "Orders",
  columns: [{ name: "order_id", type: "string" }, { name: "amount", type: "decimal(12,2)" }, { name: "placed_at", type: "timestamp" }],
  partitionBy: ["placed_at:day"],
  residencyClass: "shared" as const,
};

describe("analytics: datasets", () => {
  it("list GETs /analytics and returns the datasets", async () => {
    const { c, seen } = harness(() => ok([{ slug: "orders", displayName: "Orders" }]));
    const r = await c.analytics.list();
    expect([seen[0]!.method, seen[0]!.path]).toEqual(["GET", BASE]);
    expect(r.data[0]!.slug).toBe("orders");
  });

  it("create POSTs the body to /analytics/<slug>", async () => {
    const { c, seen } = harness(() => ok({ slug: "orders", endpoints: { read: "x" } }));
    const r = await c.analytics.create("orders", { ...NEW_DATASET, storageTarget: { kind: "managed" } });
    expect([seen[0]!.method, seen[0]!.path]).toEqual(["POST", `${BASE}/orders`]);
    expect(seen[0]!.json).toEqual({ ...NEW_DATASET, storageTarget: { kind: "managed" } });
    expect(r.data.endpoints).toEqual({ read: "x" });
  });

  it("create checks the shape before sending", async () => {
    const { c, seen } = harness(() => ok({}));
    await expect(c.analytics.create("", NEW_DATASET)).rejects.toThrow(TypeError);
    await expect(c.analytics.create("orders", { ...NEW_DATASET, columns: [] })).rejects.toThrow(/columns/);
    await expect(c.analytics.create("orders", { ...NEW_DATASET, columns: [{ name: "a", type: "varchar" }] })).rejects.toThrow(/column type/);
    await expect(c.analytics.create("orders", { ...NEW_DATASET, residencyClass: "regional" as never })).rejects.toThrow(/residencyClass/);
    expect(seen).toHaveLength(0);
  });

  it("create surfaces 429 K9O_DATASET_LIMIT_EXCEEDED and 409 K9O_STATE_CONFLICT", async () => {
    const full = harness(() => err(429, "K9O_DATASET_LIMIT_EXCEEDED"));
    expect((await caught(full.c.analytics.create("orders", NEW_DATASET))).code).toBe("K9O_DATASET_LIMIT_EXCEEDED");
    const once = harness(() => err(409, "K9O_STATE_CONFLICT"));
    expect((await caught(once.c.analytics.create("orders", NEW_DATASET))).status).toBe(409);
  });

  it("get and delete use the slug in the path (encoded)", async () => {
    const { c, seen } = harness((s) => (s.method === "DELETE" ? ok({ slug: "orders", status: "retired" }) : ok({ slug: "orders" })));
    expect((await c.analytics.get("orders")).data.slug).toBe("orders");
    const del = await c.analytics.delete("orders");
    expect(del.data).toEqual({ slug: "orders", status: "retired" });
    expect(seen.map((s) => [s.method, s.path])).toEqual([["GET", `${BASE}/orders`], ["DELETE", `${BASE}/orders`]]);
    await c.analytics.get("a b");
    expect(seen[2]!.path).toBe(`${BASE}/a%20b`);
  });

  it("get surfaces 404 K9O_DATASET_NOT_FOUND; delete of a platform dataset 403", async () => {
    const { c } = harness((s) => (s.method === "GET" ? err(404, "K9O_DATASET_NOT_FOUND") : err(403, "K9O_FORBIDDEN")));
    expect((await caught(c.analytics.get("nope"))).code).toBe("K9O_DATASET_NOT_FOUND");
    expect((await caught(c.analytics.delete("telemetry"))).status).toBe(403);
  });
});

describe("analytics: query, read, write, materialize", () => {
  it("query POSTs { sql, datasets } to /analytics/query", async () => {
    const { c, seen } = harness(() => ok([{ n: 3 }]));
    const r = await c.analytics.query({ sql: "SELECT count(*) AS n FROM dataset.orders", datasets: ["orders"] });
    expect([seen[0]!.method, seen[0]!.path]).toEqual(["POST", `${BASE}/query`]);
    expect(seen[0]!.json).toEqual({ sql: "SELECT count(*) AS n FROM dataset.orders", datasets: ["orders"] });
    expect(r.data).toEqual([{ n: 3 }]);
  });

  it("query checks sql and datasets, and surfaces 400, 500 and 503", async () => {
    const { c, seen } = harness(() => ok([]));
    await expect(c.analytics.query({ sql: "", datasets: ["a"] })).rejects.toThrow(TypeError);
    await expect(c.analytics.query({ sql: "x".repeat(100_001), datasets: ["a"] })).rejects.toThrow(TypeError);
    await expect(c.analytics.query({ sql: "SELECT 1", datasets: [] })).rejects.toThrow(TypeError);
    await expect(c.analytics.query({ sql: "SELECT 1", datasets: Array.from({ length: 65 }, (_, i) => `d${i}`) })).rejects.toThrow(TypeError);
    expect(seen).toHaveLength(0);
    for (const [status, code] of [[400, "K9O_QUERY_INVALID"], [500, "K9O_QUERY_EXECUTION_FAILED"], [503, "K9O_ANALYTICS_UNAVAILABLE"]] as const) {
      const h = harness(() => err(status, code));
      expect((await caught(h.c.analytics.query({ sql: "SELECT 1", datasets: ["a"] }))).code).toBe(code);
    }
  });

  it("read POSTs the page options and returns the cursor in meta", async () => {
    const { c, seen } = harness(() => ok([{ _k9o_row_id: "r1", order_id: "A-1" }], { cursor: { next: "cur-2" }, schema: [{ name: "order_id", type: "string" }] }));
    const page = await c.analytics.read("orders", { partitionFilter: { region: "de01" }, cursor: "cur-1", limit: 50 });
    expect([seen[0]!.method, seen[0]!.path]).toEqual(["POST", `${BASE}/orders/read`]);
    expect(seen[0]!.json).toEqual({ partitionFilter: { region: "de01" }, cursor: "cur-1", limit: 50 });
    expect(page.data[0]!._k9o_row_id).toBe("r1");
    expect(page.meta.cursor.next).toBe("cur-2");
    expect(page.meta["schema"]).toBeDefined();
  });

  it("read sends an empty body by default, pages until the cursor is null, and refuses a bad limit", async () => {
    const pages = [ok([{ _k9o_row_id: "r1" }], { cursor: { next: "c2" } }), ok([{ _k9o_row_id: "r2" }], { cursor: { next: null } })];
    const { c, seen } = harness(() => pages.shift()!);
    const rows: string[] = [];
    let cursor: string | undefined;
    do {
      const p = await c.analytics.read("orders", cursor !== undefined ? { cursor } : {});
      rows.push(...p.data.map((r) => r._k9o_row_id!));
      cursor = p.meta.cursor.next ?? undefined;
    } while (cursor !== undefined);
    expect(rows).toEqual(["r1", "r2"]);
    expect(seen.map((s) => s.json)).toEqual([{}, { cursor: "c2" }]);
    await expect(c.analytics.read("orders", { limit: 0 })).rejects.toThrow(TypeError);
  });

  it("read surfaces 400 K9O_ANALYTICS_READ_INVALID and 404", async () => {
    expect((await caught(harness(() => err(400, "K9O_ANALYTICS_READ_INVALID")).c.analytics.read("orders"))).code).toBe("K9O_ANALYTICS_READ_INVALID");
    expect((await caught(harness(() => err(404, "K9O_DATASET_NOT_FOUND")).c.analytics.read("orders"))).status).toBe(404);
  });

  it("write sends an array as a JSON body, with onError in the query", async () => {
    const { c, seen } = harness(() => ok({ ingested: 2, skipped: 1, skippedDetails: [{ row: 3 }] }));
    const r = await c.analytics.write("orders", [{ order_id: "A-1" }, { order_id: "A-2" }], { onError: "reject" });
    expect([seen[0]!.method, seen[0]!.path, seen[0]!.query]).toEqual(["POST", `${BASE}/orders/write`, { onError: "reject" }]);
    expect(seen[0]!.json).toEqual([{ order_id: "A-1" }, { order_id: "A-2" }]);
    expect(seen[0]!.headers.get("content-type")).toBe("application/json");
    expect(r.data.ingested).toBe(2);
    expect(r.data.skipped).toBe(1);
  });

  it("write sends a string as NDJSON bytes, and checks its input", async () => {
    const { c, seen } = harness(() => ok({ ingested: 2 }));
    await c.analytics.write("orders", '{"order_id":"A-1"}\n{"order_id":"A-2"}\n');
    expect(seen[0]!.text).toBe('{"order_id":"A-1"}\n{"order_id":"A-2"}\n');
    expect(seen[0]!.headers.get("content-type")).toBe("application/x-ndjson");
    expect(seen[0]!.query).toEqual({});
    await expect(c.analytics.write("orders", [])).rejects.toThrow(TypeError);
    await expect(c.analytics.write("orders", "  ")).rejects.toThrow(TypeError);
    await expect(c.analytics.write("orders", [{ a: 1 }], { onError: "ignore" as never })).rejects.toThrow(TypeError);
    expect(seen).toHaveLength(1);
  });

  it("write surfaces 400 parse failure and 503 unavailable", async () => {
    expect((await caught(harness(() => err(400, "K9O_INGEST_PARSE_FAILED")).c.analytics.write("o", [{ a: 1 }]))).code).toBe("K9O_INGEST_PARSE_FAILED");
    expect((await caught(harness(() => err(503, "K9O_ANALYTICS_UNAVAILABLE")).c.analytics.write("o", [{ a: 1 }], { onError: "reject" }))).status).toBe(503);
  });

  it("materialize sends exactly one source", async () => {
    const { c, seen } = harness(() => ok({ rowsRead: 10, ingested: 9, rejected: 1 }));
    const r = await c.analytics.materialize("orders", { fromCollection: "orders_raw" });
    await c.analytics.materialize("orders", { fromQuery: "stq_1" });
    expect([seen[0]!.method, seen[0]!.path, seen[0]!.json]).toEqual(["POST", `${BASE}/orders/materialize`, { fromCollection: "orders_raw" }]);
    expect(seen[1]!.json).toEqual({ fromQuery: "stq_1" });
    expect(r.data).toEqual({ rowsRead: 10, ingested: 9, rejected: 1 });
    await expect(c.analytics.materialize("orders", {} as never)).rejects.toThrow(/exactly one/);
    await expect(c.analytics.materialize("orders", { fromCollection: "a", fromQuery: "b" } as never)).rejects.toThrow(/exactly one/);
    expect(seen).toHaveLength(2);
  });

  it("materialize surfaces 400 K9O_DATASET_RESIDENCY_SOURCE_MISMATCH", async () => {
    const h = harness(() => err(400, "K9O_DATASET_RESIDENCY_SOURCE_MISMATCH"));
    expect((await caught(h.c.analytics.materialize("orders", { fromCollection: "people" }))).code).toBe("K9O_DATASET_RESIDENCY_SOURCE_MISMATCH");
  });
});

describe("analytics: upload and download", () => {
  it("upload sends multipart with the file and the options in the query", async () => {
    const { c, seen } = harness(() => ok({ ingested: 2, skipped: 0 }));
    const r = await c.analytics.upload("orders", "order_id;amount\nA-1;5\nA-2;7\n", { format: "csv", delimiter: ";", hasHeader: true, encoding: "utf-8", onError: "skip" });
    const s = seen[0]!;
    expect([s.method, s.path]).toEqual(["POST", `${BASE}/orders/upload`]);
    expect(s.query).toEqual({ format: "csv", onError: "skip", delimiter: ";", encoding: "utf-8", hasHeader: "true" });
    expect(s.form).not.toBeNull();
    const file = s.form!.get("file") as File;
    expect(file.name).toBe("upload.csv");
    expect(await file.text()).toBe("order_id;amount\nA-1;5\nA-2;7\n");
    expect(s.form!.get("manifest")).toBeNull();
    expect(r.data.ingested).toBe(2);
  });

  it("upload sends dryRun and a manifest that creates the dataset", async () => {
    const { c, seen } = harness(() => ok({ columns: [{ name: "order_id", type: "string" }], preview: [] }));
    await c.analytics.upload("fresh", new TextEncoder().encode('[{"order_id":"A-1"}]'), { format: "json", dryRun: true, manifest: NEW_DATASET, fileName: "orders.json" });
    const s = seen[0]!;
    expect(s.query).toEqual({ format: "json", dryRun: "true" });
    expect((s.form!.get("file") as File).name).toBe("orders.json");
    expect(JSON.parse(String(s.form!.get("manifest")))).toEqual(NEW_DATASET);
  });

  it("upload checks format and manifest before sending, and surfaces 429 and 400", async () => {
    const { c, seen } = harness(() => ok({}));
    await expect(c.analytics.upload("orders", "x", {} as never)).rejects.toThrow(/format/);
    await expect(c.analytics.upload("orders", "x", { format: "xml" as never })).rejects.toThrow(/format/);
    await expect(c.analytics.upload("orders", "x", { format: "csv", manifest: { ...NEW_DATASET, columns: [] } })).rejects.toThrow(/columns/);
    expect(seen).toHaveLength(0);
    expect((await caught(harness(() => err(429, "K9O_DATASET_LIMIT_EXCEEDED")).c.analytics.upload("n", "a", { format: "csv" }))).status).toBe(429);
    expect((await caught(harness(() => err(400, "K9O_INGEST_PARSE_FAILED")).c.analytics.upload("n", "a", { format: "csv" }))).code).toBe("K9O_INGEST_PARSE_FAILED");
  });

  it("downloadOriginal returns the bytes, content type and file name, not an envelope", async () => {
    const bytes = new Uint8Array([111, 114, 100, 101, 114, 10, 0, 255]);
    const { c, seen } = harness(() => new Response(bytes, { status: 200, headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="orders.csv"' } }));
    const f = await c.analytics.downloadOriginal("orders");
    expect([seen[0]!.method, seen[0]!.path]).toEqual(["GET", `${BASE}/orders/upload/original`]);
    expect(seen[0]!.headers.get("accept")).toBe("*/*");
    expect(Array.from(f.bytes)).toEqual(Array.from(bytes));
    expect(f.contentType).toBe("text/csv");
    expect(f.fileName).toBe("orders.csv");
  });

  it("downloadOriginal surfaces 404 when none is stored, and 503", async () => {
    expect((await caught(harness(() => err(404, "K9O_NOT_FOUND")).c.analytics.downloadOriginal("orders"))).status).toBe(404);
    expect((await caught(harness(() => err(503, "K9O_ANALYTICS_UNAVAILABLE")).c.analytics.downloadOriginal("orders"))).code).toBe("K9O_ANALYTICS_UNAVAILABLE");
  });
});

describe("analytics.rollups", () => {
  const input = {
    slug: "orders_per_hour", source: "orders_stream", dimensions: ["country"],
    measures: [{ name: "n", agg: "count" }, { name: "total", agg: "sum", column: "amount" }], windowSeconds: 3600, nonPersonal: true, reattestIntervalDays: 30 as const,
  };

  it("create POSTs the rollup with nonPersonal", async () => {
    const { c, seen } = harness(() => ok({ id: "rol_1", slug: "orders_per_hour", endpoints: { read: "r", subscribe: "s" } }));
    const r = await c.analytics.rollups.create("orders", input);
    expect([seen[0]!.method, seen[0]!.path]).toEqual(["POST", `${BASE}/orders/rollups`]);
    expect(seen[0]!.json).toEqual(input);
    expect(r.data.id).toBe("rol_1");
  });

  it("create sends subjectField for per-subject data", async () => {
    const { c, seen } = harness(() => ok({ id: "rol_2" }));
    const { nonPersonal: _n, ...rest } = input;
    await c.analytics.rollups.create("orders", { ...rest, subjectField: "customer_id" });
    expect(seen[0]!.json).toEqual({ ...rest, subjectField: "customer_id" });
  });

  it("create checks the shape and surfaces 409 K9O_ALREADY_EXISTS", async () => {
    const { c, seen } = harness(() => ok({}));
    await expect(c.analytics.rollups.create("orders", { ...input, nonPersonal: undefined })).rejects.toThrow(/exactly one/);
    await expect(c.analytics.rollups.create("orders", { ...input, subjectField: "customer_id" })).rejects.toThrow(/exactly one/);
    await expect(c.analytics.rollups.create("orders", { ...input, windowSeconds: 30 })).rejects.toThrow(/windowSeconds/);
    await expect(c.analytics.rollups.create("orders", { ...input, measures: [] })).rejects.toThrow(/measures/);
    await expect(c.analytics.rollups.create("orders", { ...input, reattestIntervalDays: 14 as never })).rejects.toThrow(/reattestIntervalDays/);
    await expect(c.analytics.rollups.create("orders", { ...input, dimensions: Array.from({ length: 17 }, (_, i) => `d${i}`) })).rejects.toThrow(/dimensions/);
    expect(seen).toHaveLength(0);
    expect((await caught(harness(() => err(409, "K9O_ALREADY_EXISTS")).c.analytics.rollups.create("orders", input))).code).toBe("K9O_ALREADY_EXISTS");
  });

  it("list, delete and reattest hit their routes and decode the attestation state", async () => {
    const { c, seen } = harness((s) =>
      s.method === "DELETE" ? ok({ id: "rol_1", deleted: true })
      : s.method === "POST" ? ok({ id: "rol_1", expiresAt: "2027-01-25T00:00:00.000Z", attestationStatus: "active" })
      : ok({ rollups: [{ id: "rol_1", attestedAt: "2026-10-27T00:00:00.000Z", expiresAt: "2026-11-26T00:00:00.000Z", attestationStatus: "expiring_soon" }] }));
    const list = await c.analytics.rollups.list("orders");
    expect(list.data.rollups[0]!.attestationStatus).toBe("expiring_soon");
    expect((await c.analytics.rollups.delete("orders", "rol_1")).data).toEqual({ id: "rol_1", deleted: true });
    const re = await c.analytics.rollups.reattest("orders", "rol_1", { reattestIntervalDays: 90 });
    await c.analytics.rollups.reattest("orders", "rol_1");
    expect(re.data.attestationStatus).toBe("active");
    expect(seen.map((s) => [s.method, s.path])).toEqual([
      ["GET", `${BASE}/orders/rollups`], ["DELETE", `${BASE}/orders/rollups/rol_1`],
      ["POST", `${BASE}/orders/rollups/rol_1/reattest`], ["POST", `${BASE}/orders/rollups/rol_1/reattest`],
    ]);
    expect(seen[2]!.json).toEqual({ reattestIntervalDays: 90 });
    expect(seen[3]!.json).toEqual({});
  });

  it("reattest checks the interval and passes the human-only refusal through untouched", async () => {
    const h = harness(() => err(403, "K9O_RBAC_DENY", { reason: "human_only" }));
    const e = await caught(h.c.analytics.rollups.reattest("orders", "rol_1"));
    expect([e.status, e.code, e.context["reason"]]).toEqual([403, "K9O_RBAC_DENY", "human_only"]);
    expect(h.seen).toHaveLength(1); // the SDK does not pre-judge the token
    await expect(h.c.analytics.rollups.reattest("orders", "rol_1", { reattestIntervalDays: 8 as never })).rejects.toThrow(TypeError);
    expect(h.seen).toHaveLength(1);
  });
});

describe("analytics.schedules", () => {
  it("create POSTs the schedule", async () => {
    const { c, seen } = harness(() => ok({ id: "sch_1", nextRunAt: "2026-10-27T13:00:00.000Z" }));
    const r = await c.analytics.schedules.create("orders", { fromCollection: "orders_raw", intervalSeconds: 3600, reattestIntervalDays: 7 });
    expect([seen[0]!.method, seen[0]!.path]).toEqual(["POST", `${BASE}/orders/schedules`]);
    expect(seen[0]!.json).toEqual({ fromCollection: "orders_raw", intervalSeconds: 3600, reattestIntervalDays: 7 });
    expect(r.data.id).toBe("sch_1");
  });

  it("create checks the shape and surfaces 409", async () => {
    const { c, seen } = harness(() => ok({}));
    await expect(c.analytics.schedules.create("orders", { fromCollection: "a", intervalSeconds: 59 })).rejects.toThrow(/intervalSeconds/);
    await expect(c.analytics.schedules.create("orders", { fromCollection: "", intervalSeconds: 60 })).rejects.toThrow(/fromCollection/);
    await expect(c.analytics.schedules.create("orders", { fromCollection: "a", intervalSeconds: 60, reattestIntervalDays: 1 as never })).rejects.toThrow(TypeError);
    expect(seen).toHaveLength(0);
    expect((await caught(harness(() => err(409, "K9O_PENDING_CHANGE_ALREADY_EXISTS")).c.analytics.schedules.create("orders", { fromCollection: "a", intervalSeconds: 60 }))).status).toBe(409);
  });

  it("list, delete and reattest hit their routes and decode the run state", async () => {
    const { c, seen } = harness((s) =>
      s.method === "DELETE" ? ok({ id: "sch_1", deleted: true })
      : s.method === "POST" ? ok({ id: "sch_1", attestationStatus: "active" })
      : ok({ schedules: [{ id: "sch_1", lastRunAt: "2026-10-27T12:00:00.000Z", lastRunStatus: "ok", nextRunAt: "2026-10-27T13:00:00.000Z", attestedAt: "x", expiresAt: "y", attestationStatus: "active" }] }));
    const list = await c.analytics.schedules.list("orders");
    expect([list.data.schedules[0]!.lastRunStatus, list.data.schedules[0]!.nextRunAt]).toEqual(["ok", "2026-10-27T13:00:00.000Z"]);
    expect((await c.analytics.schedules.delete("orders", "sch_1")).data).toEqual({ id: "sch_1", deleted: true });
    await c.analytics.schedules.reattest("orders", "sch_1", { reattestIntervalDays: 365 });
    expect(seen.map((s) => [s.method, s.path])).toEqual([
      ["GET", `${BASE}/orders/schedules`], ["DELETE", `${BASE}/orders/schedules/sch_1`], ["POST", `${BASE}/orders/schedules/sch_1/reattest`],
    ]);
    expect(seen[2]!.json).toEqual({ reattestIntervalDays: 365 });
  });

  it("reattest passes the human-only refusal through", async () => {
    const e = await caught(harness(() => err(403, "K9O_RBAC_DENY", { reason: "human_only" })).c.analytics.schedules.reattest("orders", "sch_1"));
    expect([e.code, e.context["reason"]]).toEqual(["K9O_RBAC_DENY", "human_only"]);
  });
});

describe("rollups", () => {
  it("list GETs /rollups", async () => {
    const { c, seen } = harness(() => ok({ rollups: [{ slug: "orders_per_hour", endpoints: { read: "r" } }] }));
    const r = await c.rollups.list();
    expect([seen[0]!.method, seen[0]!.path]).toEqual(["GET", "/@portal/rollups"]);
    expect(r.data.rollups[0]!.slug).toBe("orders_per_hour");
  });

  it("read sends from, to and dims in the query and decodes suppressed cells and coverage", async () => {
    const cells = [{ window: "2026-10-27T10:00:00Z", n: 12 }, { status: "suppressed", reason: "cohort_below_k" }];
    const { c, seen } = harness(() => ok({ rollup: { slug: "orders_per_hour" }, k: 10, cells, coverage: { complete: true } }));
    const r = await c.rollups.read("orders_per_hour", { from: new Date("2026-10-27T00:00:00Z"), to: "2026-10-27T12:00:00Z", dims: ["country", "channel"] });
    expect([seen[0]!.method, seen[0]!.path]).toEqual(["GET", "/@portal/rollups/orders_per_hour/read"]);
    expect(seen[0]!.query).toEqual({ from: "2026-10-27T00:00:00.000Z", to: "2026-10-27T12:00:00Z", dims: "country,channel" });
    expect(r.data.cells![1]).toEqual({ status: "suppressed", reason: "cohort_below_k" });
    expect(r.data.coverage).toEqual({ complete: true });
    expect(r.data.k).toBe(10);
    await c.rollups.read("orders_per_hour");
    expect(seen[1]!.query).toEqual({});
  });

  it("read surfaces 400, 404, 409, 500 and 503", async () => {
    for (const [status, code] of [[400, "K9O_INVALID_FIELD_VALUE"], [404, "K9O_NOT_FOUND"], [409, "K9O_STATE_CONFLICT"], [500, "K9O_QUERY_EXECUTION_FAILED"], [503, "K9O_ANALYTICS_UNAVAILABLE"]] as const) {
      const e = await caught(harness(() => err(status, code)).c.rollups.read("r"));
      expect([e.status, e.code]).toEqual([status, code]);
    }
  });

  it("needs projectSlug on the client", async () => {
    const { c } = harness(() => ok([]), null);
    await expect(c.rollups.list()).rejects.toThrow(/projectSlug/);
    await expect(c.analytics.list()).rejects.toThrow(/projectSlug/);
  });
});

describe("rollups.subscribe", () => {
  const enc = new TextEncoder();
  // A frame as the gateway sends it: the SSE id is the resume cursor, `eventId` drops a re-sent cell, the cell is the payload.
  const cell = (id: string, extra: Record<string, unknown> = {}, cursor = `cur_${id}`) =>
    `id: ${cursor}\nevent: cell\ndata: ${JSON.stringify({
      topic: "rollups.orders_per_hour", eventType: "cell",
      payload: { cellKey: "k1", bucket: "2026-10-27T10:00:00Z", dims: { region: "eu" }, final: true, measures: { n: 1 }, ...extra },
      occurredAt: "2026-10-27T10:05:00.000Z", eventId: id,
    })}\n\n`;

  function sse(scripts: Array<{ text?: string; status?: number; hang?: boolean }>) {
    const conns: Array<{ path: string; query: Record<string, string>; lastEventId: string | null }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers["accept"] !== "text/event-stream") return new Response("", { status: 200 });
      const url = new URL(String(input));
      conns.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), lastEventId: headers["last-event-id"] ?? null });
      const s = scripts[conns.length - 1] ?? { hang: true };
      if ((s.status ?? 200) !== 200) return new Response(JSON.stringify({ code: "K9O_SUBSCRIPTION_LIMIT_EXCEEDED", message: "x", context: {} }), { status: s.status, headers: { "content-type": "application/json" } });
      const stream = new ReadableStream<Uint8Array>({
        start(ctl) {
          if (s.text) ctl.enqueue(enc.encode(s.text));
          if (!s.hang) ctl.close();
          else init?.signal?.addEventListener("abort", () => ctl.error(new DOMException("aborted", "AbortError")), { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof globalThis.fetch;
    return { conns, c: createClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "portal", apiKey: "tok", fetch: fetchImpl }) };
  }

  async function take(sub: AsyncIterable<RollupCellEvent> & { close(): void }, n: number): Promise<RollupCellEvent[]> {
    const out: RollupCellEvent[] = [];
    for await (const e of sub) {
      out.push(e);
      if (out.length === n) sub.close();
    }
    return out;
  }

  it("yields cell events, skipping heartbeats and other event names, and sends fromSequence on the first connection", async () => {
    const { c, conns } = sse([{ text: `retry: 10\n:hb\n\nevent: heartbeat\ndata: {}\n\n${cell("evt_a")}${cell("evt_b", { measures: { n: 2 } })}` }]);
    const got = await take(c.rollups.subscribe("orders_per_hour", { fromSequence: 40, retryDelayMs: 5 }), 2);
    expect(got.map((e) => [e.eventId, e.eventType, e.payload.measures, e.suppressed])).toEqual([["evt_a", "cell", { n: 1 }, false], ["evt_b", "cell", { n: 2 }, false]]);
    expect(got[0]!.payload).toEqual({ cellKey: "k1", bucket: "2026-10-27T10:00:00Z", dims: { region: "eu" }, final: true, measures: { n: 1 } });
    expect(conns[0]!.path).toBe("/@portal/rollups/orders_per_hour/subscribe");
    expect(conns[0]!.query).toEqual({ fromSequence: "40" });
  });

  it("reconnects with Last-Event-ID, drops a resent cell and calls onResync, then carries on", async () => {
    const resyncs: string[] = [];
    const { c, conns } = sse([
      { text: cell("evt_a") },
      { text: cell("evt_a") + cell("evt_b") + `event: resync\ndata: {"reason":"cursor-unknown","action":"reread-source"}\n\n` },
      { text: cell("evt_c") },
    ]);
    const got = await take(c.rollups.subscribe("orders_per_hour", { retryDelayMs: 5, fromSequence: 7, onResync: (r) => void resyncs.push(r.action) }), 3);
    expect(got.map((e) => e.eventId)).toEqual(["evt_a", "evt_b", "evt_c"]);
    expect(conns[1]!.lastEventId).toBe("cur_evt_a"); // the SSE id, not the eventId
    expect(conns[1]!.query).toEqual({}); // fromSequence applies to the first connection only
    expect(conns[2]!.lastEventId).toBeNull();
    expect(resyncs).toEqual(["reread-source"]);
  });

  it("yields a suppressed cell with the typed flag and no values", async () => {
    const sup = `id: 5\nevent: cell\ndata: ${JSON.stringify({ topic: "rollups.lookout-kanon", eventType: "cell", payload: { cellKey: "k9", bucket: "2026-10-27T10:00:00Z", dims: {}, status: "suppressed", reason: "cohort_below_k" }, occurredAt: "t", eventId: "evt_s" })}\n\n`;
    const { c } = sse([{ text: sup }]);
    const got = await take(c.rollups.subscribe("lookout-kanon", { retryDelayMs: 5 }), 1);
    expect(got[0]!.suppressed).toBe(true);
    expect([got[0]!.payload.status, got[0]!.payload.reason, got[0]!.payload.measures]).toEqual(["suppressed", "cohort_below_k", undefined]);
    expect(got[0]!.eventId).toBe("evt_s");
  });

  it("resumes from the frame id and drops a cell the resume re-sends (by eventId, even under a new cursor)", async () => {
    const { c, conns } = sse([{ text: cell("evt_a", {}, "100-1") + cell("evt_b", {}, "100-2") }, { text: cell("evt_b", {}, "101-1") + cell("evt_c", {}, "101-2") }]);
    const got = await take(c.rollups.subscribe("orders_per_hour", { retryDelayMs: 5 }), 3);
    expect(got.map((e) => e.eventId)).toEqual(["evt_a", "evt_b", "evt_c"]);
    expect(conns[1]!.lastEventId).toBe("100-2");
  });

  it("throws a 429 once", async () => {
    const { c, conns } = sse([{ status: 429 }]);
    const e = await caught(take(c.rollups.subscribe("r", { retryDelayMs: 5 }), 1));
    expect([e.status, e.code]).toEqual([429, "K9O_SUBSCRIPTION_LIMIT_EXCEEDED"]);
    expect(conns).toHaveLength(1);
  });
});
