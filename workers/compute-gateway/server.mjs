import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.SDA_COMPUTE_GATEWAY_DATA_DIR ?? "/var/lib/sda-compute-gateway";
const COMPUTE_GATEWAY_VERSION = process.env.SDA_COMPUTE_GATEWAY_VERSION ?? "0.1.3";
const EXTRACTION_PIPELINE_VERSION = process.env.SDA_EXTRACTION_PIPELINE_VERSION ?? "0.1.6";
const INDEXING_PIPELINE_VERSION = process.env.SDA_INDEXING_PIPELINE_VERSION ?? "0.1.7";
const MAX_CONCURRENT_JOBS = positiveInteger(process.env.SDA_COMPUTE_GATEWAY_CONCURRENCY, 1);
const MAX_REQUEST_BODY_BYTES = positiveInteger(
  process.env.SDA_COMPUTE_GATEWAY_MAX_BODY_BYTES,
  1_048_576
);
const MINERU_BACKEND = process.env.SDA_MINERU_BACKEND ?? "pipeline";
const MINERU_BIN = process.env.SDA_MINERU_BIN ?? "/home/sistemas/sda-mineru/.venv/bin/mineru";
const MINERU_LANG = process.env.SDA_MINERU_LANG ?? "latin";
const MINERU_PDF_RENDER_TIMEOUT = process.env.SDA_MINERU_PDF_RENDER_TIMEOUT ?? "600";
const MINERU_TASK_RESULT_TIMEOUT = process.env.SDA_MINERU_TASK_RESULT_TIMEOUT ?? "1800";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const TOKEN = process.env.SDA_COMPUTE_GATEWAY_TOKEN;
const TREE_INDEXER_TOKEN = process.env.SDA_TREE_INDEXER_TOKEN ?? TOKEN;
const ALLOW_UNAUTHENTICATED_WORKER = process.env.SDA_ALLOW_UNAUTHENTICATED_WORKER === "1";
const TREE_INDEXER_URL = (process.env.SDA_TREE_INDEXER_URL ?? "http://127.0.0.1:8790").replace(
  /\/+$/,
  ""
);
const execFileAsync = promisify(execFile);

let activeJobs = 0;
const pendingJobs = [];

function positiveInteger(value, fallback) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function json(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

class RequestBodyTooLargeError extends Error {
  constructor(limit) {
    super(`Request body exceeds ${limit} bytes.`);
    this.name = "RequestBodyTooLargeError";
    this.limit = limit;
  }
}

function requireAuth(request, response) {
  if (!TOKEN) {
    if (ALLOW_UNAUTHENTICATED_WORKER) {
      return true;
    }

    json(response, 503, { error: "Worker auth token is not configured." });
    return false;
  }

  const header = request.headers.authorization ?? "";

  if (header === `Bearer ${TOKEN}`) {
    return true;
  }

  json(response, 401, { error: "Unauthorized" });
  return false;
}

async function readRequestBody(request, limit = MAX_REQUEST_BODY_BYTES) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > limit) {
      throw new RequestBodyTooLargeError(limit);
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readJson(request) {
  return JSON.parse((await readRequestBody(request)).toString("utf8"));
}

async function readText(request) {
  return (await readRequestBody(request)).toString("utf8");
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

function jobDir(jobId) {
  return join(DATA_DIR, "jobs", jobId);
}

function mineruOutputPath(jobId) {
  return join(jobDir(jobId), "extractions", "mineru");
}

function mineruLogPath(jobId) {
  return join(jobDir(jobId), "logs", "mineru.log");
}

function storagePathForArtifact(payload, parserVersion, jobId, artifactPath) {
  return [
    payload.tenant_id,
    payload.document_id,
    "extractions",
    "mineru",
    parserVersion,
    jobId,
    ...artifactPath.split("/")
  ].join("/");
}

function contentTypeForPath(path) {
  if (path.endsWith(".json")) {
    return "application/json";
  }

  if (path.endsWith(".md")) {
    return "text/markdown";
  }

  if (path.endsWith(".pdf")) {
    return "application/pdf";
  }

  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (path.endsWith(".png")) {
    return "image/png";
  }

  if (path.endsWith(".log") || path.endsWith(".txt")) {
    return "text/plain";
  }

  return "application/octet-stream";
}

function artifactTypeForPath(path) {
  const basename = path.split("/").pop() ?? path;

  if (basename.endsWith("_content_list.json")) {
    return "content_list";
  }

  if (basename.endsWith("_content_list_v2.json")) {
    return "content_list_v2";
  }

  if (basename.endsWith("_middle.json")) {
    return "middle_json";
  }

  if (basename.endsWith("_model.json")) {
    return "model_json";
  }

  if (basename.endsWith("_layout.pdf")) {
    return "layout_pdf";
  }

  if (basename.endsWith("_span.pdf")) {
    return "span_pdf";
  }

  if (basename.endsWith("_origin.pdf")) {
    return "origin_pdf";
  }

  if (basename.endsWith(".md")) {
    return "markdown";
  }

  if (basename.endsWith(".jpg") || basename.endsWith(".jpeg") || basename.endsWith(".png")) {
    return "image";
  }

  if (basename.endsWith(".log")) {
    return "log";
  }

  return "artifact";
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

async function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function listFiles(root, prefix = "") {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = join(root, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath, relativePath)));
    } else if (entry.isFile()) {
      files.push({ absolutePath, relativePath });
    }
  }

  return files;
}

