"""Pydantic-settings — lee env vars con prefijo SDA_. No es el sistema
de runtime config (que vive en DB) — esto es bootstrap-only:
URLs, keys, credenciales que el servicio necesita para arrancar."""

from typing import Literal
from pydantic import SecretStr, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SDA_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Environment ---
    env: Literal["local", "staging", "production"] = "local"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    # --- Supabase ---
    supabase_url: str = Field(..., description="https://<project>.supabase.co")
    supabase_service_key: SecretStr = Field(..., description="service_role key (server-side)")
    db_dsn: SecretStr = Field(..., description="postgresql://... con service_role credentials")

    # --- DeepSeek ---
    deepseek_api_key: SecretStr = Field(..., description="API key DeepSeek")
    deepseek_base_url: str = "https://api.deepseek.com/v1"

    # --- Bearer entre Supabase pg_net y srv-ia-01 ---
    srv_ia_01_secret: SecretStr = Field(..., description="Bearer token compartido")

    # --- MinerU (Wave 1) ---
    mineru_shared_secret: SecretStr = Field(
        ..., description="Bearer compartido entre indexer y sda-mineru-parser"
    )

    # --- Pool DB ---
    db_pool_min_size: int = 2
    db_pool_max_size: int = 20

    # --- Server ---
    host: str = "0.0.0.0"
    port: int = 8000
