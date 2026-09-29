import threading

import numpy as np
from fastembed import TextEmbedding

from .config import settings

_model: TextEmbedding | None = None
_lock = threading.Lock()


def get_model() -> TextEmbedding:
    global _model
    with _lock:
        if _model is None:
            _model = TextEmbedding(settings.embed_model, cache_dir=str(settings.embed_cache_dir))
        return _model


def embed_passages(texts: list[str]) -> list[np.ndarray]:
    return list(get_model().passage_embed(texts, batch_size=32))


def embed_query(text: str) -> np.ndarray:
    return next(iter(get_model().query_embed(text)))
