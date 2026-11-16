import { apiGet } from "./http.js";
import type { DeployEnv } from "./env.js";

/**
 * Harbor registry API client (0.2.0, CI-02 + DEP-02).
 *
 * Auth is HTTP Basic with the robot account: username
 * PIPELINE_DOCTOR_HARBOR_USER, password PIPELINE_DOCTOR_HARBOR_TOKEN.
 * A Harbor repository is "project/repo" — the first path segment is
 * the project, the rest is the repository.
 */

export interface HarborArtifact {
  digest: string;
  /** Size in bytes. Absent when the caller only needs the digest. */
  size?: number;
}

export type HarborResult =
  | { ok: true; artifact: HarborArtifact }
  | { ok: false; status: number };

function splitRepository(repository: string): {
  project: string;
  repo: string;
} {
  const slash = repository.indexOf("/");
  if (slash === -1) return { project: "library", repo: repository };
  return {
    project: repository.slice(0, slash),
    repo: repository.slice(slash + 1),
  };
}

/**
 * Fetches one artifact by repository + tag or digest.
 * Returns ok:false with the HTTP status on 4xx (404 = not in Harbor);
 * throws on network errors and 429/5xx (shared apiGet policy).
 */
export async function getHarborArtifact(
  env: DeployEnv,
  repository: string,
  reference: string,
  fetchFn: typeof fetch,
): Promise<HarborResult> {
  const base = (env.harborUrl as string).replace(/\/+$/, "");
  const { project, repo } = splitRepository(repository);
  const url =
    `${base}/api/v2.0/projects/${encodeURIComponent(project)}` +
    `/repositories/${encodeURIComponent(repo)}` +
    `/artifacts/${encodeURIComponent(reference)}`;
  const basic = Buffer.from(
    `${env.harborUser}:${env.harborToken}`,
    "utf8",
  ).toString("base64");
  const res = await apiGet(
    url,
    { headers: { Authorization: `Basic ${basic}` } },
    fetchFn,
  );
  if (res.status !== 200) return { ok: false, status: res.status };
  let body: unknown;
  try {
    body = JSON.parse(res.text) as unknown;
  } catch {
    throw new Error(`Harbor returned a non-JSON response for ${repository}`);
  }
  const digest =
    body !== null && typeof body === "object" && "digest" in body
      ? (body as { digest?: unknown }).digest
      : undefined;
  const size =
    body !== null && typeof body === "object" && "size" in body
      ? (body as { size?: unknown }).size
      : undefined;
  if (typeof digest !== "string") {
    throw new Error(`Harbor response for ${repository} has no digest field`);
  }
  if (size !== undefined && typeof size !== "number") {
    throw new Error(`Harbor response for ${repository} has no size field`);
  }
  return { ok: true, artifact: { digest, size } };
}
