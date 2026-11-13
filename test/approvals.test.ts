import { describe, expect, it } from "bun:test";
import { createClient, KError } from "../src/index.ts";

type Seen = { url: string; method: string; body?: unknown };

function client(data: unknown = {}, meta: Record<string, unknown> = {}, projectSlug: string | null = "portal") {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    seen.push({
      url: String(input),
      method: String(init?.method),
      ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}),
    });
    return new Response(JSON.stringify({ data, meta }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const c = createClient({ baseUrl: "https://acme.api.k9o.io", ...(projectSlug !== null ? { projectSlug } : {}), apiKey: "k", fetch: fetchImpl });
  return { c, seen };
}

const BASE = "https://acme.api.k9o.io/@portal";

const pending = {
  id: "apr_1", status: "pending_approval", collection: "orders", operation: "update", makerId: "usr_1",
  proposedPayload: { amount: 5 }, targetRecordId: "rec_1", approverId: null, decidedAt: null, decisionReason: null,
  createdAt: "2026-10-26T10:00:00.000Z", expiresAt: null,
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

describe("client.approvals", () => {
  it("list sends status and limit as query and returns the rows", async () => {
    const { c, seen } = client([pending]);
    const r = await c.approvals.list({ status: "pending_approval", limit: 20 });
    expect(r.data[0]!.id).toBe("apr_1");
    expect(seen).toEqual([{ method: "GET", url: `${BASE}/pending-approvals?status=pending_approval&limit=20` }]);
  });

  it("list without options sends no query", async () => {
    const { c, seen } = client([]);
    await c.approvals.list();
    expect(seen[0]!.url).toBe(`${BASE}/pending-approvals`);
  });

  it("list validates limit 1..200 before any request", async () => {
    const { c, seen } = client([]);
    for (const limit of [0, 201, 1.5, Number.NaN]) {
      expect((await rejects(c.approvals.list({ limit }))).code).toBe("K9O_INVALID_FIELD_VALUE");
    }
    await c.approvals.list({ limit: 200 });
    await c.approvals.list({ limit: 1 });
    expect(seen).toHaveLength(2);
  });

  it("get reads one change", async () => {
    const { c, seen } = client(pending);
    await c.approvals.get("apr_1");
    expect(seen).toEqual([{ method: "GET", url: `${BASE}/pending-approvals/apr_1` }]);
  });

  it("approve posts the optional reason and exposes a still-pending result", async () => {
    const { c, seen } = client(pending);
    const r = await c.approvals.approve("apr_1", { reason: "looks fine" });
    expect(r.data.status).toBe("pending_approval");
    await c.approvals.approve("apr_1");
    expect(seen).toEqual([
      { method: "POST", url: `${BASE}/pending-approvals/apr_1/approve`, body: { reason: "looks fine" } },
      { method: "POST", url: `${BASE}/pending-approvals/apr_1/approve`, body: {} },
    ]);
  });

  it("reject requires a non-empty reason client-side", async () => {
    const { c, seen } = client({ ...pending, status: "rejected" });
    for (const input of [{ reason: "" }, { reason: "   " }, {} as { reason: string }, undefined as unknown as { reason: string }]) {
      expect((await rejects(c.approvals.reject("apr_1", input))).code).toBe("K9O_INVALID_FIELD_VALUE");
    }
    expect(seen).toHaveLength(0);
    await c.approvals.reject("apr_1", { reason: "duplicate" });
    expect(seen).toEqual([{ method: "POST", url: `${BASE}/pending-approvals/apr_1/reject`, body: { reason: "duplicate" } }]);
  });

  it("id arguments are validated and encoded", async () => {
    const { c, seen } = client(pending);
    expect((await rejects(c.approvals.get(""))).code).toBe("K9O_INVALID_FIELD_VALUE");
    await c.approvals.get("a/b");
    expect(seen[0]!.url).toBe(`${BASE}/pending-approvals/a%2Fb`);
  });

  it("list pages with limit and cursor; meta.cursor.next is null on the last page", async () => {
    const replies = [
      { data: [pending], meta: { cursor: { next: "eyJ2IjoxLCJwIjoicHJval8xIn0" } } },
      { data: [{ ...pending, id: "apr_2" }], meta: { cursor: { next: null } } },
    ];
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 200 });
      seen.push(`${init?.method} ${String(input)}`);
      return new Response(JSON.stringify(replies[seen.length - 1]), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const c = createClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "portal", apiKey: "k", fetch: fetchImpl });
    const first = await c.approvals.list({ limit: 1 });
    expect(first.meta.cursor.next).toBe("eyJ2IjoxLCJwIjoicHJval8xIn0");
    const second = await c.approvals.list({ limit: 1, cursor: first.meta.cursor.next! });
    expect(second.data[0]!.id).toBe("apr_2");
    expect(second.meta.cursor.next).toBeNull();
    expect(seen).toEqual([
      `GET ${BASE}/pending-approvals?limit=1`,
      `GET ${BASE}/pending-approvals?limit=1&cursor=eyJ2IjoxLCJwIjoicHJval8xIn0`,
    ]);
  });

  it("an invalid cursor surfaces as K9O_INVALID_CURSOR (400)", async () => {
    const body = { code: "K9O_INVALID_CURSOR", message: "Cursor is malformed; omit it to start from the newest pending change", context: {}, recommendation: null };
    const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null, { status: 200 }) : new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
    const c = createClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "portal", apiKey: "k", fetch: fetchImpl });
    const e = await rejects(c.approvals.list({ cursor: "abc!" }));
    expect(e.code).toBe("K9O_INVALID_CURSOR");
    expect(e.status).toBe(400);
  });

  it("bulk exposes failed rows; HTTP 200 with a failed row", async () => {
    const result = {
      attestationId: "apr_Vf23zMoj7m0u", action: "approve", affectedCount: 1, affectedIds: ["apr_A"],
      failed: [{ id: "apr_B", code: "K9O_STATE_CONFLICT", reason: "Pending change 'apr_B' was decided concurrently" }], reason: null,
    };
    const { c, seen } = client(result);
    const criteria = { eq: ["change.table", "orders"] };
    const r = await c.approvals.bulk({ action: "approve", criteria });
    expect(r.data.affectedIds).toEqual(["apr_A"]);
    expect(r.data.failed).toEqual([{ id: "apr_B", code: "K9O_STATE_CONFLICT", reason: "Pending change 'apr_B' was decided concurrently" }]);
    expect(seen).toEqual([{ method: "POST", url: `${BASE}/pending-approvals/bulk`, body: { action: "approve", criteria } }]);
  });

  it("bulk with failed: [] decodes as empty, and an absent failed also decodes as empty", async () => {
    const base = { attestationId: "apr_Vf23zMoj7m0u", action: "reject", affectedCount: 0, affectedIds: [], reason: "probe: matches nothing" };
    const criteria = { eq: ["change.table", "__no_such_collection_probe__"] };
    const withEmpty = await client({ ...base, failed: [] }).c.approvals.bulk({ action: "reject", criteria, reason: "probe: matches nothing" });
    expect(withEmpty.data.failed).toEqual([]);
    const absent = client(base);
    const r = await absent.c.approvals.bulk({ action: "reject", criteria, reason: "probe: matches nothing" });
    expect(r.data.failed).toEqual([]);
    expect(absent.seen[0]).toEqual({ method: "POST", url: `${BASE}/pending-approvals/bulk`, body: { action: "reject", criteria, reason: "probe: matches nothing" } });
  });

  it("bulk sends action, criteria and reason", async () => {
    const result = { attestationId: "apr_x", action: "reject", affectedCount: 1, affectedIds: ["apr_1"], reason: "stale" };
    const { c, seen } = client(result);
    const criteria = { eq: ["change.table", "orders"] };
    const r = await c.approvals.bulk({ action: "reject", criteria, reason: "stale" });
    expect(r.data.affectedIds).toEqual(["apr_1"]);
    await c.approvals.bulk({ action: "approve", criteria });
    expect(seen).toEqual([
      { method: "POST", url: `${BASE}/pending-approvals/bulk`, body: { action: "reject", criteria, reason: "stale" } },
      { method: "POST", url: `${BASE}/pending-approvals/bulk`, body: { action: "approve", criteria } },
    ]);
  });

  it("bulk validates action, criteria and the reject reason", async () => {
    const { c, seen } = client({});
    const criteria = { eq: ["change.table", "orders"] };
    const bad: unknown[] = [
      { action: "delete", criteria },
      { action: "approve", criteria: null },
      { action: "approve", criteria: [criteria] },
      { action: "approve", criteria: "x" },
      { action: "approve" },
      { action: "reject", criteria },
      { action: "reject", criteria, reason: " " },
    ];
    for (const input of bad) {
      expect((await rejects(c.approvals.bulk(input as never))).code).toBe("K9O_INVALID_FIELD_VALUE");
    }
    expect(seen).toHaveLength(0);
  });

  it("needs a bound project", async () => {
    const { c } = client({}, {}, null);
    await expect(c.approvals.list()).rejects.toThrow(/projectSlug/);
  });
});

