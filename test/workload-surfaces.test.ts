import { describe, expect, it } from "bun:test";
import { createClient, isQueuedWrite, KError, type PendingChange } from "../src/index.ts";

type Seen = { url: string; method: string; body?: unknown };
type Reply = { status?: number; body?: unknown };

function client(reply: Reply | ((seen: Seen) => Reply) = {}) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    const entry: Seen = {
      url: String(input),
      method: String(init?.method),
      ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}),
    };
    seen.push(entry);
    const r = typeof reply === "function" ? reply(entry) : reply;
    const status = r.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(r.body ?? { data: null, meta: {} }), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const c = createClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "portal", apiKey: "k", fetch: fetchImpl });
  return { c, seen };
}

const BASE = "https://acme.api.k9o.io/@portal";
const META = { cost: {}, timing: {}, context: { requestId: "req_1", traceId: "req_1", projectId: "proj_1" } };

async function rejects(p: PromiseLike<unknown>): Promise<KError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(KError);
    return e as KError;
  }
  throw new Error("expected a rejection");
}

// Live-confirmed queued insert (202).
const queuedInsert = {
  data: {
    id: "apr_5oLshD2MVT27",
    status: "pending_approval",
    collection: "conformance_kv",
    operation: "insert",
    makerId: "usr_conformance0001",
    proposedPayload: { id: "contract2-probe-0001", val: "contract2-probe" },
    targetRecordId: null,
  },
  meta: { ...META, approval: { status: "pending_approval" } },
};

type Kv = { id: string; val: string };

describe("requireApproval on single-record writes", () => {
  it("insert without the modifier sends no query and returns the row", async () => {
    const { c, seen } = client({ status: 201, body: { data: { id: "a", val: "b" }, meta: META } });
    const r = await c.from("conformance_kv").insert<Kv>({ id: "a", val: "b" });
    expect(r.data.id).toBe("a");
    expect(seen).toEqual([{ method: "POST", url: `${BASE}/data/conformance_kv`, body: { id: "a", val: "b" } }]);
  });

  it("insert .requireApproval() sends ?requireApproval=true and a 202 types as the queued change", async () => {
    const { c, seen } = client({ status: 202, body: queuedInsert });
    const r = await c.from("conformance_kv").insert<Kv>({ id: "contract2-probe-0001", val: "contract2-probe" }).requireApproval();
    expect(seen).toEqual([{
      method: "POST",
      url: `${BASE}/data/conformance_kv?requireApproval=true`,
      body: { id: "contract2-probe-0001", val: "contract2-probe" },
    }]);
    expect(isQueuedWrite(r)).toBe(true);
    if (isQueuedWrite(r)) {
      const change: Pick<PendingChange, "id" | "operation" | "collection"> = r.data;
      expect(change.id).toBe("apr_5oLshD2MVT27");
      expect(r.data.status).toBe("pending_approval");
      expect(r.data.targetRecordId).toBeNull();
      expect(r.meta.approval.status).toBe("pending_approval");
    } else {
      // Type check: the other branch is the plain row envelope.
      const row: string = r.data.val;
      throw new Error(`unexpected row ${row}`);
    }
  });

  it("with an auto_approve policy the applied row comes back and is not queued", async () => {
    const { c } = client({ status: 201, body: { data: { id: "a", val: "b" }, meta: META } });
    const r = await c.from("conformance_kv").insert<Kv>({ id: "a", val: "b" }).requireApproval();
    expect(isQueuedWrite(r)).toBe(false);
    if (!isQueuedWrite(r)) expect(r.data.val).toBe("b");
  });

  it("update .requireApproval() sends PATCH with the flag and the id in the path", async () => {
    const queued = { data: { ...queuedInsert.data, operation: "update", targetRecordId: "r 1", proposedPayload: { val: "z" } }, meta: queuedInsert.meta };
    const { c, seen } = client({ status: 202, body: queued });
    const r = await c.from("conformance_kv").update<Kv>({ val: "z" }).eq("id", "r 1").requireApproval();
    expect(seen).toEqual([{ method: "PATCH", url: `${BASE}/data/conformance_kv/r%201?requireApproval=true`, body: { val: "z" } }]);
    expect(isQueuedWrite(r) && r.data.operation).toBe("update");
  });

  it("delete .requireApproval() sends DELETE with the flag and no body", async () => {
    const queued = { data: { ...queuedInsert.data, operation: "delete", targetRecordId: "r1", proposedPayload: {} }, meta: queuedInsert.meta };
    const { c, seen } = client({ status: 202, body: queued });
    const r = await c.from("conformance_kv").delete().eq("id", "r1").requireApproval();
    expect(seen).toEqual([{ method: "DELETE", url: `${BASE}/data/conformance_kv/r1?requireApproval=true` }]);
    expect(isQueuedWrite(r) && r.data.targetRecordId).toBe("r1");
  });

  it("update and delete without the modifier send no query", async () => {
    const { c, seen } = client({ body: { data: { id: "r1" }, meta: META } });
    await c.from("conformance_kv").update<Kv>({ val: "z" }).eq("id", "r1");
    await c.from("conformance_kv").delete().eq("id", "r1");
    expect(seen.map((s) => s.url)).toEqual([`${BASE}/data/conformance_kv/r1`, `${BASE}/data/conformance_kv/r1`]);
  });

  it("keeps the id-filter check and rejects through catch()", async () => {
    const { c, seen } = client();
    const e = await rejects(c.from("conformance_kv").delete().requireApproval());
    expect(e.code).toBe("K9O_INVALID_FIELD_VALUE");
    const viaCatch = await c.from("Bad Name").insert({ a: 1 }).catch((err: unknown) => err);
    expect(viaCatch).toBeInstanceOf(KError);
    expect(seen).toHaveLength(0);
  });

  it("surfaces the gateway's error for a bad value", async () => {
    const { c } = client({ status: 403, body: { code: "K9O_RBAC_DENY", message: "no", context: { reason: "end_user_cannot_propose" }, recommendation: null } });
    const e = await rejects(c.from("conformance_kv").insert({ id: "a" }).requireApproval());
    expect(e.code).toBe("K9O_RBAC_DENY");
  });
});

