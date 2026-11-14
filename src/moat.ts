/**
 * Moat: a local guard around one model call. It runs in your process, makes no network call and needs no account.
 *
 * What it does:
 *   1. Pins the system prompt. `messages(input)` builds the message list itself: your prompt is always the one
 *      `system` message and the untrusted input is always a `user` message, never a `system` one.
 *   2. Refuses untrusted input that carries a role or system marker (a refusal, not a sanitiser).
 *   3. Enforces a declared input schema and a declared output schema.
 *   4. Filters the output for personal data through a function you pass (optional).
 *
 * The pin is structural. It stops injected text from becoming the system prompt; it does not stop that text from
 * reaching the model, so keep treating the model's answer as untrusted and check it with `checkOutput`.
 *
 * A refusal is thrown as `MoatRefusal`, with a `reason` from a closed set and a short `detail` that never repeats
 * the refused content. A bad prompt or schema given to the constructor throws `MoatConfigError`.
 *
 * Schema language: a subset of JSON Schema. Supported keywords: `type` (object, array, string, number, integer,
 * boolean, null, or a list of them), `properties`, `required`, `additionalProperties` (true or false), `items` (one
 * schema), `enum`, `const`, `minLength`, `maxLength`, `pattern` (a regular expression, searched, not anchored),
 * `minimum`, `maximum`, `minItems`, `maxItems`. Any other keyword is rejected by the constructor, so a typo never
 * switches a check off.
 */

import { sha256Hex } from "./sha256.ts";

/** Why a call was refused. The set is closed. */
export type MoatReason = "role_marker" | "input_schema" | "output_schema" | "pii";

export const MOAT_REASONS: ReadonlyArray<MoatReason> = ["role_marker", "input_schema", "output_schema", "pii"];

/** Thrown when input or output is refused. */
export class MoatRefusal extends Error {
  readonly reason: MoatReason;
  readonly detail: string;
  constructor(reason: MoatReason, detail: string) {
    super(`moat refused (${reason}): ${detail}`);
    this.name = "MoatRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

/** Thrown by the constructor for an empty prompt, an unsupported schema keyword or a malformed schema. */
export class MoatConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoatConfigError";
  }
}

export type MoatType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

/** The supported JSON Schema subset. */
export type MoatSchema = {
  type?: MoatType | ReadonlyArray<MoatType>;
  properties?: Readonly<Record<string, MoatSchema>>;
  required?: ReadonlyArray<string>;
  additionalProperties?: boolean;
  items?: MoatSchema;
  enum?: ReadonlyArray<unknown>;
  const?: unknown;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

/**
 * What a PII filter says about a piece of text: `true`, a number above 0, a non-empty array, or an object with
 * `found: true` or `total` above 0 means personal data was found. Anything else that is not one of those shapes is
 * treated as a refusal (the filter is not understood, so the output is not passed).
 */
export type MoatPiiResult = boolean | number | ReadonlyArray<unknown> | { found?: boolean; total?: number };

export type MoatPiiFilter =
  | ((text: string) => MoatPiiResult | Promise<MoatPiiResult>)
  | { detect(text: string): MoatPiiResult | Promise<MoatPiiResult> };

export type MoatOptions = {
  /** The system prompt, pinned. */
  prompt: string;
  /** Schema the untrusted input must satisfy before it is placed in the message list. */
  inputSchema?: MoatSchema;
  /** Schema the model output must satisfy. */
  outputSchema?: MoatSchema;
  filters?: {
    /** Called with the output as text; see {@link MoatPiiResult}. Without it there is no PII step. */
    pii?: MoatPiiFilter;
  };
};

export type MoatMessage = { role: "system" | "user"; content: string };

const KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum", "const", "minLength", "maxLength", "pattern",
  "minimum", "maximum", "minItems", "maxItems",
]);
const TYPES: ReadonlyArray<string> = ["object", "array", "string", "number", "integer", "boolean", "null"];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkCount(schema: Record<string, unknown>, key: string, path: string): void {
  const v = schema[key];
  if (v !== undefined && !(typeof v === "number" && Number.isInteger(v) && v >= 0)) {
    throw new MoatConfigError(`${path}: ${key} must be a non-negative integer`);
  }
}

