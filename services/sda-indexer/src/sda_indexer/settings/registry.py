"""Registry de settings runtime — Wave 0.

Wave 0 incluye ~20 settings de las ~80-100 totales que tendremos al final
de Wave 3. Cada Wave agrega settings nuevas; las viejas no se quitan,
sólo se marcan deprecated_at en DB cuando se eliminan del código.
"""

from .types import SettingDef


SETTINGS: list[SettingDef] = [
    # --- LLM model selection (Mejora #6, escala completa en Wave 1) ---
    SettingDef("llm.model.summarize", "model_id", "deepseek-chat",
               "Modelo LLM para summary de nodos. Wave 0 usa deepseek-chat "
               "(actualmente aliased a deepseek-v4-flash en el backend de DeepSeek); "
               "Wave 1 puede cambiar a tiered routing con pro/flash split.",
               scopes=["global", "doc_type", "collection", "document"]),

    # --- Rate limits ---
    SettingDef("llm.max_concurrent.deepseek", "number", 50,
               "Calls concurrentes máximas a DeepSeek antes de backpressure.",
               scopes=["global"]),

    # --- Retries y timeouts ---
    SettingDef("llm.timeout_ms.summarize", "duration_ms", 30000,
               "Timeout para llamadas LLM de summary individual.",
               scopes=["global"]),
    SettingDef("llm.timeout_ms.structure", "duration_ms", 120000,
               "Timeout para llamadas LLM de extracción de estructura.",
               scopes=["global"]),
    SettingDef("llm.retry.max_attempts", "number", 3,
               "Reintentos de tenacity antes de fallar.",
               scopes=["global"]),
    SettingDef("llm.retry.backoff_base_ms", "number", 1000,
               "Backoff base exponencial para tenacity.",
               scopes=["global"]),
    SettingDef("llm.retry.backoff_max_ms", "number", 8000,
               "Backoff máximo para tenacity.",
               scopes=["global"]),

    # --- pgmq ---
    SettingDef("pgmq.visibility_timeout.q_extract_structure", "duration_ms", 600000,
               "Visibility timeout para extract_structure (10 min).",
               scopes=["global"]),
    SettingDef("pgmq.visibility_timeout.q_summarize_node", "duration_ms", 120000,
               "Visibility timeout para summarize_node (2 min).",
               scopes=["global"]),
    SettingDef("pgmq.visibility_timeout.q_finalize", "duration_ms", 60000,
               "Visibility timeout para finalize (1 min).",
               scopes=["global"]),
    SettingDef("pgmq.max_retries_before_dlq.q_summarize_node", "number", 5,
               "Reintentos antes de DLQ (Wave 2). Wave 0 sólo registra el valor.",
               scopes=["global"]),

    # --- Summarize behavior ---
    SettingDef("summarize.max_summary_chars", "number", 280,
               "Largo máximo del summary por nodo.",
               scopes=["global", "doc_type"]),
    SettingDef("summarize.language", "enum", "es",
               "Idioma del summary generado. Wave 1 expande con i18n.",
               scopes=["global", "doc_type", "collection", "document"],
               validation={"enum": ["es", "en", "auto"]}),

    # --- LangGraph ---
    SettingDef("langgraph.checkpoint_ttl_days", "number", 7,
               "Retención de checkpoints antes de GC.",
               scopes=["global"]),

    # --- Feature flags (Wave 0 todas en false) ---
    SettingDef("feature.embeddings_enabled", "boolean", False,
               "Activar pipeline de embeddings (Wave 3).",
               scopes=["global", "collection"]),
    SettingDef("feature.entity_extraction_enabled", "boolean", False,
               "Activar extracción de entidades (Wave 3).",
               scopes=["global", "collection"]),
    SettingDef("feature.question_prediction_enabled", "boolean", False,
               "Activar question-prediction (Wave 3).",
               scopes=["global", "collection"]),
    SettingDef("feature.typed_extraction_enabled", "boolean", False,
               "Activar typed extraction (Wave 3).",
               scopes=["global", "collection", "doc_type"]),
    SettingDef("feature.multimodal_enabled", "boolean", False,
               "Activar multi-modal (Wave 3).",
               scopes=["global", "collection"]),
    SettingDef("feature.incremental_reindex_enabled", "boolean", False,
               "Activar incremental re-indexing (Wave 3).",
               scopes=["global", "collection"]),

    # --- Prompts (los .j2 cargados en boot — bootstrapping en Task 24) ---
    SettingDef("prompt.template.summarize", "prompt_template",
               "<bootstrapped-from-prompts/summarize.j2>",
               "Template Jinja2 para summarize_node. Se popula al boot.",
               scopes=["global", "doc_type", "collection"]),
]


REGISTRY_BY_KEY: dict[str, SettingDef] = {s.key: s for s in SETTINGS}
