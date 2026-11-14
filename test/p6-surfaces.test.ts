/**
 * Tests for the P6 surface families:
 *   - client.studio.workflows.*
 *   - client.studio.dashboards.*
 *   - client.compute.llms.* + client.org.defaultLLM
 *   - client.realtime.subscribe() (SSE)
 *
 * Verifies URL composition + HTTP method against the cemented routes +
 * the realtime async-iterable abstraction (SSE transport).
 */

import { describe, expect, it } from "bun:test";
import { createClient, realtimeTopic, type RealtimeEvent, type LLMStreamChunk } from "../src/index.ts";
import { SeenEventIds } from "../src/realtime.ts";

type CapturedRequest = { url: string; method: string; body?: string };

function captureFetch(captured: CapturedRequest, response: unknown = { data: null, meta: {} }, status = 200): typeof globalThis.fetch {
  return ((async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = typeof input === "string" ? input : input.toString();
    captured.method = init?.method as string;
    if (init?.body !== undefined) captured.body = String(init.body);
    return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  }) as unknown) as typeof globalThis.fetch;
}

/** Build a fetch that returns an SSE byte stream from the given lines. */
function sseFetch(captured: CapturedRequest, sseText: string): typeof globalThis.fetch {
  return ((async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = typeof input === "string" ? input : input.toString();
    captured.method = init?.method as string;
    if (init?.body !== undefined) captured.body = String(init.body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseText));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown) as typeof globalThis.fetch;
}

const PROJ = { baseUrl: "https://acme.api.k9o.io", projectSlug: "portal" };

describe("client.studio.workflows", () => {
  it("list GETs /@portal/workflows", async () => {
    const cap: CapturedRequest = { url: "", method: "" };
    const c = createClient({ ...PROJ, fetch: captureFetch(cap, { data: [], meta: {} }) });
    await c.studio.workflows.list();
    expect(cap.method).toBe("GET");
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/workflows");
  });

  it("list composes filters", async () => {
    const cap: CapturedRequest = { url: "", method: "" };
    const c = createClient({ ...PROJ, fetch: captureFetch(cap, { data: [], meta: {} }) });
    await c.studio.workflows.list({ status: "active", triggerType: "manual", limit: 10 });
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/workflows?status=active&triggerType=manual&limit=10");
  });

  it("create POSTs /@portal/workflows with body", async () => {
    const cap: CapturedRequest = { url: "", method: "" };
    const c = createClient({ ...PROJ, fetch: captureFetch(cap, { data: {}, meta: {} }) });
    await c.studio.workflows.create({
      name: "onboard", triggerType: "manual", triggerConfig: {},
      actions: [{ index: 0, action_type: "send_notification", config: {} }],
    });
    expect(cap.method).toBe("POST");
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/workflows");
    expect(cap.body).toContain("send_notification");
  });

  it("read / update / delete address /@portal/workflows/<id>", async () => {
    const cap: CapturedRequest = { url: "", method: "" };
    const c = createClient({ ...PROJ, fetch: captureFetch(cap, { data: {}, meta: {} }) });
    await c.studio.workflows.read("wfl_x");
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/workflows/wfl_x");
    await c.studio.workflows.update("wfl_x", { status: "archived" });
    expect(cap.method).toBe("PATCH");
    await c.studio.workflows.delete("wfl_x");
    expect(cap.method).toBe("DELETE");
  });

  it("trigger POSTs /@portal/workflows/<id>/runs", async () => {
    const cap: CapturedRequest = { url: "", method: "" };
    const c = createClient({ ...PROJ, fetch: captureFetch(cap, { data: {}, meta: {} }) });
    await c.studio.workflows.trigger("wfl_x", { foo: "bar" });
    expect(cap.method).toBe("POST");
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/workflows/wfl_x/runs");
    expect(JSON.parse(cap.body!)).toEqual({ triggerContext: { foo: "bar" } });
  });

  it("runs.list / runs.read / runs.cancel address the runs sub-path", async () => {
    const cap: CapturedRequest = { url: "", method: "" };
    const c = createClient({ ...PROJ, fetch: captureFetch(cap, { data: [], meta: {} }) });
    await c.studio.workflows.runs.list("wfl_x", { status: "running" });
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/workflows/wfl_x/runs?status=running");
    await c.studio.workflows.runs.read("wfl_x", "wfr_y");
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/workflows/wfl_x/runs/wfr_y");
    await c.studio.workflows.runs.cancel("wfl_x", "wfr_y");
    expect(cap.method).toBe("POST");
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/workflows/wfl_x/runs/wfr_y/cancel");
  });
});

