import { cleanEnvValue, optionalOriginEnv } from "@/lib/platform/env";

type SameOriginResult =
  | { ok: true }
  | {
      error: string;
      ok: false;
      status: 403;
    };

function originFromValue(value: string | undefined) {
  const cleaned = cleanEnvValue(value);

  if (!cleaned) {
    return null;
  }

  try {
    return new URL(
      cleaned.startsWith("http://") || cleaned.startsWith("https://") ? cleaned : `https://${cleaned}`
    ).origin;
  } catch {
    return null;
  }
}

function allowedOrigins(request: Request) {
  const requestOrigin = originFromValue(request.url);
  const configuredOrigins = [
    "APP_ORIGIN",
    "NEXT_PUBLIC_APP_URL",
    "VERCEL_PROJECT_PRODUCTION_URL",
    "VERCEL_BRANCH_URL",
    "VERCEL_URL"
  ]
    .map((name) => {
      try {
        return optionalOriginEnv(name);
      } catch {
        return null;
      }
    })
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
