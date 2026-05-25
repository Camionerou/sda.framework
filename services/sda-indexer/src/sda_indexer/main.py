"""FastAPI app + lifespan + wiring de DB, settings, LLM, workflows."""

from contextlib import asynccontextmanager
import structlog
from fastapi import FastAPI, Depends
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
    app.state.structure_graph = build_structure_graph(db=db, supabase=supabase)
    app.state.summarize_graph = build_summarize_graph(
        db=db, settings=settings_client, llm=llm,
    )
    app.state.finalize_graph = build_finalize_graph(db=db)

    yield

    await settings_client.close()
    await db.close()
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
