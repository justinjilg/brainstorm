/**
 * Language Adapter Registry — lazy-loads adapters by file extension.
 *
 * Missing tree-sitter grammars are silently skipped. TypeScript is always
 * available (bundled dependency). Other languages are optional peer deps.
 */

import type { LanguageAdapter } from "./types.js";
import { createLogger } from "@brainst0rm/shared";

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
 * Try to load an optional language adapter by dynamically importing its
 * tree-sitter grammar package. Silently skips if not installed.
 */
async function tryLoadOptionalAdapter(
  name: string,
  grammarPackage: string,
  adapterModule: string,
  factoryName: string,
): Promise<boolean> {
  if (failedAdapters.has(name)) return false;
  try {
    // First check if the grammar package is available
    await import(grammarPackage);
    // Then load the adapter
    const mod = await import(adapterModule);
    const adapter = mod[factoryName]() as LanguageAdapter;
    adapter.getParser(); // verify it works
    registerAdapter(adapter);
    log.debug({ language: name }, "Language adapter loaded");
    return true;
  } catch {
    failedAdapters.add(name);
    log.debug(
      { language: name },
      "Language adapter not available (grammar not installed)",
    );
    return false;
  }
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

  // Optional adapters — try each, skip if grammar not installed.
  // Each adapter file checks for its grammar package internally.
  const optional: Array<{
    name: string;
    grammar: string;
    module: string;
    factory: string;
  }> = [
    {
      name: "python",
      grammar: "tree-sitter-python",
      module: "./python.js",
      factory: "createPythonAdapter",
    },
    {
      name: "go",
      grammar: "tree-sitter-go",
      module: "./go.js",
      factory: "createGoAdapter",
    },
    {
      name: "rust",
      grammar: "tree-sitter-rust",
      module: "./rust.js",
      factory: "createRustAdapter",
    },
    {
      name: "java",
      grammar: "tree-sitter-java",
      module: "./java.js",
      factory: "createJavaAdapter",
    },
  ];

  for (const { name, grammar, module: mod, factory } of optional) {
    if (await tryLoadOptionalAdapter(name, grammar, mod, factory)) {
      loaded.push(name);
    }
  }

  return loaded;
}
