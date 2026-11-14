/**
 * Encryption SDK: `client.crypto.*`. Your application encrypts and decrypts with the project's key encryption key (KEK). You
 * never name a key.
 *
 * Routing. `encrypt` checks the project's custody mode on every call (`GET /@<slug>/crypto/mode`, never cached) and sends
 * plaintext to the platform only when the key is platform-held (PLATFORM_MANAGED, CONFIDENTIAL_WORKLOAD, SKR). For BYOK and
 * HYOK it uses the registered client core (`crypto.useClientCore`); with none registered it raises
 * `K9O_ZK_CLIENT_CORE_UNAVAILABLE` and sends nothing. An unknown mode, or a failed mode check, fails closed. `decrypt` and
 * `rewrap` send the ciphertext to the platform first and open it with the client core when the platform answers 409
 * `K9O_ZK_STORE_FLOW_REQUIRED` with `context.route` `"client"`.
 *
 * Wire mapping (project plane), all `POST` with `{ crypt, items: [...] }`:
 *   - `encrypt({ crypt, items: [{ plaintext, context? }] })`  -> /@<slug>/crypto/encrypt
 *   - `decrypt({ crypt, items: [{ ciphertext, context? }] })` -> /@<slug>/crypto/decrypt
 *   - `rewrap({ crypt, items: [{ ciphertext, context? }] })`  -> /@<slug>/crypto/rewrap  (open and re-seal under the current KEK version)
 *
 * The SDK takes bytes (or a string, read as UTF-8) and does the base64 for you. The ciphertext is one opaque container
 * (base64): the SDK never parses it. Nothing is retried automatically after a failure, a 5xx included.
 */

import { request, type HttpClientConfig } from "./http.ts";
import { KError } from "./kerror.ts";
import { projectPath } from "./url-grammar.ts";
import type { Envelope } from "./envelope.ts";

/** Bytes, or a string that is sent as its UTF-8 bytes. */
export type CryptoInput = Uint8Array | ArrayBuffer | string;

export const CRYPTO_MAX_ITEMS = 100;
/** Plaintext limit per item: 64 KiB. */
export const CRYPTO_MAX_ITEM_BYTES = 64 * 1024;
/** Plaintext limit per call: 1 MiB. */
export const CRYPTO_MAX_CALL_BYTES = 1024 * 1024;
/** Context limit per item: 256 bytes. */
export const CRYPTO_MAX_CONTEXT_BYTES = 256;
const CRYPT = /^(?!actions$)[a-z0-9-]{1,64}$/;
const CRYPT_RULE = 'crypt must be 1 to 64 characters of a-z, 0-9 and "-", and not "actions"';

/** 409: the call went to the wrong side of the custody boundary (`context`: `{ custodyMode, route, epoch }`). */
export const CRYPTO_ERR_ZK_STORE_FLOW_REQUIRED = "K9O_ZK_STORE_FLOW_REQUIRED";
/** 501, raised by the SDK: the project's key is in your own KMS or HSM and no client core is registered. */
export const CRYPTO_ERR_ZK_CLIENT_CORE_UNAVAILABLE = "K9O_ZK_CLIENT_CORE_UNAVAILABLE";
/** Raised by the SDK before the call reaches the client core: `expectedKeyRefs` is set and the core does not declare that it enforces it. */
export const CRYPTO_ERR_KEY_PIN_UNENFORCED = "K9O_CRYPTO_KEY_PIN_UNENFORCED";
/** 404 on encrypt: the crypt name is not registered. Decrypt and rewrap do not refuse on this. */
export const CRYPTO_ERR_CRYPT_NOT_FOUND = "K9O_CRYPT_NOT_FOUND";
/** 409 on encrypt: the crypt is retired. Decrypt and rewrap still work, so data stays readable. */
export const CRYPTO_ERR_CRYPT_RETIRED = "K9O_CRYPT_RETIRED";
/** Raised by the SDK before any plaintext is sent: the custody mode could not be read or is not one this SDK knows. */
export const CRYPTO_ERR_CUSTODY_UNKNOWN = "K9O_CRYPTO_CUSTODY_UNKNOWN";

const SERVER_MODES: ReadonlySet<string> = new Set(["PLATFORM_MANAGED", "CONFIDENTIAL_WORKLOAD", "SKR"]);
const CLIENT_MODES: ReadonlySet<string> = new Set(["BYOK", "HYOK"]);

