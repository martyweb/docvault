"""Document search (keyword + semantic) and in-app previews."""

import asyncio
import csv
import io
import json
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query

from .config import settings
from .db import pool
from .embeddings import embed_query
from .ingest import _decode

router = APIRouter(prefix="/api")

# ts_headline wraps matches in these; the frontend turns them into <mark>.
HL_START, HL_END = "[[[", "]]]"
# bge-small scores unrelated text around 0.5-0.6, so a document with no keyword hit only counts
# when its semantic match is strong in absolute terms AND close to the best match for this query.
MIN_SEMANTIC_SCORE = 0.55
SEMANTIC_WINDOW = 0.05
RRF_K = 60  # reciprocal-rank-fusion constant


@router.get("/search")
async def search(q: str = Query(..., min_length=1, max_length=500), limit: int = Query(20, ge=1, le=100)):
    q = q.strip()
    vector = await asyncio.to_thread(embed_query, q)
    async with pool.connection() as conn:
        keyword = await (await conn.execute(
            f"""
            SELECT c.id, c.document_id, c.page, c.chunk_index,
                   ts_rank_cd(to_tsvector('english', c.content), tq) AS rank,
                   ts_headline('english', c.content, tq,
                               'StartSel="{HL_START}", StopSel="{HL_END}", MaxFragments=2, MaxWords=35, MinWords=12, FragmentDelimiter=" … "') AS snippet
            FROM chunks c
            JOIN documents d ON d.id = c.document_id,
                 websearch_to_tsquery('english', %(q)s) tq
            WHERE d.status = 'ready' AND to_tsvector('english', c.content) @@ tq
            ORDER BY rank DESC LIMIT 60
            """, {"q": q},
        )).fetchall()
        semantic = await (await conn.execute(
            """
            SELECT c.id, c.document_id, c.page, c.chunk_index, left(c.content, 280) AS snippet,
                   1 - (c.embedding <=> %(v)s) AS score
            FROM chunks c JOIN documents d ON d.id = c.document_id
            WHERE d.status = 'ready'
            ORDER BY c.embedding <=> %(v)s LIMIT 40
            """, {"v": vector},
        )).fetchall()
        name_hits = await (await conn.execute(
            "SELECT id FROM documents WHERE status = 'ready' AND filename ILIKE %s",
            (f"%{q.replace('%', '').replace('_', '')}%",),
        )).fetchall()
        docs = {r["id"]: r for r in await (await conn.execute(
            "SELECT id, filename, size_bytes, chunk_count, created_at FROM documents WHERE status = 'ready'"
        )).fetchall()}

    # Fuse the two rankings per chunk, then roll up to documents.
    results: dict[UUID, dict] = {}

    def entry(doc_id: UUID) -> dict:
        if doc_id not in results:
            d = docs[doc_id]
            results[doc_id] = {"document_id": doc_id, "filename": d["filename"], "size_bytes": d["size_bytes"],
                               "created_at": d["created_at"], "score": 0.0, "keyword": False,
                               "filename_match": False, "similarity": None, "hits": {}}
        return results[doc_id]

    for rank, r in enumerate(keyword):
        e = entry(r["document_id"])
        e["keyword"] = True
        e["score"] += 1 / (RRF_K + rank)
        e["hits"].setdefault(r["id"], {"page": r["page"], "chunk_index": r["chunk_index"],
                                       "snippet": r["snippet"], "match": "keyword"})
    keyword_docs = {r["document_id"] for r in keyword}
    best = float(semantic[0]["score"]) if semantic else 0.0
    cutoff = max(MIN_SEMANTIC_SCORE, best - SEMANTIC_WINDOW)
    for rank, r in enumerate(semantic):
        score = float(r["score"])
        if score < cutoff and r["document_id"] not in keyword_docs:
            continue
        e = entry(r["document_id"])
        e["score"] += 1 / (RRF_K + rank)
        e["similarity"] = max(e["similarity"] or 0, score)
        e["hits"].setdefault(r["id"], {"page": r["page"], "chunk_index": r["chunk_index"],
                                       "snippet": r["snippet"].strip() + "…", "match": "semantic"})
    for r in name_hits:
        e = entry(r["id"])
        e["filename_match"] = True
        e["score"] += 1 / RRF_K

    ranked = sorted(results.values(), key=lambda e: e["score"], reverse=True)[:limit]
    for e in ranked:
        hits = sorted(e["hits"].values(), key=lambda h: (h["match"] != "keyword", h["chunk_index"]))
        e["hit_count"] = len(hits)
        e["hits"] = hits[:3]
    return {"query": q, "highlight": [HL_START, HL_END], "results": ranked}


# ---- Preview ---------------------------------------------------------------

MAX_PREVIEW_BYTES = 5 * 1024 * 1024
MAX_TABLE_ROWS = 2000
CODE_LANGUAGES = {
    ".py": "python", ".js": "javascript", ".ts": "typescript", ".tsx": "tsx", ".jsx": "jsx", ".java": "java",
    ".go": "go", ".rb": "ruby", ".c": "c", ".h": "c", ".cpp": "cpp", ".cs": "csharp", ".sql": "sql",
    ".sh": "bash", ".yaml": "yaml", ".yml": "yaml", ".xml": "xml", ".toml": "toml", ".ini": "ini",
    ".cfg": "ini", ".conf": "ini", ".json": "json",
}


@router.get("/documents/{doc_id}")
async def get_document(doc_id: UUID):
    async with pool.connection() as conn:
        doc = await (await conn.execute(
            "SELECT id, filename, content_type, size_bytes, status, error, chunk_count, created_at"
            " FROM documents WHERE id = %s", (doc_id,)
        )).fetchone()
    if not doc:
        raise HTTPException(404, "Document not found.")
    return doc


def _build_preview(doc_id: UUID, filename: str) -> dict:
    path = settings.upload_dir / str(doc_id)
    if not path.exists():
        raise HTTPException(404, "File is missing from storage.")
    ext = Path(filename).suffix.lower()
    file_url = f"/api/documents/{doc_id}/file"

    if ext == ".pdf":
        return {"kind": "pdf", "url": f"{file_url}?inline=1"}
    if path.stat().st_size > MAX_PREVIEW_BYTES:
        return {"kind": "unavailable", "reason": "File is too large to preview.", "url": file_url}

    if ext == ".docx":
        import mammoth

        with path.open("rb") as f:
            result = mammoth.convert_to_html(f)
        return {"kind": "html", "content": result.value}

    text = _decode(path.read_bytes())
    if ext in (".html", ".htm"):
        return {"kind": "html", "content": text}
    if ext in (".md", ".markdown"):
        return {"kind": "markdown", "content": text}
    if ext in (".csv", ".tsv"):
        rows = list(csv.reader(io.StringIO(text), delimiter="\t" if ext == ".tsv" else ","))
        return {"kind": "table", "rows": rows[:MAX_TABLE_ROWS + 1], "truncated": len(rows) > MAX_TABLE_ROWS + 1,
                "total_rows": len(rows)}
    if ext == ".json":
        try:
            text = json.dumps(json.loads(text), indent=2, ensure_ascii=False)
        except ValueError:
            pass
    if ext in CODE_LANGUAGES:
        return {"kind": "code", "language": CODE_LANGUAGES[ext], "content": text}
    return {"kind": "text", "content": text}


@router.get("/documents/{doc_id}/preview")
async def preview_document(doc_id: UUID):
    doc = await get_document(doc_id)
    return await asyncio.to_thread(_build_preview, doc_id, doc["filename"])
