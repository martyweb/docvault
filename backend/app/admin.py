"""Settings, version info, and a read-only database browser."""

import importlib.metadata
import platform
from datetime import datetime, timezone

import anthropic
import numpy as np
from fastapi import APIRouter, HTTPException, Query
from psycopg import sql
from pydantic import BaseModel

from . import app_settings, rag
from .config import settings
from .db import pool

APP_VERSION = "0.2.0"
STARTED_AT = datetime.now(timezone.utc)

router = APIRouter(prefix="/api")


# ---- Settings --------------------------------------------------------------

def _settings_view() -> dict:
    key = app_settings.get("anthropic_api_key")
    return {
        "anthropic_api_key": {
            "configured": bool(key),
            "hint": app_settings.mask(key) if key else None,
            "source": app_settings.source("anthropic_api_key"),
        },
        "anthropic_base_url": {
            "value": app_settings.get("anthropic_base_url") or None,
            "source": app_settings.source("anthropic_base_url"),
            "default": "https://api.anthropic.com",
        },
        "claude_model": settings.claude_model,
        "claude_effort": settings.claude_effort,
    }


class SettingsUpdate(BaseModel):
    # Omitted = unchanged; null or "" = remove the override and fall back to the environment.
    anthropic_api_key: str | None = None
    anthropic_base_url: str | None = None


def _validate_url(url: str | None):
    if url and not url.startswith(("http://", "https://")):
        raise HTTPException(422, "API URL must start with http:// or https://")


@router.get("/settings")
async def get_settings():
    return _settings_view()


@router.put("/settings")
async def put_settings(body: SettingsUpdate):
    values = {k: (v.strip() if isinstance(v, str) else v) for k, v in body.model_dump(exclude_unset=True).items()}
    if "anthropic_base_url" in values and values["anthropic_base_url"]:
        values["anthropic_base_url"] = values["anthropic_base_url"].rstrip("/")
    _validate_url(values.get("anthropic_base_url"))
    await app_settings.update(values)
    return _settings_view()


@router.post("/settings/test")
async def test_settings(body: SettingsUpdate):
    """Checks a key/URL (unsaved values from the form, else the saved ones) by looking up the model."""
    key = (body.anthropic_api_key or "").strip() or app_settings.get("anthropic_api_key")
    url = (body.anthropic_base_url or "").strip().rstrip("/") or app_settings.get("anthropic_base_url")
    _validate_url(url)
    if not key:
        return {"ok": False, "error": "No API key configured."}
    try:
        model = await rag.make_client(key, url).with_options(timeout=15, max_retries=0).models.retrieve(
            settings.claude_model
        )
        return {"ok": True, "model": model.id, "display_name": model.display_name}
    except anthropic.AuthenticationError:
        return {"ok": False, "error": "The API key was rejected."}
    except anthropic.PermissionDeniedError:
        return {"ok": False, "error": "The key doesn't have access to this model."}
    except anthropic.NotFoundError:
        return {"ok": False, "error": f"Model {settings.claude_model} not found at this URL."}
    except anthropic.APIStatusError as e:
        return {"ok": False, "error": f"API returned {e.status_code}."}
    except anthropic.APIConnectionError:
        return {"ok": False, "error": f"Could not connect to {url or 'api.anthropic.com'}."}


# ---- Versions --------------------------------------------------------------

PACKAGES = ["fastapi", "uvicorn", "anthropic", "fastembed", "onnxruntime", "psycopg", "pgvector",
            "pypdf", "python-docx", "pydantic", "numpy"]


def _pkg_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


@router.get("/versions")
async def versions():
    async with pool.connection() as conn:
        pg = (await (await conn.execute("SHOW server_version")).fetchone())["server_version"]
        ext = await (await conn.execute("SELECT extversion FROM pg_extension WHERE extname = 'vector'")).fetchone()
    return {
        "app": APP_VERSION,
        "started_at": STARTED_AT,
        "runtime": {"Python": platform.python_version(), "PostgreSQL": pg.split()[0],
                    "pgvector": ext["extversion"] if ext else None},
        "packages": {p: _pkg_version(p) for p in PACKAGES},
        "models": {"Claude model": settings.claude_model, "Claude effort": settings.claude_effort,
                   "Embedding model": settings.embed_model, "Embedding dimensions": str(settings.embed_dim)},
    }


# ---- Database browser (read-only) ------------------------------------------

async def _table_names(conn) -> list[str]:
    rows = await (await conn.execute(
        "SELECT table_name FROM information_schema.tables"
        " WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
    )).fetchall()
    return [r["table_name"] for r in rows]


@router.get("/db/tables")
async def db_tables():
    async with pool.connection() as conn:
        tables = []
        for name in await _table_names(conn):
            ident = sql.Identifier(name)
            count = (await (await conn.execute(sql.SQL("SELECT count(*) AS n FROM {}").format(ident))).fetchone())["n"]
            size = (await (await conn.execute(
                "SELECT pg_total_relation_size(%s::regclass) AS s", (f'public."{name}"',)
            )).fetchone())["s"]
            columns = await (await conn.execute(
                "SELECT column_name AS name, CASE WHEN data_type = 'USER-DEFINED' THEN udt_name ELSE data_type END AS type,"
                " is_nullable = 'YES' AS nullable, column_default AS default"
                " FROM information_schema.columns WHERE table_schema = 'public' AND table_name = %s"
                " ORDER BY ordinal_position", (name,)
            )).fetchall()
            indexes = await (await conn.execute(
                "SELECT indexname AS name, indexdef AS definition FROM pg_indexes"
                " WHERE schemaname = 'public' AND tablename = %s ORDER BY indexname", (name,)
            )).fetchall()
            tables.append({"name": name, "rows": count, "size_bytes": size, "columns": columns, "indexes": indexes})
    return tables


def _cell(table: str, row: dict, column: str, value, max_chars: int):
    if hasattr(value, "to_list"):  # pgvector.Vector
        value = np.asarray(value.to_list())
    if isinstance(value, np.ndarray):
        return f"vector({len(value)}) [{', '.join(f'{x:.3f}' for x in value[:4])}, …]"
    if table == "app_settings" and column == "value" and row.get("key") in app_settings.SECRET:
        return app_settings.mask(value)
    if isinstance(value, str) and len(value) > max_chars:
        return value[:max_chars] + f"… (+{len(value) - max_chars} chars)"
    return value


@router.get("/db/tables/{name}/rows")
async def db_rows(name: str, limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0),
                  max_chars: int = Query(300, ge=20, le=20000)):
    async with pool.connection() as conn:
        if name not in await _table_names(conn):
            raise HTTPException(404, "Table not found.")
        ident = sql.Identifier(name)
        total = (await (await conn.execute(sql.SQL("SELECT count(*) AS n FROM {}").format(ident))).fetchone())["n"]
        rows = await (await conn.execute(
            sql.SQL("SELECT * FROM {} ORDER BY ctid LIMIT %s OFFSET %s").format(ident), (limit, offset)
        )).fetchall()
    return {
        "total": total,
        "offset": offset,
        "rows": [{c: _cell(name, r, c, v, max_chars) for c, v in r.items()} for r in rows],
    }
