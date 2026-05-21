export type ComputeGatewayDocumentRef = {
  byte_size: number | null;
  filename: string;
  mime_type: string;
  r2_bucket: string;
  r2_key: string;
  signed_url: string;
};

export type ComputeGatewayIndexJobRequest = {
  document: ComputeGatewayDocumentRef;
  document_id: string;
  run_id: string;
  source: string;
  tenant_id: string;
  versions?: Record<string, string>;
};

export type ComputeGatewayIndexJobResponse = {
  job_id: string;
  metadata?: Record<string, unknown>;
  queue?: {
    active: number;
    concurrency: number;
    pending: number;
  };
  stage?: string;
  status?: string;
};

export type ComputeGatewayTreeIndexJobRequest = {
  document_id: string;
  document_title?: string | null;
  extraction_id: string;
  filename?: string | null;
  run_id: string;
  source: string;
  tenant_id: string;
  versions?: Record<string, string>;
};

export type ComputeGatewayTreeIndexJobResponse = {
  job_id: string;
  stage?: string;
  status?: string;
};

export type ComputeGatewayArtifact = {
  artifact_type: string;
  byte_size: number;
  checksum_sha256: string;
  content_type: string;
  relative_path: string;
  storage_bucket: string;
  storage_path: string;
};

export type ComputeGatewayIndexJobStatus = {
  artifact_bucket?: string;
  artifact_count?: number;
  artifact_prefix?: string;
  artifacts?: ComputeGatewayArtifact[];
  completed_at?: string;
  created_at: string;
  document_id: string;
  error?: string;
  failed_at?: string;
  job_id: string;
  manifest?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  message?: string;
  mineru_backend?: string;
  mineru_lang?: string;
  mineru_version?: string;
  progress: number;
  run_id: string;
  stage: string;
  started_at?: string;
  status: "queued" | "running" | "succeeded" | "failed" | string;
  tenant_id: string;
  updated_at: string;
  versions?: Record<string, string>;
};

export type ComputeGatewayTreeIndexJobStatus = {
  artifact_count?: number;
  chunk_count?: number;
  completed_at?: string;
  content_list_path?: string;
  created_at: string;
  doc_summary?: string;
  document_id: string;
  error?: string;
  failed_at?: string;
  extraction_id: string;
  job_id: string;
  message?: string;
  metrics?: Record<string, unknown>;
  model?: string;
  page_count?: number;
  persisted_at?: string;
  progress: number;
  provider?: string;
  run_id: string;
  source: string;
  stage: string;
  status: "queued" | "running" | "succeeded" | "failed" | string;
  tenant_id: string;
  updated_at: string;
  version?: string;
  versions?: Record<string, string>;
};

type ComputeGatewayConfig = {
  timeoutMs: number;
  token?: string;
  url: string;
};

export class ComputeGatewayNotConfiguredError extends Error {
  constructor() {
    super("COMPUTE_GATEWAY_URL no esta configurado.");
    this.name = "ComputeGatewayNotConfiguredError";
  }
}

type GatewayJson = Record<string, unknown>;

function formatResponseStatus(response: Response) {
  return `${response.status} ${response.statusText}`.trim();
}

function truncateResponseBody(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
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
    const snippet = truncateResponseBody(text);
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

export async function createComputeGatewayIndexJob(
  payload: ComputeGatewayIndexJobRequest
): Promise<ComputeGatewayIndexJobResponse> {
  const config = getComputeGatewayConfig();

  if (!config) {
    throw new ComputeGatewayNotConfiguredError();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.url}/v1/index-jobs`, {
      body: JSON.stringify(payload),
      headers: {
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        "content-type": "application/json"
      },
      method: "POST",
      signal: controller.signal
    });

    const body = await readJsonResponse<ComputeGatewayIndexJobResponse>(
      response,
      "Compute Gateway"
    );

    if (!response.ok) {
      throw new Error(
        errorMessageFromBody(body, `Compute Gateway respondio ${formatResponseStatus(response)}`)
      );
    }

    if (!body.job_id) {
      throw new Error("Compute Gateway no devolvio job_id.");
    }

    return {
      job_id: body.job_id,
      metadata: body.metadata,
      queue: body.queue,
      stage: body.stage,
      status: body.status
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getComputeGatewayIndexJob(
  jobId: string
): Promise<ComputeGatewayIndexJobStatus> {
  const config = getComputeGatewayConfig();

  if (!config) {
    throw new ComputeGatewayNotConfiguredError();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.url}/v1/index-jobs/${jobId}`, {
      headers: {
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {})
      },
      method: "GET",
      signal: controller.signal
    });

    const body = await readJsonResponse<ComputeGatewayIndexJobStatus>(
      response,
      "Compute Gateway"
    );

    if (!response.ok) {
      throw new Error(
        errorMessageFromBody(body, `Compute Gateway respondio ${formatResponseStatus(response)}`)
      );
    }

    if (!body.job_id) {
      throw new Error("Compute Gateway no devolvio job_id.");
    }

    return body as ComputeGatewayIndexJobStatus;
  } finally {
    clearTimeout(timeout);
  }
}

export async function createComputeGatewayTreeIndexJob(
  payload: ComputeGatewayTreeIndexJobRequest
): Promise<ComputeGatewayTreeIndexJobResponse> {
  const config = getComputeGatewayConfig();

  if (!config) {
    throw new ComputeGatewayNotConfiguredError();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.url}/v1/tree-index-jobs`, {
      body: JSON.stringify(payload),
      headers: {
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        "content-type": "application/json"
      },
      method: "POST",
      signal: controller.signal
    });

    const body = await readJsonResponse<ComputeGatewayTreeIndexJobResponse>(
      response,
      "Tree Indexer"
    );

    if (!response.ok) {
      throw new Error(
        errorMessageFromBody(body, `Tree Indexer respondio ${formatResponseStatus(response)}`)
      );
    }

    if (!body.job_id) {
      throw new Error("Tree Indexer no devolvio job_id.");
    }

    return {
      job_id: body.job_id,
      stage: body.stage,
      status: body.status
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getComputeGatewayTreeIndexJob(
  jobId: string
): Promise<ComputeGatewayTreeIndexJobStatus> {
  const config = getComputeGatewayConfig();

  if (!config) {
    throw new ComputeGatewayNotConfiguredError();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.url}/v1/tree-index-jobs/${jobId}`, {
      headers: {
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {})
      },
      method: "GET",
      signal: controller.signal
    });

    const body = await readJsonResponse<ComputeGatewayTreeIndexJobStatus>(
      response,
      "Tree Indexer"
    );

    if (!response.ok) {
      throw new Error(
        errorMessageFromBody(body, `Tree Indexer respondio ${formatResponseStatus(response)}`)
      );
    }

    if (!body.job_id) {
      throw new Error("Tree Indexer no devolvio job_id.");
    }

    return body as ComputeGatewayTreeIndexJobStatus;
  } finally {
    clearTimeout(timeout);
  }
}
