import { Redis } from "@upstash/redis";

import {
  cleanProviderKeyPart,
  defaultUpstashRedisKeyPrefix,
  getUpstashRedisConfig,
  positiveIntegerEnv
} from "@/lib/platform/server";

export type RedisConfig = {
  keyPrefix: string;
  token: string;
  url: string;
};

export type RedisLock = {
  acquired: boolean;
  configured: boolean;
  degraded?: boolean;
  key: string;
  value: string;
};

let redisClient: Redis | null | undefined;

export { positiveIntegerEnv };

export function getRedisConfig(): RedisConfig | null {
  return getUpstashRedisConfig();
}

export function isRedisConfigured() {
  return Boolean(getRedisConfig());
}

export function getRedis() {
  if (redisClient !== undefined) {
    return redisClient;
  }

  const config = getRedisConfig();

  if (!config) {
    redisClient = null;
    return redisClient;
  }

  redisClient = new Redis({
    token: config.token,
    url: config.url
  });

  return redisClient;
}

export function redisKey(...parts: string[]) {
  const config = getRedisConfig();
  const prefix = config?.keyPrefix ?? defaultUpstashRedisKeyPrefix();

  return [prefix, ...parts.map(cleanProviderKeyPart)].join(":");
}

export async function pingRedis() {
  const redis = getRedis();

  if (!redis) {
    return { configured: false, ok: false as const };
  }

  const response = await redis.ping();

  return {
    configured: true,
    ok: response === "PONG",
    response
  };
}

export async function setRedisHeartbeat(
  service: string,
  metadata: Record<string, unknown> = {},
  ttlSeconds = positiveIntegerEnv("UPSTASH_REDIS_HEARTBEAT_TTL_SECONDS", 120)
) {
  const redis = getRedis();
  const key = redisKey("heartbeat", service);

  if (!redis) {
    return { configured: false, key };
  }

  try {
    await redis.set(
      key,
      {
        at: new Date().toISOString(),
        metadata,
        service
      },
      { ex: ttlSeconds }
    );
  } catch {
    return { configured: true, degraded: true, key, ttl_seconds: ttlSeconds };
  }

  return { configured: true, key, ttl_seconds: ttlSeconds };
}

export async function acquireRedisLock(
  keyParts: string[],
  ttlSeconds: number,
  value = crypto.randomUUID()
): Promise<RedisLock> {
  const redis = getRedis();
  const key = redisKey("lock", ...keyParts);

  if (!redis) {
    return {
      acquired: true,
      configured: false,
      key,
      value
    };
  }

  let result: unknown;

  try {
    result = await redis.set(key, value, { ex: ttlSeconds, nx: true });
  } catch {
    return {
      acquired: true,
      configured: true,
      degraded: true,
      key,
      value
    };
  }

  return {
    acquired: result === "OK",
    configured: true,
    key,
    value
  };
}

export async function releaseRedisLock(lock: RedisLock) {
  const redis = getRedis();

  if (!redis || !lock.configured) {
    return { configured: Boolean(redis), released: false };
  }

  let currentValue: string | null;

  try {
    currentValue = await redis.get<string>(lock.key);
  } catch {
    return { configured: true, degraded: true, released: false };
  }

  if (currentValue !== lock.value) {
    return { configured: true, released: false };
  }

  let deleted = 0;

  try {
    deleted = await redis.del(lock.key);
  } catch {
    return { configured: true, degraded: true, released: false };
  }

  return {
    configured: true,
    released: deleted > 0
  };
}

export async function getRedisJson<T>(keyParts: string[]) {
  const redis = getRedis();
  const key = redisKey("cache", ...keyParts);

  if (!redis) {
    return { configured: false, hit: false as const, key, value: null as T | null };
  }

  try {
    const value = await redis.get<T>(key);

    return {
      configured: true,
      hit: value !== null,
      key,
      value
    };
  } catch {
    return { configured: true, degraded: true, hit: false as const, key, value: null as T | null };
  }
}

export async function setRedisJson<T>(keyParts: string[], value: T, ttlSeconds: number) {
  const redis = getRedis();
  const key = redisKey("cache", ...keyParts);

  if (!redis) {
    return { configured: false, key, stored: false };
  }

  try {
    await redis.set(key, value, { ex: ttlSeconds });

    return { configured: true, key, stored: true, ttl_seconds: ttlSeconds };
  } catch {
    return { configured: true, degraded: true, key, stored: false };
  }
}

export async function deleteRedisKey(keyParts: string[]) {
  const redis = getRedis();
  const key = redisKey("cache", ...keyParts);

  if (!redis) {
    return { configured: false, deleted: 0, key };
  }

  try {
    const deleted = await redis.del(key);

    return { configured: true, deleted, key };
  } catch {
    return { configured: true, degraded: true, deleted: 0, key };
  }
}