/** Reject anything outside the subset. Exported for tests of the construction rules. */
export function assertSupportedSchema(schema: unknown, path = "$"): asserts schema is MoatSchema {
  if (!isObj(schema)) throw new MoatConfigError(`${path}: a schema must be an object`);
  for (const k of Object.keys(schema)) {
    if (!KEYWORDS.has(k)) throw new MoatConfigError(`${path}: unsupported schema keyword "${k}"`);
  }
  const t = schema["type"];
  if (t !== undefined) {
    const list = Array.isArray(t) ? t : [t];
    if (list.length === 0 || !list.every((x) => typeof x === "string" && TYPES.includes(x))) {
      throw new MoatConfigError(`${path}: type must be one of ${TYPES.join(", ")} or a list of them`);
    }
  }
  const props = schema["properties"];
  if (props !== undefined) {
    if (!isObj(props)) throw new MoatConfigError(`${path}: properties must be an object of schemas`);
    for (const [k, v] of Object.entries(props)) assertSupportedSchema(v, `${path}.${k}`);
  }
  const req = schema["required"];
  if (req !== undefined && !(Array.isArray(req) && req.every((x) => typeof x === "string"))) {
    throw new MoatConfigError(`${path}: required must be a list of property names`);
  }
  const ap = schema["additionalProperties"];
  if (ap !== undefined && typeof ap !== "boolean") throw new MoatConfigError(`${path}: additionalProperties must be true or false`);
  if (schema["items"] !== undefined) assertSupportedSchema(schema["items"], `${path}[]`);
  const en = schema["enum"];
  if (en !== undefined && !(Array.isArray(en) && en.length > 0)) throw new MoatConfigError(`${path}: enum must be a non-empty list`);
  for (const k of ["minLength", "maxLength", "minItems", "maxItems"]) checkCount(schema, k, path);
  const pat = schema["pattern"];
  if (pat !== undefined) {
    if (typeof pat !== "string") throw new MoatConfigError(`${path}: pattern must be a string`);
    try {
      new RegExp(pat);
    } catch {
      throw new MoatConfigError(`${path}: pattern is not a valid regular expression`);
    }
  }
  for (const k of ["minimum", "maximum"]) {
    const v = schema[k];
    if (v !== undefined && !(typeof v === "number" && Number.isFinite(v))) throw new MoatConfigError(`${path}: ${k} must be a finite number`);
  }
}

function typeOf(v: unknown): MoatType | "other" {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "string": return "string";
    case "boolean": return "boolean";
    case "number": return Number.isFinite(v) ? (Number.isInteger(v) ? "integer" : "number") : "other";
    case "object": return "object";
    default: return "other";
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

const len = (s: string): number => Array.from(s).length;

/** The first violation of `schema` by `value` as a short message without the value, or null when it conforms. */
function violation(value: unknown, schema: MoatSchema, path: string): string | null {
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const list = Array.isArray(schema.type) ? (schema.type as ReadonlyArray<MoatType>) : [schema.type as MoatType];
    const ok = list.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) return `${path}: expected ${list.join(" or ")}, got ${actual}`;
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) return `${path}: does not equal the required constant`;
  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(e, value))) return `${path}: not one of the allowed values`;
  if (typeof value === "string") {
    if (schema.minLength !== undefined && len(value) < schema.minLength) return `${path}: shorter than ${schema.minLength}`;
    if (schema.maxLength !== undefined && len(value) > schema.maxLength) return `${path}: longer than ${schema.maxLength}`;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return `${path}: does not match the pattern`;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path}: below ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path}: above ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path}: fewer than ${schema.minItems} items`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path}: more than ${schema.maxItems} items`;
    if (schema.items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        const v = violation(value[i], schema.items, `${path}[${i}]`);
        if (v !== null) return v;
      }
    }
  }
  if (isObj(value)) {
    for (const k of schema.required ?? []) if (!Object.hasOwn(value, k)) return `${path}: missing required property "${k}"`;
    const props = schema.properties ?? {};
    for (const k of Object.keys(value)) {
      if (Object.hasOwn(props, k)) {
        const v = violation(value[k], props[k]!, `${path}.${k}`);
        if (v !== null) return v;
      } else if (schema.additionalProperties === false) {
        return `${path}: unexpected property "${k}"`;
      }
    }
  }
  return null;
}

// --- role markers ---

/**
 * Default-ignorable and format code points, removed before matching (the Moat contract table, as code point ranges;
 * no platform property lookup is used). Each entry is [first, last].
 */
