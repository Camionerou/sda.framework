"""Bearer token middleware factory. Token compartido entre pg_net y srv-ia-01."""

import secrets
from fastapi import Header, HTTPException, status


def require_bearer(expected_token: str):
    """Devuelve una FastAPI dependency que valida Authorization: Bearer <expected_token>."""
    async def _validator(authorization: str | None = Header(None)):
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing Bearer token",
            )
        token = authorization[len("Bearer "):]
        if not secrets.compare_digest(token, expected_token):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Bearer token",
            )
    return _validator
