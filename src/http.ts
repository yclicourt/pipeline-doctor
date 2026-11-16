/**
 * Shared HTTP policy for API clients (0.2.0).
 *
 * The rule (same spirit as the OSV client in v1): a network failure,
 * a 429 or a 5xx means the check cannot verify anything, so the run
 * fails loudly (exit 2) — never a silent pass. A 4xx is returned to
 * the caller, which decides what it means (usually "the token cannot
 * see that resource" → skipped with the status named).
 */

export const REQUEST_TIMEOUT_MS = 10_000;

export interface ApiResponse {
  status: number;
  text: string;
}

export async function apiGet(
  url: string,
  init: RequestInit,
  fetchFn: typeof fetch,
): Promise<ApiResponse> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `request to ${new URL(url).host} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 429 || response.status >= 500) {
    throw new Error(
      `${new URL(url).host} returned HTTP ${response.status} — retry later, the check cannot verify anything right now`,
    );
  }
  return { status: response.status, text: await response.text() };
}
