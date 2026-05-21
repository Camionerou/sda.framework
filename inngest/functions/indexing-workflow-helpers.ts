import type {
  ComputeGatewayArtifact,
  ComputeGatewayIndexJobStatus,
  ComputeGatewayTreeIndexJobStatus
} from "@/lib/compute-gateway";
import { INDEXING_VERSION_COLUMNS } from "@/lib/system-versions";

type ArtifactDocumentRef = {
  id: string;
  tenant_id: string;
};

export function getWorkflowConcurrency() {
  const value = Number(process.env.INDEXING_WORKFLOW_CONCURRENCY ?? 2);

  return Number.isInteger(value) && value > 0 ? value : 2;
}

export function getGatewayPollAttempts() {
  const value = Number(process.env.COMPUTE_GATEWAY_POLL_ATTEMPTS ?? 240);

  return Number.isInteger(value) && value > 0 ? value : 240;
}

export function getGatewayPollInterval() {
  return process.env.COMPUTE_GATEWAY_POLL_INTERVAL ?? "30s";
}

export function getTreeIndexerPollAttempts() {
  const value = Number(process.env.TREE_INDEXER_POLL_ATTEMPTS ?? 240);

  return Number.isInteger(value) && value > 0 ? value : 240;
}

export function getTreeIndexerPollInterval() {
  return process.env.TREE_INDEXER_POLL_INTERVAL ?? "30s";
}

export function mapGatewayProgress(job: ComputeGatewayIndexJobStatus) {
  const gatewayProgress = Number.isFinite(job.progress) ? job.progress : 0;

  return Math.max(8, Math.min(35, 8 + Math.round(gatewayProgress * 0.27)));
}

export function mapGatewayStage(job: ComputeGatewayIndexJobStatus) {
  if (job.status === "failed") {
    return "failed";
  }

  if (job.stage === "persisting_artifacts") {
    return "persisting";
  }

  return "extracting";
}

export function mapTreeProgress(job: ComputeGatewayTreeIndexJobStatus) {
  const treeProgress = Number.isFinite(job.progress) ? job.progress : 0;

  return Math.max(35, Math.min(95, 35 + Math.round(treeProgress * 0.6)));
}

export function mapTreeStage(job: ComputeGatewayTreeIndexJobStatus) {
  if (job.status === "failed") {
    return job.stage === "llm_missing" ? "structuring" : "failed";
  }

  if (job.status === "succeeded") {
    return "indexed";
  }

  return "structuring";
}

export function getParserVersion(job: ComputeGatewayIndexJobStatus) {
  const manifestVersion = job.manifest?.parser_version;

  if (typeof job.mineru_version === "string" && job.mineru_version) {
    return job.mineru_version;
  }

  if (typeof manifestVersion === "string" && manifestVersion) {
    return manifestVersion;
  }

  return "unknown";
}

function getManifestString(
  manifest: Record<string, unknown> | undefined,
  key: string,
  fallback: string
) {
  const value = manifest?.[key];

  return typeof value === "string" && value ? value : fallback;
}

export function getExtractionPipelineVersion(job: ComputeGatewayIndexJobStatus) {
  return getManifestString(
    job.manifest,
    "extraction_pipeline_version",
    INDEXING_VERSION_COLUMNS.extraction_pipeline_version
  );
}

export function getIndexingPipelineVersion(job: ComputeGatewayIndexJobStatus) {
  return getManifestString(
    job.manifest,
    "indexing_pipeline_version",
    INDEXING_VERSION_COLUMNS.indexing_pipeline_version
  );
}

export function getArtifactPrefix(
  job: ComputeGatewayIndexJobStatus,
  document: ArtifactDocumentRef,
  parserVersion: string
) {
  return (
    job.artifact_prefix ??
    [
      document.tenant_id,
      document.id,
      "extractions",
      "mineru",
      parserVersion,
      job.job_id
    ].join("/")
  );
}

export function artifactRows(
  job: ComputeGatewayIndexJobStatus,
  artifacts: ComputeGatewayArtifact[]
) {
  return artifacts.map((artifact) => ({
    artifact_type: artifact.artifact_type,
    byte_size: artifact.byte_size,
    checksum_sha256: artifact.checksum_sha256,
    content_type: artifact.content_type,
    document_id: job.document_id,
    extraction_id: job.job_id,
    metadata: {
      relative_path: artifact.relative_path
    },
    storage_bucket: artifact.storage_bucket,
    storage_path: artifact.storage_path,
    tenant_id: job.tenant_id
  }));
}

export function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function isStorageObjectMissingError(error: unknown) {
  const message = messageFromError(error, "").toLowerCase();

  return message.includes("object not found") || message.includes("storage object not found");
}