// Type-level discrimination (checked by tsc, not by bun).
function typeChecks(c: ReturnType<typeof client>["c"]): void {
  void (async () => {
    // Without the flag the result is the row envelope.
    const plain = await c.from("kv").insert<Kv>({ id: "a" });
    const id: string = plain.data.id;
    // @ts-expect-error a plain write has no `status` discriminant
    plain.data.status;
    // With the flag the result is the union; the row is not reachable until narrowed.
    const gated = await c.from("kv").insert<Kv>({ id: "a" }).requireApproval();
    // @ts-expect-error `val` is only on the row branch
    gated.data.val;
    if (isQueuedWrite(gated)) {
      const apr: string = gated.data.id;
      const s: "pending_approval" = gated.data.status;
      void apr; void s;
    } else {
      const val: string = gated.data.val;
      void val;
    }
    // @ts-expect-error requireApproval cannot be applied twice
    c.from("kv").insert<Kv>({ id: "a" }).requireApproval().requireApproval();
    void id;
  });
}
void typeChecks;

describe("client.functions.triggers", () => {
  const trigger = {
    id: "0b8f6a52-3f0e-4c8e-9a47-5d2b0f1c7e11", functionName: "my-fn", collection: "orders", events: ["insert", "update"],
    filter: null, enabled: true, logOkInvocations: false, createdAt: "2026-10-26T17:59:56.815Z",
  };

  it("list: GET, empty list (live)", async () => {
    const { c, seen } = client({ body: { data: [], meta: META } });
    const r = await c.functions.triggers.list("my-fn");
    expect(r.data).toEqual([]);
    expect(seen).toEqual([{ method: "GET", url: `${BASE}/functions/my-fn/triggers` }]);
  });

  it("create: POST with the camelCase body, 201", async () => {
    const { c, seen } = client({ status: 201, body: { data: trigger, meta: META } });
    const r = await c.functions.triggers.create("my-fn", {
      collection: "orders", events: ["insert", "update"], filter: { eq: ["resource.status", "paid"] }, enabled: true, logOkInvocations: false,
    });
    expect(r.data.id).toBe(trigger.id);
    expect(seen[0]).toEqual({
      method: "POST",
      url: `${BASE}/functions/my-fn/triggers`,
      body: { collection: "orders", events: ["insert", "update"], filter: { eq: ["resource.status", "paid"] }, enabled: true, logOkInvocations: false },
    });
  });

  it("create validates the collection identifier and events 1-4 before any request", async () => {
    const { c, seen } = client();
    const bad = [
      { collection: "1orders", events: ["insert"] },
      { collection: "or ders", events: ["insert"] },
      { collection: "a".repeat(129), events: ["insert"] },
      { collection: "orders", events: [] },
      { collection: "orders", events: ["insert", "update", "delete", "upsert", "insert"] },
      { collection: "orders", events: ["truncate"] },
    ];
    for (const input of bad) {
      const e = await rejects(c.functions.triggers.create("my-fn", input as never));
      expect(e.code).toBe("K9O_INVALID_FIELD_VALUE");
    }
    expect(seen).toHaveLength(0);
    await c.functions.triggers.create("my-fn", { collection: "_orders9", events: ["insert", "update", "delete", "upsert"] });
    expect(seen).toHaveLength(1);
  });

  it("update: PATCH with only the given fields; filter null clears", async () => {
    const { c, seen } = client({ body: { data: trigger, meta: META } });
    await c.functions.triggers.update("my-fn", trigger.id, { filter: null, enabled: false });
    expect(seen[0]).toEqual({ method: "PATCH", url: `${BASE}/functions/my-fn/triggers/${trigger.id}`, body: { filter: null, enabled: false } });
  });

  it("update refuses an empty patch and bad events", async () => {
    const { c, seen } = client();
    expect((await rejects(c.functions.triggers.update("my-fn", trigger.id, {}))).code).toBe("K9O_INVALID_FIELD_VALUE");
    expect((await rejects(c.functions.triggers.update("my-fn", trigger.id, { events: [] }))).code).toBe("K9O_INVALID_FIELD_VALUE");
    expect(seen).toHaveLength(0);
  });

  it("delete: DELETE, 204 has no body and data is undefined", async () => {
    const { c, seen } = client({ status: 204 });
    const r = await c.functions.triggers.delete("my-fn", trigger.id);
    expect(r.data).toBeUndefined();
    expect(seen).toEqual([{ method: "DELETE", url: `${BASE}/functions/my-fn/triggers/${trigger.id}` }]);
  });

  it("delete of an unknown trigger is the gateway's 404", async () => {
    const { c } = client({ status: 404, body: { code: "K9O_TRIGGER_NOT_FOUND", message: "nf", context: {}, recommendation: null } });
    expect((await rejects(c.functions.triggers.delete("my-fn", trigger.id))).code).toBe("K9O_TRIGGER_NOT_FOUND");
  });

  it("encodes the function name", async () => {
    const { c, seen } = client({ body: { data: [], meta: META } });
    await c.functions.triggers.list("a b");
    expect(seen[0]!.url).toBe(`${BASE}/functions/a%20b/triggers`);
  });
});

