import { describe, it, expect } from "vitest";
import {
  findVaultPatterns,
  buildScrubMap,
  injectSecrets,
  scrubSecrets,
} from "../middleware/builtin/secret-substitution.js";

describe("secret-substitution", () => {
  describe("findVaultPatterns", () => {
    it("finds $VAULT_* patterns in string args", () => {
      const patterns = findVaultPatterns({
        command:
          "curl -H 'Authorization: Bearer $VAULT_ANTHROPIC_API_KEY' https://api.anthropic.com",
      });
      expect(patterns).toEqual(["ANTHROPIC_API_KEY"]);
    });

    it("finds multiple patterns across nested objects", () => {
      const patterns = findVaultPatterns({
        headers: {
          auth: "$VAULT_API_KEY",
          extra: "$VAULT_SECRET_TOKEN",
        },
        body: "data with $VAULT_API_KEY again",
      });
      expect(patterns).toContain("API_KEY");
      expect(patterns).toContain("SECRET_TOKEN");
      expect(patterns).toHaveLength(2); // deduped
    });

    it("finds patterns in arrays", () => {
      const patterns = findVaultPatterns({
        args: ["--key", "$VAULT_MY_KEY", "--verbose"],
      });
      expect(patterns).toEqual(["MY_KEY"]);
    });

    it("returns empty array when no patterns", () => {
      expect(findVaultPatterns({ command: "ls -la" })).toEqual([]);
      expect(findVaultPatterns({ path: "/tmp/file.txt" })).toEqual([]);
    });

    it("ignores partial patterns", () => {
      // $VAULT alone (no underscore + name)
      expect(findVaultPatterns({ s: "$VAULT" })).toEqual([]);
      // VAULT_KEY without $
      expect(findVaultPatterns({ s: "VAULT_KEY" })).toEqual([]);
      // $VAULT_ with no name after
      expect(findVaultPatterns({ s: "$VAULT_" })).toEqual([]);
    });

    it("handles non-string values", () => {
      expect(findVaultPatterns({ count: 42, flag: true, nil: null })).toEqual(
        [],
      );
    });
  });

  describe("buildScrubMap", () => {
    it("resolves patterns to a scrub map", async () => {
      const resolver = async (name: string) => {
        if (name === "API_KEY") return "sk-ant-1234567890";
        return null;
      };

      const map = await buildScrubMap(["API_KEY", "MISSING_KEY"], resolver);
      expect(map.size).toBe(1);
      expect(map.get("sk-ant-1234567890")).toBe("$VAULT_API_KEY");
    });

    it("returns empty map when nothing resolves", async () => {
      const resolver = async () => null;
      const map = await buildScrubMap(["NOPE"], resolver);
      expect(map.size).toBe(0);
    });
  });

  describe("injectSecrets", () => {
    it("replaces $VAULT_NAME with resolved values in place", () => {
      // scrubMap: resolvedValue → placeholder
      const scrubMap = new Map([["sk-real-key-123", "$VAULT_API_KEY"]]);

      const input: Record<string, unknown> = {
        command: "curl -H 'Bearer $VAULT_API_KEY' https://example.com",
      };

      injectSecrets(input, scrubMap);
      expect(input.command).toBe(
        "curl -H 'Bearer sk-real-key-123' https://example.com",
      );
    });

    it("handles nested objects", () => {
      const scrubMap = new Map([["secret123", "$VAULT_TOKEN"]]);

      const input: Record<string, unknown> = {
        headers: { auth: "Bearer $VAULT_TOKEN" },
      };

      injectSecrets(input, scrubMap);
      expect((input.headers as any).auth).toBe("Bearer secret123");
    });

    it("skips _vaultSubstitutions key", () => {
      const scrubMap = new Map([["val", "$VAULT_X"]]);
      const input: Record<string, unknown> = {
        _vaultSubstitutions: ["X"],
        data: "$VAULT_X",
      };

      injectSecrets(input, scrubMap);
      expect(input._vaultSubstitutions).toEqual(["X"]); // untouched
      expect(input.data).toBe("val");
    });
  });

  describe("scrubSecrets", () => {
    it("replaces resolved values with placeholders in output", () => {
      const scrubMap = new Map([
        ["sk-ant-secret-key-12345", "$VAULT_ANTHROPIC_API_KEY"],
      ]);

      const output = {
        stdout: "Response: authenticated with sk-ant-secret-key-12345",
        exitCode: 0,
      };

      const scrubbed = scrubSecrets(output, scrubMap) as any;
      expect(scrubbed.stdout).toBe(
        "Response: authenticated with $VAULT_ANTHROPIC_API_KEY",
      );
      expect(scrubbed.exitCode).toBe(0);
    });

    it("scrubs from nested arrays and objects", () => {
      const scrubMap = new Map([["mysecret", "$VAULT_KEY"]]);
      const output = {
        lines: ["line1", "contains mysecret here", "line3"],
        meta: { token: "mysecret" },
      };

      const scrubbed = scrubSecrets(output, scrubMap) as any;
      expect(scrubbed.lines[1]).toBe("contains $VAULT_KEY here");
      expect(scrubbed.meta.token).toBe("$VAULT_KEY");
    });

    it("returns original when scrub map is empty", () => {
      const output = { data: "sensitive" };
      const result = scrubSecrets(output, new Map());
      expect(result).toBe(output); // same reference, no copy
    });

    it("skips very short secrets to avoid false positives", () => {
      const scrubMap = new Map([
        ["ab", "$VAULT_SHORT"], // length 2 — too short
        ["abcde", "$VAULT_LONG"], // length 5 — long enough
      ]);

      const output = { text: "ab and abcde here" };
      const scrubbed = scrubSecrets(output, scrubMap) as any;
      expect(scrubbed.text).toBe("ab and $VAULT_LONG here");
    });

    it("handles string output directly", () => {
      const scrubMap = new Map([["secret", "$VAULT_X"]]);
      expect(scrubSecrets("has secret in it", scrubMap)).toBe(
        "has $VAULT_X in it",
      );
    });

    it("replaces the longer of two prefix-sharing secrets first (leak guard)", () => {
      // Two secrets where one is a prefix of the other. A naive
      // Map-order scrub would replace `abcd` first, leaving
      // `<$VAULT_SHORT>1234` — leaking `1234`, the tail of the
      // longer secret. Real scenario: rotating keys where old +
      // new values share a random prefix. Fix sorts by length DESC.
      const scrubMap = new Map<string, string>([
        ["abcd", "$VAULT_SHORT"],
        ["abcd1234", "$VAULT_LONG"],
      ]);
      const scrubbed = scrubSecrets(
        { text: "contains abcd1234 verbatim" },
        scrubMap,
      ) as any;
      // The longer secret must be fully replaced — no tail leak.
      expect(scrubbed.text).toBe("contains $VAULT_LONG verbatim");
      expect(scrubbed.text).not.toContain("1234");
    });
  });

  describe("scrubSecrets — deep / cyclic / shared structures", () => {
    it("scrubs a secret nested ~200k levels deep without throwing (objects)", () => {
      const secret = "sk-ant-deep-secret-value-000";
      const scrubMap = new Map([[secret, "$VAULT_DEEP"]]);

      // Build a deeply nested object with the secret at the bottom.
      const depth = 200_000;
      let node: any = { value: secret };
      for (let i = 0; i < depth; i++) node = { child: node };

      let scrubbed: any;
      expect(() => {
        scrubbed = scrubSecrets(node, scrubMap);
      }).not.toThrow();

      // Walk back down to the leaf and confirm it was scrubbed.
      let cur = scrubbed;
      for (let i = 0; i < depth; i++) cur = cur.child;
      expect(cur.value).toBe("$VAULT_DEEP");
    });

    it("scrubs a secret at the bottom of a ~200k-deep array chain", () => {
      const secret = "sk-ant-deep-array-secret-111";
      const scrubMap = new Map([[secret, "$VAULT_ARR"]]);

      const depth = 200_000;
      let node: any = [secret];
      for (let i = 0; i < depth; i++) node = [node];

      let scrubbed: any;
      expect(() => {
        scrubbed = scrubSecrets(node, scrubMap);
      }).not.toThrow();

      let cur = scrubbed;
      for (let i = 0; i < depth; i++) cur = cur[0];
      expect(cur[0]).toBe("$VAULT_ARR");
    });

    it("scrubs a wide/large tree", () => {
      const secret = "wide-tree-secret-value";
      const scrubMap = new Map([[secret, "$VAULT_WIDE"]]);
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < 50_000; i++) {
        obj[`k${i}`] = i % 2 === 0 ? secret : "plain";
      }
      const scrubbed = scrubSecrets(obj, scrubMap) as any;
      expect(scrubbed.k0).toBe("$VAULT_WIDE");
      expect(scrubbed.k1).toBe("plain");
      expect(scrubbed.k2).toBe("$VAULT_WIDE");
    });

    it("terminates on cyclic input and scrubs the secret", () => {
      const secret = "cyclic-secret-value";
      const scrubMap = new Map([[secret, "$VAULT_CYCLE"]]);
      const a: any = { token: secret };
      a.self = a; // direct cycle
      const b: any = { data: secret, back: a };
      a.other = b; // longer cycle a → b → a

      let scrubbed: any;
      expect(() => {
        scrubbed = scrubSecrets(a, scrubMap);
      }).not.toThrow();

      expect(scrubbed.token).toBe("$VAULT_CYCLE");
      expect(scrubbed.other.data).toBe("$VAULT_CYCLE");
      // Cycle is preserved structurally as an alias to the clone.
      expect(scrubbed.self).toBe(scrubbed);
      expect(scrubbed.other.back).toBe(scrubbed);
    });

    it("scrubs both occurrences of a shared subtree (and dedupes the clone)", () => {
      const secret = "shared-subtree-secret";
      const scrubMap = new Map([[secret, "$VAULT_SHARED"]]);
      const shared = { token: secret };
      const root = { first: shared, second: shared };

      const scrubbed = scrubSecrets(root, scrubMap) as any;
      expect(scrubbed.first.token).toBe("$VAULT_SHARED");
      expect(scrubbed.second.token).toBe("$VAULT_SHARED");
      // Shared reference collapses to a single clone (more faithful to input).
      expect(scrubbed.first).toBe(scrubbed.second);
    });
  });

  describe("injectSecrets — prefix collision", () => {
    it("replaces the longer of two prefix-sharing placeholders first", () => {
      // Same bug class in the inject direction: $VAULT_AB is a
      // prefix of $VAULT_ABCD. Without length-sort, a tool arg of
      // "$VAULT_ABCD" could match $VAULT_AB first, leaving
      // "<valueAB>CD" — leaking the partial placeholder and
      // inserting the WRONG secret value.
      const scrubMap = new Map<string, string>([
        ["valueAB", "$VAULT_AB"],
        ["valueABCD", "$VAULT_ABCD"],
      ]);
      const input: Record<string, unknown> = {
        command: "echo $VAULT_ABCD and $VAULT_AB",
      };
      injectSecrets(input, scrubMap);
      expect(input.command).toBe("echo valueABCD and valueAB");
    });

    it("preserves literal $ in secret values (no backreference corruption)", () => {
      // Real-world case: user stores a password with literal `$`
      // characters in the vault. Pre-fix, the string-form
      // replaceAll() would interpret `$1`/`$&`/etc. in the SECRET
      // VALUE as regex backreferences — stripping them before the
      // tool saw the value. The auth call would silently fail
      // with a truncated password.
      const tricky = "MyP$1$&ssword$";
      const scrubMap = new Map<string, string>([[tricky, "$VAULT_MY_PW"]]);
      const input: Record<string, unknown> = {
        command: "curl -u user:$VAULT_MY_PW https://api.example.com",
      };
      injectSecrets(input, scrubMap);
      expect(input.command).toBe(
        `curl -u user:${tricky} https://api.example.com`,
      );
    });
  });
});