export const DEFAULT_IGNORABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xfff8], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0000, 0xe0fff],
];
const hex = (n: number): string => `\\u{${n.toString(16)}}`;
const IGNORABLE = new RegExp(`[${DEFAULT_IGNORABLE_RANGES.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join("")}]`, "gu");
const LINE_ROLE = /^ *(system|assistant|developer|tool|user) *:/;
const ROLE_JSON = /"role"\s*:\s*"\s*(system|developer|assistant)\s*"/;
const MARKERS: ReadonlyArray<string> = [
  "<|system|>", "<|im_start|>", "<|im_end|>", "[inst]", "<<sys>>", "### system", "### instruction",
];

/**
 * Cyrillic and Greek look-alikes of the marker letters, read as the Latin letter (comparison text only, applied before case-folding).
 * This is not general homoglyph detection. Mirrors audit/reference/moat-confusables.json; a test guards against drift.
 */
export const MOAT_CONFUSABLES: Readonly<Record<string, string>> = {
  "\u0430": "a",
  "\u0410": "a",
  "\u0441": "c",
  "\u0421": "c",
  "\u0435": "e",
  "\u0415": "e",
  "\u0456": "i",
  "\u0406": "i",
  "\u043e": "o",
  "\u041e": "o",
  "\u0440": "p",
  "\u0420": "p",
  "\u0455": "s",
  "\u0405": "s",
  "\u0443": "y",
  "\u0423": "y",
  "\u0501": "d",
  "\u04cf": "l",
  "\u04c0": "l",
  "\u0422": "t",
  "\u041c": "m",
  "\u041d": "h",
  "\u0445": "x",
  "\u0425": "x",
  "\u0442": "t",
  "\u0391": "a",
  "\u03b1": "a",
  "\u0395": "e",
  "\u03b5": "e",
  "\u0399": "i",
  "\u03b9": "i",
  "\u039f": "o",
  "\u03bf": "o",
  "\u03a1": "p",
  "\u03c1": "p",
  "\u03a4": "t",
  "\u03c4": "t",
  "\u03a5": "y",
  "\u03c5": "u",
  "\u03bd": "v",
  "\u039c": "m",
  "\u039d": "n",
  "\u03a7": "x",
  "\u03c7": "x",
  "\u03f2": "c",
  "\u03f9": "c",
  "\u0397": "h",
};

function foldConfusables(s: string): string {
  let out = "";
  for (const ch of s) out += MOAT_CONFUSABLES[ch] ?? ch;
  return out;
}

const COMBINING = /[\p{Mn}\p{Me}]/gu;

function normalise(s: string): string {
  // NFKC, NFKD with combining marks dropped, drop ignorable code points, map confusables to Latin, case-fold, collapse horizontal whitespace (line breaks stay). Matching only.
  return foldConfusables(s.normalize("NFKC").normalize("NFKD").replace(COMBINING, "").replace(IGNORABLE, "")).toLowerCase().replace(/[\t\p{Zs}]+/gu, " ");
}

function* strings(v: unknown): Generator<string> {
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x);
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) { yield k; yield* strings(x); }
}

function roleKeyed(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(roleKeyed);
  if (!isObj(v)) return false;
  for (const [k, x] of Object.entries(v)) {
    if (normalise(k).trim() === "role" && typeof x === "string" && ["system", "developer", "assistant"].includes(normalise(x).trim())) return true;
    if (roleKeyed(x)) return true;
  }
  return false;
}

function markerIn(text: string): string | null {
  const n = normalise(text);
  for (const line of n.split(/[\r\n\u0085\u2028\u2029]/)) {
    const m = LINE_ROLE.exec(line);
    if (m !== null) return `a line starts with "${m[1]}:"`;
  }
  const flat = n.replace(/\s+/g, " ");
  for (const m of MARKERS) if (flat.includes(m)) return `contains the marker ${m}`;
  if (ROLE_JSON.test(flat)) return "contains a JSON object with a role of system, developer or assistant";
  return null;
}

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  const s = JSON.stringify(v);
  if (s === undefined) throw new MoatRefusal("input_schema", "the input cannot be written as JSON");
  return s;
}

export class Moat {
  readonly #prompt: string;
  readonly #inputSchema: MoatSchema | undefined;
  readonly #outputSchema: MoatSchema | undefined;
  readonly #pii: ((text: string) => MoatPiiResult | Promise<MoatPiiResult>) | undefined;

