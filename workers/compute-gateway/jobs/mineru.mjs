import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import {
  COMPUTE_GATEWAY_VERSION,
  EXTRACTION_PIPELINE_VERSION,
  INDEXING_PIPELINE_VERSION,
  MINERU_BACKEND,
  MINERU_BIN,
  MINERU_LANG,
  MINERU_PDF_RENDER_TIMEOUT,
  MINERU_TASK_RESULT_TIMEOUT
} from "../config.mjs";
import { publishInngestEvent } from "../inngest-events.mjs";
import { uploadStorageObject } from "../storage.mjs";
import { inputPath, mineruLogPath, mineruOutputPath, patchJob } from "./store.mjs";

const execFileAsync = promisify(execFile);

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
  const artifactBucket = payload.document.storage_bucket || payload.document.r2_bucket || "documents";
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

    await uploadStorageObject(artifactBucket, storagePath, file.absolutePath, contentType, fileStats.size);

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

export async function processJob(job, payload) {
  try {
    const startedAt = new Date().toISOString();
    const inputFile = await downloadDocument(job, payload);
    const mineruResult = await runMineru(job, inputFile);
    const artifactUpload = await uploadArtifacts(job, payload, mineruResult);
    const manifest = await buildExtractionManifest(payload, mineruResult, artifactUpload);

    const terminalJob = await patchJob(job.job_id, {
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
    await publishInngestEvent("compute/mineru.completed", terminalJob);
  } catch (error) {
    const terminalJob = await patchJob(job.job_id, {
      error: error instanceof Error ? error.message : "Unknown gateway error.",
      failed_at: new Date().toISOString(),
      progress: 100,
      stage: "failed",
      status: "failed"
    });
    await publishInngestEvent("compute/mineru.completed", terminalJob);
  }
}
