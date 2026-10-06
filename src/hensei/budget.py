"""Shared usage accounting with conservative reservations before model calls."""
from __future__ import annotations

import asyncio
import json
from .providers import ProviderError


class BudgetExceeded(ProviderError):
    pass


class TokenBudget:
    def __init__(self, limit: int, store, concurrency: int):
        self.limit, self.store = limit, store
        self.reserved = 0
        self.condition = asyncio.Condition()
        self.slots = asyncio.Semaphore(concurrency)
        self.exhausted = False

    def wrap(self, provider, task_id: str):
        budget = self

        class AccountedProvider:
            async def complete(self, messages, tools, max_output_tokens):
                # UTF-8 bytes are deliberately conservative relative to token counts.
                reservation = len(json.dumps({'messages': messages, 'tools': tools}, ensure_ascii=False).encode()) + max_output_tokens
                async with budget.slots:
                    async with budget.condition:
                        while budget.store.get('tokens', 0) + budget.reserved + reservation > budget.limit:
                            if budget.reserved == 0:
                                budget.exhausted = True
                                raise BudgetExceeded('The remaining run budget cannot conservatively reserve this request')
                            await budget.condition.wait()
                        budget.reserved += reservation
                    try:
                        response = await provider.complete(messages, tools, max_output_tokens)
                        usage = response.get('usage', {})
                        budget.store.record_usage(task_id, usage, requested_model=getattr(provider, 'model', 'scripted'),
                                                  returned_model=response.get('model'),
                                                  fingerprint=response.get('system_fingerprint'),
                                                  reservation=reservation)
                        if budget.store.get('tokens', 0) >= budget.limit:
                            budget.exhausted = True
                        return response
                    except Exception:
                        budget.store.event('model_request_failed', task_id, billing_unknown=True)
                        raise
                    finally:
                        async with budget.condition:
                            budget.reserved -= reservation
                            budget.condition.notify_all()

        return AccountedProvider()
