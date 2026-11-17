import { apiGet } from "./http.js";
import type { DeployEnv } from "./env.js";

/**
 * Kubernetes API client (0.2.0, DEP-01/04/09/10).
 *
 * Read-only: every call is a GET with a ServiceAccount bearer token
 * (PIPELINE_DOCTOR_K8S_TOKEN) against PIPELINE_DOCTOR_K8S_API_URL.
 * A 4xx is returned to the caller (usually "not found" → an error
 * finding); network errors and 429/5xx throw (shared apiGet policy).
 */

export type K8sResult<T> =
  | { ok: true; body: T }
  | { ok: false; status: number };

export interface K8sDeployment {
  metadata: { name: string; namespace: string; generation?: number };
  spec: {
    replicas?: number;
    template?: {
      spec?: {
        containers?: { name: string; image: string }[];
      };
    };
  };
  status: {
    replicas?: number;
    updatedReplicas?: number;
    availableReplicas?: number;
    observedGeneration?: number;
    conditions?: { type: string; status: string; reason?: string }[];
  };
}

export interface K8sEndpoints {
  subsets?: { addresses?: { ip: string }[] }[];
}

export interface K8sPod {
  metadata: { name: string; namespace: string };
  status: {
    phase?: string;
    containerStatuses?: {
      name: string;
      restartCount: number;
      state?: {
        waiting?: { reason?: string };
        terminated?: { reason?: string };
      };
      lastState?: {
        terminated?: { reason?: string };
      };
    }[];
  };
}

export interface K8sEvent {
  metadata: { name: string };
  involvedObject: { kind: string; name: string };
  reason: string;
  type: string;
  lastTimestamp?: string;
}

function baseUrl(env: DeployEnv): string {
  return (env.k8sApiUrl as string).replace(/\/+$/, "");
}

function headers(env: DeployEnv): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${env.k8sToken}`,
  };
}

async function k8sGet<T>(
  env: DeployEnv,
  path: string,
  fetchFn: typeof fetch,
): Promise<K8sResult<T>> {
  const res = await apiGet(`${baseUrl(env)}${path}`, { headers: headers(env) }, fetchFn);
  if (res.status !== 200) return { ok: false, status: res.status };
  let body: unknown;
  try {
    body = JSON.parse(res.text) as unknown;
  } catch {
    throw new Error(`Kubernetes API returned a non-JSON response for ${path}`);
  }
  return { ok: true, body: body as T };
}

export async function getDeployment(
  env: DeployEnv,
  namespace: string,
  name: string,
  fetchFn: typeof fetch,
): Promise<K8sResult<K8sDeployment>> {
  return k8sGet<K8sDeployment>(
    env,
    `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`,
    fetchFn,
  );
}

export async function getEndpoints(
  env: DeployEnv,
  namespace: string,
  serviceName: string,
  fetchFn: typeof fetch,
): Promise<K8sResult<K8sEndpoints>> {
  return k8sGet<K8sEndpoints>(
    env,
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/endpoints/${encodeURIComponent(serviceName)}`,
    fetchFn,
  );
}

export async function listPods(
  env: DeployEnv,
  namespace: string,
  labelSelector: string,
  fetchFn: typeof fetch,
): Promise<K8sResult<{ items: K8sPod[] }>> {
  return k8sGet<{ items: K8sPod[] }>(
    env,
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${encodeURIComponent(labelSelector)}`,
    fetchFn,
  );
}

export async function listEvents(
  env: DeployEnv,
  namespace: string,
  fetchFn: typeof fetch,
): Promise<K8sResult<{ items: K8sEvent[] }>> {
  return k8sGet<{ items: K8sEvent[] }>(
    env,
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/events`,
    fetchFn,
  );
}