describe("client.schedules", () => {
  const sched = {
    id: "5a2c0a39-6b1e-4f40-9a58-0c7f1d9d2b01", functionName: "nightly", scheduleExpression: "0 0 * * *", scheduleTimezone: "UTC",
    catchupPolicy: "skip", collection: null, enabled: true, status: "active", logOkInvocations: false,
    createdAt: "2026-10-26T17:59:56.815Z", lastInvocationAt: null, nextInvocationAt: null,
  };

  it("list: live empty page with cursor.next null; sends function_name and paging query", async () => {
    const { c, seen } = client({ body: { data: [], meta: { ...META, cursor: { next: null } } } });
    const r = await c.schedules.list({ status: "active", functionName: "nightly", limit: 2, cursor: "abc" });
    expect(r.data).toEqual([]);
    expect((r.meta["cursor"] as { next: string | null }).next).toBeNull();
    const url = new URL(seen[0]!.url);
    expect(seen[0]!.method).toBe("GET");
    expect(url.pathname).toBe("/@portal/forge/schedules");
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: "active", function_name: "nightly", limit: "2", cursor: "abc" });
  });

  it("list without options sends no query; validates limit", async () => {
    const { c, seen } = client({ body: { data: [], meta: META } });
    await c.schedules.list();
    expect(seen[0]!.url).toBe(`${BASE}/forge/schedules`);
    for (const limit of [0, 201, 1.5]) expect((await rejects(c.schedules.list({ limit }))).code).toBe("K9O_INVALID_FIELD_VALUE");
    expect(seen).toHaveLength(1);
  });

  it("get: GET by id", async () => {
    const { c, seen } = client({ body: { data: sched, meta: META } });
    expect((await c.schedules.get(sched.id)).data.status).toBe("active");
    expect(seen).toEqual([{ method: "GET", url: `${BASE}/forge/schedules/${sched.id}` }]);
  });

  it("create: POST with the camelCase body", async () => {
    const { c, seen } = client({ status: 201, body: { data: sched, meta: META } });
    await c.schedules.create({ functionName: "nightly", scheduleExpression: "@daily", scheduleTimezone: "Europe/Berlin", catchupPolicy: "run_once", collection: "orders", enabled: false, logOkInvocations: true });
    expect(seen[0]).toEqual({
      method: "POST",
      url: `${BASE}/forge/schedules`,
      body: { functionName: "nightly", scheduleExpression: "@daily", scheduleTimezone: "Europe/Berlin", catchupPolicy: "run_once", collection: "orders", enabled: false, logOkInvocations: true },
    });
  });

  it("create: the tier gate is the gateway's 403", async () => {
    const { c } = client({ status: 403, body: { code: "K9O_TIER_FEATURE_GATED", message: "gated", context: {}, recommendation: null } });
    expect((await rejects(c.schedules.create({ functionName: "nightly", scheduleExpression: "* * * * *" }))).code).toBe("K9O_TIER_FEATURE_GATED");
  });

  it("update: PATCH with status; an empty patch is refused", async () => {
    const { c, seen } = client({ body: { data: { ...sched, status: "paused", enabled: false }, meta: META } });
    const r = await c.schedules.update(sched.id, { status: "paused" });
    expect(r.data.status).toBe("paused");
    expect(seen[0]).toEqual({ method: "PATCH", url: `${BASE}/forge/schedules/${sched.id}`, body: { status: "paused" } });
    expect((await rejects(c.schedules.update(sched.id, {}))).code).toBe("K9O_INVALID_FIELD_VALUE");
    expect(seen).toHaveLength(1);
  });

  it("delete: DELETE, 204", async () => {
    const { c, seen } = client({ status: 204 });
    expect((await c.schedules.delete(sched.id)).data).toBeUndefined();
    expect(seen).toEqual([{ method: "DELETE", url: `${BASE}/forge/schedules/${sched.id}` }]);
  });

  it("runs: GET with limit and cursor", async () => {
    const { c, seen } = client({ body: { data: [], meta: { ...META, cursor: { next: null } } } });
    await c.schedules.runs(sched.id, { limit: 10, cursor: "c1" });
    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe(`/@portal/forge/schedules/${sched.id}/runs`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "10", cursor: "c1" });
    await c.schedules.runs(sched.id);
    expect(seen[1]!.url).toBe(`${BASE}/forge/schedules/${sched.id}/runs`);
  });

  it("runNow: POST with no body, 202, body passed through", async () => {
    const { c, seen } = client({ status: 202, body: { data: { accepted: true }, meta: META } });
    const r = await c.schedules.runNow(sched.id);
    expect(r.data).toEqual({ accepted: true });
    expect(seen).toEqual([{ method: "POST", url: `${BASE}/forge/schedules/${sched.id}/run-now` }]);
  });
});

