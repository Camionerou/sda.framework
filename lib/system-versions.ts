export const SYSTEM_COMPONENT_VERSIONS = {
  app: "0.1.7",
  chat_agent: "0.0.0",
  compute_gateway_extraction: "0.1.4",
  embedding_pipeline: "0.0.0",
  extraction_pipeline: "0.1.7",
  indexing_pipeline: "0.1.8",
  inngest_indexing_workflow: "0.1.6",
  tree_indexer_python: "0.1.4",
  tree_prompt: "0.1.2"
} as const;

export type SystemComponent = keyof typeof SYSTEM_COMPONENT_VERSIONS;

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