describe("client.approvalPolicies", () => {
  const policy = { id: "apo_1", collection: "orders", operation: "update", predicate: { gt: ["change.row.amount", 1000] }, action: "queue", authoredBy: "usr_1", createdAt: "2026-10-26T10:00:00.000Z" };

  it("list, create and delete use the policy routes", async () => {
    const { c, seen } = client(policy);
    await c.approvalPolicies.list();
    await c.approvalPolicies.create({ collection: "orders", operation: "update", action: "queue", predicate: policy.predicate });
    const d = await c.approvalPolicies.delete("apo_1");
    expect(d.data).toBeDefined();
    expect(seen).toEqual([
      { method: "GET", url: `${BASE}/approval-policies` },
      { method: "POST", url: `${BASE}/approval-policies`, body: { collection: "orders", operation: "update", action: "queue", predicate: policy.predicate } },
      { method: "DELETE", url: `${BASE}/approval-policies/apo_1` },
    ]);
  });

  it("create validates every field client-side", async () => {
    const { c, seen } = client({});
    const ok = { collection: "orders", operation: "insert", action: "auto_approve", predicate: { eq: ["maker.id", "u"] } } as const;
    const bad: unknown[] = [
      { ...ok, collection: "1orders" },
      { ...ok, collection: "a-b" },
      { ...ok, collection: "" },
      { ...ok, collection: "a".repeat(64) },
      { ...ok, operation: "upsert" },
      { ...ok, action: "block" },
      { ...ok, predicate: null },
      { ...ok, predicate: [] },
      { ...ok, predicate: "x" },
    ];
    for (const input of bad) {
      expect((await rejects(c.approvalPolicies.create(input as never))).code).toBe("K9O_INVALID_FIELD_VALUE");
    }
    expect(seen).toHaveLength(0);
    await c.approvalPolicies.create({ ...ok, collection: "a".repeat(63) });
    await c.approvalPolicies.create({ ...ok, collection: "_x1" });
    expect(seen).toHaveLength(2);
  });

  it("delete validates the id", async () => {
    const { c } = client({});
    expect((await rejects(c.approvalPolicies.delete(""))).code).toBe("K9O_INVALID_FIELD_VALUE");
  });
});