describe("client.studio.dashboards", () => {
  it("CRUD + pin/unpin address the right routes", async () => {
    const cap: CapturedRequest = { url: "", method: "" };
    const c = createClient({ ...PROJ, fetch: captureFetch(cap, { data: {}, meta: {} }) });
    await c.studio.dashboards.list();
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/dashboards");
    await c.studio.dashboards.create({ name: "ops" });
    expect(cap.method).toBe("POST");
    await c.studio.dashboards.read("dsh_x");
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/dashboards/dsh_x");
    await c.studio.dashboards.pin("dsh_x");
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/dashboards/dsh_x/pin");
    await c.studio.dashboards.unpin("dsh_x");
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/dashboards/dsh_x/unpin");
  });
});

describe("client.compute.llms", () => {
  it("list / read address /@portal/compute/llms", async () => {
    const cap: CapturedRequest = { url: "", method: "" };
    const c = createClient({ ...PROJ, fetch: captureFetch(cap, { data: [], meta: {} }) });
    await c.compute.llms.list({ modality: "embeddings" });
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/compute/llms?modality=embeddings");
    await c.compute.llms.read("gpt-4o");
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/compute/llms/gpt-4o");
  });

  it("invoke POSTs /@portal/compute/llms/<id>/invoke", async () => {
    const cap: CapturedRequest = { url: "", method: "" };
    const c = createClient({ ...PROJ, fetch: captureFetch(cap, { data: { modelId: "mistral-7b", content: "hi", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, usageType: "sdk.direct" }, meta: {} }) });
    const { data } = await c.compute.llms.invoke("mistral-7b", { prompt: "hello", params: { maxTokens: 16, temperature: 0.5 } });
    expect(cap.method).toBe("POST");
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/compute/llms/mistral-7b/invoke");
    expect(JSON.parse(cap.body!)).toEqual({ prompt: "hello", maxTokens: 16, temperature: 0.5 });
    expect(data.content).toBe("hi");
    expect(data.usage.totalTokens).toBe(2);
  });

  it("invokeStream yields the OpenAI-style chunks until [DONE]", async () => {
    const cap: CapturedRequest = { url: "", method: "" };
    const chunk = (content: string | null, extra: object = {}) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }], ...extra })}\n\n`;
    const sse = chunk("Hel") + chunk("lo") + chunk(null, { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }) + `data: [DONE]\n\n`;
    const c = createClient({ ...PROJ, fetch: sseFetch(cap, sse) });
    const chunks: LLMStreamChunk[] = [];
    for await (const ch of c.compute.llms.invokeStream("gpt-4o", { prompt: "hi", params: { maxTokens: 8 } })) {
      chunks.push(ch);
    }
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/compute/llms/gpt-4o/invoke-stream");
    expect(JSON.parse(cap.body!)).toEqual({ prompt: "hi", maxTokens: 8 });
    expect(chunks.map((x) => x.choices?.[0]?.delta?.content ?? "").join("")).toBe("Hello");
    expect(chunks[2]?.usage?.total_tokens).toBe(3);
  });
});

describe("client.org.defaultLLM", () => {
  it("get GETs /default-llm; set PATCHes it", async () => {
    const cap: CapturedRequest = { url: "", method: "" };
    const c = createClient({ baseUrl: "https://acme.api.k9o.io", fetch: captureFetch(cap, { data: "mistral-7b", meta: {} }) });
    await c.org.defaultLLM.get();
    expect(cap.url).toBe("https://acme.api.k9o.io/default-llm");
    await c.org.defaultLLM.set({ modelId: "claude-3-5-sonnet" });
    expect(cap.method).toBe("PATCH");
    expect(cap.body).toContain("claude-3-5-sonnet");
  });
});

describe("client.realtime", () => {
  it("topic builders produce the 6 closed families", () => {
    expect(realtimeTopic.collection("orders")).toBe("collections.orders.*");
    expect(realtimeTopic.workflowRuns()).toBe("studio.workflows.runs.*");
    expect(realtimeTopic.dashboardRefresh("dsh_x")).toBe("studio.dashboards.refresh.dsh_x");
    expect(realtimeTopic.functionInvocations("fn_x")).toBe("forge.functions.invocations.fn_x");
    expect(realtimeTopic.auditOrg("role_granted")).toBe("audit.org.role_granted");
  });

  it("subscribe yields events as an async iterable", async () => {
    const cap: CapturedRequest = { url: "", method: "" };
    const ev1: RealtimeEvent = { topic: "collections.orders.*", eventType: "row_inserted", payload: { id: 1 }, occurredAt: "t1", eventId: "evt_1" };
    const ev2: RealtimeEvent = { topic: "collections.orders.*", eventType: "row_updated", payload: { id: 1 }, occurredAt: "t2", eventId: "evt_2" };
    const sse = `id: 1\nevent: row_inserted\ndata: ${JSON.stringify(ev1)}\n\nid: 2\nevent: row_updated\ndata: ${JSON.stringify(ev2)}\n\n`;
    const c = createClient({ ...PROJ, fetch: sseFetch(cap, sse) });
    const sub = c.realtime.subscribe(realtimeTopic.collection("orders"));
    const seen: RealtimeEvent[] = [];
    for await (const e of sub) {
      seen.push(e);
      if (seen.length === 2) sub.close();
    }
    expect(cap.url).toBe("https://acme.api.k9o.io/@portal/realtime/subscribe?topic=collections.orders.*");
    expect(seen.map((e) => e.eventType)).toEqual(["row_inserted", "row_updated"]);
  });

  const evt = (n: number, eventType = "row_inserted"): RealtimeEvent => ({ topic: "collections.orders.row_inserted", eventType, payload: { id: n }, occurredAt: `t${n}`, eventId: `evt_${String(n).padStart(22, "0")}` });
  const frame = (e: RealtimeEvent) => `id: ${e.eventId}\nevent: ${e.eventType}\ndata: ${JSON.stringify(e)}\n\n`;
  /** A fetch that answers each connection with the next SSE body (the last one repeats), recording each request's headers. */
  function multiSseFetch(bodies: string[], seenHeaders: Record<string, string>[]): typeof globalThis.fetch {
    let i = 0;
    return ((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("/realtime/subscribe")) return new Response("{}", { status: 404 }); // region discovery
      seenHeaders.push({ ...(init?.headers as Record<string, string>) });
      const text = bodies[Math.min(i++, bodies.length - 1)]!;
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(`retry: 1\n:ok\n\n${text}`)); c.close(); } });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown) as typeof globalThis.fetch;
  }

  it("🔴 reconnects with Last-Event-ID after the server closes, and yields a resume's re-sent events only once", async () => {
    const hdrs: Record<string, string>[] = [];
    const [e1, e2, e3, e4] = [evt(1), evt(2), evt(3), evt(4)];
    // Connection 1: e1, e2, then the server closes. Connection 2 (Last-Event-ID e2): the lookback re-sends e1, then e3, e4.
    const c = createClient({ ...PROJ, fetch: multiSseFetch([frame(e1!) + frame(e2!), frame(e1!) + frame(e3!) + frame(e4!), ""], hdrs) });
    const sub = c.realtime.subscribe(realtimeTopic.collection("orders"));
    const got: string[] = [];
    for await (const e of sub) {
      got.push(e.eventId);
      if (got.length === 4) sub.close();
    }
    expect(got).toEqual([e1!.eventId, e2!.eventId, e3!.eventId, e4!.eventId]); // e1 once, though sent twice
    expect(hdrs[0]!["last-event-id"]).toBeUndefined();
    expect(hdrs[1]!["last-event-id"]).toBe(e2!.eventId);
  });

  it("🔴 a resync without onResync ends the subscription (never a silent gap)", async () => {
    const hdrs: Record<string, string>[] = [];
    const resync = `event: resync\ndata: ${JSON.stringify({ reason: "cursor-unknown", action: "reread-source" })}\n\n`;
    const c = createClient({ ...PROJ, fetch: multiSseFetch([frame(evt(1)) + resync + frame(evt(2))], hdrs) });
    const seen: string[] = [];
    for await (const e of c.realtime.subscribe(realtimeTopic.collection("orders"))) seen.push(e.eventType);
    expect(seen).toEqual(["row_inserted"]);
    expect(hdrs).toHaveLength(1);
  });

  it("a resync with onResync calls it, then carries on live without the stale cursor", async () => {
    const hdrs: Record<string, string>[] = [];
    const resync = `event: resync\ndata: ${JSON.stringify({ reason: "cursor-unknown", action: "reread-source" })}\n\n`;
    const c = createClient({ ...PROJ, fetch: multiSseFetch([frame(evt(1)) + resync, frame(evt(2))], hdrs) });
    const resyncs: unknown[] = [];
    const sub = c.realtime.subscribe(realtimeTopic.collection("orders"), { onResync: (r) => { resyncs.push(r); } });
    const seen: number[] = [];
    for await (const e of sub) {
      seen.push((e.payload as { id: number }).id);
      if (seen.length === 2) sub.close();
    }
    expect(resyncs).toEqual([{ reason: "cursor-unknown", action: "reread-source" }]);
    expect(seen).toEqual([1, 2]);
    expect(hdrs[1]!["last-event-id"]).toBeUndefined(); // rejoins live: the cursor was no use
  });

  it("the seen-set is bounded by count and by age", () => {
    let now = 0;
    const s = new SeenEventIds(3, 1000, () => now);
    expect(["a", "b", "c", "d"].map((id) => s.firstTime(id))).toEqual([true, true, true, true]);
    expect(s.size).toBe(3);
    expect(s.firstTime("a")).toBe(true); // evicted by count
    expect(s.firstTime("d")).toBe(false);
    now = 5000;
    expect(s.firstTime("d")).toBe(true); // forgotten by age
  });
});
