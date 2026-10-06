import json
import unittest
from unittest.mock import patch
import urllib.error

from hensei.providers import DeepSeekProvider, ProviderError, ScriptedProvider


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_payload_preserves_continuation_metadata(self):
        provider = DeepSeekProvider(api_key="dummy-test-key")
        seen = []
        def request(payload):
            seen.append(json.loads(payload))
            return {"choices": []}
        with patch.object(provider, "_request", request):
            messages = [{"role": "assistant", "content": None, "reasoning_content": "keep", "tool_calls": [{"id": "1"}]}]
            await provider.complete(messages, [], 42)
        self.assertEqual(seen[0]["messages"], messages)
        self.assertEqual(seen[0]["thinking"], {"type": "enabled"})
        self.assertEqual(seen[0]["reasoning_effort"], "high")
        self.assertEqual(seen[0]["max_tokens"], 42)

    async def test_nontransient_error_does_not_retry_or_expose_key(self):
        provider = DeepSeekProvider(api_key="secret", max_retries=2)
        with patch.object(provider, "_request", side_effect=urllib.error.HTTPError("url", 401, "secret", {}, None)) as request:
            with self.assertRaisesRegex(ProviderError, "HTTP 401") as caught:
                await provider.complete([], [], 10)
            self.assertEqual(request.call_count, 1)
            self.assertNotIn("secret", str(caught.exception))

    async def test_transient_error_has_bounded_retries(self):
        provider = DeepSeekProvider(api_key="test", max_retries=2)
        with patch.object(provider, "_request", side_effect=urllib.error.URLError("failure")) as request, patch("hensei.providers.asyncio.sleep"):
            with self.assertRaises(ProviderError):
                await provider.complete([], [], 10)
            self.assertEqual(request.call_count, 3)

    async def test_scripted_exhaustion(self):
        with self.assertRaises(ProviderError):
            await ScriptedProvider([]).complete([], [], 10)


if __name__ == "__main__":
    unittest.main()
