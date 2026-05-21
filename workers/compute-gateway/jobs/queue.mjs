import { randomUUID } from "node:crypto";

import { MAX_CONCURRENT_JOBS, MINERU_BACKEND, MINERU_LANG } from "../config.mjs";
import { processJob } from "./mineru.mjs";
import { writeJob } from "./store.mjs";

let activeJobs = 0;
const pendingJobs = [];

export function queueSnapshot() {
  return {
    active: activeJobs,
    concurrency: MAX_CONCURRENT_JOBS,
    pending: pendingJobs.length
  };
}

export function enqueueJob(job, payload) {
  pendingJobs.push({ job, payload });
  void drainQueue();
}

export async function drainQueue() {
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

export async function createQueuedIndexJob(payload) {
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

  return {
    job,
    queue: queueSnapshot()
  };
}
