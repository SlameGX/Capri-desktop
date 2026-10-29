'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const telegram = require('../src/main/telegram');

test('telegram: generates valid 6-digit pairing code', () => {
  const pin = telegram.generatePairingCode();
  assert.equal(typeof pin, 'string');
  assert.equal(pin.length, 6);
  assert.match(pin, /^\d{6}$/);
  assert.equal(telegram.getActivePairing(), pin);
});

test('telegram: status reflects configuration correctly', () => {
  const status = telegram.getStatus();
  assert.equal(typeof status, 'object');
  assert.equal('running' in status, true);
  assert.equal('enabled' in status, true);
  assert.equal('hasToken' in status, true);
  assert.equal('allowedUserId' in status, true);
});

test('telegram: notifyClaudeEvent handles Antigravity and Claude events cleanly', async () => {
  // Should not throw even when not fully configured or missing fields
  await assert.doesNotReject(async () => {
    await telegram.notifyClaudeEvent({
      session_id: 'agy:session_123',
      hook_event_name: 'Stop',
      last_assistant_message: 'Antigravity task completed successfully.',
    });
    await telegram.notifyClaudeEvent({
      session_id: 'claude:session_456',
      hook_event_name: 'Stop',
      message: 'Claude completed task.',
    });
    await telegram.notifyClaudeEvent({
      session_id: 'agy:session_123',
      hook_event_name: 'Notification',
      message: 'Antigravity prompt',
    });
    await telegram.notifyClaudeEvent({
      session_id: 'agy:session_123',
      hook_event_name: 'StopFailure',
      error: 'Something went wrong',
    });
  });
});
