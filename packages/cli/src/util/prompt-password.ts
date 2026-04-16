/**
 * Prompt for a secret with masked echo on the terminal.
 *
 * Secrets must never be echoed in plaintext — they land in scrollback,
 * terminal session recordings, and shared-screen demos. Use this helper
 * any time the CLI needs a user-supplied credential (vault password,
 * GitHub PAT, provider API key, etc.) instead of the usual
 * readline.question which echoes every keystroke.
 *
 * Supports a BRAINSTORM_VAULT_PASSWORD env-var bypass for scripting and
 * CI. Other callers can pass a different `envVar` to reuse the same
 * shape for their own bypass variable, or pass `null` to disable.
 */
export function promptPassword(
  prompt: string,
  envVar: string | null = "BRAINSTORM_VAULT_PASSWORD",
): Promise<string> {
  if (envVar) {
    const envPassword = process.env[envVar];
    if (envPassword) {
      console.error(`  [prompt] Using ${envVar} from environment (no prompt)`);
      return Promise.resolve(envPassword);
    }
  }

  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);

    let rawModeWasSet = false;
    try {
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(true);
        rawModeWasSet = true;
      }
    } catch {
      // Some environments don't support raw mode (non-TTY).
    }

    if (process.stdin.isPaused?.()) process.stdin.resume();

    let password = "";
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      if (rawModeWasSet) {
        try {
          process.stdin.setRawMode?.(false);
        } catch {
          /* ignore */
        }
      }
      process.stderr.write("\n");
    };

    const onData = (ch: Buffer) => {
      const c = ch.toString();
      if (c === "\n" || c === "\r" || c === "\u0004") {
        cleanup();
        resolve(password);
      } else if (c === "\u0003") {
        cleanup();
        reject(new Error("Cancelled"));
      } else if (c === "\u007F" || c === "\b") {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stderr.write("\b \b");
        }
      } else if (c.charCodeAt(0) >= 32) {
        password += c;
        process.stderr.write("*");
      }
    };
    process.stdin.on("data", onData);
  });
}
