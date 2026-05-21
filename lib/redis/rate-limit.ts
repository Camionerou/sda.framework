import { Ratelimit, type Duration } from "@upstash/ratelimit";

import { getRedis, positiveIntegerEnv, redisKey } from "@/lib/redis/client";

type RateLimitResult = {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
  source: "disabled" | "error" | "upstash";
  success: boolean;
};

let indexingRequestLimiter: Ratelimit | null | undefined;
let inviteAcceptLimiter: Ratelimit | null | undefined;

function indexingRateLimitMax() {
  return positiveIntegerEnv("INDEXING_REQUEST_RATE_LIMIT_MAX", 20);
}

function indexingRateLimitWindow(): Duration {
  const value = process.env.INDEXING_REQUEST_RATE_LIMIT_WINDOW?.trim();

  return (value || "1 m") as Duration;
}

function inviteAcceptRateLimitMax() {
  return positiveIntegerEnv("INVITE_ACCEPT_RATE_LIMIT_MAX", 5);
}

function inviteAcceptRateLimitWindow(): Duration {
  const value = process.env.INVITE_ACCEPT_RATE_LIMIT_WINDOW?.trim();

  return (value || "1 h") as Duration;
}

function rateLimitTimeoutMs() {
  return positiveIntegerEnv("UPSTASH_REDIS_RATELIMIT_TIMEOUT_MS", 1_000);
}

function getIndexingRequestLimiter() {
  if (indexingRequestLimiter !== undefined) {
    return indexingRequestLimiter;
  }

  const redis = getRedis();

  if (!redis) {
    indexingRequestLimiter = null;
    return indexingRequestLimiter;
  }

  indexingRequestLimiter = new Ratelimit({
    analytics: process.env.UPSTASH_REDIS_RATELIMIT_ANALYTICS === "1",
    limiter: Ratelimit.slidingWindow(indexingRateLimitMax(), indexingRateLimitWindow()),
    prefix: redisKey("ratelimit", "indexing-request"),
    redis,
    timeout: rateLimitTimeoutMs()
  });

  return indexingRequestLimiter;
}

function getInviteAcceptLimiter() {
  if (inviteAcceptLimiter !== undefined) {
    return inviteAcceptLimiter;
  }

  const redis = getRedis();

  if (!redis) {
    inviteAcceptLimiter = null;
    return inviteAcceptLimiter;
  }

  inviteAcceptLimiter = new Ratelimit({
    analytics: process.env.UPSTASH_REDIS_RATELIMIT_ANALYTICS === "1",
    limiter: Ratelimit.slidingWindow(inviteAcceptRateLimitMax(), inviteAcceptRateLimitWindow()),
    prefix: redisKey("ratelimit", "invite-accept"),
    redis,
    timeout: rateLimitTimeoutMs()
  });

  return inviteAcceptLimiter;
}

export function clientIpFromHeaders(headers: Headers) {
  const forwardedFor = headers.get("x-forwarded-for")?.split(",")[0]?.trim();

  return (
    forwardedFor ||
    headers.get("x-real-ip")?.trim() ||
    headers.get("cf-connecting-ip")?.trim() ||
    undefined
  );
}

export async function limitIndexingRequest(input: {
  actorId: string;
  ip?: string;
  tenantId: string;
}): Promise<RateLimitResult> {
  const limiter = getIndexingRequestLimiter();

  if (!limiter) {
    return {
      limit: null,
      remaining: null,
      reset: null,
      source: "disabled",
      success: true
    };
  }

  try {
    const result = await limiter.limit(`tenant:${input.tenantId}:actor:${input.actorId}`, {
      ip: input.ip
    });

    return {
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
      source: "upstash",
      success: result.success
    };
  } catch {
    return {
      limit: null,
      remaining: null,
      reset: null,
      source: "error",
      success: true
    };
  }
}

export async function limitInviteAccept(input: {
  actorId: string;
  ip?: string;
}): Promise<RateLimitResult> {
  const limiter = getInviteAcceptLimiter();

  if (!limiter) {
    return {
      limit: null,
      remaining: null,
      reset: null,
      source: "disabled",
      success: true
    };
  }

  try {
    const result = await limiter.limit(`actor:${input.actorId}`, {
      ip: input.ip
    });

    return {
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
      source: "upstash",
      success: result.success
    };
  } catch {
    return {
      limit: null,
      remaining: null,
      reset: null,
      source: "error",
      success: true
    };
  }
}
