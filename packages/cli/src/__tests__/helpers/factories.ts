/**
 * Test data factories for TUI component tests.
 */

import type { SelectOption } from "../../components/SelectPrompt.js";

// ── App Props ──────────────────────────────────────────────────────────

export interface MockAppProps {
  strategy: string;
  modelCount: { local: number; cloud: number };
  onSendMessage: (text: string) => AsyncGenerator<any>;
  onAbort?: () => void;
  slashCallbacks?: Record<string, any>;
  models?: MockModelInfo[];
  configInfo?: MockConfigInfo;
  vaultInfo?: MockVaultInfo;
  gateway?: any;
  memoryInfo?: { localCount: number; types: Record<string, number> };
}

export interface MockModelInfo {
  id: string;
  name: string;
  provider: string;
  qualityTier: number;
  speedTier: number;
  pricing: { input: number; output: number };
  status: string;
}

export interface MockConfigInfo {
  strategy: string;
  permissionMode: string;
  outputStyle: string;
  sandbox: string;
}

export interface MockVaultInfo {
  exists: boolean;
  isOpen: boolean;
  keyCount: number;
  keys: string[];
  createdAt: string | null;
  opAvailable: boolean;
  resolvedKeys: string[];
}

/**
 * Create default App props with sensible test values.
 */
export function makeAppProps(overrides?: Partial<MockAppProps>): MockAppProps {
  return {
    strategy: "combined",
    modelCount: { local: 0, cloud: 3 },
    onSendMessage: makeSilentStream(),
    onAbort: () => {},
    slashCallbacks: {},
    models: [
      makeModelInfo({
        id: "opus-4.6",
        name: "Opus 4.6",
        provider: "anthropic",
      }),
      makeModelInfo({
        id: "sonnet-4.6",
        name: "Sonnet 4.6",
        provider: "anthropic",
        qualityTier: 4,
      }),
      makeModelInfo({ id: "gpt-5.4", name: "GPT-5.4", provider: "openai" }),
    ],
    configInfo: {
      strategy: "combined",
      permissionMode: "confirm",
      outputStyle: "concise",
      sandbox: "none",
    },
    vaultInfo: {
      exists: false,
      isOpen: false,
      keyCount: 0,
      keys: [],
      createdAt: null,
      opAvailable: false,
      resolvedKeys: [],
    },
    memoryInfo: { localCount: 0, types: {} },
    ...overrides,
  };
}

// ── Model Info ─────────────────────────────────────────────────────────

export function makeModelInfo(
  overrides?: Partial<MockModelInfo>,
): MockModelInfo {
  return {
    id: "test-model",
    name: "Test Model",
    provider: "test",
    qualityTier: 5,
    speedTier: 3,
    pricing: { input: 0.003, output: 0.015 },
    status: "available",
    ...overrides,
  };
}

// ── Select Options ─────────────────────────────────────────────────────

export function makeSelectOptions(count = 3): SelectOption[] {
  return Array.from({ length: count }, (_, i) => ({
    label: `Option ${i + 1}`,
    value: `opt-${i + 1}`,
    description: `Description for option ${i + 1}`,
    recommended: i === 0,
  }));
}

// ── Stream Factories ───────────────────────────────────────────────────

/**
 * A silent stream that immediately finishes (for components that need onSendMessage but don't use it).
 */
export function makeSilentStream(): (text: string) => AsyncGenerator<any> {
  return async function* () {
    yield { type: "done", totalCost: 0 };
  };
}

/**
 * Create a mock event stream from an array of events.
 */
export function makeMockStream(
  events: any[],
): (text: string) => AsyncGenerator<any> {
  return async function* () {
    for (const event of events) {
      yield event;
    }
  };
}

/**
 * Create a simple text response stream.
 */
export function makeTextResponseStream(
  text: string,
  model = "test-model",
): any[] {
  return [
    {
      type: "routing",
      decision: {
        model: { id: model, name: model },
        strategy: "combined",
        reason: "test",
      },
    },
    ...text.split("").map((char) => ({ type: "text-delta", delta: char })),
    { type: "done", totalCost: 0.001, totalTokens: { input: 10, output: 20 } },
  ];
}

/**
 * Create an error stream.
 */
export function makeErrorStream(message: string): any[] {
  return [
    { type: "error", error: new Error(message) },
    { type: "done", totalCost: 0 },
  ];
}
