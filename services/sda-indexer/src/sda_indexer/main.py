"""FastAPI app + lifespan + wiring de DB, settings, LLM, workflows."""

from contextlib import asynccontextmanager
from urllib.parse import quote, urlparse, urlunparse, parse_qsl
import structlog
from fastapi import FastAPI, Depends
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from supabase import create_client
from .config import Settings
from .db.client import DB
from .settings.client import SettingsClient
from .settings.sync import sync_registry_to_db
from .settings.registry import SETTINGS
from .llm.client import LLMClient
from .workflows.structure import build_graph as build_structure_graph
from .workflows.summarize import build_graph as build_summarize_graph
from .workflows.finalize import build_graph as build_finalize_graph
from .api.auth import require_bearer
from .api.health import router as health_router
from .api.structure import router as structure_router
from .api.summarize import router as summarize_router
from .api.finalize import router as finalize_router

log = structlog.get_logger()

CHECKPOINT_SCHEMA = "langgraph_checkpoints"


def _checkpoint_dsn(dsn: str, schema: str) -> str:
    """Return a copy of ``dsn`` whose libpq ``options`` set search_path to schema.

    AsyncPostgresSaver creates unqualified tables (checkpoints, checkpoint_blobs,
    checkpoint_writes, checkpoint_migrations). To keep them in a dedicated schema,
    we force the connection's search_path via libpq ``options``. The schema itself
    must be created beforehand (bootstrap below).

    libpq's URI parser only decodes ``%XX`` escapes (NOT ``+`` for space), so we
    build the query string by hand with explicit ``%20`` to preserve ``-c <opt>``.
    """
    parsed = urlparse(dsn)
    existing_pairs = parse_qsl(parsed.query, keep_blank_values=True)
    existing_options = next(
        (v for k, v in existing_pairs if k == "options"), "",
    )
    raw_options = (
        f"{existing_options} -c search_path={schema}".strip()
        if existing_options
        else f"-c search_path={schema}"
    )
    rest = [(k, v) for k, v in existing_pairs if k != "options"]
    parts = [f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in rest]
    # quote with safe='' encodes space as %20 (libpq-compatible).
    parts.append(f"options={quote(raw_options, safe='')}")
    return urlunparse(parsed._replace(query="&".join(parts)))


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = Settings()
    log.info("startup", env=cfg.env, supabase=cfg.supabase_url)

    db = DB(
        dsn=cfg.db_dsn.get_secret_value(),
        min_size=cfg.db_pool_min_size,
        max_size=cfg.db_pool_max_size,
    )
    await db.start()

    log.info("settings.sync.start")
    await sync_registry_to_db(db.pool, SETTINGS)

    settings_client = SettingsClient(db.pool, SETTINGS, start_listener=True)

    # Setup LangGraph checkpointer (Postgres-backed, schema: langgraph_checkpoints)
    async with db.pool.acquire() as conn:
        await conn.execute(f'create schema if not exists "{CHECKPOINT_SCHEMA}"')
    checkpoint_dsn = _checkpoint_dsn(
        cfg.db_dsn.get_secret_value(), CHECKPOINT_SCHEMA,
    )
    checkpoint_cm = AsyncPostgresSaver.from_conn_string(checkpoint_dsn)
    checkpointer = await checkpoint_cm.__aenter__()
    await checkpointer.setup()  # crea tablas si no existen
    app.state.checkpointer = checkpointer
    app.state._checkpoint_cm = checkpoint_cm  # para teardown
    log.info("langgraph.checkpointer.started", schema=CHECKPOINT_SCHEMA)

    supabase = create_client(
        cfg.supabase_url, cfg.supabase_service_key.get_secret_value(),
    )

    llm = LLMClient(
        api_key=cfg.deepseek_api_key.get_secret_value(),
        base_url=cfg.deepseek_base_url,
    )

    app.state.db = db
    app.state.settings_client = settings_client
    app.state.llm = llm
    app.state.supabase = supabase
    app.state.structure_graph = build_structure_graph(
        db=db, supabase=supabase, checkpointer=checkpointer,
    )
    app.state.summarize_graph = build_summarize_graph(
        db=db, settings=settings_client, llm=llm, checkpointer=checkpointer,
    )
    app.state.finalize_graph = build_finalize_graph(
        db=db, checkpointer=checkpointer,
    )

    yield

    await settings_client.close()
    await db.close()
    await app.state._checkpoint_cm.__aexit__(None, None, None)
    log.info("shutdown")


def make_app() -> FastAPI:
    cfg = Settings()
    bearer = cfg.srv_ia_01_secret.get_secret_value()
    deps = [Depends(require_bearer(bearer))]

    app = FastAPI(
        title="sda-indexer",
        version="0.1.0",
        lifespan=lifespan,
    )
    # Health sin auth para Docker healthcheck
    app.include_router(health_router)
    # Endpoints protegidos
    app.include_router(structure_router, dependencies=deps)
    app.include_router(summarize_router, dependencies=deps)
    app.include_router(finalize_router, dependencies=deps)
    return app


app = make_app()
