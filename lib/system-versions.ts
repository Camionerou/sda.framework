import versions from "@/lib/system-versions.json";

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
