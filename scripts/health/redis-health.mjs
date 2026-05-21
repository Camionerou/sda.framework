import { Redis } from "@upstash/redis";

import { cleanEnvValue, loadEnvFiles } from "../shared/env-loader.mjs";

loadEnvFiles();

const url = cleanEnvValue(process.env.UPSTASH_REDIS_REST_URL);
const token = cleanEnvValue(process.env.UPSTASH_REDIS_REST_TOKEN);

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

let urlHost;
try {
  urlHost = new URL(url).host;
} catch {
  console.log(
    JSON.stringify(
      {
        configured: true,
        ok: false,
        reason: "invalid_upstash_redis_rest_url"
      },
      null,
      2
    )
  );
  process.exit(1);
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
        url_host: urlHost
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
        url_host: urlHost
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}
