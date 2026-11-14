/**
 * Key inventory SDK: `client.keys.*`. The project's encryption keys, as metadata only: no key material is ever returned.
 *
 * Wire mapping (project plane):
 *   - `list({ status? })`  -> GET  /@<slug>/vault/keys[?status=all]
 *   - `get(keyId)`         -> GET  /@<slug>/vault/keys/<keyId>
 *   - `rotate(keyId, { stepUp? })` -> POST /@<slug>/vault/keys/<keyId>/rotate
 *
 * Reading needs the PROJECT_ADMIN or PROJECT_AUDITOR project role; rotating needs PROJECT_ADMIN and a fresh step-up proof.
 * Only a person's credential works: end-user, extension, service and workload tokens are refused.
 */

import { buildUrl, request, type HttpClientConfig } from "./http.ts";
import { KError } from "./kerror.ts";
import { resolveRegionalOrigin } from "./region.ts";
import { projectPath } from "./url-grammar.ts";
import type { Envelope } from "./envelope.ts";

/** Where a key lives: `active` (new data keys are wrapped under it), `rotating` (a rotation is running) or `revoked` (rotated out). */
export type VaultKeyStatus = "active" | "rotating" | "revoked";

/** The key service of a key you bring (BYOK). */
export type VaultKeyByokRef = {
  /** For example `aws-kms`. */
  provider: string | null;
  region: string | null;
  /** First 16 characters of base64url(SHA-256) of your key's identifier, to match it to yours. */
  externalKeyFingerprint: string | null;
};

/** The HSM cluster of a key you hold (HYOK). */
export type VaultKeyHyokRef = {
  clusterId: string | null;
  clusterName: string | null;
  externalKeyFingerprint: string | null;
};

/** One key version. */
export type VaultKey = {
  /** `vkey_<uuid>`. */
  id: string;
  /** Starts at 1 and goes up by one on each rotation. */
  version: number | null;
  /** `active`, `rotating` or `revoked`; an open set, so treat it as a string. */
  status: VaultKeyStatus | (string & {}) | null;
  /** `PLATFORM_MANAGED`, `SKR`, `BYOK` or `HYOK`; an open set. */
  custodyMode: string | null;
  createdAt: string | null;
  /** When the key was last rotated; `null` if never. */
  rotatedAt: string | null;
  /** Set when the key is your own (BYOK); otherwise `null`. */
  byokRef: VaultKeyByokRef | null;
  /** Set when the key is held in your HSM cluster (HYOK); otherwise `null`. */
  hyokRef: VaultKeyHyokRef | null;
};

export type ListKeysOptions = {
  /** `active` (default) lists the active key only; `all` adds the rotating and revoked versions. */
  status?: "active" | "all" | undefined;
};

/** The key list is not paged: it holds every key version the `status` asks for. */
export type ListKeysResult = {
  items: VaultKey[];
};

/**
 * The step-up challenge of a 401 `K9O_STEP_UP_REQUIRED` answer (the gateway's `context.stepUp`). The proof you return
 * must answer exactly this challenge, once, within `maxAgeSec`.
 */
export type StepUpChallenge = {
  /** Echoed back unchanged in the proof header. */
  scopeSetRoot: string;
  /** Echoed back unchanged; single use. */
  nonce: string;
  /** The ways to prove, for example `webauthn`, `dpop` or `mtls`. Pick one. */
  methods: string[];
  /** How long the challenge stays valid, in seconds (120). */
  maxAgeSec: number;
  /** The minimum tier of proof, for example `T3_KEY_POSSESSION`. */
  minTier?: string | undefined;
  singleUse?: boolean | undefined;
  /** The relying-party id a passkey assertion must name, when the gateway sends one. */
  rpId?: string | undefined;
};

/** The call the proof is for. A DPoP proof binds to exactly this method and URL. */
export type StepUpCall = { method: string; url: string };

