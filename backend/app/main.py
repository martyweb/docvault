import asyncio
import hashlib
import json
import logging
import mimetypes
import os
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import UUID, uuid4

import anthropic
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import admin, app_settings, ingest, rag, search
from .config import settings
from .db import init_db, pool
from .embeddings import get_model

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("docvault")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    await init_db()
    await app_settings.load()
    # Download/load the embedding model up front so the first upload or question isn't slow.
    await asyncio.to_thread(get_model)
    worker = asyncio.create_task(ingest.worker())
    await ingest.requeue_unfinished()
    yield
    worker.cancel()
    await pool.close()


app = FastAPI(title="DocVault", version=admin.APP_VERSION, lifespan=lifespan)
app.include_router(admin.router)
app.include_router(search.router)

INLINE_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
DOC_COLUMNS = "id, filename, content_type, size_bytes, status, error, chunk_count, created_at"


@app.get("/api/health")
async def health():
    async with pool.connection() as conn:
        await conn.execute("SELECT 1")
    return {"ok": True, "model": settings.claude_model, "llm_configured": bool(app_settings.get("anthropic_api_key"))}


@app.get("/api/documents")
async def list_documents():
    async with pool.connection() as conn:
        return await (await conn.execute(f"SELECT {DOC_COLUMNS} FROM documents ORDER BY created_at DESC")).fetchall()


@app.post("/api/documents", status_code=201)
async def upload_document(file: UploadFile):
    filename = Path(file.filename or "upload").name
    ext = Path(filename).suffix.lower()
    if ext not in ingest.SUPPORTED_EXTENSIONS:
        raise HTTPException(415, f"Unsupported file type '{ext or filename}'.")

    doc_id = uuid4()
    dest = settings.upload_dir / str(doc_id)
    tmp = dest.with_suffix(".part")
    sha, size, limit = hashlib.sha256(), 0, settings.max_upload_mb * 1024 * 1024
    try:
        with tmp.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, f"File exceeds {settings.max_upload_mb} MB limit.")
                sha.update(chunk)
                out.write(chunk)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise

    digest = sha.hexdigest()
    async with pool.connection() as conn:
        existing = await (
            await conn.execute(f"SELECT {DOC_COLUMNS} FROM documents WHERE sha256 = %s", (digest,))
        ).fetchone()
        if existing:
            tmp.unlink(missing_ok=True)
            return {**existing, "duplicate": True}
        os.replace(tmp, dest)
        doc = await (
            await conn.execute(
                "INSERT INTO documents (id, filename, content_type, size_bytes, sha256)"
                f" VALUES (%s, %s, %s, %s, %s) RETURNING {DOC_COLUMNS}",
                (doc_id, filename, file.content_type, size, digest),
            )
        ).fetchone()
    ingest.enqueue(doc_id)
    return doc


@app.get("/api/documents/{doc_id}/file")
async def download_document(doc_id: UUID, inline: bool = False):
    async with pool.connection() as conn:
        doc = await (await conn.execute("SELECT filename FROM documents WHERE id = %s", (doc_id,))).fetchone()
    path = settings.upload_dir / str(doc_id)
    if not doc or not path.exists():
        raise HTTPException(404, "Document not found.")
    media_type = mimetypes.guess_type(doc["filename"])[0] or "application/octet-stream"
    # Only render inert types inline; uploaded HTML/SVG served from our origin could run scripts.
    inline = inline and (media_type == "application/pdf" or media_type in INLINE_IMAGE_TYPES)
    return FileResponse(
        path, filename=doc["filename"], media_type=media_type,
        content_disposition_type="inline" if inline else "attachment",
        headers={"X-Content-Type-Options": "nosniff"},
    )


@app.post("/api/documents/{doc_id}/reprocess", status_code=202)
async def reprocess_document(doc_id: UUID):
    async with pool.connection() as conn:
        res = await conn.execute(
            "UPDATE documents SET status = 'processing', error = NULL WHERE id = %s", (doc_id,)
        )
    if res.rowcount == 0:
        raise HTTPException(404, "Document not found.")
    ingest.enqueue(doc_id)
    return {"ok": True}


@app.delete("/api/documents/{doc_id}", status_code=204)
async def delete_document(doc_id: UUID):
    async with pool.connection() as conn:
        res = await conn.execute("DELETE FROM documents WHERE id = %s", (doc_id,))
    if res.rowcount == 0:
        raise HTTPException(404, "Document not found.")
    (settings.upload_dir / str(doc_id)).unlink(missing_ok=True)


class ChatTurn(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=8000)
    history: list[ChatTurn] = []
    document_ids: list[UUID] | None = None


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@app.post("/api/chat")
async def chat(req: ChatRequest):
    if not app_settings.get("anthropic_api_key"):
        raise HTTPException(503, "No Anthropic API key configured. Add one on the Settings page.")

    excerpts = await rag.retrieve(req.question, req.document_ids)

    async def events():
        yield _sse("sources", [
            {k: e[k] for k in ("n", "document_id", "filename", "page", "score")} | {"snippet": e["content"][:400]}
            for e in excerpts
        ])
        try:
            async for text in rag.stream_answer(req.question, [t.model_dump() for t in req.history], excerpts):
                yield _sse("delta", text)
            yield _sse("done", {})
        except anthropic.AuthenticationError:
            yield _sse("error", "Anthropic API key was rejected.")
        except anthropic.RateLimitError:
            yield _sse("error", "Rate limited by the Anthropic API; try again shortly.")
        except anthropic.APIStatusError as e:
            log.warning("Claude API error: %s", e)
            yield _sse("error", f"Claude API error ({e.status_code}).")
        except anthropic.APIConnectionError:
            yield _sse("error", "Could not reach the Anthropic API.")
        except RuntimeError as e:
            yield _sse("error", str(e))

    return StreamingResponse(
        events(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
