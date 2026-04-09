/**
 * Notarize the macOS app after code signing.
 *
 * Called by electron-builder as an afterSign hook.
 * Uses Apple App Store Connect API key for authentication.
 *
 * Required env vars (resolved from 1Password at build time):
 *   APPLE_API_KEY_ID     — Key ID from App Store Connect
 *   APPLE_API_ISSUER     — Issuer ID from App Store Connect
 *   APPLE_API_KEY_PATH   — Path to the .p8 private key file
 *
 * Skip notarization by setting CSC_IDENTITY_AUTO_DISCOVERY=false
 * or SKIP_NOTARIZE=true.
 */

const { notarize } = require("@electron/notarize");
const path = require("path");

module.exports = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  // Only notarize macOS builds
  if (electronPlatformName !== "darwin") return;

  // Skip if explicitly disabled
  if (
    process.env.SKIP_NOTARIZE === "true" ||
    process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false"
  ) {
    console.log("Skipping notarization (disabled by env)");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const keyId = process.env.APPLE_API_KEY_ID;
  const issuerId = process.env.APPLE_API_ISSUER;
  const keyPath = process.env.APPLE_API_KEY_PATH;

  if (!keyId || !issuerId || !keyPath) {
    console.warn(
      "Skipping notarization: APPLE_API_KEY_ID, APPLE_API_ISSUER, or APPLE_API_KEY_PATH not set"
    );
    return;
  }

  console.log(`Notarizing ${appPath}...`);

  await notarize({
    appPath,
    appleApiKey: keyPath,
    appleApiKeyId: keyId,
    appleApiIssuer: issuerId,
  });

  console.log("Notarization complete");
};
