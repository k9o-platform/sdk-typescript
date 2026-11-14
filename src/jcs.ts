/**
 * The platform's canonical JSON form (the "Kilimanjaro JCS code-point profile").
 *
 * `canonicalize(value)` returns the canonical JSON text of a JSON value:
 *   - object members sorted by their names' UTF-8 bytes (the same as Unicode code point order, not UTF-16 code unit
 *     order), no whitespace;
 *   - strings escaped minimally: `"` and `\` with a backslash, the short escapes `\b \t \n \f \r`, every other
 *     control character below U+0020 as lowercase `\u00xx`; `/` is not escaped and every other code point
 *     (U+2028 and U+2029 included) is written literally;
 *   - numbers are integers only, in base 10 without an exponent, `-0` as `0`; a fractional number, `NaN`, `Infinity`
 *     or an absolute value above 9007199254740991 (2^53 - 1) is refused;
 *   - `undefined` (outside an object member), `bigint`, functions, symbols and strings with unpaired surrogates are
 *     refused with `JcsError`.
 *
 * An object member whose value is `undefined` is left out, as `JSON.stringify` does when the same object is sent.
 */

export class JcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JcsError";
  }
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 9007199254740991
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const UTF8 = new TextEncoder();

function str(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new JcsError("string contains an unpaired surrogate");
  // For well-formed strings JSON.stringify emits exactly the minimal escapes of the profile.
  return JSON.stringify(s);
}

function num(n: number): string {
  if (!Number.isFinite(n)) throw new JcsError("NaN and Infinity cannot be canonicalised");
  if (!Number.isInteger(n)) throw new JcsError("only integers can be canonicalised; a fractional number is refused");
  if (Math.abs(n) > MAX_SAFE) throw new JcsError("an integer above 9007199254740991 in absolute value is refused");
  return n === 0 ? "0" : String(n); // integers up to 2^53-1 print in base 10 without an exponent; -0 prints 0
}

function compareUtf8(a: string, b: string): number {
  const x = UTF8.encode(a);
  const y = UTF8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = x[i]! - y[i]!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function write(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return num(value);
    case "string":
      return str(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => write(v)).join(",")}]`;
      const o = value as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort(compareUtf8);
      return `{${keys.map((k) => `${str(k)}:${write(o[k])}`).join(",")}}`;
    }
    default:
      throw new JcsError(`a ${typeof value} value cannot be canonicalised`);
  }
}

/** The canonical JSON text of `value` under the platform's profile. Throws `JcsError` for a value that cannot be canonicalised. */
export function canonicalize(value: unknown): string {
  return write(value);
}
