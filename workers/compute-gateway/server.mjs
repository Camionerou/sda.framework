import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.SDA_COMPUTE_GATEWAY_DATA_DIR ?? "/var/lib/sda-compute-gateway";
const TOKEN = process.env.SDA_COMPUTE_GATEWAY_TOKEN;

function json(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function requireAuth(request, response) {
  if (!TOKEN) {
    return true;
  }

  const header = request.headers.authorization ?? "";

  if (header === `Bearer ${TOKEN}`) {
    return true;
  }

  json(response, 401, { error: "Unauthorized" });
  return false;
}

async function readJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

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

function jobPath(jobId) {
  return join(DATA_DIR, "jobs", jobId, "job.json");
}

function inputPath(jobId, filename) {
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 180) || "document.bin";

  return join(DATA_DIR, "jobs", jobId, "input", safeFilename);
}

async function writeJob(job) {
  const path = jobPath(job.job_id);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(job, null, 2)}\n`);
}

async function readJob(jobId) {
  const path = jobPath(jobId);

  if (!existsSync(path)) {
    return null;
  }

  return JSON.parse(await readFile(path, "utf8"));
}

async function patchJob(jobId, patch) {
  const current = await readJob(jobId);

  if (!current) {
    return null;
  }

  const next = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString()
  };

  await writeJob(next);
  return next;
}

async function downloadDocument(job, payload) {
  await patchJob(job.job_id, {
    progress: 10,
    stage: "downloading",
    status: "running"
  });

  const response = await fetch(payload.document.signed_url);

  if (!response.ok || !response.body) {
    throw new Error(`Document download failed with ${response.status}.`);
  }

  const path = inputPath(job.job_id, payload.document.filename);

  await mkdir(dirname(path), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));

  await patchJob(job.job_id, {
    input_path: path,
    message: "Document downloaded. MinerU integration pending.",
    progress: 15,
    stage: "extracting",
    status: "downloaded"
  });
}

async function processJob(job, payload) {
  try {
    await downloadDocument(job, payload);
  } catch (error) {
    await patchJob(job.job_id, {
      error: error instanceof Error ? error.message : "Unknown gateway error.",
      stage: "failed",
      status: "failed"
    });
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
    json(response, 400, {
      error: error instanceof Error ? error.message : "Invalid request."
    });
    return;
  }

  const now = new Date().toISOString();
  const job = {
    created_at: now,
    document_id: payload.document_id,
    job_id: randomUUID(),
    progress: 0,
    run_id: payload.run_id,
    source: payload.source ?? "unknown",
    stage: "queued",
    status: "queued",
    tenant_id: payload.tenant_id,
    updated_at: now
  };

  await writeJob(job);
  void processJob(job, payload);

  json(response, 202, {
    job_id: job.job_id,
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

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/v1/health") {
      json(response, 200, {
        ok: true,
        service: "sda-compute-gateway"
      });
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