  constructor(options: MoatOptions) {
    if (typeof options?.prompt !== "string" || options.prompt.length === 0) throw new MoatConfigError("prompt must be a non-empty string");
    // A runtime whose normalize() does nothing would let a fullwidth label through the marker scan: refuse to start.
    if (typeof String.prototype.normalize !== "function" || "\uff53".normalize("NFKC") !== "s") {
      throw new MoatConfigError("this runtime cannot do Unicode NFKC normalisation, which Moat needs for its marker scan");
    }
    if (options.inputSchema !== undefined) assertSupportedSchema(options.inputSchema, "inputSchema");
    if (options.outputSchema !== undefined) assertSupportedSchema(options.outputSchema, "outputSchema");
    const pii = options.filters?.pii;
    if (pii !== undefined && typeof pii !== "function" && typeof pii?.detect !== "function") {
      throw new MoatConfigError("filters.pii must be a function or an object with a detect(text) method");
    }
    this.#prompt = options.prompt;
    this.#inputSchema = options.inputSchema;
    this.#outputSchema = options.outputSchema;
    this.#pii = pii === undefined ? undefined : typeof pii === "function" ? pii : (t) => pii.detect(t);
  }

  /**
   * The message list for one model call: the pinned prompt as `system`, then the untrusted input as text in a `user`
   * message (a string as it is, anything else as JSON). Throws `MoatRefusal` (`input_schema` or `role_marker`).
   */
  messages(untrustedInput: unknown): MoatMessage[] {
    if (this.#inputSchema !== undefined) {
      const v = violation(untrustedInput, this.#inputSchema, "$");
      if (v !== null) throw new MoatRefusal("input_schema", v);
    }
    const text = asText(untrustedInput);
    let found = markerIn(text);
    if (found === null) {
      // Object input is written as one JSON line, which hides line starts: look inside every string as well.
      let parsed: unknown = untrustedInput;
      if (typeof untrustedInput === "string") {
        try { parsed = JSON.parse(untrustedInput); } catch { parsed = untrustedInput; }
      }
      for (const s of strings(parsed)) {
        found = markerIn(s);
        if (found !== null) break;
      }
      if (found === null && roleKeyed(parsed)) found = "contains a JSON object with a role of system, developer or assistant";
    }
    if (found !== null) throw new MoatRefusal("role_marker", found);
    return [
      { role: "system", content: this.#prompt },
      { role: "user", content: text },
    ];
  }

  /**
   * Check what the model returned. Without an output schema the value is returned as it is. With one, a string is
   * parsed as JSON first (unless the schema asks for a string) and must conform; then the PII filter, if any, sees
   * the output as text. Returns the validated value. Throws `MoatRefusal` (`output_schema` or `pii`).
   */
  async checkOutput(modelOutput: unknown): Promise<unknown> {
    let value = modelOutput;
    const schema = this.#outputSchema;
    if (schema !== undefined) {
      const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
      const stringOnly = types.length === 1 && types[0] === "string";
      if (typeof modelOutput === "string" && !stringOnly) {
        try {
          value = JSON.parse(modelOutput);
        } catch {
          if (!types.includes("string")) throw new MoatRefusal("output_schema", "the output is not valid JSON");
        }
      }
      const v = violation(value, schema, "$");
      if (v !== null) throw new MoatRefusal("output_schema", v);
    }
    if (this.#pii !== undefined) {
      const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
      let r: MoatPiiResult;
      try {
        r = await this.#pii(text);
      } catch {
        throw new MoatRefusal("pii", "the PII filter failed, so the output is not passed");
      }
      const hit =
        typeof r === "boolean" ? r
        : typeof r === "number" ? r > 0
        : Array.isArray(r) ? r.length > 0
        : isObj(r) && (typeof r["found"] === "boolean" || typeof r["total"] === "number")
          ? r["found"] === true || (typeof r["total"] === "number" && r["total"] > 0)
          : null;
      if (hit === null) throw new MoatRefusal("pii", "the PII filter returned an unrecognised result, so the output is not passed");
      if (hit) throw new MoatRefusal("pii", "the output contains personal data");
    }
    return value;
  }

  /** Lowercase hex SHA-256 of the pinned prompt, for example to pass to Rampart as input. */
  promptSha256(): string {
    return sha256Hex(this.#prompt);
  }
}
