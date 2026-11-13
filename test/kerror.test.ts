/**
 * Unit tests for `KError` + `kerrorFromWire`.
 */

import { describe, expect, it } from "bun:test";
import { KError, kerrorFromWire, type KErrorWire } from "../src/kerror.ts";

describe("KError construct shape", () => {
  it("constructs with required fields + sets defaults for optional", () => {
    const e = new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "bad" });
    expect(e.code).toBe("K9O_INVALID_FIELD_VALUE");
    expect(e.message).toBe("bad");
    expect(e.context).toEqual({});
    expect(e.recommendation).toBeNull();
    expect(e.status).toBeNull();
    expect(e.requestId).toBeNull();
    expect(e.name).toBe("KError");
    expect(e).toBeInstanceOf(Error);
  });

  it("freezes context to prevent caller mutation", () => {
    const e = new KError({
      code: "K9O_TIER_CAP_HIT",
      message: "cap",
      context: { dimension: "mau", limit: 1000 },
    });
    expect(Object.isFrozen(e.context)).toBe(true);
    expect(() => {
      (e.context as Record<string, unknown>)["dimension"] = "x";
    }).toThrow();
  });
});

describe("kerrorFromWire rehydration", () => {
  it("rehydrates wire payload into typed KError + preserves all fields", () => {
    const wire: KErrorWire = {
      code: "K9O_PROJECT_NOT_FOUND",
      message: "no such project",
      context: { projectSlug: "ghost" },
      recommendation: "create the project first",
      requestId: "req_abc123",
    };
    const e = kerrorFromWire(wire, 404);
    expect(e.code).toBe("K9O_PROJECT_NOT_FOUND");
    expect(e.message).toBe("no such project");
    expect(e.context).toEqual({ projectSlug: "ghost" });
    expect(e.recommendation).toBe("create the project first");
    expect(e.status).toBe(404);
    expect(e.requestId).toBe("req_abc123");
  });

  it("passes through unknown codes (no allowlist; open code-space)", () => {
    const wire: KErrorWire = {
      code: "K9O_NEW_CODE_NOT_YET_KNOWN",
      message: "novel",
    };
    const e = kerrorFromWire(wire, 422);
    expect(e.code).toBe("K9O_NEW_CODE_NOT_YET_KNOWN");
    expect(e.status).toBe(422);
  });

  it("tolerates missing optional fields", () => {
    const e = kerrorFromWire({ code: "X", message: "y" }, 500);
    expect(e.context).toEqual({});
    expect(e.recommendation).toBeNull();
    expect(e.requestId).toBeNull();
  });
});

// Gateway bodies may carry an object in `recommendation`.
const CASES: Array<{ name: string; rec: unknown; status: number; expectRec: string | null; expectRetry: number | null }> = [
  { name: "object with action", rec: { action: "Open Billing and settle the outstanding wallet balance to lift the suspension." }, status: 403, expectRec: "Open Billing and settle the outstanding wallet balance to lift the suspension.", expectRetry: null },
  { name: "object with retryAfterSec and note", rec: { retryAfterSec: 30, note: "retry" }, status: 429, expectRec: "retry", expectRetry: 30 },
  { name: "null", rec: null, status: 403, expectRec: null, expectRetry: null },
  { name: "string", rec: "Do the thing.", status: 403, expectRec: "Do the thing.", expectRetry: null },
  { name: "number", rec: 42, status: 403, expectRec: null, expectRetry: null },
  { name: "array", rec: ["a", "b"], status: 403, expectRec: null, expectRetry: null },
  { name: "negative retryAfterSec", rec: { retryAfterSec: -1 }, status: 429, expectRec: null, expectRetry: null },
];
const body = (rec: unknown) => ({ code: "K9O_READ_ONLY_SUSPENDED", message: "Project is suspended.", context: { x: 1 }, recommendation: rec });

describe("recommendation decoding", () => {
  for (const c of CASES) {
    it(`keeps the error whole when recommendation is ${c.name}`, () => {
      const e = kerrorFromWire(body(c.rec) as KErrorWire, c.status);
      expect(e.code).toBe("K9O_READ_ONLY_SUSPENDED");
      expect(e.message).toBe("Project is suspended.");
      expect(e.status).toBe(c.status);
      expect(e.context).toEqual({ x: 1 });
      expect(e.recommendation).toBe(c.expectRec);
      expect(e.retryAfterSec).toBe(c.expectRetry);
    });
  }
});
