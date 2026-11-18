/**
 * `pg` for Cloudflare Workers.
 *
 * `api/[...path].ts` reaches Postgres through `pg.Pool`, including real
 * transactions (`pool.connect()` → BEGIN/COMMIT/ROLLBACK) for account deletion,
 * invite acceptance and profile deletion. Workers cannot load the native `pg`
 * driver, but Neon's serverless driver exposes the same Pool/Client surface over
 * WebSockets, which Workers support natively.
 *
 * `wrangler.jsonc` aliases `pg` to this module at bundle time. The Vercel/Node
 * deployment keeps importing the real driver, so there is one handler source
 * with two transports.
 */

import { Pool as NeonPool } from "@neondatabase/serverless";

/** The only `pg.PoolConfig` field this app sets for the serverless transport. */
export interface PoolConfig {
  connectionString?: string;
}

class Pool extends NeonPool {
  constructor(config: PoolConfig = {}) {
    // The native driver's `ssl` / `max` options describe a TCP pool; the
    // serverless driver already speaks TLS to Neon and manages its own
    // connections, so only the connection string is forwarded.
    super({ connectionString: config.connectionString });
  }
}

const pg = { Pool };

export default pg;
export { Pool };
