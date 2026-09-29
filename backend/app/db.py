from pgvector.psycopg import register_vector_async
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .config import settings

SCHEMA = f"""
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
    id           UUID PRIMARY KEY,
    filename     TEXT NOT NULL,
    content_type TEXT,
    size_bytes   BIGINT NOT NULL,
    sha256       TEXT NOT NULL UNIQUE,
    status       TEXT NOT NULL DEFAULT 'processing',  -- processing | ready | failed
    error        TEXT,
    chunk_count  INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
    id          BIGSERIAL PRIMARY KEY,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INT NOT NULL,
    page        INT,
    content     TEXT NOT NULL,
    embedding   vector({settings.embed_dim}) NOT NULL
);

-- Settings changed from the UI; these override the matching environment variables.
CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks (document_id);
CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING gin (to_tsvector('english', content));
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
"""


async def _configure(conn):
    await register_vector_async(conn)


pool = AsyncConnectionPool(
    settings.database_url,
    min_size=1,
    max_size=10,
    open=False,
    configure=_configure,
    kwargs={"row_factory": dict_row, "autocommit": True},
)


async def init_db():
    # The extension must exist before the pool's configure hook can register the vector type.
    import psycopg

    async with await psycopg.AsyncConnection.connect(settings.database_url, autocommit=True) as conn:
        await conn.execute(SCHEMA)
    await pool.open(wait=True)
