import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DATA_DIR } from "../config.mjs";

function jobPath(jobId) {
  return join(DATA_DIR, "jobs", jobId, "job.json");
}

export function inputPath(jobId, filename) {
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 180) || "document.bin";

  return join(DATA_DIR, "jobs", jobId, "input", safeFilename);
}

export function jobDir(jobId) {
  return join(DATA_DIR, "jobs", jobId);
}

export function mineruOutputPath(jobId) {
  return join(jobDir(jobId), "extractions", "mineru");
}

export function mineruLogPath(jobId) {
  return join(jobDir(jobId), "logs", "mineru.log");
}

export async function writeJob(job) {
  const path = jobPath(job.job_id);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(job, null, 2)}\n`);
}

export async function readJob(jobId) {
  const path = jobPath(jobId);

  if (!existsSync(path)) {
    return null;
  }

  return JSON.parse(await readFile(path, "utf8"));
}

export async function patchJob(jobId, patch) {
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
