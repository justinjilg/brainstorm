/**
 * API Contract Detection — finds where one project's HTTP client calls
 * match another project's server endpoint definitions.
 *
 * Uses endpoint data from @brainst0rm/ingest (mapEndpoints) and import
 * patterns to detect cross-project dependencies.
 */

export interface ApiContract {
  /** Project making the call. */
  clientProject: string;
  /** File containing the client call. */
  clientFile: string;
  /** HTTP method (GET, POST, etc.). */
  method: string;
  /** URL path pattern. */
  path: string;
  /** Project serving the endpoint. */
  serverProject: string;
  /** File containing the server route. */
  serverFile: string;
  /** Confidence (exact path match = 1.0, partial = 0.5). */
  confidence: number;
}

/**
 * Detect API contracts between two project graphs.
 *
 * Heuristic: scans for fetch/axios/http calls in the client project
 * and matches URL paths against endpoint routes in the server project.
 */
export function detectApiContracts(
  clientDb: any,
  serverDb: any,
  clientProject: string,
  serverProject: string,
): ApiContract[] {
  const contracts: ApiContract[] = [];

  // Get server endpoints (from ingest's mapEndpoints data stored in graph metadata)
  // Also try direct SQL from the call_edges — look for route-defining patterns
  const serverRoutes = serverDb
    .prepare(
      `
    SELECT DISTINCT name, file FROM functions
    WHERE name LIKE 'handle%' OR name LIKE 'get%' OR name LIKE 'post%'
       OR name LIKE 'put%' OR name LIKE 'delete%' OR name LIKE 'patch%'
  `,
    )
    .all() as Array<{ name: string; file: string }>;

  // Get client HTTP calls (functions named fetch, axios, http, request)
  const clientCalls = clientDb
    .prepare(
      `
    SELECT DISTINCT callee, file, caller FROM call_edges
    WHERE callee IN ('fetch', 'get', 'post', 'put', 'delete', 'patch', 'request')
       OR callee LIKE '%Client%'
  `,
    )
    .all() as Array<{ callee: string; file: string; caller: string | null }>;

  // Match by naming convention: client calls "getUsers" → server defines "handleGetUsers"
  for (const clientCall of clientCalls) {
    for (const serverRoute of serverRoutes) {
      // Extract the action from the server handler name
      const serverAction = serverRoute.name
        .replace(/^handle/, "")
        .replace(/^(get|post|put|delete|patch)/, "")
        .toLowerCase();

      const clientAction = (clientCall.caller ?? "")
        .replace(/^(fetch|get|post|put|delete|request)/, "")
        .toLowerCase();

      if (serverAction && clientAction && serverAction === clientAction) {
        contracts.push({
          clientProject,
          clientFile: clientCall.file,
          method: clientCall.callee.toUpperCase(),
          path: `/${serverAction}`,
          serverProject,
          serverFile: serverRoute.file,
          confidence: 0.5, // naming-convention match
        });
      }
    }
  }

  // Look for shared import sources (same npm package used by both)
  const clientImports = clientDb
    .prepare("SELECT DISTINCT source FROM imports WHERE source NOT LIKE '.%'")
    .all() as Array<{ source: string }>;

  const serverImports = new Set(
    (
      serverDb
        .prepare(
          "SELECT DISTINCT source FROM imports WHERE source NOT LIKE '.%'",
        )
        .all() as Array<{ source: string }>
    ).map((i) => i.source),
  );

  const sharedDeps = clientImports
    .filter((i) => serverImports.has(i.source))
    .map((i) => i.source);

  // Shared types suggest cross-project dependency
  // (not a contract per se, but useful signal)

  return contracts;
}
