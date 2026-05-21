import versions from "@/lib/system-versions.json";
import type { ComponentVersionRow, TreeRow } from "@/lib/documents/detail";
import type { DocumentRow, DocumentStatus, IndexingRunRow } from "@/lib/documents";

export const SYSTEM_COMPONENT_VERSIONS = versions;

export type SystemComponent = keyof typeof SYSTEM_COMPONENT_VERSIONS;

export const SYSTEM_COMPONENT_VERSION_ROWS = Object.entries(SYSTEM_COMPONENT_VERSIONS).map(
  ([component, version]) => ({
    component,
    version
  })
);

export const TREE_INDEXER_PYTHON_ID = "sda-pageindex-python-langgraph";

export const TREE_INDEXER_PYTHON_VERSION =
  `${TREE_INDEXER_PYTHON_ID}-v${SYSTEM_COMPONENT_VERSIONS.tree_indexer_python}`;

export const INDEXING_VERSION_COLUMNS = {
  embedding_pipeline_version: SYSTEM_COMPONENT_VERSIONS.embedding_pipeline,
  extraction_pipeline_version: SYSTEM_COMPONENT_VERSIONS.extraction_pipeline,
  indexing_pipeline_version: SYSTEM_COMPONENT_VERSIONS.indexing_pipeline,
  tree_indexer_version: SYSTEM_COMPONENT_VERSIONS.tree_indexer_python
} as const;

export const INDEXING_VERSION_METADATA = {
  versions: {
    ...INDEXING_VERSION_COLUMNS,
    app_version: SYSTEM_COMPONENT_VERSIONS.app,
    compute_gateway_extraction_version:
      SYSTEM_COMPONENT_VERSIONS.compute_gateway_extraction,
    inngest_indexing_workflow_version:
      SYSTEM_COMPONENT_VERSIONS.inngest_indexing_workflow,
    tree_indexer_runtime_version: TREE_INDEXER_PYTHON_VERSION,
    tree_prompt_version: SYSTEM_COMPONENT_VERSIONS.tree_prompt
  }
} as const;

export type PipelineVersionKey =
  | "embedding_pipeline"
  | "extraction_pipeline"
  | "indexing_pipeline"
  | "tree_indexer"
  | "tree_prompt";

export type PipelineVersions = Record<PipelineVersionKey, string | null>;

export const PIPELINE_VERSION_COMPONENTS = [
  ["indexing_pipeline", "indexing_pipeline"],
  ["extraction_pipeline", "extraction_pipeline"],
  ["tree_indexer_python", "tree_indexer"],
  ["tree_prompt", "tree_prompt"],
  ["embedding_pipeline", "embedding_pipeline"]
] as const satisfies ReadonlyArray<readonly [string, PipelineVersionKey]>;

export function latestVersionMap(componentVersions: ComponentVersionRow[]) {
  return new Map(componentVersions.map((row) => [row.component, row.version]));
}

export function documentPipelineVersions(input: {
  document: DocumentRow;
  latestRun: IndexingRunRow | null;
  tree: TreeRow | null;
}): PipelineVersions {
  return {
    embedding_pipeline:
      input.document.embedding_pipeline_version ?? input.latestRun?.embedding_pipeline_version ?? null,
    extraction_pipeline:
      input.document.extraction_pipeline_version ?? input.latestRun?.extraction_pipeline_version ?? null,
    indexing_pipeline:
      input.document.indexing_pipeline_version ??
      input.tree?.indexing_pipeline_version ??
      input.latestRun?.indexing_pipeline_version ??
      null,
    tree_indexer:
      input.document.tree_indexer_version ??
      input.tree?.tree_indexer_version ??
      input.latestRun?.tree_indexer_version ??
      null,
    tree_prompt: input.tree?.tree_prompt_version ?? null
  };
}

export function isPipelineVersionStale(input: {
  documentStatus: DocumentStatus;
  latestVersions: Map<string, string>;
  versions: PipelineVersions;
}) {
  if (input.documentStatus !== "indexed") {
    return false;
  }

  return PIPELINE_VERSION_COMPONENTS.some(([component, versionKey]) => {
    const current = input.versions[versionKey];
    const latest = input.latestVersions.get(component);

    return Boolean(current && latest && current !== latest);
  });
}

export function pipelineVersionState(
  latestVersions: Map<string, string>,
  component: string,
  current: string | null
) {
  const latest = latestVersions.get(component);

  if (!current || !latest) {
    return "missing" as const;
  }

  return current === latest ? ("current" as const) : ("stale" as const);
}
