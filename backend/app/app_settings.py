"""Runtime-editable settings: a DB override on top of the environment defaults."""

from .config import settings
from .db import pool

EDITABLE = ("anthropic_api_key", "anthropic_base_url")
SECRET = {"anthropic_api_key"}

_overrides: dict[str, str] = {}


async def load():
    async with pool.connection() as conn:
        rows = await (await conn.execute("SELECT key, value FROM app_settings")).fetchall()
    _overrides.clear()
    _overrides.update({r["key"]: r["value"] for r in rows})


def get(key: str) -> str:
    return _overrides.get(key) or getattr(settings, key) or ""


def source(key: str) -> str | None:
    if _overrides.get(key):
        return "database"
    return "environment" if getattr(settings, key) else None


async def update(values: dict[str, str | None]):
    """A string sets the override; None removes it (falling back to the environment)."""
    async with pool.connection() as conn, conn.transaction():
        for key, value in values.items():
            if value:
                await conn.execute(
                    "INSERT INTO app_settings (key, value) VALUES (%s, %s)"
                    " ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
                    (key, value),
                )
            else:
                await conn.execute("DELETE FROM app_settings WHERE key = %s", (key,))
    await load()


def mask(value: str) -> str:
    return f"{value[:7]}…{value[-4:]}" if len(value) > 14 else "•" * len(value)
