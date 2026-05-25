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

    # =========================================================================
    # Wave 1 settings — PDF + costo (spec §4.2)
    # =========================================================================

    # --- Fast-path heuristics (Mejora #5) ---
    SettingDef("parser.fast_path.enabled", "boolean", True,
               "Si true, intenta path nativo (pypdf) antes de MinerU.",
               scopes=["global", "collection"]),
    SettingDef("parser.fast_path.min_text_ratio", "number", 0.7,
               "Mínimo % de páginas con capa de texto extraíble para fast path.",
               scopes=["global", "collection"]),
    SettingDef("parser.fast_path.max_pages_for_fast", "number", 100,
               "PDFs con más páginas que esto van siempre por full path.",
               scopes=["global", "collection"]),
    SettingDef("parser.fast_path.require_toc", "boolean", False,
               "Si true, fast path solo se activa cuando hay TOC detectable.",
               scopes=["global", "collection"]),
    SettingDef("parser.fast_path.min_confidence", "number", 0.8,
               "Confidence mínima del clasificador heurístico para fast path.",
               scopes=["global", "collection"]),

    # --- MinerU service ---
    SettingDef("parser.mineru.url", "string",
               "https://mineru.sdaframework.com",
               "URL del servicio sda-mineru-parser (Cloudflare Tunnel).",
               scopes=["global"]),
    SettingDef("parser.mineru.timeout_seconds", "number", 600,
               "Timeout HTTP indexer → mineru (10 min, cubre PDFs grandes).",
               scopes=["global"]),
    SettingDef("parser.mineru.signed_url_ttl_seconds", "number", 3600,
               "TTL de signed URL Supabase Storage (1h, cubre retries).",
               scopes=["global"]),
    SettingDef("parser.mineru.max_pdf_mb", "number", 100,
               "Rechazo upstream si el PDF excede este tamaño.",
               scopes=["global", "collection"]),

    # --- Download resilience (spec §1.2) ---
    SettingDef("parser.download.max_retries", "number", 5,
               "Reintentos de descarga del PDF antes de DLQ.",
               scopes=["global"]),
    SettingDef("parser.download.backoff_base_seconds", "number", 2,
               "Backoff base exponencial para retries de descarga.",
               scopes=["global"]),
    SettingDef("parser.download.range_resume_min_mb", "number", 5,
               "PDFs >X MB usan HTTP Range resume al re-descargar.",
               scopes=["global"]),
    SettingDef("parser.download.chunk_size_kb", "number", 1024,
               "Tamaño de chunk para streaming download.",
               scopes=["global"]),

    # --- PageIndex algorithm ---
    SettingDef("pageindex.max_tokens_per_node", "number", 8000,
               "Nodo del tree con más tokens se split recursivamente.",
               scopes=["global", "collection", "document"]),
    SettingDef("pageindex.min_tokens_per_node", "number", 200,
               "Nodo con menos tokens se merge con el sibling anterior.",
               scopes=["global", "collection", "document"]),
    SettingDef("pageindex.max_tree_depth", "number", 6,
               "Profundidad máxima del tree antes de truncar.",
               scopes=["global", "collection", "document"]),
    SettingDef("pageindex.toc_detection_max_pages", "number", 20,
               "Cuántas primeras páginas escanear buscando TOC.",
               scopes=["global", "collection"]),
    SettingDef("pageindex.if_add_node_text", "boolean", True,
               "Gotcha: defaults PageIndex es false. Necesitamos true para retrieval/re-summary.",
               scopes=["global"]),

    # --- Contextual chunking (Mejora #1) ---
    SettingDef("summarize.contextual_chunking.enabled", "boolean", True,
               "Si true, genera (prefix, summary) combinado y persiste text_contextualized.",
               scopes=["global", "collection", "document"]),
    SettingDef("summarize.contextual_chunking.prefix_max_tokens", "number", 100,
               "Cap del contextual prefix en tokens.",
               scopes=["global", "collection"]),

    # --- Tiered models (Mejora #6) ---
    # Sub-fases validator y repair caen a llm.router.structure.* por default.
    SettingDef("llm.router.toc.model", "model_id", "deepseek-chat",
               "Modelo para fase TOC detection + transformation.",
               scopes=["global", "collection"]),
    SettingDef("llm.router.toc.temperature", "number", 0.0,
               "Temperature para fase TOC (precisión >> creatividad).",
               scopes=["global", "collection"]),
    SettingDef("llm.router.structure.model", "model_id", "deepseek-chat",
               "Modelo para fase structure extraction + validator + repair.",
               scopes=["global", "collection"]),
    SettingDef("llm.router.structure.temperature", "number", 0.0,
               "Temperature para fase structure.",
               scopes=["global", "collection"]),
    SettingDef("llm.router.summarize.model", "model_id", "deepseek-chat",
               "Modelo para summary + contextual_prefix combinado. Swap a flash variant cuando aparezca.",
               scopes=["global", "collection", "document"]),
    SettingDef("llm.router.summarize.temperature", "number", 0.1,
               "Temperature para summarize (poco creativo, algo de variación).",
               scopes=["global", "collection", "document"]),
]


REGISTRY_BY_KEY: dict[str, SettingDef] = {s.key: s for s in SETTINGS}