async function getMineruVersion() {
  const { stdout } = await execFileAsync(MINERU_BIN, ["--version"], {
    timeout: 30_000
  });
  const text = stdout.trim();
  const match = text.match(/version\s+([^\s]+)/i);

  return match?.[1] ?? text;
}

function requireSupabaseStorageConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridos para persistir artefactos.");
  }

  return {
    key: SUPABASE_SERVICE_ROLE_KEY,
    url: SUPABASE_URL
  };
}

async function uploadStorageObject(bucket, path, filePath, contentType, byteSize) {
  const config = requireSupabaseStorageConfig();
  const encodedBucket = encodeURIComponent(bucket);
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${config.url}/storage/v1/object/${encodedBucket}/${encodedPath}`, {
    body: createReadStream(filePath),
    // Required by Node fetch when streaming a request body.
    duplex: "half",
    headers: {
      apikey: config.key,
      authorization: `Bearer ${config.key}`,
      "cache-control": "3600",
      "content-length": String(byteSize),
      "content-type": contentType,
      "x-upsert": "true"
    },
    method: "POST"
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Storage upload failed ${response.status}: ${text || response.statusText}`);
  }
}

async function summarizeContentList(outputRoot) {
  const files = await listFiles(outputRoot);
  const contentList = files.find((file) => file.relativePath.endsWith("_content_list.json"));

  if (!contentList) {
    return null;
  }

  const data = JSON.parse(await readFile(contentList.absolutePath, "utf8"));

  if (!Array.isArray(data)) {
    return null;
  }

  const types = {};
  const pages = new Set();

  for (const item of data) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const type = typeof item.type === "string" ? item.type : "unknown";
    types[type] = (types[type] ?? 0) + 1;

    if (Number.isInteger(item.page_idx)) {
      pages.add(item.page_idx);
    }
  }

  const sortedPages = [...pages].sort((a, b) => a - b);

  return {
    item_count: data.length,
    page_count: sortedPages.length,
    page_end: sortedPages.at(-1) ?? null,
    page_start: sortedPages[0] ?? null,
    types
  };
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
    message: "Document downloaded.",
    progress: 15,
    stage: "extracting",
    status: "running"
  });

  return path;
}

async function runMineru(job, inputFile) {
  const outputDir = mineruOutputPath(job.job_id);
  const logPath = mineruLogPath(job.job_id);
  const parserVersion = await getMineruVersion();

  await rm(outputDir, { force: true, recursive: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(dirname(logPath), { recursive: true });

  await patchJob(job.job_id, {
    message: "MinerU extraction started.",
    mineru_backend: MINERU_BACKEND,
    mineru_lang: MINERU_LANG,
    mineru_version: parserVersion,
    output_path: outputDir,
    progress: 25,
    stage: "extracting",
    status: "running"
  });

  await new Promise((resolve, reject) => {
    const logStream = createWriteStream(logPath, { flags: "a" });
    const child = execMineru(inputFile, outputDir);

    logStream.write(`started_at=${new Date().toISOString()}\n`);
    logStream.write(`mineru_version=${parserVersion}\n`);
    logStream.write(`input=${inputFile}\n`);
    logStream.write(`output=${outputDir}\n`);

    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });
    child.on("error", (error) => {
      logStream.end();
      reject(error);
    });
    child.on("close", (code) => {
      logStream.write(`finished_at=${new Date().toISOString()}\n`);
      logStream.write(`exit_code=${code}\n`);
      logStream.end();

      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`MinerU exited with code ${code}.`));
      }
    });
  });

  await patchJob(job.job_id, {
    message: "MinerU extraction completed. Uploading artifacts.",
    progress: 70,
    stage: "persisting_artifacts",
    status: "running"
  });

  return {
    logPath,
    outputDir,
    parserVersion
  };
}

