import { Redis } from "@upstash/redis";

import { envValue, loadSdaEnv, requiredEnv } from "./env.mjs";

export function cleanKeyPart(value) {
  return String(value).replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 180) || "unknown";
}

export function redisConfig() {
  loadSdaEnv();

  const url = envValue("UPSTASH_REDIS_REST_URL");
  const token = envValue("UPSTASH_REDIS_REST_TOKEN");

  if (!url || !token) {
    return null;
  }

  return {
    keyPrefix:
      envValue("UPSTASH_REDIS_KEY_PREFIX") ||
      `sda:${cleanKeyPart(process.env.VERCEL_ENV || process.env.NODE_ENV || "local")}`,
    token,
    url
  };
}

export function createRedis() {
  const config = redisConfig();

  if (!config) {
    throw new Error("Faltan UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN.");
  }

  return {
    config,
    redis: new Redis({
      token: requiredEnv("UPSTASH_REDIS_REST_TOKEN"),
      url: requiredEnv("UPSTASH_REDIS_REST_URL")
    })
  };
}

export function prefixedRedisKey(key, prefix) {
  const text = String(key);

  return text.startsWith(`${prefix}:`) ? text : `${prefix}:${text}`;
}
