import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { jcsCanonicalize, JcsError } from "../src/index.ts";
import { sha256Hex } from "../src/sha256.ts";

import cases from "./fixtures/jcs-cases.json";

type Case = { name: string; input: unknown; expectCanonical?: string; expectError?: string };

describe("platform canonical form: shared cases", () => {
  for (const c of (cases as { cases: Case[] }).cases) {
    it(c.name, () => {
      if (c.expectError !== undefined) expect(() => jcsCanonicalize(c.input)).toThrow(JcsError);
      else expect(jcsCanonicalize(c.input)).toBe(c.expectCanonical!);
    });
  }
});

describe("platform canonical form: objects, strings, numbers", () => {
  it("sorts keys by UTF-8 byte order, not UTF-16 code units", () => {
    expect(jcsCanonicalize({ "\u{1f600}": 1, "\uff5e": 2, "\ufb00": 3 })).toBe('{"\ufb00":3,"\uff5e":2,"\u{1f600}":1}');
  });

  it("handles nesting, empty containers and no whitespace", () => {
    expect(jcsCanonicalize({ b: [], a: {}, c: [1, { z: 1, y: null }] })).toBe('{"a":{},"b":[],"c":[1,{"y":null,"z":1}]}');
  });

  it("writes -0 as 0 and refuses fractions, NaN, Infinity and integers beyond 2^53-1", () => {
    expect(jcsCanonicalize(-0)).toBe("0");
    for (const n of [0.5, 1e-7, 1e21, 2 ** 53, -(2 ** 53), Number.NaN, Infinity, -Infinity]) {
      expect(() => jcsCanonicalize(n)).toThrow(JcsError);
    }
  });

  it("leaves out undefined members, refuses other non-JSON values and unpaired surrogates", () => {
    expect(jcsCanonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => jcsCanonicalize(undefined)).toThrow(JcsError);
    expect(() => jcsCanonicalize([undefined])).toThrow(JcsError);
    expect(() => jcsCanonicalize(1n)).toThrow(JcsError);
    expect(() => jcsCanonicalize("\ud800")).toThrow(JcsError);
    expect(() => jcsCanonicalize({ "\udc00": 1 })).toThrow(JcsError);
  });
});

describe("sha256", () => {
  it("matches the known vectors and node:crypto", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
      const s = "x".repeat(n);
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
    }
  });
});