/**
 * The project's custody state. `epoch` is opaque and changes with every custody transition. `route` is `"client"` or `"server"`
 * when the gateway named one (absent on older gateways, and when it named a value this SDK does not know): follow it, do not infer it from `custodyMode`.
 */
export type CryptoMode = { custodyMode: string; epoch: string; route?: "client" | "server" };

const FEDERATED_OPS: ReadonlySet<string> = new Set(["encrypt", "decrypt", "rewrap"]);

/** A registered crypt: the name an application encrypts under. `retiredAt` is null while `status` is "active". */
export type Crypt = { name: string; status: "active" | "retired"; createdAt: string; retiredAt: string | null };

/** What a federated token is for. `decrypt` and `rewrap` are one class on the platform: they get the same token. */
export type FederatedTokenRequest = { crypt: string; op: "encrypt" | "decrypt" | "rewrap" };

/**
 * A short-lived identity token (RS256 JWT) for your own cloud's token exchange. `expiresAt` is at most 15 minutes after
 * issue. `issuer` is the project's issuer URL and never changes; `subject` is `<project>:crypt:<crypt>:op:<op>`;
 * `audience` is the one set on your key attachment. The token is a credential: keep it out of logs.
 */
export type FederatedToken = {
  token: string; expiresAt: string; issuer: string; subject: string; audience: string; kid: string;
  /** The project id, when the gateway names it. A hint only: check it against your own configuration. */
  projectId?: string;
  /** The cloud the project's key is attached to, when the gateway names it. A hint only: check it against your own configuration. */
  provider?: string;
};

const FEDERATED_FIELDS = ["token", "expiresAt", "issuer", "subject", "audience", "kid"] as const;

/** An encrypt item as the client core receives it: the plaintext is always bytes. */
export type ClientCoreEncryptItem = { plaintext: Uint8Array; context?: string | undefined };

/**
 * The hook the language's Kibo binding fills: opens and seals data client-side, against your own KMS or HSM, so the platform
 * never sees plaintext or the key. Register one with `client.crypto.useClientCore(core)`. It carries no custody epoch.
 * Return one result per item, in order.
 */
export interface ClientCryptoCore {
  /**
   * Set to `true` only when this core refuses a key that is not in `options.expectedKeyRefs`, before it uses any token or
   * makes any network call. When you set `expectedKeyRefs` on the client and the core does not declare this, the call
   * is refused with `K9O_CRYPTO_KEY_PIN_UNENFORCED` before it reaches the core, because a pin the core ignores would look like a pin.
   */
  readonly enforcesExpectedKeyRefs?: boolean;
  encrypt(crypt: string, items: ReadonlyArray<ClientCoreEncryptItem>, options?: ClientCoreOptions): Promise<EncryptResult> | EncryptResult;
  decrypt(crypt: string, items: ReadonlyArray<CiphertextItem>, options?: ClientCoreOptions): Promise<DecryptResult> | DecryptResult;
  rewrap(crypt: string, items: ReadonlyArray<CiphertextItem>, options?: ClientCoreOptions): Promise<RewrapResult> | RewrapResult;
}

/**
 * What the router passes to the client core on every call. `expectedKeyRefs` is the list you set in the client options.
 * When it is present the core must refuse a key whose reference (version ignored) is not in it, before it uses any
 * token or makes any network call. It is absent when you did not set it.
 */
export type ClientCoreOptions = {
  expectedKeyRefs?: ReadonlyArray<string> | undefined;
};

/**
 * Check `expectedKeyRefs` from the client options and return it as a frozen copy (or `undefined` when not set). It must be a
 * non-empty list of non-blank strings without whitespace, and none may be a wildcard, since a wildcard pins nothing.
 */
export function checkExpectedKeyRefs(refs: ReadonlyArray<string> | undefined): ReadonlyArray<string> | undefined {
  if (refs === undefined) return undefined;
  const bad = (message: string) => invalid(`expectedKeyRefs: ${message}`, { field: "expectedKeyRefs" });
  if (!Array.isArray(refs) || refs.length === 0) throw bad("pass a non-empty list of key identifiers, or leave it out");
  for (const r of refs) {
    if (typeof r !== "string" || r.trim() === "" || /\s/.test(r)) throw bad("each entry must be a key identifier without spaces");
    if (r.includes("*")) throw bad("an entry cannot contain \"*\"; name the exact key");
  }
  return Object.freeze([...refs]);
}

/** The provider whose key reference rules apply (see {@link keyRefMatches}). */
export type KeyRefProvider = "aws" | "gcp" | "azure" | "vault";

