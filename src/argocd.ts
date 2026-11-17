import { apiGet } from "./http.js";
import type { DeployEnv } from "./env.js";

/**
 * ArgoCD API client (0.2.0, DEP-03 + DEP-07).
 *
 * Read-only GETs with the API token (PIPELINE_DOCTOR_ARGOCD_TOKEN)
 * against PIPELINE_DOCTOR_ARGOCD_URL. A 4xx is returned to the
 * caller; network errors and 429/5xx throw (shared apiGet policy).
 */

export type ArgoResult<T> =
  | { ok: true; body: T }
  | { ok: false; status: number };

export interface ArgoResource {
  kind: string;
  name: string;
  namespace: string;
  /** "Synced" | "OutOfSync" | "Unknown" */
  status: string;
}

export interface ArgoApplication {
  metadata: { name: string };
  /** Absent on a fresh app that ArgoCD has not synced yet. */
  status?: {
    sync?: { status?: string };
    health?: { status?: string };
    resources?: ArgoResource[];
  };
}

export async function getApplication(
  env: DeployEnv,
  name: string,
  fetchFn: typeof fetch,
): Promise<ArgoResult<ArgoApplication>> {
  const base = (env.argocdUrl as string).replace(/\/+$/, "");
  const res = await apiGet(
    `${base}/api/v1/applications/${encodeURIComponent(name)}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${env.argocdToken}`,
      },
    },
    fetchFn,
  );
  if (res.status !== 200) return { ok: false, status: res.status };
  let body: unknown;
  try {
    body = JSON.parse(res.text) as unknown;
  } catch {
    throw new Error(`ArgoCD returned a non-JSON response for ${name}`);
  }
  return { ok: true, body: body as ArgoApplication };
}
