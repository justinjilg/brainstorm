import { describe, it, expect } from "vitest";
import {
  nfcNormalize,
  canonicalBytes,
  signingInput,
  SIGN_CONTEXT,
  NfcKeyCollisionError,
} from "../canonical.js";

describe("nfcNormalize", () => {
  it("normalizes string values to NFC", () => {
    // "café" with combining acute (NFD: 5 chars: 'c', 'a', 'f', 'e', U+0301)
    const decomposed = "café";
    const composed = "café"; // NFC: 4 chars
    expect(decomposed.length).toBe(5);
    expect(composed.length).toBe(4);
    expect(nfcNormalize(decomposed)).toBe(composed);
  });

  it("normalizes object keys to NFC", () => {
    const decomposed = { ["café"]: 1 };
    const result = nfcNormalize(decomposed);
    expect(Object.keys(result)).toEqual(["café"]);
  });

  it("recurses into arrays", () => {
    expect(nfcNormalize(["café", "munchen"])).toEqual(["café", "munchen"]);
  });

  it("recurses into nested objects", () => {
    const input = { outer: { inner: "café" } };
    const out = nfcNormalize(input);
    expect((out as any).outer.inner).toBe("café");
  });

  it("preserves non-string scalars", () => {
    expect(nfcNormalize(42)).toBe(42);
    expect(nfcNormalize(true)).toBe(true);
    expect(nfcNormalize(null)).toBe(null);
  });

  // Cryptographic-injectivity regression tests (Codex blocking findings)

  it("preserves a __proto__ own-key as own property (does NOT trigger legacy setter)", () => {
    // Build object with own-enumerable __proto__ key — this is what JSON
    // parse gives you for {"__proto__": {...}} input.
    const input = JSON.parse('{"__proto__": {"evil": true}, "regular": 1}');
    const out = nfcNormalize(input) as any;
    // The normalized object MUST still have __proto__ as an own key,
    // not silently dropped. Use hasOwnProperty since the prototype chain
    // also exposes a __proto__ accessor on plain objects.
    const keys = Object.keys(out);
    expect(keys).toContain("__proto__");
    expect(keys).toContain("regular");
    // And canonical bytes must include both keys
    const bytes = canonicalBytes(input);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("__proto__");
    expect(text).toContain("regular");
  });

  it("throws NfcKeyCollisionError when two keys normalize to the same form", () => {
    // "café" with combining acute (NFD form, 5 chars) and
    // "café" precomposed (NFC form, 4 chars) collide after normalization.
    // Source-file safe: build the two forms from explicit code points so
    // the editor/normalizer can't collapse them before the test runs.
    const decomposed = "café"; // NFD: e + combining acute (5 chars)
    const composed = "café"; // NFC: precomposed é (4 chars)
    expect(decomposed).not.toBe(composed); // sanity: different strings
    expect(decomposed.normalize("NFC")).toBe(composed); // collide on normalize
    const colliding = JSON.parse(
      JSON.stringify({ [decomposed]: 1, [composed]: 2 }),
    );
    // We need to construct an object literal where both forms are keys
    // — use Object.assign with separate sources to force two distinct
    // own properties.
    const obj: Record<string, number> = Object.create(null);
    Object.defineProperty(obj, decomposed, {
      value: 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(obj, composed, {
      value: 2,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    // Sanity: object now has two keys
    expect(Object.keys(obj).length).toBe(2);
    expect(() => nfcNormalize(obj)).toThrow(NfcKeyCollisionError);
  });

  it("does not falsely flag collision when keys are already-equal normalized forms", () => {
    // Same key twice in source object collapses to one own-key in JS;
    // that's fine and is NOT a collision. Verify the simple non-collision case.
    expect(() => nfcNormalize({ café: 1, name: "x" })).not.toThrow();
  });
});

describe("canonicalBytes", () => {
  it("produces deterministic output regardless of input key order", () => {
    const a = { b: 1, a: 2 };
    const b = { a: 2, b: 1 };
    const ba = canonicalBytes(a);
    const bb = canonicalBytes(b);
    expect(new TextDecoder().decode(ba)).toBe(new TextDecoder().decode(bb));
  });

  it("normalizes Unicode equivalents to the same bytes", () => {
    const decomposed = { name: "café" };
    const composed = { name: "café" };
    const bd = canonicalBytes(decomposed);
    const bc = canonicalBytes(composed);
    expect(new TextDecoder().decode(bd)).toBe(new TextDecoder().decode(bc));
  });

  it("throws on undefined / non-JSON-serializable input", () => {
    expect(() => canonicalBytes(undefined)).toThrow();
  });
});

describe("signingInput", () => {
  it("prepends the SIGN_CONTEXT prefix bytes", () => {
    const value = { a: 1 };
    const out = signingInput(SIGN_CONTEXT.COMMAND_ENVELOPE, value);
    const prefix = new TextEncoder().encode(SIGN_CONTEXT.COMMAND_ENVELOPE);
    expect(out.slice(0, prefix.length)).toEqual(prefix);
  });

  it("produces different outputs for different contexts (domain separation)", () => {
    const value = { a: 1 };
    const a = signingInput(SIGN_CONTEXT.COMMAND_ENVELOPE, value);
    const b = signingInput(SIGN_CONTEXT.CONNECTION_PROOF, value);
    expect(a).not.toEqual(b);
  });
});
