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

test('telegram: manages Antigravity code session lifecycle and streams changes', async () => {
  assert.equal(telegram.isTelegramCodeSessionActive(), false);

  // Start session
  const sess = telegram.startTelegramCodeSession('12345678', 'token_xyz', 'Add telegram restart and window management');
  assert.equal(telegram.isTelegramCodeSessionActive(), true);
  assert.equal(sess.chatId, '12345678');
  assert.equal(sess.task, 'Add telegram restart and window management');

  // Should process tool edit event during active code session without throwing
  await assert.doesNotReject(async () => {
    await telegram.notifyClaudeEvent({
      session_id: 'agy:session_code_test',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: 'src/main/telegram.js',
        replacement_snippet: '// added window management',
      },
    });

    await telegram.notifyClaudeEvent({
      session_id: 'agy:session_code_test',
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: {
        file_path: 'src/main/windowManager.js',
        content_len: 4200,
        content_snippet: '// window manager content',
      },
    });

    await telegram.notifyClaudeEvent({
      session_id: 'agy:session_code_test',
      hook_event_name: 'PostToolUse',
      tool_name: 'PowerShell',
      tool_input: {
        command: 'npm test',
      },
    });
  });

  // End session on Stop
  await telegram.notifyClaudeEvent({
    session_id: 'agy:session_code_test',
    hook_event_name: 'Stop',
    last_assistant_message: 'All features added and verified.',
  });

  // Session should be automatically closed
  assert.equal(telegram.isTelegramCodeSessionActive(), false);
});

test('telegram: windowManager list and find functions work', async () => {
  const wm = telegram.windowManager;
  assert.equal(typeof wm, 'object');
  assert.equal(typeof wm.listWindows, 'function');
  assert.equal(typeof wm.findWindow, 'function');
  assert.equal(typeof wm.openOrFocusApp, 'function');
  assert.equal(typeof wm.minimizeWindow, 'function');
  assert.equal(typeof wm.maximizeWindow, 'function');
  assert.equal(typeof wm.restoreWindow, 'function');
  assert.equal(typeof wm.resizeWindow, 'function');
  assert.equal(typeof wm.closeWindow, 'function');

  const wins = await wm.listWindows();
  assert.equal(Array.isArray(wins), true);
  if (wins.length > 0) {
    const first = wins[0];
    assert.equal('hwnd' in first, true);
    assert.equal('title' in first, true);
    assert.equal('process' in first, true);

    const foundByHwnd = await wm.findWindow(first.hwnd);
    assert.equal(foundByHwnd?.hwnd, first.hwnd);

    const foundByIndex = await wm.findWindow('1');
    assert.equal(foundByIndex?.hwnd, first.hwnd);
  }
});

test('telegram: tool edits are ignored when code session is NOT active', async () => {
  // Ensure session is inactive
  telegram.stopTelegramCodeSession();
  assert.equal(telegram.isTelegramCodeSessionActive(), false);

  // Notify a PostToolUse event when NOT in telegram code session
  await telegram.notifyClaudeEvent({
    session_id: 'agy:desktop_ide_session',
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: {
      file_path: 'src/secret.js',
      replacement_snippet: '// some secret edit on desktop',
    },
  });

  // Since it was not started from Telegram, session must remain inactive
  assert.equal(telegram.isTelegramCodeSessionActive(), false);
});

test('telegram: restart script exists and is structured for detached sequence execution', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const restartScript = path.join(__dirname, '..', 'src', 'main', 'restart.ps1');
  assert.equal(fs.existsSync(restartScript), true);
  const content = fs.readFileSync(restartScript, 'utf8');
  assert.match(content, /npm run dev/);
  assert.match(content, /Stop-Process/);
  assert.match(content, /Start-Process/);
});
