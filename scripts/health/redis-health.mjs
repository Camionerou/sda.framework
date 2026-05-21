import { Redis } from "@upstash/redis";

import { loadEnvFiles } from "../shared/env-loader.mjs";

loadEnvFiles();

const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

if (!url || !token) {
  console.log(
    JSON.stringify(
      {
        configured: false,
        ok: false,
        reason: "missing_upstash_redis_rest_url_or_token"
      },
      null,
      2
    )
  );
  process.exit(0);
}

const redis = new Redis({ token, url });
const startedAt = Date.now();

try {
  const response = await redis.ping();

  console.log(
    JSON.stringify(
      {
        configured: true,
        latency_ms: Date.now() - startedAt,
        ok: response === "PONG",
        response,
        url_host: new URL(url).host
      },
      null,
      2
    )
  );

  if (response !== "PONG") {
    process.exitCode = 1;
  }
} catch (error) {
  console.log(
    JSON.stringify(
      {
        configured: true,
        error: error instanceof Error ? error.message : "unknown redis ping error",
        latency_ms: Date.now() - startedAt,
        ok: false,
        url_host: new URL(url).host
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}