function keyIdentity(ref: string, p: KeyRefProvider): string {
  switch (p) {
    case "aws":
      return ref;
    case "gcp":
      return ref.split("/cryptoKeyVersions/")[0] as string;
    case "azure":
      return ref.split("/").slice(0, 5).join("/").toLowerCase();
    case "vault": {
      const cut = ref.lastIndexOf("/");
      const path = cut < 0 ? "" : ref.slice(0, cut);
      const key = cut < 0 ? ref : ref.slice(cut + 1);
      const colon = key.indexOf(":");
      return `${path}/${colon < 0 ? key : key.slice(0, colon)}`;
    }
  }
}

/**
 * Whether `keyRef` is one of `expected`, ignoring the key version, by the rule the Kibo client core applies for `provider`:
 * AWS compares the whole reference; GCP drops `/cryptoKeyVersions/<n>` and what follows; Azure compares the first five
 * `/`-separated parts (`https://<host>/keys/<key>`) in lower case, so a version and the case of the host and key name
 * are ignored; Vault compares `<path>/<key>` without a `:<version>` suffix. The provider is required and is never guessed
 * from the reference: a Vault reference can look like a URL. For authors of a client core; the SDK does not call it.
 */
export function keyRefMatches(keyRef: string, expected: ReadonlyArray<string>, provider: KeyRefProvider): boolean {
  const k = keyIdentity(keyRef, provider);
  return expected.some((e) => keyIdentity(e, provider) === k);
}

export type EncryptItem = {
  /** The data to encrypt: at most 64 KiB. */
  plaintext: CryptoInput;
  /** Binds the ciphertext to this value (at most 256 bytes, sent as a string). Give the same value on decrypt. */
  context?: string | undefined;
};

export type CiphertextItem = {
  /** What `encrypt` returned: base64 of one opaque container. Pass it back unchanged. */
  ciphertext: string;
  /** The same context the data was encrypted with. */
  context?: string | undefined;
};

export type EncryptRequest = { crypt: string; items: ReadonlyArray<EncryptItem> };
export type DecryptRequest = { crypt: string; items: ReadonlyArray<CiphertextItem> };
export type RewrapRequest = { crypt: string; items: ReadonlyArray<CiphertextItem> };

/** One item that failed on its own: the gateway's `code` and `message` for it. The other items of the call may have succeeded. */
export type CryptoItemFailure = { ok: false; code: string; message?: string | undefined; [field: string]: unknown };

/** An encrypted or re-wrapped item. */
export type CiphertextResult = { ok: true; ciphertext: string; [field: string]: unknown };

/** A decrypted item. `text` is `plaintext` read as UTF-8, and is absent when the bytes are not valid UTF-8. */
export type PlaintextResult = { ok: true; plaintext: Uint8Array; text?: string | undefined; [field: string]: unknown };

/** Results arrive in the order of the items you sent. */
export type EncryptResult = { items: Array<CiphertextResult | CryptoItemFailure> };
export type DecryptResult = { items: Array<PlaintextResult | CryptoItemFailure> };
export type RewrapResult = { items: Array<CiphertextResult | CryptoItemFailure> };

function invalid(message: string, context: Record<string, unknown> = {}): KError {
  return new KError({ code: "K9O_INVALID_FIELD_VALUE", message, context, recommendation: null });
}

function tooLarge(message: string, context: Record<string, unknown>): KError {
  return new KError({ code: "K9O_PAYLOAD_TOO_LARGE", message, context, recommendation: "Send smaller items, or split them over several calls." });
}

function requireProjectSlug(config: HttpClientConfig): string {
  if (typeof config.projectSlug !== "string" || config.projectSlug.length === 0) {
    throw new Error("crypto operations require projectSlug bound on the client");
  }
  return config.projectSlug;
}

