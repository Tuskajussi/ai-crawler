import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyModelError } from './pi';
import { AgentExecutionError, isEscalatableError } from './execution-errors';

test('only temporary network/provider failures are retried and eligible for fallback', () => {
  for (const message of ['503 temporarily unavailable', '429 overloaded', 'Connection error', 'Stream ended without finish_reason', 'socket closed unexpectedly']) {
    const error = classifyModelError(new Error(message));
    assert.equal(error.retryable, true, message);
    assert.equal(isEscalatableError(error), true, message);
  }
  for (const message of ['401 network authentication failed', '403 access denied', '404 model missing', '429 insufficient_quota', '429 subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable', 'Unexpected implementation bug']) {
    const error = classifyModelError(new Error(message));
    assert.equal(error.retryable, false, message);
    assert.equal(isEscalatableError(error), false, message);
  }
  const report = new AgentExecutionError('Invalid report after repair', 'report');
  assert.equal(classifyModelError(report), report);
  assert.equal(report.retryable, false);
  assert.equal(isEscalatableError(report), true);
});