function execMineru(inputFile, outputDir) {
  return spawn(
    MINERU_BIN,
    ["-p", inputFile, "-o", outputDir, "-b", MINERU_BACKEND, "-l", MINERU_LANG],
    {
      env: {
        ...process.env,
        MINERU_PDF_RENDER_TIMEOUT,
        MINERU_TASK_RESULT_TIMEOUT_SECONDS: MINERU_TASK_RESULT_TIMEOUT
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
}

async function uploadArtifacts(job, payload, mineruResult) {
  const outputFiles = await listFiles(mineruResult.outputDir);
  const logRelativePath = "logs/mineru.log";
  const files = [
    ...outputFiles,
    {
      absolutePath: mineruResult.logPath,
      relativePath: logRelativePath
    }
  ];
  const artifactBucket = payload.document.r2_bucket || "documents";
  const artifactPrefix = [
    payload.tenant_id,
    payload.document_id,
    "extractions",
    "mineru",
    mineruResult.parserVersion,
    job.job_id
  ].join("/");
  const artifacts = [];
  let uploaded = 0;

  for (const file of files) {
    const fileStats = await stat(file.absolutePath);
    const contentType = contentTypeForPath(file.relativePath);
    const storagePath = storagePathForArtifact(
      payload,
      mineruResult.parserVersion,
      job.job_id,
      file.relativePath
    );
    const checksum = await sha256File(file.absolutePath);

    await uploadStorageObject(
      artifactBucket,
      storagePath,
      file.absolutePath,
      contentType,
      fileStats.size
    );

    artifacts.push({
      artifact_type: artifactTypeForPath(file.relativePath),
      byte_size: fileStats.size,
      checksum_sha256: checksum,
      content_type: contentType,
      relative_path: file.relativePath,
      storage_bucket: artifactBucket,
      storage_path: storagePath
    });

    uploaded += 1;
    await patchJob(job.job_id, {
      message: `Uploaded ${uploaded}/${files.length} MinerU artifacts.`,
      progress: Math.min(95, 70 + Math.floor((uploaded / files.length) * 25)),
      stage: "persisting_artifacts",
      status: "running"
    });
  }

  return {
    artifact_bucket: artifactBucket,
    artifact_prefix: artifactPrefix,
    artifacts
  };
}

function versionFromPayload(payload, key, fallback) {
  const value = payload?.versions?.[key];

  return typeof value === "string" && value ? value : fallback;
}

async function buildExtractionManifest(payload, mineruResult, artifactUpload) {
  const content = await summarizeContentList(mineruResult.outputDir);

  return {
    artifact_bucket: artifactUpload.artifact_bucket,
    artifact_count: artifactUpload.artifacts.length,
    artifact_prefix: artifactUpload.artifact_prefix,
    artifacts: artifactUpload.artifacts,
    backend: MINERU_BACKEND,
    compute_gateway_version: COMPUTE_GATEWAY_VERSION,
    content,
    extraction_pipeline_version: versionFromPayload(
      payload,
      "extraction_pipeline_version",
      EXTRACTION_PIPELINE_VERSION
    ),
    indexing_pipeline_version: versionFromPayload(
      payload,
      "indexing_pipeline_version",
      INDEXING_PIPELINE_VERSION
    ),
    lang: MINERU_LANG,
    parser: "mineru",
    parser_version: mineruResult.parserVersion,
    versions: payload.versions ?? {}
  };
}

async function processJob(job, payload) {
  try {
    const startedAt = new Date().toISOString();
    const inputFile = await downloadDocument(job, payload);
    const mineruResult = await runMineru(job, inputFile);
    const artifactUpload = await uploadArtifacts(job, payload, mineruResult);
    const manifest = await buildExtractionManifest(payload, mineruResult, artifactUpload);

    await patchJob(job.job_id, {
      artifact_bucket: manifest.artifact_bucket,
      artifact_count: manifest.artifact_count,
      artifact_prefix: manifest.artifact_prefix,
      artifacts: manifest.artifacts,
      completed_at: new Date().toISOString(),
      manifest,
      metadata: {
        versions: payload.versions ?? {}
      },
      message: "MinerU extraction persisted.",
      mineru_backend: MINERU_BACKEND,
      mineru_lang: MINERU_LANG,
      mineru_version: mineruResult.parserVersion,
      progress: 100,
      stage: "extracted",
      started_at: startedAt,
      status: "succeeded"
    });
  } catch (error) {
    await patchJob(job.job_id, {
      error: error instanceof Error ? error.message : "Unknown gateway error.",
      failed_at: new Date().toISOString(),
      progress: 100,
      stage: "failed",
      status: "failed"
    });
  }
}

function enqueueJob(job, payload) {
  pendingJobs.push({ job, payload });
  void drainQueue();
}

async function drainQueue() {
  while (activeJobs < MAX_CONCURRENT_JOBS && pendingJobs.length > 0) {
    const next = pendingJobs.shift();

    if (!next) {
      return;
    }

    activeJobs += 1;

    void processJob(next.job, next.payload).finally(() => {
      activeJobs -= 1;
      void drainQueue();
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

  const now = new Date().toISOString();
  const job = {
    created_at: now,
    document_id: payload.document_id,
    job_id: randomUUID(),
    mineru_backend: MINERU_BACKEND,
    mineru_lang: MINERU_LANG,
    progress: 0,
    run_id: payload.run_id,
    source: payload.source ?? "unknown",
    stage: "queued",
    status: "queued",
    tenant_id: payload.tenant_id,
    updated_at: now,
    versions: payload.versions ?? {}
  };

  await writeJob(job);
  enqueueJob(job, payload);

  json(response, 202, {
    job_id: job.job_id,
    queue: {
      active: activeJobs,
      concurrency: MAX_CONCURRENT_JOBS,
      pending: pendingJobs.length
    },
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

function isTreeIndexerPath(pathname) {
  return (
    pathname === "/v1/tree-index-jobs" ||
    /^\/v1\/tree-index-jobs\/[a-f0-9-]+(?:\/result)?$/.test(pathname)
  );
}

async function proxyTreeIndexer(request, response, url) {
  if (!requireAuth(request, response)) {
    return;
  }

  if (!["GET", "POST"].includes(request.method)) {
    json(response, 405, { error: "Method not allowed." });
    return;
  }

  let body;

  try {
    body = request.method === "POST" ? await readText(request) : undefined;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      json(response, 413, {
        error: error.message,
        max_body_bytes: error.limit
      });
      return;
    }

    throw error;
  }

  const upstreamResponse = await fetch(`${TREE_INDEXER_URL}${url.pathname}${url.search}`, {
    body,
    headers: {
      ...(TREE_INDEXER_TOKEN ? { authorization: `Bearer ${TREE_INDEXER_TOKEN}` } : {}),
      ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {})
    },
    method: request.method
  });
  const text = await upstreamResponse.text();

  response.writeHead(upstreamResponse.status, {
    "content-type": upstreamResponse.headers.get("content-type") ?? "application/json; charset=utf-8"
  });
  response.end(text);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/v1/health") {
      if (!requireAuth(request, response)) {
        return;
      }

      json(response, 200, {
        active_jobs: activeJobs,
        auth_configured: Boolean(TOKEN),
        compute_gateway_version: COMPUTE_GATEWAY_VERSION,
        concurrency: MAX_CONCURRENT_JOBS,
        extraction_pipeline_version: EXTRACTION_PIPELINE_VERSION,
        indexing_pipeline_version: INDEXING_PIPELINE_VERSION,
        mineru_backend: MINERU_BACKEND,
        mineru_lang: MINERU_LANG,
        mineru_storage_configured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
        ok: true,
        pending_jobs: pendingJobs.length,
        request_body_limit_bytes: MAX_REQUEST_BODY_BYTES,
        service: "sda-compute-gateway",
        tree_indexer_auth_configured: Boolean(TREE_INDEXER_TOKEN)
      });
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
