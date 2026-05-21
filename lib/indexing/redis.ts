import {
  acquireRedisLock,
  getRedis,
  getRedisJson,
  positiveIntegerEnv,
  redisKey,
  releaseRedisLock,
  setRedisHeartbeat,
  setRedisJson
} from "@/lib/redis/client";

export type IndexingRunSnapshot = {
  document_id: string;
  event_type?: string;
  message?: string;
  progress: number;
  run_id: string;
  stage: string;
  status: string;
  tenant_id: string;
  updated_at: string;
};

export function indexingDispatchLockTtlSeconds() {
  return positiveIntegerEnv("INDEXING_DISPATCH_LOCK_TTL_SECONDS", 120);
}

export function indexingTenantActiveLimit() {
  return positiveIntegerEnv("INDEXING_TENANT_ACTIVE_LIMIT", 2);
}

export function indexingTenantActiveTtlSeconds() {
  return positiveIntegerEnv("INDEXING_TENANT_ACTIVE_TTL_SECONDS", 3_600);
}

export function indexingRunSnapshotTtlSeconds() {
  return positiveIntegerEnv("INDEXING_RUN_SNAPSHOT_TTL_SECONDS", 3_600);
}

export async function acquireIndexingDispatchLock(input: {
  documentId: string;
  runId: string;
  tenantId: string;
}) {
  return acquireRedisLock(
    ["indexing-dispatch", input.tenantId, input.documentId, input.runId],
    indexingDispatchLockTtlSeconds()
  );
}

export async function releaseIndexingDispatchLock(lock: Awaited<ReturnType<typeof acquireIndexingDispatchLock>>) {
  return releaseRedisLock(lock);
}

export async function recordIndexingApiHeartbeat(metadata: Record<string, unknown> = {}) {
  return setRedisHeartbeat("indexing-api", metadata);
}

export async function reserveIndexingTenantActiveRun(input: {
  documentId: string;
  runId: string;
  tenantId: string;
}) {
  const redis = getRedis();
  const limit = indexingTenantActiveLimit();
  const ttlSeconds = indexingTenantActiveTtlSeconds();
  const key = redisKey("indexing", "tenant-active", input.tenantId);

  if (!redis) {
    return {
      active_count: null,
      allowed: true,
      configured: false,
      key,
      limit,
      retry_after_seconds: null,
      ttl_seconds: ttlSeconds
    };
  }

  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1_000;

  try {
    await redis.zremrangebyscore(key, 0, now);

    const existingScore = await redis.zscore(key, input.runId);
    const activeCount = await redis.zcard(key);

    if (existingScore === null && activeCount >= limit) {
      return {
        active_count: activeCount,
        allowed: false,
        configured: true,
        key,
        limit,
        retry_after_seconds: Math.min(60, ttlSeconds),
        ttl_seconds: ttlSeconds
      };
    }

    await redis.zadd(key, {
      member: input.runId,
      score: expiresAt
    });
    await redis.expire(key, ttlSeconds + 60);

    return {
      active_count: existingScore === null ? activeCount + 1 : activeCount,
      allowed: true,
      configured: true,
      key,
      limit,
      retry_after_seconds: null,
      ttl_seconds: ttlSeconds
    };
  } catch {
    return {
      active_count: null,
      allowed: true,
      configured: true,
      degraded: true,
      key,
      limit,
      retry_after_seconds: null,
      ttl_seconds: ttlSeconds
    };
  }
}

export async function releaseIndexingTenantActiveRun(input: {
  runId: string;
  tenantId: string;
}) {
  const redis = getRedis();
  const key = redisKey("indexing", "tenant-active", input.tenantId);

  if (!redis) {
    return { configured: false, key, released: 0 };
  }

  try {
    const released = await redis.zrem(key, input.runId);

    return { configured: true, key, released };
  } catch {
    return { configured: true, degraded: true, key, released: 0 };
  }
}

export async function recordIndexingRunSnapshot(input: {
  documentId: string;
  eventType?: string;
  message?: string;
  progress: number;
  runId: string;
  stage: string;
  status: string;
  tenantId: string;
}) {
  const snapshot: IndexingRunSnapshot = {
    document_id: input.documentId,
    event_type: input.eventType,
    message: input.message,
    progress: input.progress,
    run_id: input.runId,
    stage: input.stage,
    status: input.status,
    tenant_id: input.tenantId,
    updated_at: new Date().toISOString()
  };
  const ttlSeconds = indexingRunSnapshotTtlSeconds();

  const [runResult, documentResult, latestResult, heartbeatResult] = await Promise.all([
    setRedisJson(["indexing-run", input.tenantId, input.runId], snapshot, ttlSeconds),
    setRedisJson(["indexing-document", input.tenantId, input.documentId], snapshot, ttlSeconds),
    setRedisJson(["indexing-latest"], snapshot, ttlSeconds),
    setRedisHeartbeat("indexing-workflow", snapshot, ttlSeconds)
  ]);

  return {
    document: documentResult,
    heartbeat: heartbeatResult,
    latest: latestResult,
    run: runResult,
    snapshot
  };
}

export async function readLatestIndexingRunSnapshot() {
  return getRedisJson<IndexingRunSnapshot>(["indexing-latest"]);
}
