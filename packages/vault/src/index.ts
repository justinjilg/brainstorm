export { deriveKey, generateSalt, encrypt, decrypt, KDF_PARAMS } from './crypto.js';
export { BrainstormVault } from './vault.js';
export { KeyResolver, type PasswordPrompt } from './resolver.js';
export { isOpAvailable, opRead } from './backends/op-cli.js';
export { envRead } from './backends/env.js';
export type { VaultFile, VaultPayload, VaultConfig, EncryptResult } from './types.js';
