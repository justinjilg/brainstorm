import { describe, it, expect } from "vitest";
import { calculateComplexity } from "../complexity.js";
import { inferMethod, inferPathFromFile } from "../endpoints.js";
import { extractImports, extractExports } from "../dependencies.js";

describe("Pure functions in ingest package", () => {
  describe("calculateComplexity", () => {
    it("returns null for empty or whitespace-only strings", () => {
      expect(calculateComplexity("")).toBeNull();
      expect(calculateComplexity("   \n   \n")).toBeNull();
    });

    it("calculates basic complexity metrics correctly", () => {
      const code = `
function hello() {
  if (true) {
    console.log("Hello");
  }
}
      `;
      const result = calculateComplexity(code);
      expect(result).not.toBeNull();
      expect(result?.functionCount).toBe(1); // 1 function
      expect(result?.branchCount).toBe(1); // 1 if statement
      expect(result?.maxNesting).toBe(2); // function body is 0->1, if body is 1->2 (assuming 2 spaces)
    });
  });

  describe("inferMethod", () => {
    it("infers GET from relevant strings", () => {
      expect(inferMethod("app.get('/api')")).toBe("GET");
      expect(inferMethod("@Get('/route')")).toBe("GET");
    });

    it("infers POST from relevant strings", () => {
      expect(inferMethod("router.post('/login')")).toBe("POST");
    });

    it("defaults to ANY for unknown strings", () => {
      expect(inferMethod("router.all('/users')")).toBe("ANY");
    });
  });

  describe("inferPathFromFile", () => {
    it("handles standard API paths", () => {
      expect(inferPathFromFile("src/api/users/route.ts")).toBe("/api/users");
    });

    it("handles regular files without 'api' directory", () => {
      expect(inferPathFromFile("src/controllers/auth.ts")).toBe(
        "/src/controllers/auth",
      );
    });
  });

  describe("extractImports", () => {
    it("extracts static imports in TS", () => {
      const imports = extractImports("import { foo } from 'bar';", ".ts");
      expect(imports).toEqual([{ specifier: "bar", type: "static" }]);
    });

    it("extracts dynamic imports in TS", () => {
      const imports = extractImports(
        "const x = import('dynamic-module');",
        ".ts",
      );
      expect(imports).toEqual([
        { specifier: "dynamic-module", type: "dynamic" },
      ]);
    });

    it("extracts python imports", () => {
      const imports = extractImports(
        "import os\nfrom typing import List",
        ".py",
      );
      expect(imports).toEqual([
        { specifier: "typing", type: "static" },
        { specifier: "os", type: "static" },
      ]);
    });
  });

  describe("extractExports", () => {
    it("extracts JS/TS exported functions and classes", () => {
      const code = `
export function doThing() {}
export class MyClass {}
export const VALUE = 42;
      `;
      const exports = extractExports(code, ".ts");
      expect(exports).toEqual(["doThing", "MyClass", "VALUE"]);
    });

    it("extracts Python defs and classes", () => {
      const code = `
def my_func():
    pass

class MyModel:
    pass

def _private_func():
    pass
      `;
      const exports = extractExports(code, ".py");
      expect(exports).toEqual(["my_func", "MyModel"]);
    });
  });
});
