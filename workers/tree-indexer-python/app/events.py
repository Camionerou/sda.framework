from __future__ import annotations

import os
from typing import Any

import httpx

INNGEST_EVENT_KEY = os.getenv("INNGEST_EVENT_KEY")


async def publish_inngest_event(name: str, data: dict[str, Any]) -> None:
    if not INNGEST_EVENT_KEY:
        return

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                f"https://inn.gs/e/{INNGEST_EVENT_KEY}",
                json={"name": name, "data": data},
            )
            if response.status_code >= 400:
                print(f"Inngest event {name} rejected with {response.status_code}.")
    except Exception as error:
        print(f"Inngest event {name} could not be published: {error}")
