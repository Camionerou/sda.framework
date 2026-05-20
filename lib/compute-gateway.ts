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

    const text = await response.text();
    const body = text ? (JSON.parse(text) as Partial<ComputeGatewayIndexJobResponse>) : {};

    if (!response.ok) {
      throw new Error(
        body.status ?? `Compute Gateway respondio ${response.status} ${response.statusText}`.trim()
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

    const text = await response.text();
    const body = text ? (JSON.parse(text) as Partial<ComputeGatewayIndexJobStatus>) : {};

    if (!response.ok) {
      throw new Error(
        body.status ?? `Compute Gateway respondio ${response.status} ${response.statusText}`.trim()
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