function toBytes(v: CryptoInput, where: string): Uint8Array {
  if (typeof v === "string") return new TextEncoder().encode(v);
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw invalid(`${where} must be bytes (Uint8Array or ArrayBuffer) or a string`);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function checkEnvelope(req: { crypt: string; items: ReadonlyArray<unknown> }, op: string): void {
  if (typeof req !== "object" || req === null) throw invalid(`crypto.${op}: pass { crypt, items }`);
  if (typeof req.crypt !== "string" || !CRYPT.test(req.crypt)) {
    throw invalid(`crypto.${op}: ${CRYPT_RULE}`, { field: "crypt" });
  }
  if (!Array.isArray(req.items) || req.items.length < 1 || req.items.length > CRYPTO_MAX_ITEMS) {
    throw invalid(`crypto.${op}: items must hold 1 to ${CRYPTO_MAX_ITEMS} entries`, { field: "items" });
  }
}

function wireContext(item: { context?: string | undefined }, op: string, i: number): { context?: string } {
  const c = item.context;
  if (c === undefined) return {};
  if (typeof c !== "string") throw invalid(`crypto.${op}: items[${i}].context must be a string`, { field: `items[${i}].context` });
  if (new TextEncoder().encode(c).length > CRYPTO_MAX_CONTEXT_BYTES) {
    throw invalid(`crypto.${op}: items[${i}].context is longer than ${CRYPTO_MAX_CONTEXT_BYTES} bytes`, { field: `items[${i}].context` });
  }
  return { context: c };
}

function encryptBody(req: EncryptRequest): { crypt: string; items: Array<{ plaintext: string; context?: string }> } {
  checkEnvelope(req, "encrypt");
  let total = 0;
  const items = req.items.map((item, i) => {
    if (typeof item !== "object" || item === null || !("plaintext" in item)) throw invalid(`crypto.encrypt: items[${i}] needs a plaintext`, { field: `items[${i}]` });
    const bytes = toBytes(item.plaintext, `crypto.encrypt: items[${i}].plaintext`);
    if (bytes.length > CRYPTO_MAX_ITEM_BYTES) {
      throw tooLarge(`crypto.encrypt: items[${i}].plaintext is ${bytes.length} bytes; the limit is ${CRYPTO_MAX_ITEM_BYTES} (64 KiB) per item`, { field: `items[${i}].plaintext`, limitBytes: CRYPTO_MAX_ITEM_BYTES });
    }
    total += bytes.length;
    return { plaintext: bytesToBase64(bytes), ...wireContext(item, "encrypt", i) };
  });
  if (total > CRYPTO_MAX_CALL_BYTES) {
    throw tooLarge(`crypto.encrypt: the plaintext adds up to ${total} bytes; the limit is ${CRYPTO_MAX_CALL_BYTES} (1 MiB) per call`, { limitBytes: CRYPTO_MAX_CALL_BYTES });
  }
  return { crypt: req.crypt, items };
}

function ciphertextBody(req: DecryptRequest | RewrapRequest, op: string): { crypt: string; items: Array<{ ciphertext: string; context?: string }> } {
  checkEnvelope(req, op);
  const items = req.items.map((item, i) => {
    if (typeof item !== "object" || item === null || typeof item.ciphertext !== "string" || item.ciphertext.length === 0) {
      throw invalid(`crypto.${op}: items[${i}] needs the ciphertext string that encrypt returned`, { field: `items[${i}].ciphertext` });
    }
    return { ciphertext: item.ciphertext, ...wireContext(item, op, i) };
  });
  return { crypt: req.crypt, items };
}

/** Keep every field the gateway sent; read the ones this SDK knows. */
function decodeItems<R>(res: Envelope<unknown>, sent: number, op: string, ok: (o: Record<string, unknown>) => R | null): Array<R | CryptoItemFailure> {
  const list = (res.data as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(list) || list.length !== sent) {
    throw new KError({
      code: "K9O_INTERNAL_ERROR",
      message: `crypto.${op}: the gateway answered ${Array.isArray(list) ? list.length : "no"} items for ${sent} sent`,
      context: { sent, received: Array.isArray(list) ? list.length : null },
      status: null,
    });
  }
  return list.map((raw): R | CryptoItemFailure => {
    const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof o["code"] === "string") {
      const { code, message, ...rest } = o;
      return { ...rest, ok: false, code: code as string, message: typeof message === "string" ? message : undefined };
    }
    const good = ok(o);
    if (good !== null) return good;
    return { ...o, ok: false, code: "K9O_INTERNAL_ERROR", message: "the gateway sent an item with neither a result nor a code" };
  });
}

