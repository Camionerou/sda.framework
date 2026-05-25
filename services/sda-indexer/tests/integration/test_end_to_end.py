"""E2E: subir un .md a Storage local → esperar status='ready' → verificar tree_nodes.

Requiere:
- Supabase local corriendo
- Migraciones aplicadas
- srv-ia-01 corriendo en :8000
- Vault tiene 'srv_ia_01_secret' y 'srv_ia_01_url'

Nota sobre pg_cron en local: Supabase CLI corre Postgres con
`cron.use_background_workers = off`, lo que limita pg_cron a granularidad
de un minuto (ignora schedules sub-minuto). En prod los background workers
están on. Para el test E2E llamamos manualmente al dispatcher en un loop
de polling — equivale a lo que hace el cron, sin esperar minutos.
"""

import os
import asyncio
import time
import pytest
import asyncpg
from supabase import create_client

pytestmark = pytest.mark.asyncio


TEST_PATH_PREFIX = "test-e2e-"


@pytest.fixture
async def pool():
    dsn = os.getenv("SDA_DB_DSN", "postgresql://postgres:postgres@localhost:54322/postgres")
    p = await asyncpg.create_pool(dsn, min_size=1, max_size=3)
    # Setup: limpia indexing_jobs huérfanos + drena colas de tests previos
    async with p.acquire() as conn:
        await _purge_test_state(conn)
    yield p
    async with p.acquire() as conn:
        await _purge_test_state(conn)
    await p.close()


async def _purge_test_state(conn) -> None:
    await conn.execute(
        f"delete from documents where source_path like '{TEST_PATH_PREFIX}%';"
    )
    await conn.execute("delete from indexing_jobs;")
    await conn.fetchval("select pgmq.purge_queue('q_extract_structure')")
    await conn.fetchval("select pgmq.purge_queue('q_summarize_node')")
    await conn.fetchval("select pgmq.purge_queue('q_finalize')")


@pytest.fixture
def supabase():
    url = os.getenv("SDA_SUPABASE_URL", "http://127.0.0.1:54321")
    # El cliente python de Supabase usa la JWT service_role para storage.
    # Aceptamos SDA_SUPABASE_STORAGE_KEY si se pasa, sino caemos a service_key.
    key = (
        os.getenv("SDA_SUPABASE_STORAGE_KEY")
        or os.getenv("SDA_SUPABASE_SERVICE_KEY", "")
    )
    if not key:
        pytest.skip("SDA_SUPABASE_STORAGE_KEY o SDA_SUPABASE_SERVICE_KEY requerido")
    client = create_client(url, key)
    # Setup: limpia objetos de tests previos para que upload genere INSERT trigger
    _cleanup_test_objects(client)
    yield client
    _cleanup_test_objects(client)


def _cleanup_test_objects(supabase) -> None:
    """Borra todos los objetos en 'docs' con prefix test-e2e- — necesario
    para que el siguiente upload dispare on_storage_doc_uploaded (que solo
    se ejecuta en INSERT, no en UPDATE/upsert)."""
    try:
        items = supabase.storage.from_("docs").list("", {"limit": 1000})
        names = [
            i["name"] for i in items
            if isinstance(i, dict) and i.get("name", "").startswith(TEST_PATH_PREFIX)
        ]
        if names:
            supabase.storage.from_("docs").remove(names)
    except Exception:
        pass


async def _kick_dispatchers(pool) -> None:
    """Simula un tick del cron — drena las 3 colas activas."""
    async with pool.acquire() as conn:
        await conn.fetchval(
            "select dispatch_pgmq_to_srv_ia('q_extract_structure', '/index/structure', 5)"
        )
        await conn.fetchval(
            "select dispatch_pgmq_to_srv_ia('q_summarize_node', '/index/summarize', 20)"
        )
        await conn.fetchval(
            "select dispatch_pgmq_to_srv_ia('q_finalize', '/index/finalize', 5)"
        )


async def _upload_md(supabase, path: str, content: str, tmp_path) -> None:
    """Sube un .md a Storage. El fixture limpia objetos previos, así que un
    INSERT real ocurre (no UPDATE/upsert) y on_storage_doc_uploaded dispara."""
    local = tmp_path / path.replace("/", "_")
    local.write_bytes(content.encode())
    supabase.storage.from_("docs").upload(path, str(local))


async def test_e2e_md_to_ready(pool, supabase, tmp_path):
    md = (
        "# Documento E2E\n\nDescripción inicial del documento de prueba.\n\n"
        "## Sección Uno\n\nContenido suficientemente largo para que el "
        "summarizer tenga algo concreto que resumir y generar texto.\n\n"
        "## Sección Dos\n\nMás contenido en otra sección con detalles "
        "adicionales que ameriten una segunda llamada al LLM.\n"
    )
    path = "test-e2e-1.md"
    await _upload_md(supabase, path, md, tmp_path)

    # Loop: kick dispatchers + check status
    timeout = 180  # generoso para 3 llamadas LLM seriales en local
    start = time.time()
    final_status = None
    while time.time() - start < timeout:
        await _kick_dispatchers(pool)
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "select status, node_count from documents where source_path=$1",
                path,
            )
        if row and row["status"] == "ready":
            final_status = row["status"]
            assert row["node_count"] >= 3, f"expected >=3 nodes, got {row['node_count']}"
            break
        await asyncio.sleep(3)

    assert final_status == "ready", (
        f"timeout: doc didn't reach ready in {timeout}s (last poll: {row})"
    )

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "select status, summary from tree_nodes where document_id="
            "(select id from documents where source_path=$1)",
            path,
        )
    assert rows, "no tree_nodes encontrados"
    assert all(r["status"] == "ready" for r in rows), \
        f"nodes con status != ready: {[r['status'] for r in rows]}"
    assert all(r["summary"] for r in rows), "algún nodo sin summary"


async def test_e2e_idempotent_same_sha(pool, supabase, tmp_path):
    """Subir el mismo contenido bajo dos paths distintos → uno se marca duplicate.

    El primer doc se procesa completo; el segundo entra a structure, calcula sha
    real, choca con el unique constraint y se marca como 'duplicate' sin crear
    tree_nodes.
    """
    md = "# Idempotency test\n\nContenido fijo para reuse.\n"

    p1 = "test-e2e-orig.md"
    p2 = "test-e2e-dup.md"

    # Subir el primero y kickear hasta que tenga sha real
    await _upload_md(supabase, p1, md, tmp_path)

    timeout1 = 60
    start = time.time()
    while time.time() - start < timeout1:
        await _kick_dispatchers(pool)
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "select sha256 from documents where source_path=$1", p1,
            )
        if row and row["sha256"] and not row["sha256"].startswith("provisional:"):
            break
        await asyncio.sleep(2)
    else:
        pytest.fail("primer doc no llegó a tener sha real en 60s")

    # Subir el segundo con MISMO contenido — debe ser detectado como duplicate
    await _upload_md(supabase, p2, md, tmp_path)

    timeout2 = 60
    start = time.time()
    p2_status = None
    while time.time() - start < timeout2:
        await _kick_dispatchers(pool)
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "select status from documents where source_path=$1", p2,
            )
        if row and row["status"] == "duplicate":
            p2_status = row["status"]
            break
        await asyncio.sleep(2)

    assert p2_status == "duplicate", (
        f"segundo doc no se marcó duplicate (got: {p2_status})"
    )
