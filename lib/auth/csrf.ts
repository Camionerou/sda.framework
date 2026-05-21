type SameOriginResult =
  | { ok: true }
  | {
      error: string;
      ok: false;
      status: 403;
    };

function originFromValue(value: string | undefined) {
  if (!value) {
    return null;
  }

  const normalized = value.startsWith("http://") || value.startsWith("https://")
    ? value
    : `https://${value}`;

  try {
    return new URL(normalized).origin;
  } catch {
    return null;
  }
}

function allowedOrigins(request: Request) {
  const requestOrigin = originFromValue(request.url);
  const configuredOrigins = [
    process.env.APP_ORIGIN,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_URL
  ]
    .map(originFromValue)
    .filter((origin): origin is string => Boolean(origin));

  return new Set([requestOrigin, ...configuredOrigins].filter(Boolean));
}

export function requireSameOrigin(request: Request): SameOriginResult {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  if (!origin) {
    if (fetchSite === "cross-site") {
      return {
        error: "Cross-site requests are not allowed.",
        ok: false,
        status: 403
      };
    }

    return { ok: true };
  }

  const normalizedOrigin = originFromValue(origin);

  if (normalizedOrigin && allowedOrigins(request).has(normalizedOrigin)) {
    return { ok: true };
  }

  return {
    error: "Cross-origin requests are not allowed.",
    ok: false,
    status: 403
  };
}