function textOf(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function coreUnavailable(custodyMode: string): KError {
  return new KError({
    code: CRYPTO_ERR_ZK_CLIENT_CORE_UNAVAILABLE,
    message: "this project's key is held in your own KMS; install and register the Kibo client core for this language, or call kibo.encrypt/decrypt directly",
    context: { custodyMode, requirement: "kibo-client-core" },
    recommendation: "Register the Kibo client core with client.crypto.useClientCore(core), or call kibo.encrypt and kibo.decrypt directly.",
    status: 501,
  });
}

function custodyUnknown(message: string, context: Record<string, unknown>): KError {
  return new KError({ code: CRYPTO_ERR_CUSTODY_UNKNOWN, message: `${message}; nothing was sent`, context, recommendation: null, status: null });
}

function isFlowRequired(e: unknown): e is KError {
  return e instanceof KError && e.status === 409 && e.code === CRYPTO_ERR_ZK_STORE_FLOW_REQUIRED;
}

function wantsClientRoute(e: unknown): e is KError {
  return isFlowRequired(e) && e.context["route"] === "client";
}

function coreResult<R>(res: { items?: unknown }, sent: number, op: string): R {
  if (typeof res !== "object" || res === null || !Array.isArray(res.items) || res.items.length !== sent) {
    throw new KError({ code: "K9O_INTERNAL_ERROR", message: `crypto.${op}: the client core returned a different number of results than items`, context: { sent }, status: null });
  }
  return res as R;
}

export function makeCryptoNamespace(config: HttpClientConfig) {
  const path = (op: string) => projectPath(requireProjectSlug(config), `crypto/${op}`);
  let clientCore: ClientCryptoCore | null = null;
  const coreOptions = (): ClientCoreOptions => ({
    ...(config.expectedKeyRefs === undefined ? {} : { expectedKeyRefs: config.expectedKeyRefs }),
  });

  const readMode = async (crypt?: string): Promise<Envelope<CryptoMode>> => {
    if (crypt !== undefined && (typeof crypt !== "string" || !CRYPT.test(crypt))) {
      throw invalid(`crypto.mode: ${CRYPT_RULE}`, { field: "crypt" });
    }
    const res = await request<unknown>(config, { method: "GET", path: path("mode"), ...(crypt === undefined ? {} : { query: { crypt } }) });
    const d = res.data as { custodyMode?: unknown; epoch?: unknown; route?: unknown } | null | undefined;
    if (typeof d !== "object" || d === null || typeof d.custodyMode !== "string" || typeof d.epoch !== "string") {
      throw new KError({ code: "K9O_INTERNAL_ERROR", message: "crypto.mode: the gateway answered without a custodyMode and epoch", context: {}, status: null });
    }
    return { ...res, data: { custodyMode: d.custodyMode, epoch: d.epoch, ...(d.route === "client" || d.route === "server" ? { route: d.route } : {}) } };
  };

  /**
   * The fresh check before every encrypt. A failed mode call rethrows the original error unchanged; an unknown, missing or
   * malformed answer raises `K9O_CRYPTO_CUSTODY_UNKNOWN`. Either way no plaintext goes anywhere.
   */
  const checkMode = async (crypt: string): Promise<CryptoMode & { route: "server" | "client" }> => {
    const res = await request<unknown>(config, { method: "GET", path: path("mode"), query: { crypt } });
    const d = res.data as { custodyMode?: unknown; epoch?: unknown; route?: unknown } | null | undefined;
    const seen = typeof d === "object" && d !== null && typeof d.custodyMode === "string" ? d.custodyMode : undefined;
    const context: Record<string, unknown> = seen !== undefined && seen !== "" ? { custodyMode: seen } : {};
    if (seen === undefined || seen === "") throw custodyUnknown("crypto.encrypt: the custody mode answer has no custodyMode", context);
    const rawRoute: unknown = d?.route;
    if (rawRoute !== undefined && rawRoute !== "server" && rawRoute !== "client") {
      if (typeof rawRoute === "string") context["route"] = rawRoute;
      throw custodyUnknown("crypto.encrypt: the custody mode answer has an unknown route", context);
    }
    const epoch = typeof d?.epoch === "string" ? d.epoch : "";
    if (SERVER_MODES.has(seen)) {
      if (epoch === "") throw custodyUnknown(`crypto.encrypt: the custody mode answer for ${seen} has no epoch`, context);
      return { custodyMode: seen, epoch, route: "server" };
    }
    if (CLIENT_MODES.has(seen)) {
      if (rawRoute !== "server") return { custodyMode: seen, epoch, route: "client" };
      if (epoch === "") throw custodyUnknown(`crypto.encrypt: the custody mode answer for ${seen} names the server route but has no epoch`, context);
      return { custodyMode: seen, epoch, route: "server" };
    }
    throw custodyUnknown(`crypto.encrypt: unknown custody mode "${seen}"`, context);
  };

  const needCore = (custodyMode: string): ClientCryptoCore => {
    if (clientCore === null) throw coreUnavailable(custodyMode);
    if (config.expectedKeyRefs !== undefined && clientCore.enforcesExpectedKeyRefs !== true) {
      throw new KError({
        code: CRYPTO_ERR_KEY_PIN_UNENFORCED,
        message: "expectedKeyRefs is set but the client core does not declare that it enforces it; nothing was sent",
        context: { custodyMode, requirement: "client-core-enforces-expected-key-refs" },
        recommendation: "Use a client core that enforces the pin (it sets enforcesExpectedKeyRefs to true), or leave expectedKeyRefs out.",
        status: null,
      });
    }
    return clientCore;
  };

  const ciphertextOp = async <R>(op: "decrypt" | "rewrap", req: DecryptRequest | RewrapRequest, decode: (res: Envelope<unknown>, n: number) => R): Promise<Envelope<R>> => {
    requireProjectSlug(config);
    const body = ciphertextBody(req, op);
    try {
      const res = await request<unknown>(config, { method: "POST", path: path(op), body });
      return { ...res, data: decode(res, body.items.length) };
    } catch (e) {
      if (!wantsClientRoute(e)) throw e;
      const mode = typeof e.context["custodyMode"] === "string" ? (e.context["custodyMode"] as string) : "unknown";
      const core = needCore(mode);
      const items = body.items.map((it) => ({ ciphertext: it.ciphertext, ...(it.context !== undefined ? { context: it.context } : {}) }));
      const out = op === "decrypt" ? await core.decrypt(body.crypt, items, coreOptions()) : await core.rewrap(body.crypt, items, coreOptions());
      return { data: coreResult<R>(out, items.length, op), meta: {} };
    }
  };

  const cryptOf = (d: unknown, op: string): Crypt => {
    const o = d as Record<string, unknown> | null | undefined;
    const bad = (why: string) => new KError({ code: "K9O_INTERNAL_ERROR", message: `crypto.crypts.${op}: the gateway answered ${why}`, context: {}, status: null });
    if (typeof o !== "object" || o === null) throw bad("without a crypt");
    if (typeof o.name !== "string" || o.name === "") throw bad("without a name");
    if (o.status !== "active" && o.status !== "retired") throw bad("with an unknown status");
    if (typeof o.createdAt !== "string" || o.createdAt === "") throw bad("without createdAt");
    if (o.retiredAt !== null && typeof o.retiredAt !== "string") throw bad("with a retiredAt that is neither a date nor null");
    return { name: o.name, status: o.status, createdAt: o.createdAt, retiredAt: o.retiredAt };
  };
  const checkCryptName = (name: unknown, op: string): string => {
    if (typeof name !== "string" || !CRYPT.test(name)) throw invalid(`crypto.crypts.${op}: ${CRYPT_RULE}`, { field: "name" });
    return name;
  };
  const crypts = {
    /**
     * The crypts you hold: every one of them if you have a `*` grant on crypts, none if you are a member with no grant.
     * Errors: 403 `K9O_ACCESS_DENIED` (not a project member), 503 if the registry cannot be read.
     */
    async list(): Promise<Envelope<{ crypts: Crypt[] }>> {
      const res = await request<unknown>(config, { method: "GET", path: path("crypts") });
      const d = res.data as { crypts?: unknown } | null | undefined;
      if (typeof d !== "object" || d === null || !Array.isArray(d.crypts)) {
        throw new KError({ code: "K9O_INTERNAL_ERROR", message: "crypto.crypts.list: the gateway answered without crypts", context: {}, status: null });
      }
      return { ...res, data: { crypts: d.crypts.map((c) => cryptOf(c, "list")) } };
    },

    /**
     * Register a crypt so `encrypt` accepts it. `name` is 1 to 64 characters of a-z, 0-9 and "-", and not "actions"; a bad
     * name is refused before anything is sent. Needs `crypto:manage_crypts` (project admins by default).
     * Errors: 409 `K9O_CRYPT_ALREADY_EXISTS`, 409 `K9O_CRYPT_LIMIT_EXCEEDED` (256 per project, retired ones counted),
     * 409 `K9O_CRYPT_RETIRED` (a retired name cannot be used again).
     */
    async create(name: string): Promise<Envelope<Crypt>> {
      requireProjectSlug(config);
      checkCryptName(name, "create");
      const res = await request<unknown>(config, { method: "POST", path: path("crypts"), body: { name } });
      return { ...res, data: cryptOf(res.data, "create") };
    },

    /**
     * Retire a crypt: `encrypt` then refuses the name. `decrypt` and `rewrap` never read the registry, so data stays
     * readable. This does not isolate, enforce or destroy anything. Needs `crypto:manage_crypts`; a personal access token
     * is refused with `K9O_RBAC_DENY`. Errors: 404 `K9O_CRYPT_NOT_FOUND`, 409 `K9O_CRYPT_RETIRED`.
     */
    async retire(name: string): Promise<Envelope<Crypt>> {
      requireProjectSlug(config);
      checkCryptName(name, "retire");
      const res = await request<unknown>(config, { method: "POST", path: path(`crypts/${name}/retire`) });
      return { ...res, data: cryptOf(res.data, "retire") };
    },
  };
  return {
    crypts,
    /**
     * The project's custody state: `{ custodyMode, epoch, route? }`. `epoch` is opaque and changes with every custody transition.
     * `route` is `"client"` or `"server"` (absent on older gateways, or when the gateway named an unknown value): follow it, not `custodyMode`.
     * `encrypt` calls this itself before every call; you need it only to look.
     */
    async mode(crypt?: string): Promise<Envelope<CryptoMode>> {
      return readMode(crypt);
    },

    /**
     * A short-lived identity token for a crypt and an operation, to present to your own cloud's token exchange
     * (`POST /@{project}/crypto/federated-token`). The platform never sees your key or plaintext. Needs the project editor
     * role. `crypt` is 1 to 64 characters of a-z, 0-9 and "-"; `op` is `"encrypt"`, `"decrypt"` or `"rewrap"`; a bad
     * value is refused before anything is sent. The token lasts at most 15 minutes; ask again when `expiresAt` passes.
     * Errors: 409 `K9O_CUSTODY_SERVER_ROUTE` (no token is issued; `context.route` is `server` when the platform holds the key or the install is self-hosted,
     * or `client-idp` when the platform has no identity token for the key's provider), 429 `K9O_RATE_LIMITED`, 503 `K9O_KEY_SERVICE_UNAVAILABLE` (nothing was issued).
     * Never retried by the SDK.
     */
    async federatedToken(req: FederatedTokenRequest): Promise<Envelope<FederatedToken>> {
      requireProjectSlug(config);
      if (typeof req !== "object" || req === null) throw invalid("crypto.federatedToken: pass { crypt, op }");
      if (typeof req.crypt !== "string" || !CRYPT.test(req.crypt)) {
        throw invalid(`crypto.federatedToken: ${CRYPT_RULE}`, { field: "crypt" });
      }
      if (typeof req.op !== "string" || !FEDERATED_OPS.has(req.op)) {
        throw invalid(`crypto.federatedToken: op must be "encrypt", "decrypt" or "rewrap"`, { field: "op" });
      }
      const res = await request<unknown>(config, { method: "POST", path: path("federated-token"), body: { crypt: req.crypt, op: req.op } });
      const d = res.data as Record<string, unknown> | null | undefined;
      const out: Record<string, string> = {};
      for (const k of FEDERATED_FIELDS) {
        const v = typeof d === "object" && d !== null ? d[k] : undefined;
        if (typeof v !== "string" || v === "") {
          throw new KError({ code: "K9O_INTERNAL_ERROR", message: `crypto.federatedToken: the gateway answered without ${k}`, context: {}, status: null });
        }
        out[k] = v;
      }
      for (const k of ["projectId", "provider"] as const) {
        const v = typeof d === "object" && d !== null ? d[k] : undefined;
        if (typeof v === "string" && v !== "") out[k] = v;
      }
      return { ...res, data: out as FederatedToken };
    },

    /**
     * Register the client core (the Kibo binding) that serves BYOK and HYOK projects. Pass `null` to remove it. Without
     * one, a call that needs the client route raises 501 `K9O_ZK_CLIENT_CORE_UNAVAILABLE`.
     */
    useClientCore(core: ClientCryptoCore | null): void {
      clientCore = core;
    },

    /**
     * Encrypt up to 100 items under the project's key. Each item is bytes or a UTF-8 string, at most 64 KiB, and the call
     * at most 1 MiB; the SDK refuses more before sending (`K9O_PAYLOAD_TOO_LARGE`). Results come in item order; an item
     * can fail on its own (`{ ok: false, code }`). The same `crypt` and `context` must be given on decrypt.
     * The custody mode is read fresh on every call (never cached). Platform-held keys go to the platform with the epoch;
     * BYOK and HYOK go to the client core, and with none registered the call raises 501 `K9O_ZK_CLIENT_CORE_UNAVAILABLE`
     * without sending anything. An unknown, missing or malformed answer raises `K9O_CRYPTO_CUSTODY_UNKNOWN`, and a failed mode call rethrows its own
     * error, both without sending. If custody moves between the check and the send (409 `K9O_ZK_STORE_FLOW_REQUIRED`) the SDK checks and routes
     * once more, then raises the 409.
     * Errors: 404 `K9O_CRYPT_NOT_FOUND` (the crypt is not registered), 409 `K9O_CRYPT_RETIRED` (it is retired; decrypt and rewrap
     * are not refused for either), 429 `K9O_RATE_LIMITED` (`retryAfterSec`), 503 `K9O_KEY_SERVICE_UNAVAILABLE` (the whole call failed). Never retried by the SDK.
     */
    async encrypt(req: EncryptRequest): Promise<Envelope<EncryptResult>> {
      requireProjectSlug(config);
      const body = encryptBody(req);
      for (let attempt = 0; ; attempt++) {
        const mode = await checkMode(body.crypt);
        if (mode.route === "client") {
          const core = needCore(mode.custodyMode);
          const items = body.items.map((it) => ({ plaintext: base64ToBytes(it.plaintext), ...(it.context !== undefined ? { context: it.context } : {}) }));
          const out = await core.encrypt(body.crypt, items, coreOptions());
          return { data: coreResult<EncryptResult>(out, items.length, "encrypt"), meta: {} };
        }
        try {
          const res = await request<unknown>(config, { method: "POST", path: path("encrypt"), body: { ...body, custodyEpoch: mode.epoch } });
          return { ...res, data: { items: decodeItems<CiphertextResult>(res, body.items.length, "encrypt", ciphertextItem) } };
        } catch (e) {
          if (attempt === 0 && isFlowRequired(e)) continue;
          throw e;
        }
      }
    },

    /**
     * Decrypt up to 100 items. Give the same `crypt` and `context` as on encrypt. Results come in item order, as bytes
     * (`plaintext`) with `text` when they are UTF-8.
     * The ciphertext goes to the platform first. If it belongs to a key held in your own KMS or HSM the platform answers
     * 409 `K9O_ZK_STORE_FLOW_REQUIRED` with `context.route` `"client"` and the SDK opens it with the client core (501
     * `K9O_ZK_CLIENT_CORE_UNAVAILABLE` when none is registered). Only ciphertext crosses in the first call.
     * Errors: 400 `K9O_ENVELOPE_INTEGRITY_FAILURE` for every ciphertext that cannot be opened (wrong crypt or context,
     * damaged, another project's); the gateway gives one code for all of them, so the SDK cannot tell you which.
     * 409 `K9O_SEALED_UNDER_RETIRED_KEY` (`context.resealableUntil` while `rewrap` still works), 429, 503 as for encrypt.
     */
    async decrypt(req: DecryptRequest): Promise<Envelope<DecryptResult>> {
      const r = await ciphertextOp<DecryptResult>("decrypt", req, (res, n) => ({ items: decodeItems<PlaintextResult>(res, n, "decrypt", plaintextItem) }));
      return r;
    },

    /**
     * Open each ciphertext and seal it again under the project's current key version, in one call; on the platform route
     * the plaintext never leaves the platform. The fix for 409 `K9O_SEALED_UNDER_RETIRED_KEY` while the re-seal window is
     * open. Same crypt and context as on encrypt. Routes and errors as for decrypt.
     */
    async rewrap(req: RewrapRequest): Promise<Envelope<RewrapResult>> {
      return ciphertextOp<RewrapResult>("rewrap", req, (res, n) => ({ items: decodeItems<CiphertextResult>(res, n, "rewrap", ciphertextItem) }));
    },
  };
}

function ciphertextItem(o: Record<string, unknown>): CiphertextResult | null {
  return typeof o["ciphertext"] === "string" ? { ...o, ok: true, ciphertext: o["ciphertext"] } : null;
}

function plaintextItem(o: Record<string, unknown>): PlaintextResult | null {
  const p = o["plaintext"];
  if (typeof p !== "string") return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(p);
  } catch {
    return null;
  }
  return { ...o, ok: true, plaintext: bytes, text: textOf(bytes) };
}
