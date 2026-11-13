/**
 * `KError` — the closed-taxonomy error class returned by every `@k9o/core`
 * surface on non-2xx gateway responses or SDK-side validation failures.
 *
 * TypeScript / JavaScript throw on error; the per-language SDKs deliver this same payload
 * via their idiomatic mechanism (Go tuple-return; Rust Result; Python
 * raise; etc.) without changing the field shape.
 *
 * Fields:
 *   - `code`     — closed-taxonomy string (e.g. `K9O_TIER_CAP_HIT`,
 *                  `K9O_PROJECT_NOT_FOUND`); unknown codes pass through
 *                  with `code` preserved + `INTERNAL_ERROR` family
 *                  classification recorded in `context.originalCode`.
 *   - `message`  — human-readable explanation.
 *   - `context`  — structured per-code payload (immutable; frozen).
 *   - `recommendation` — actionable next step (may be null when the
 *                  gateway didn't return one).
 *   - `status`   — HTTP status the gateway returned (or null for
 *                  SDK-side construct-time errors like
 *                  `K9O_INVALID_BASE_URL`).
 *   - `requestId` — gateway-emitted trace ID for downstream correlation.
 *
 * Standalone `@k9o/gate` ships its own `GateError` for the Auth0-parity
 * deployment shape; when `@k9o/gate` is composed inside `@k9o/core`,
 * `GateError` semantics align with `KError extends KError` (alignment still open).
 * Until then `KError` is the canonical error type returned by `@k9o/core` surfaces; `GateError` thrown by
 * `@k9o/gate`-delegated surfaces remain `KError`-shape-compatible
 * (both expose the same `code` / `message` / `context` / `recommendation`
 * fields) so caller code that narrows on `code` works against either.
 */

/**
 * Wire-shape sentinel matching the gateway's `KError` JSON payload. The HTTP client recognises this on non-2xx responses
 * and rehydrates it into a `KError` instance.
 */
export type KErrorWire = {
  code: string;
  message: string;
  context?: Record<string, unknown>;
  /** A string or null; the gateway may also send an object such as `{ action }` or `{ retryAfterSec, note }`. */
  recommendation?: unknown;
  requestId?: string;
};

/**
 * The customer-facing error type. Every `@k9o/core` surface throws this
 * on non-2xx upstream responses, transport failures, or SDK-side
 * validation failures.
 */
export class KError extends Error {
  readonly code: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly recommendation: string | null;
  /** Seconds the gateway asks the caller to wait, when it sent one; otherwise `null`. */
  readonly retryAfterSec: number | null;
  readonly status: number | null;
  readonly requestId: string | null;

  constructor(init: {
    code: string;
    message: string;
    context?: Record<string, unknown>;
    recommendation?: string | null;
    retryAfterSec?: number | null;
    status?: number | null;
    requestId?: string | null;
  }) {
    super(init.message);
    this.name = "KError";
    this.code = init.code;
    this.context = Object.freeze({ ...(init.context ?? {}) });
    this.recommendation = init.recommendation ?? null;
    this.retryAfterSec = init.retryAfterSec ?? null;
    this.status = init.status ?? null;
    this.requestId = init.requestId ?? null;
  }
}

/**
 * Rehydrate a wire `KError` payload into a typed `KError` instance.
 * Unlike `@k9o/gate.gateErrorFromWire`, `@k9o/core` does not maintain
 * a hand-curated allow-list of known codes — the gateway's KError
 * code-space is open-ended and curated centrally; the SDK
 * preserves whatever code the gateway sends. Code-narrowing in caller
 * code uses string-literal comparison against the well-known codes
 * (e.g. `if (e.code === 'K9O_TIER_CAP_HIT')`).
 */
export function kerrorFromWire(wire: KErrorWire, status: number): KError {
  const { recommendation, retryAfterSec } = decodeRecommendation(wire.recommendation);
  return new KError({
    code: wire.code,
    message: wire.message,
    context: wire.context ?? {},
    recommendation,
    retryAfterSec,
    status,
    requestId: wire.requestId ?? null,
  });
}

/**
 * Read the wire `recommendation`, which is a string, null, or an object
 * (`{ action }` or `{ retryAfterSec, note }`). A string is kept; an object gives
 * its `action`, else its `note`, when that is a string; anything else gives null.
 * `retryAfterSec` is the object's number when it is finite and not negative.
 */
export function decodeRecommendation(raw: unknown): { recommendation: string | null; retryAfterSec: number | null } {
  if (typeof raw === "string") return { recommendation: raw, retryAfterSec: null };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { recommendation: null, retryAfterSec: null };
  const o = raw as Record<string, unknown>;
  const recommendation = typeof o["action"] === "string" ? o["action"] : typeof o["note"] === "string" ? o["note"] : null;
  const n = o["retryAfterSec"];
  const retryAfterSec = typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
  return { recommendation, retryAfterSec };
}
