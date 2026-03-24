/** Read a key from environment variables. */
export function envRead(keyName: string): string | null {
  return process.env[keyName] ?? null;
}
