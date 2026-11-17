import { Client } from "pg";
import type { DeployEnv } from "./env.js";

/**
 * Postgres access (0.2.0, DEP-06 + DEP-08 + DEP-11 share ONE
 * connection — decision 04).
 *
 * The query function is injectable so the Deploy checks can be
 * tested without a live database; production wraps a real `pg`
 * Client with 10s connect + query timeouts.
 */

export type PgQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export interface PgConnection {
  query: PgQuery;
  close: () => Promise<void>;
}

/**
 * Opens one connection. Returns null when DATABASE_URL is not set.
 * Throws when the connection fails — the caller reports it as the
 * DEP-06 finding (the database is a deploy target, not a third-party
 * data source, so an unreachable DB is a finding, not a tool error).
 */
export async function connectPostgres(
  env: DeployEnv,
): Promise<PgConnection | null> {
  if (env.databaseUrl === undefined) return null;
  const client = new Client({
    connectionString: env.databaseUrl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
  });
  await client.connect();
  return {
    query: async (sql: string, params?: unknown[]) => {
      const result = await client.query(sql, (params ?? []) as never[]);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    close: () => client.end(),
  };
}
