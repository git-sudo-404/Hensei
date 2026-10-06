"""Async chat providers; constructing an adapter never makes a network call."""
from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from typing import Any, Protocol


class Provider(Protocol):
    async def complete(self, messages: list[dict], tools: list[dict], max_output_tokens: int) -> dict: ...


class ProviderError(RuntimeError):
    def __init__(self, message: str, attempts: int = 1, http_status: int | None = None):
        super().__init__(message)
        self.attempts = attempts
        self.http_status = http_status


class DeepSeekProvider:
    endpoint = "https://api.deepseek.com/chat/completions"

    def __init__(self, api_key: str | None = None, model: str = "deepseek-flash", timeout_s: float = 60, max_retries: int = 2):
        self.api_key = api_key if api_key is not None else os.environ.get("DEEPSEEK_API_KEY")
        if not self.api_key:
            raise ProviderError("Set DEEPSEEK_API_KEY before using the DeepSeek provider.")
        if timeout_s <= 0 or not isinstance(max_retries, int) or isinstance(max_retries, bool) or max_retries < 0:
            raise ValueError("Invalid provider retry or timeout limits")
        self.model, self.timeout_s, self.max_retries = model, timeout_s, max_retries

    def _request(self, payload: bytes) -> dict:
        request = urllib.request.Request(self.endpoint, data=payload, headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
            data = response.read(8 * 1024 * 1024 + 1)
            if len(data) > 8 * 1024 * 1024:
                raise ProviderError("Provider response exceeded size limit")
            result = json.loads(data)
            if not isinstance(result, dict):
                raise ProviderError("Provider returned an invalid response")
            return result

    async def complete(self, messages: list[dict], tools: list[dict], max_output_tokens: int) -> dict:
        payload = json.dumps({"model": self.model, "messages": messages, "tools": tools, "max_tokens": max_output_tokens, "thinking": {"type": "enabled"}, "reasoning_effort": "high"}).encode()
        for attempt in range(self.max_retries + 1):
            try:
                result = await asyncio.to_thread(self._request, payload)
                result["_hensei_request_attempts"] = attempt + 1
                return result
            except urllib.error.HTTPError as exc:
                status = exc.code
                exc.close()
                transient = status in {408, 429, 500, 502, 503, 504}
                if not transient or attempt == self.max_retries:
                    raise ProviderError(f"DeepSeek HTTP {status}", attempt + 1, http_status=status) from None
            except (urllib.error.URLError, TimeoutError, OSError):
                if attempt == self.max_retries:
                    raise ProviderError("DeepSeek request failed after bounded retries", attempt + 1) from None
            except (ValueError, TypeError):
                raise ProviderError("DeepSeek returned malformed JSON", attempt + 1) from None
            await asyncio.sleep(min(2 ** attempt, 8))
        raise ProviderError("DeepSeek request failed")


class ScriptedProvider:
    """Deterministic offline provider used by tests and demonstrations."""
    def __init__(self, responses: list[dict]):
        self.responses = list(responses)
        self.requests: list[dict[str, Any]] = []

    async def complete(self, messages: list[dict], tools: list[dict], max_output_tokens: int) -> dict:
        self.requests.append(json.loads(json.dumps({"messages": messages, "tools": tools, "max_output_tokens": max_output_tokens})))
        if not self.responses:
            raise ProviderError("Scripted provider exhausted")
        return self.responses.pop(0)