describe("client.endUsers", () => {
  const euRow = {
    id: "eu_YmGE3Z6nkv5i", email: "user@example.com", emailVerifiedAt: null, status: "active",
    createdAt: "2026-10-09T12:15:13.430Z", lastSigninAt: null, signInMethods: ["password"], region: null,
  };
  const grant = { id: "eurg_AbCdEf123456", endUserId: "eu_YmGE3Z6nkv5i", role: "billing-manager", grantedAt: "2026-10-26T17:59:56.815Z", grantedBy: "usr_1" };

  it("list and get", async () => {
    const { c, seen } = client({ body: { data: [euRow], meta: { ...META, cursor: { next: null } } } });
    await c.endUsers.list({ status: "all", q: "us", limit: 5, cursor: "x" });
    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe("/@portal/end-users");
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: "all", q: "us", limit: "5", cursor: "x" });
    await c.endUsers.get("eu_YmGE3Z6nkv5i");
    expect(seen[1]).toEqual({ method: "GET", url: `${BASE}/end-users/eu_YmGE3Z6nkv5i` });
  });

  it("roleGrants.list unwraps data.grants (live: empty wrapper)", async () => {
    const { c, seen } = client({ body: { data: { grants: [] }, meta: META } });
    const r = await c.endUsers.roleGrants.list();
    expect(r.data).toEqual([]);
    expect(seen).toEqual([{ method: "GET", url: `${BASE}/end-user-role-grants` }]);
    const withUser = client({ body: { data: { grants: [grant] }, meta: META } });
    const r2 = await withUser.c.endUsers.roleGrants.list({ endUserId: "eu_YmGE3Z6nkv5i" });
    expect(r2.data[0]!.role).toBe("billing-manager");
    expect(withUser.seen[0]!.url).toBe(`${BASE}/end-user-role-grants?endUserId=eu_YmGE3Z6nkv5i`);
  });

  it("roleGrants.grant posts the pair and returns the grant", async () => {
    const { c, seen } = client({ body: { data: { grant }, meta: META } });
    const r = await c.endUsers.roleGrants.grant({ endUserId: "eu_YmGE3Z6nkv5i", role: "billing-manager" });
    expect(r.data.id).toBe("eurg_AbCdEf123456");
    expect(seen).toEqual([{ method: "POST", url: `${BASE}/end-user-role-grants`, body: { endUserId: "eu_YmGE3Z6nkv5i", role: "billing-manager" } }]);
  });

  it("roleGrants.grant checks lengths before any request", async () => {
    const { c, seen } = client();
    for (const input of [{ endUserId: "", role: "r" }, { endUserId: "eu_1", role: "" }, { endUserId: "eu_1", role: "x".repeat(129) }, { endUserId: "e".repeat(65), role: "r" }]) {
      expect((await rejects(c.endUsers.roleGrants.grant(input))).code).toBe("K9O_INVALID_FIELD_VALUE");
    }
    expect(seen).toHaveLength(0);
  });

  it("roleGrants.revoke: DELETE answers revoked true, and revoked:false for an unknown id", async () => {
    const { c, seen } = client({ body: { data: { revoked: true, revokedAt: "2026-10-26T18:00:00.000Z" }, meta: META } });
    const r = await c.endUsers.roleGrants.revoke("eurg_AbCdEf123456");
    expect(r.data).toEqual({ revoked: true, revokedAt: "2026-10-26T18:00:00.000Z" });
    expect(seen).toEqual([{ method: "DELETE", url: `${BASE}/end-user-role-grants/eurg_AbCdEf123456` }]);
    const none = client({ body: { data: { revoked: false, revokedAt: null }, meta: META } });
    const r2 = await none.c.endUsers.roleGrants.revoke("eurg_nope");
    expect(r2.data.revoked).toBe(false);
    expect(r2.data.revokedAt).toBeNull();
  });
});
