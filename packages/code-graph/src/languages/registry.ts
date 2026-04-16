/**
 * Language Adapter Registry — lazy-loads adapters by file extension.
 *
 * Missing tree-sitter grammars are silently skipped. TypeScript is always
 * available (bundled dependency). Other languages are optional peer deps.
 */

import type { LanguageAdapter } from "./types.js";
import { createLogger } from "@brainst0rm/shared";
import { createPythonAdapter } from "./python.js";
import { createGoAdapter } from "./go.js";
import { createRustAdapter } from "./rust.js";
import { createJavaAdapter } from "./java.js";

const log = createLogger("language-registry");

// Adapter cache
const adapters = new Map<string, LanguageAdapter>();
const extensionMap = new Map<string, string>(); // ext → adapterId
const failedAdapters = new Set<string>();

/**
 * Register a language adapter.
 */
export function registerAdapter(adapter: LanguageAdapter): void {
  adapters.set(adapter.id, adapter);
  for (const ext of adapter.extensions) {
    extensionMap.set(ext, adapter.id);
  }
}

/**
 * Get the adapter for a file extension, or null if unsupported.
 */
export function getAdapterForExtension(ext: string): LanguageAdapter | null {
  const id = extensionMap.get(ext);
  if (!id) return null;
  return adapters.get(id) ?? null;
}

/**
 * Get all supported file extensions across all registered adapters.
 */
export function supportedExtensions(): Set<string> {
  return new Set(extensionMap.keys());
}

/**
 * List all registered adapter IDs.
 */
export function registeredLanguages(): string[] {
  return Array.from(adapters.keys());
}

/**
 * Initialize all built-in adapters. TypeScript is always loaded;
 * others are attempted but silently skipped if grammars are missing.
 */
export async function initializeAdapters(): Promise<string[]> {
  const loaded: string[] = [];

  // TypeScript — always available (bundled dependency)
  const { createTypeScriptAdapter } = await import("./typescript.js");
  registerAdapter(createTypeScriptAdapter());
  loaded.push("typescript");

  // Optional adapters — statically imported but lazily initialized.
  // Each adapter's getParser() uses createRequire to load the grammar
  // from code-graph's own node_modules, which works after bundling.
  const optional: Array<{ name: string; factory: () => LanguageAdapter }> = [
    { name: "python", factory: createPythonAdapter },
    { name: "go", factory: createGoAdapter },
    { name: "rust", factory: createRustAdapter },
    { name: "java", factory: createJavaAdapter },
  ];

  for (const { name, factory } of optional) {
    if (failedAdapters.has(name)) continue;
    try {
      const adapter = factory();
      adapter.getParser(); // verify the grammar loads
      registerAdapter(adapter);
      loaded.push(name);
      log.debug({ language: name }, "Language adapter loaded");
    } catch (err: any) {
      failedAdapters.add(name);
      log.debug(
        { language: name, error: err.message },
        "Language adapter not available",
      );
    }
  }

  return loaded;
}
