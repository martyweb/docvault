from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql://docvault:docvault@postgres:5432/docvault"
    upload_dir: Path = Path("/data/uploads")
    max_upload_mb: int = 100

    # Local CPU embeddings (no API key needed). Changing the model requires
    # re-ingesting, since the vector column is sized to its dimension.
    embed_model: str = "BAAI/bge-small-en-v1.5"
    embed_dim: int = 384
    embed_cache_dir: Path = Path("/models")

    chunk_size: int = 1200
    chunk_overlap: int = 200
    top_k: int = 8

    # Defaults only: values saved on the Settings page take precedence (see app_settings.py).
    anthropic_api_key: str = ""
    anthropic_base_url: str = ""
    claude_model: str = "claude-opus-5-5"
    claude_effort: str = "medium"


settings = Settings()
