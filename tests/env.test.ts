import { describe, it, expect } from "vitest";
import {
  readDeployEnv,
  missingBackends,
  missingVarsReason,
} from "../src/env.js";

const FULL_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://localhost:5432/tasks",
  PIPELINE_DOCTOR_HARBOR_URL: "https://harbor.example.com",
  PIPELINE_DOCTOR_HARBOR_USER: "robot$test+ci",
  PIPELINE_DOCTOR_HARBOR_TOKEN: "harbor-token",
  PIPELINE_DOCTOR_ARGOCD_URL: "https://argocd.example.com",
  PIPELINE_DOCTOR_ARGOCD_TOKEN: "argocd-token",
  PIPELINE_DOCTOR_K8S_API_URL: "https://k8s.example.com:6443",
  PIPELINE_DOCTOR_K8S_TOKEN: "k8s-token",
  PIPELINE_DOCTOR_APP_URL: "https://app.example.com",
  PIPELINE_DOCTOR_APP_USER: "probe-user",
  PIPELINE_DOCTOR_APP_PASSWORD: "probe-pass",
  GITHUB_TOKEN: "ghp_testtoken",
};

describe("readDeployEnv", () => {
  it("reads every backend variable", () => {
    const env = readDeployEnv(FULL_ENV);
    expect(env.databaseUrl).toBe("postgres://localhost:5432/tasks");
    expect(env.harborUrl).toBe("https://harbor.example.com");
    expect(env.harborUser).toBe("robot$test+ci");
    expect(env.harborToken).toBe("harbor-token");
    expect(env.argocdUrl).toBe("https://argocd.example.com");
    expect(env.argocdToken).toBe("argocd-token");
    expect(env.k8sApiUrl).toBe("https://k8s.example.com:6443");
    expect(env.k8sToken).toBe("k8s-token");
    expect(env.appUrl).toBe("https://app.example.com");
    expect(env.appUser).toBe("probe-user");
    expect(env.appPassword).toBe("probe-pass");
    expect(env.githubToken).toBe("ghp_testtoken");
  });

  it("treats an empty string as missing", () => {
    const env = readDeployEnv({ ...FULL_ENV, DATABASE_URL: "   " });
    expect(env.databaseUrl).toBeUndefined();
  });

  it("returns undefined for everything when the env is empty", () => {
    const env = readDeployEnv({});
    expect(env).toEqual({
      databaseUrl: undefined,
      harborUrl: undefined,
      harborUser: undefined,
      harborToken: undefined,
      argocdUrl: undefined,
      argocdToken: undefined,
      k8sApiUrl: undefined,
      k8sToken: undefined,
      appUrl: undefined,
      appUser: undefined,
      appPassword: undefined,
      githubToken: undefined,
    });
  });
});

describe("missingBackends", () => {
  it("reports nothing missing when everything is configured", () => {
    expect(missingBackends(readDeployEnv(FULL_ENV))).toEqual([]);
  });

  it("reports every backend when nothing is configured", () => {
    expect(missingBackends(readDeployEnv({}))).toEqual([
      "database",
      "harbor",
      "argocd",
      "k8s",
      "app",
    ]);
  });

  it("reports a backend missing when only half its variables are set", () => {
    const env = readDeployEnv({
      PIPELINE_DOCTOR_HARBOR_URL: "https://harbor.example.com",
    });
    expect(missingBackends(env)).toContain("harbor");
  });
});

describe("missingVarsReason", () => {
  it("names the exact missing variables", () => {
    expect(missingVarsReason("database")).toBe("missing DATABASE_URL");
    expect(missingVarsReason("harbor")).toBe(
      "missing PIPELINE_DOCTOR_HARBOR_URL and PIPELINE_DOCTOR_HARBOR_USER and PIPELINE_DOCTOR_HARBOR_TOKEN",
    );
  });
});