/** What the hook returns: the method you used (one of `challenge.methods`) and that method's own proof. */
export type StepUpProof = { method: string; proof: string };

/**
 * Answers a step-up challenge. No route mints the proof: your code produces it (a passkey assertion, a DPoP proof,
 * an mTLS-bound proof). It runs at most once per call. It is awaited; throw to give up and the error reaches the caller.
 */
export type StepUpHook = (challenge: StepUpChallenge, call: StepUpCall) => StepUpProof | Promise<StepUpProof>;

export type RotateKeyOptions = {
  /** Answers the step-up challenge; the request is then sent once more with the proof. Without it, the 401 is thrown. */
  stepUp?: StepUpHook | undefined;
};

export type RotateKeyResult = {
  keyId: string;
  previousVersion: number | null;
  newVersion: number | null;
  /** `rotated`. */
  status: string | null;
};

function requireProjectSlug(config: HttpClientConfig): string {
  if (typeof config.projectSlug !== "string" || config.projectSlug.length === 0) {
    throw new Error("keys operations require projectSlug bound on the client");
  }
  return config.projectSlug;
}

function requireKeyId(keyId: string, op: string): void {
  if (typeof keyId !== "string" || keyId.length === 0) throw new TypeError(`keys.${op}: keyId must be a non-empty string (vkey_...)`);
}

/** A field the gateway leaves out reads as `null`, as the type says. Other fields it sends are kept. */
function withKeyDefaults(k: VaultKey): VaultKey {
  return { ...k, rotatedAt: k.rotatedAt ?? null, byokRef: k.byokRef ?? null, hyokRef: k.hyokRef ?? null };
}

export function makeKeysNamespace(config: HttpClientConfig) {
  return {
    /**
     * The project's keys, one entry per key version: `{ items }` (not paged). By default only the active key; pass
     * `{ status: "all" }` for the rotating and revoked versions too.
     * Errors: 401, 403 (other role, or a credential that is not a person's), 502 `K9O_UPSTREAM_UNAVAILABLE`.
     */
    async list(options: ListKeysOptions = {}): Promise<Envelope<ListKeysResult>> {
      const slug = requireProjectSlug(config);
      if (options.status !== undefined && options.status !== "active" && options.status !== "all") {
        throw new TypeError('keys.list: status must be "active" or "all"');
      }
      const res = await request<{ items?: VaultKey[] }>(config, {
        method: "GET",
        path: projectPath(slug, "vault/keys"),
        ...(options.status !== undefined ? { query: { status: options.status } } : {}),
      });
      // The list is not paged: a `nextCursor` the gateway may still send is dropped.
      return { ...res, data: { items: (res.data.items ?? []).map(withKeyDefaults) } };
    },

    /** One key by id (`vkey_...`). Errors: 404 `K9O_NOT_FOUND`, 502 `K9O_UPSTREAM_UNAVAILABLE`. */
    async get(keyId: string): Promise<Envelope<VaultKey>> {
      const slug = requireProjectSlug(config);
      requireKeyId(keyId, "get");
      const res = await request<VaultKey>(config, { method: "GET", path: projectPath(slug, `vault/keys/${encodeURIComponent(keyId)}`) });
      return { ...res, data: withKeyDefaults(res.data) };
    },

    /**
     * Rotate the project's active key: a new version is created, every data key is re-wrapped under it and the previous
     * version is revoked. If the re-wrap fails the previous version stays active. Writes to the project's encrypted data
     * wait while it runs. Needs PROJECT_ADMIN and a fresh step-up proof.
     *
     * Errors, all `KError`:
     *  - 401 `K9O_STEP_UP_REQUIRED`: the challenge is in `error.context.stepUp` (`stepUpChallengeOf(error)` returns it typed).
     *    With `options.stepUp` the SDK calls your hook with the challenge and the call (method and URL) and sends the
     *    request again, once, with the `x-k9o-step-up-proof` header; the hook's answer is never logged. Without the hook this error is thrown.
     *    A second 401 is thrown as it is (a bad proof is a generic 401 `K9O_STEP_UP_PROOF_MALFORMED`); the SDK never loops.
     *  - 409 `K9O_STATE_CONFLICT`: `context.reason` is `rotation_in_flight` or `key_not_active`.
     *  - 429 `K9O_RATE_LIMITED`: `context.reason` is `rotation_rate_cap` (at most 3 rotations in a rolling 24 hours) or `key_service_busy`;
     *    `retryAfterSec` holds the wait from the `Retry-After` header.
     *  - 403 when the credential is not a person's, 404 `K9O_NOT_FOUND`, 502 `K9O_UPSTREAM_UNAVAILABLE`.
     *
     * A refused rotation (409, 429) is checked before the step-up challenge and does not use a proof.
     */
    async rotate(keyId: string, options: RotateKeyOptions = {}): Promise<Envelope<RotateKeyResult>> {
      const slug = requireProjectSlug(config);
      requireKeyId(keyId, "rotate");
      const path = projectPath(slug, `vault/keys/${encodeURIComponent(keyId)}/rotate`);
      const hook = options.stepUp;
      if (hook !== undefined && typeof hook !== "function") throw new TypeError("keys.rotate: stepUp must be a function");
      try {
        return await request<RotateKeyResult>(config, { method: "POST", path });
      } catch (e) {
        const challenge = hook === undefined ? null : stepUpChallengeOf(e);
        if (hook === undefined || challenge === null) throw e;
        const url = buildUrl(await resolveRegionalOrigin(config), path, undefined);
        const answer = await hook(challenge, { method: "POST", url });
        const header = stepUpHeader(challenge, answer);
        // Exactly one more attempt. Whatever it answers, including a second 401, goes to the caller.
        return request<RotateKeyResult>(config, { method: "POST", path, headers: { [STEP_UP_HEADER]: header } });
      }
    },
  };
}

