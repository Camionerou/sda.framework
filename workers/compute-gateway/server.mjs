import { createServer } from "node:http";

import {
  COMPUTE_GATEWAY_VERSION,
  EXTRACTION_PIPELINE_VERSION,
  INDEXING_PIPELINE_VERSION,
  MAX_REQUEST_BODY_BYTES,
  MINERU_BACKEND,
  MINERU_LANG,
  PORT,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
  TOKEN,
  TREE_INDEXER_TOKEN
} from "./config.mjs";
import { json, readJson, RequestBodyTooLargeError, requireAuth } from "./http.mjs";
import { createQueuedIndexJob, queueSnapshot } from "./jobs/queue.mjs";
import { readJob } from "./jobs/store.mjs";
import { isTreeIndexerPath, proxyTreeIndexer } from "./proxy.mjs";

function validateIndexJob(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid JSON payload.");
  }

  for (const key of ["tenant_id", "document_id", "run_id"]) {
    if (typeof payload[key] !== "string" || !payload[key]) {
      throw new Error(`Missing ${key}.`);
    }
  }

  if (!payload.document || typeof payload.document !== "object") {
    throw new Error("Missing document.");
  }

  if (typeof payload.document.signed_url !== "string" || !payload.document.signed_url) {
    throw new Error("Missing document.signed_url.");
  }

  if (typeof payload.document.filename !== "string" || !payload.document.filename) {
    throw new Error("Missing document.filename.");
  }
}

async function createIndexJob(request, response) {
  if (!requireAuth(request, response)) {
    return;
  }

  let payload;

  try {
    payload = await readJson(request);
    validateIndexJob(payload);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      json(response, 413, {
        error: error.message,
        max_body_bytes: error.limit
      });
      return;
    }

    json(response, 400, {
      error: error instanceof Error ? error.message : "Invalid request."
    });
    return;
  }

  const { job, queue } = await createQueuedIndexJob(payload);

  json(response, 202, {
    job_id: job.job_id,
    queue,
    stage: job.stage,
    status: job.status
  });
}

async function getIndexJob(request, response, jobId) {
  if (!requireAuth(request, response)) {
    return;
  }

  const job = await readJob(jobId);

  if (!job) {
    json(response, 404, { error: "Job not found." });
    return;
  }

  json(response, 200, job);
}

function getHealth() {
  const queue = queueSnapshot();

  return {
    active_jobs: queue.active,
    auth_configured: Boolean(TOKEN),
    compute_gateway_version: COMPUTE_GATEWAY_VERSION,
    concurrency: queue.concurrency,
    extraction_pipeline_version: EXTRACTION_PIPELINE_VERSION,
    indexing_pipeline_version: INDEXING_PIPELINE_VERSION,
    mineru_backend: MINERU_BACKEND,
    mineru_lang: MINERU_LANG,
    mineru_storage_configured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
    ok: true,
    pending_jobs: queue.pending,
    request_body_limit_bytes: MAX_REQUEST_BODY_BYTES,
    service: "sda-compute-gateway",
    tree_indexer_auth_configured: Boolean(TREE_INDEXER_TOKEN)
  };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/v1/health") {
      if (!requireAuth(request, response)) {
        return;
      }

      json(response, 200, getHealth());
      return;
    }

    if (isTreeIndexerPath(url.pathname)) {
      await proxyTreeIndexer(request, response, url);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/index-jobs") {
      await createIndexJob(request, response);
      return;
    }

    const jobMatch = url.pathname.match(/^\/v1\/index-jobs\/([a-f0-9-]+)$/);

    if (request.method === "GET" && jobMatch) {
      await getIndexJob(request, response, jobMatch[1]);
      return;
    }

    json(response, 404, { error: "Not found." });
  } catch (error) {
    json(response, 500, {
      error: error instanceof Error ? error.message : "Internal server error."
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`sda-compute-gateway listening on 0.0.0.0:${PORT}`);
});