describe("client.schema.collections", () => {
  const row = { name: "orders", rowCount: 120, rowCountIsExact: true, columnCount: 8, indexCount: 3, lastMigrationSlug: "add_orders", lastMigrationAppliedAt: "2026-10-01T09:00:00.000Z" };

  it("list sends limit and cursor and returns meta.cursor", async () => {
    const { c, seen } = client([row], { cursor: { next: "b3JkZXJz", totalCount: null, countMethod: "none" } });
    const r = await c.schema.collections.list({ limit: 10, cursor: "abc" });
    expect(r.data[0]!.name).toBe("orders");
    expect((r.meta["cursor"] as { next: string }).next).toBe("b3JkZXJz");
    expect(seen).toEqual([{ method: "GET", url: `${BASE}/schema/collections?limit=10&cursor=abc` }]);
  });

  it("list with no options sends no query; limit is validated", async () => {
    const { c, seen } = client([]);
    await c.schema.collections.list();
    expect(seen[0]!.url).toBe(`${BASE}/schema/collections`);
    expect((await rejects(c.schema.collections.list({ limit: 201 }))).code).toBe("K9O_INVALID_FIELD_VALUE");
    expect(seen).toHaveLength(1);
  });
});

describe("client.approvals.comments", () => {
  const comment = {
    id: "acm_1", caseId: "apr_1", authorId: "usr_2", visibility: "approvers_only", body: "Check the amount",
    createdAt: "2026-11-13T10:00:00.000Z",
  };

  function raw(status: number, body: unknown) {
    const seen: Seen[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 200 });
      seen.push({
        url: String(input),
        method: String(init?.method),
        ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const c = createClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "portal", apiKey: "k", fetch: fetchImpl });
    return { c, seen };
  }

  it("add posts body and visibility and returns the comment", async () => {
    const { c, seen } = raw(201, { data: comment, meta: { requestId: "r1" } });
    const r = await c.approvals.comments.add("apr_1", { body: "Check the amount", visibility: "approvers_only" });
    expect(r.data).toEqual(comment);
    expect(r.meta).toEqual({ requestId: "r1" });
    expect(seen).toEqual([
      { method: "POST", url: `${BASE}/pending-approvals/apr_1/comments`, body: { body: "Check the amount", visibility: "approvers_only" } },
    ]);
  });

  it("add accepts 1 and 4000 characters and refuses 0 and 4001 before any request", async () => {
    const { c, seen } = raw(201, { data: comment, meta: {} });
    await c.approvals.comments.add("apr_1", { body: "a", visibility: "everyone" });
    await c.approvals.comments.add("apr_1", { body: "a".repeat(4000), visibility: "everyone" });
    expect(seen).toHaveLength(2);
    for (const body of ["", "a".repeat(4001), 5 as unknown as string]) {
      const e = await rejects(c.approvals.comments.add("apr_1", { body, visibility: "everyone" }));
      expect(e.code).toBe("K9O_INVALID_FIELD_VALUE");
    }
    expect(seen).toHaveLength(2);
  });

  it("add refuses a bad visibility, an empty id and a non-object input before any request", async () => {
    const { c, seen } = raw(201, { data: comment, meta: {} });
    for (const visibility of ["", "private", undefined, null]) {
      const e = await rejects(c.approvals.comments.add("apr_1", { body: "x", visibility: visibility as never }));
      expect(e.code).toBe("K9O_INVALID_FIELD_VALUE");
    }
    expect((await rejects(c.approvals.comments.add("", { body: "x", visibility: "everyone" }))).code).toBe("K9O_INVALID_FIELD_VALUE");
    expect((await rejects(c.approvals.comments.add("apr_1", null as never))).code).toBe("K9O_INVALID_FIELD_VALUE");
    expect(seen).toHaveLength(0);
  });

  it("add encodes the id in the path", async () => {
    const { c, seen } = raw(201, { data: comment, meta: {} });
    await c.approvals.comments.add("a/b", { body: "x", visibility: "everyone" });
    expect(seen[0]!.url).toBe(`${BASE}/pending-approvals/a%2Fb/comments`);
  });

  it("add maps the gateway errors to KError codes", async () => {
    for (const [status, code] of [[403, "K9O_APPROVAL_COMMENT_NOT_ELIGIBLE"], [409, "K9O_APPROVAL_COMMENT_CLOSED"], [404, "K9O_NOT_FOUND"], [403, "K9O_RBAC_DENY"]] as const) {
      const { c } = raw(status, { code, message: "m", context: { caseId: "apr_1" } });
      const e = await rejects(c.approvals.comments.add("apr_1", { body: "x", visibility: "everyone" }));
      expect(e.code).toBe(code);
    }
  });

  it("list sends limit and cursor and returns the page with nextCursor", async () => {
    const { c, seen } = raw(200, { data: [comment], nextCursor: "cur_2", meta: {} });
    const r = await c.approvals.comments.list("apr_1", { limit: 1, cursor: "cur_1" });
    expect(r.data[0]!.id).toBe("acm_1");
    expect(r.nextCursor).toBe("cur_2");
    expect(seen).toEqual([{ method: "GET", url: `${BASE}/pending-approvals/apr_1/comments?limit=1&cursor=cur_1` }]);
  });

  it("list without options sends no query and reads a null nextCursor", async () => {
    const { c, seen } = raw(200, { data: [], nextCursor: null, meta: {} });
    const r = await c.approvals.comments.list("apr_1");
    expect(r.nextCursor).toBeNull();
    expect(seen[0]!.url).toBe(`${BASE}/pending-approvals/apr_1/comments`);
  });

  it("list validates the id and limit 1..200 before any request", async () => {
    const { c, seen } = raw(200, { data: [], nextCursor: null, meta: {} });
    expect((await rejects(c.approvals.comments.list(""))).code).toBe("K9O_INVALID_FIELD_VALUE");
    for (const limit of [0, 201, 1.5, Number.NaN]) {
      expect((await rejects(c.approvals.comments.list("apr_1", { limit }))).code).toBe("K9O_INVALID_FIELD_VALUE");
    }
    expect(seen).toHaveLength(0);
    await c.approvals.comments.list("apr_1", { limit: 200 });
    expect(seen).toHaveLength(1);
  });

  it("list maps 403 and 404 errors", async () => {
    const { c } = raw(404, { code: "K9O_NOT_FOUND", message: "m", context: {} });
    expect((await rejects(c.approvals.comments.list("apr_9"))).code).toBe("K9O_NOT_FOUND");
  });
});