export const STEP_UP_HEADER = "x-k9o-step-up-proof";

/** The challenge of a 401 `K9O_STEP_UP_REQUIRED` error, typed; `null` for any other error or a challenge without `scopeSetRoot` and `nonce`. */
export function stepUpChallengeOf(e: unknown): StepUpChallenge | null {
  if (!(e instanceof KError) || e.code !== "K9O_STEP_UP_REQUIRED" || e.status !== 401) return null;
  const c = e.context["stepUp"];
  if (typeof c !== "object" || c === null) return null;
  const o = c as Record<string, unknown>;
  if (typeof o["scopeSetRoot"] !== "string" || typeof o["nonce"] !== "string") return null;
  const out: StepUpChallenge = {
    scopeSetRoot: o["scopeSetRoot"],
    nonce: o["nonce"],
    methods: Array.isArray(o["methods"]) ? o["methods"].filter((m): m is string => typeof m === "string") : [],
    maxAgeSec: typeof o["maxAgeSec"] === "number" ? o["maxAgeSec"] : 120,
  };
  if (typeof o["minTier"] === "string") out.minTier = o["minTier"];
  if (typeof o["singleUse"] === "boolean") out.singleUse = o["singleUse"];
  if (typeof o["rpId"] === "string") out.rpId = o["rpId"];
  return out;
}

/** base64url (no padding) of the JSON `{ scopeSetRoot, nonce, method, proof }`. */
function stepUpHeader(challenge: StepUpChallenge, answer: StepUpProof): string {
  if (typeof answer !== "object" || answer === null || typeof answer.method !== "string" || answer.method.length === 0 || typeof answer.proof !== "string" || answer.proof.length === 0) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "keys.rotate: the stepUp hook must return { method, proof } as non-empty strings",
      context: {},
      recommendation: null,
    });
  }
  const json = JSON.stringify({ scopeSetRoot: challenge.scopeSetRoot, nonce: challenge.nonce, method: answer.method, proof: answer.proof });
  let bin = "";
  for (const b of new TextEncoder().encode(json)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
