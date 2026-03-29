import type { ModelEntry } from "@brainst0rm/shared";

export async function checkProviderHealth(
  baseUrl: string,
  timeout = 3000,
): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(timeout),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function markDegraded(model: ModelEntry): void {
  model.status = "degraded";
  model.lastHealthCheck = Date.now();
}

export function markUnavailable(model: ModelEntry): void {
  model.status = "unavailable";
  model.lastHealthCheck = Date.now();
}

export function markAvailable(model: ModelEntry): void {
  model.status = "available";
  model.lastHealthCheck = Date.now();
}
