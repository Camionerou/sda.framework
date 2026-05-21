import type {
  ComputeGatewayIndexJobRequest,
  ComputeGatewayIndexJobResponse,
  ComputeGatewayIndexJobStatus,
  ComputeGatewayTreeIndexJobRequest,
  ComputeGatewayTreeIndexJobResponse,
  ComputeGatewayTreeIndexJobStatus
} from "@/lib/indexing/types";

export type {
  ComputeGatewayArtifact,
  ComputeGatewayDocumentRef,
  ComputeGatewayIndexJobRequest,
  ComputeGatewayIndexJobResponse,
  ComputeGatewayIndexJobStatus,
  ComputeGatewayTreeIndexJobRequest,
  ComputeGatewayTreeIndexJobResponse,
  ComputeGatewayTreeIndexJobStatus
} from "@/lib/indexing/types";

type ComputeGatewayConfig = {
  timeoutMs: number;
  token?: string;
  url: string;
};

type GatewayJson = Record<string, unknown>;
type GatewayMethod = "GET" | "POST";

export class ComputeGatewayNotConfiguredError extends Error {
  constructor() {
    super("COMPUTE_GATEWAY_URL no esta configurado.");
    this.name = "ComputeGatewayNotConfiguredError";
  }
}

function formatResponseStatus(response: Response) {
  return `${response.status} ${response.statusText}`.trim();
}

function errorMessageFromBody(body: GatewayJson, fallback: string) {
  for (const key of ["error", "message", "status", "detail"]) {
    const value = body[key];

    if (typeof value === "string" && value) {
      return value;
    }

    if (value && typeof value === "object") {
      return JSON.stringify(value);
    }
  }

  return fallback;
}

async function readJsonResponse<T extends GatewayJson>(
  response: Response,
  service: string
): Promise<Partial<T> & GatewayJson> {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as Partial<T> & GatewayJson;
  } catch {
    const status = formatResponseStatus(response);
    const snippet = text.replace(/\s+/g, " ").trim().slice(0, 500);
    throw new Error(`${service} respondio ${status} con cuerpo no JSON: ${snippet}`);
  }
}

function getTimeoutMs() {
  const value = Number(process.env.COMPUTE_GATEWAY_TIMEOUT_MS ?? 30_000);

  return Number.isFinite(value) && value > 0 ? value : 30_000;
}

export function getSignedUrlTtlSeconds() {
  const value = Number(process.env.COMPUTE_GATEWAY_SIGNED_URL_TTL_SECONDS ?? 60 * 60);

  return Number.isFinite(value) && value >= 60 ? value : 60 * 60;
}

export function getComputeGatewayConfig(): ComputeGatewayConfig | null {
  const url = process.env.COMPUTE_GATEWAY_URL?.trim();

  if (!url) {
    return null;
  }

  return {
    timeoutMs: getTimeoutMs(),
    token: process.env.COMPUTE_GATEWAY_TOKEN?.trim() || undefined,
    url: url.replace(/\/+$/, "")
  };
}

export function isComputeGatewayConfigured() {
  return Boolean(getComputeGatewayConfig());
}

async function callGateway<T extends GatewayJson & { job_id?: unknown }>(
  service: string,
  method: GatewayMethod,
  path: string,
  payload?: unknown
): Promise<T> {
  const config = getComputeGatewayConfig();

  if (!config) {
    throw new ComputeGatewayNotConfiguredError();
  }

  const response = await fetch(`${config.url}${path}`, {
    body: payload === undefined ? undefined : JSON.stringify(payload),
    headers: {
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      ...(payload === undefined ? {} : { "content-type": "application/json" })
    },
    method,
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  const body = await readJsonResponse<T>(response, service);

  if (!response.ok) {
    throw new Error(errorMessageFromBody(body, `${service} respondio ${formatResponseStatus(response)}`));
  }

  if (typeof body.job_id !== "string" || !body.job_id) {
    throw new Error(`${service} no devolvio job_id.`);
  }

  return body as T;
}

export function createComputeGatewayIndexJob(payload: ComputeGatewayIndexJobRequest) {
  return callGateway<ComputeGatewayIndexJobResponse>(
    "Compute Gateway",
    "POST",
    "/v1/index-jobs",
    payload
  );
}

export function getComputeGatewayIndexJob(jobId: string) {
  return callGateway<ComputeGatewayIndexJobStatus>(
    "Compute Gateway",
    "GET",
    `/v1/index-jobs/${jobId}`
  );
}

export function createComputeGatewayTreeIndexJob(
  payload: ComputeGatewayTreeIndexJobRequest
) {
  return callGateway<ComputeGatewayTreeIndexJobResponse>(
    "Tree Indexer",
    "POST",
    "/v1/tree-index-jobs",
    payload
  );
}

export function getComputeGatewayTreeIndexJob(jobId: string) {
  return callGateway<ComputeGatewayTreeIndexJobStatus>(
    "Tree Indexer",
    "GET",
    `/v1/tree-index-jobs/${jobId}`
  );
}
