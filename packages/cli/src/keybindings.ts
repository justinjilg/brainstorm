/**
 * Keybinding registry with default bindings.
 *
 * Each binding maps a key combination to an action name.
 * The ChatApp component handles actions via its useInput hook.
 */

export type KeyAction =
  | 'abort'          // Interrupt current operation
  | 'exit'           // Exit Brainstorm
  | 'clear-screen'   // Clear terminal
  | 'clear-chat'     // Clear conversation history
  | 'cycle-mode';    // Cycle permission mode (auto → confirm → plan)

export interface KeyBinding {
  action: KeyAction;
  description: string;
  /** Match function: returns true if the key event matches */
  match: (input: string, key: KeyEvent) => boolean;
}

/** Ink useInput key event shape */
export interface KeyEvent {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
}

export const DEFAULT_KEYBINDINGS: KeyBinding[] = [
  {
    action: 'abort',
    description: 'Interrupt current operation',
    match: (_input, key) => key.escape,
  },
  {
    action: 'exit',
    description: 'Exit Brainstorm',
    // Ink sends empty string for Ctrl+D when input is empty (standard EOF)
    match: (input, key) => key.ctrl && (input === 'd' || input === ''),
  },
  {
    action: 'clear-screen',
    description: 'Clear terminal screen',
    match: (input, key) => key.ctrl && (input === 'l' || input === '\f'),
  },
  {
    action: 'clear-chat',
    description: 'Clear conversation history',
    match: (input, key) => key.ctrl && (input === 'k' || input === '\x0b'),
  },
  {
    action: 'cycle-mode',
    description: 'Cycle permission mode (auto → confirm → plan)',
    match: (_input, key) => key.shift && key.tab,
  },
];

/**
 * Resolve which action (if any) a key event triggers.
 */
export function resolveKeyAction(input: string, key: KeyEvent, bindings = DEFAULT_KEYBINDINGS): KeyAction | null {
  for (const binding of bindings) {
    if (binding.match(input, key)) return binding.action;
  }
  return null;
}

/**
 * Get a human-readable description of all keybindings.
 */
export function formatKeybindings(bindings = DEFAULT_KEYBINDINGS): string {
  const labels: Record<string, string> = {
    abort: 'Escape',
    exit: 'Ctrl+D',
    'clear-screen': 'Ctrl+L',
    'clear-chat': 'Ctrl+K',
    'cycle-mode': 'Shift+Tab',
  };

  return bindings
    .map((b) => `  ${(labels[b.action] ?? b.action).padEnd(15)} ${b.description}`)
    .join('\n');
}
