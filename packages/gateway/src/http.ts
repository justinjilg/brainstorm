import { createLogger } from "@brainst0rm/shared";

const log = createLogger("gateway");

/**
 * Shared HTTP request helper for gateway API calls.
 * Used by both BrainstormGateway and IntelligenceAPIClient.
 */
export async function gatewayRequest(
  baseUrl: string,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
  errorPrefix = "Gateway",
  extraHeaders?: Record<string, string>,
): Promise<any> {
  const url = `${baseUrl}${path}`;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });

    // Own the body-read timeout so we can cancel it after the race
    // resolves. The previous version attached a listener to an
    // AbortSignal.timeout() handle and never removed it — after the body
    // read won the race, the timer still fired 15s later and called
    // reject() on a Promise that nothing was awaiting, producing an
    // unhandled rejection plus a retained closure under load.
    const bodyController = new AbortController();
    const bodyTimer = setTimeout(() => bodyController.abort(), 15_000);
    let text: string;
    try {
      text = await Promise.race([
        response.text(),
        new Promise<never>((_, reject) => {
          bodyController.signal.addEventListener(
            "abort",
            () => reject(new Error("Response body read timed out")),
            { once: true },
          );
        }),
      ]);
    } finally {
      clearTimeout(bodyTimer);
    }
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      const preview = text.slice(0, 200).replace(/\n/g, " ");
      const msg = `HTTP ${response.status}: non-JSON response (${preview})`;
      log.warn({ method, path, status: response.status }, msg);
      throw new Error(`${errorPrefix} ${method} ${path}: ${msg}`);
    }

    if (!response.ok) {
      const msg = data?.error?.message ?? `HTTP ${response.status}`;
      log.warn(
        { method, path, status: response.status, error: msg },
        `${errorPrefix} request failed`,
      );
      throw new Error(`${errorPrefix} ${method} ${path}: ${msg}`);
    }

    return data;
  } catch (error: any) {
    if (error.message?.startsWith(`${errorPrefix} `)) throw error;
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error(
        `${errorPrefix} ${method} ${path}: request timed out after 15s`,
      );
    }
    log.warn(
      { method, path, errorMessage: error.message },
      `${errorPrefix} request error`,
    );
    throw new Error(`${errorPrefix} ${method} ${path}: ${error.message}`);
  }
}
