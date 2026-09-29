import pg from "pg";
import { env } from "../config/env.js";

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
});

// node-postgres emits idle-client failures through EventEmitter. Without an
// error listener Node treats the event as uncaught and terminates the whole
// API process, so one stale connection can make every management route return
// 503 through the web proxy while queued jobs are running.
pool.on("error", (error) => {
  console.error(JSON.stringify({
    level: "error",
    component: "postgres-pool",
    event: "idle_client_error",
    message: error.message,
    stack: error.stack,
  }));
});

export async function closePool() {
  await pool.end();
}
