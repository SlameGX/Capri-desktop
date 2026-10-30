'use strict';

// Window Manager for Capri
// Enumerates top-level application windows and controls them (focus, minimize, maximize, resize, close).
// Connects to Windows WinSta0\default desktop via windowManager.ps1.

const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const SCRIPT_PATH = path.join(__dirname, 'windowManager.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function runScript(args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH, ...args,
    ], { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try {
        const text = (stdout || '').trim();
        resolve(text ? JSON.parse(text) : null);
      } catch {
        resolve(stdout.trim());
      }
    });
  });
}

// Normalizes search term
function normalize(str) {
  return String(str || '').toLowerCase().replace(/[\s\-_]+/g, '').trim();
}

async function listWindows() {
  if (process.platform !== 'win32') return [];
  const raw = await runScript(['-Action', 'list']);
  const list = Array.isArray(raw) ? raw : [];
  // Exclude internal / background windows
  return list.filter((w) => {
    const title = (w.title || '').trim();
    const proc = (w.process || '').toLowerCase();
    if (!title) return false;
    if (proc === 'dwm' || title.includes('DWM Notification Window')) return false;
    return true;
  });
}

// Finds a window by index (1-based), HWND, process name, or title query
async function findWindow(query) {
  const windows = await listWindows();
  if (!windows.length) return null;

  const rawQuery = String(query || '').trim();
  if (!rawQuery) return null;

  // 1. If numeric: check if it's a 1-based list index or an exact HWND
  if (/^\d+$/.test(rawQuery)) {
    const num = Number(rawQuery);
    if (num >= 1 && num <= windows.length) {
      return windows[num - 1];
    }
    const byHwnd = windows.find((w) => w.hwnd === num || String(w.hwnd) === rawQuery);
    if (byHwnd) return byHwnd;
  }

  const needle = normalize(rawQuery);

  // 2. Exact match on process name or title
  const exact = windows.find((w) => normalize(w.process) === needle || normalize(w.title) === needle);
  if (exact) return exact;

  // 3. Prefix match
  const prefix = windows.find((w) => normalize(w.process).startsWith(needle) || normalize(w.title).startsWith(needle));
  if (prefix) return prefix;

  // 4. Substring match
  const partial = windows.find((w) => normalize(w.process).includes(needle) || normalize(w.title).includes(needle) || needle.includes(normalize(w.process)));
  if (partial) return partial;

  return null;
}

async function focusWindow(query) {
  const win = typeof query === 'object' && query?.hwnd ? query : await findWindow(query);
  if (!win) throw new Error(`Pencere bulunamadı: "${query}"`);
  const res = await runScript(['-Action', 'focus', '-Hwnd', String(win.hwnd)]);
  return { ok: Boolean(res?.ok), window: win };
}

async function minimizeWindow(query) {
  const win = typeof query === 'object' && query?.hwnd ? query : await findWindow(query);
  if (!win) throw new Error(`Pencere bulunamadı: "${query}"`);
  const res = await runScript(['-Action', 'minimize', '-Hwnd', String(win.hwnd)]);
  return { ok: Boolean(res?.ok), window: win };
}

async function maximizeWindow(query) {
  const win = typeof query === 'object' && query?.hwnd ? query : await findWindow(query);
  if (!win) throw new Error(`Pencere bulunamadı: "${query}"`);
  const res = await runScript(['-Action', 'maximize', '-Hwnd', String(win.hwnd)]);
  return { ok: Boolean(res?.ok), window: win };
}

async function restoreWindow(query) {
  const win = typeof query === 'object' && query?.hwnd ? query : await findWindow(query);
  if (!win) throw new Error(`Pencere bulunamadı: "${query}"`);
  const res = await runScript(['-Action', 'restore', '-Hwnd', String(win.hwnd)]);
  return { ok: Boolean(res?.ok), window: win };
}

async function resizeWindow(query, width, height, { x = -1, y = -1 } = {}) {
  const win = typeof query === 'object' && query?.hwnd ? query : await findWindow(query);
  if (!win) throw new Error(`Pencere bulunamadı: "${query}"`);

  let finalW = width;
  let finalH = height;
  let finalX = x;
  let finalY = y;

  // Handle named presets
  if (typeof width === 'string') {
    const preset = width.toLowerCase().trim();
    if (preset === 'half-left' || preset === 'left') {
      finalW = 960; finalH = 1040; finalX = 0; finalY = 0;
    } else if (preset === 'half-right' || preset === 'right') {
      finalW = 960; finalH = 1040; finalX = 960; finalY = 0;
    } else if (preset === 'center') {
      finalW = 1280; finalH = 800; finalX = 320; finalY = 120;
    } else if (preset === '720p' || preset === 'hd') {
      finalW = 1280; finalH = 720;
    } else if (preset === '1080p' || preset === 'fhd') {
      finalW = 1920; finalH = 1080; finalX = 0; finalY = 0;
    } else {
      const match = preset.match(/^(\d+)[xX,:](\d+)$/);
      if (match) {
        finalW = Number(match[1]);
        finalH = Number(match[2]);
      }
    }
  }

  const args = [
    '-Action', 'resize',
    '-Hwnd', String(win.hwnd),
    '-Width', String(finalW || 0),
    '-Height', String(finalH || 0),
    '-X', String(finalX),
    '-Y', String(finalY),
  ];

  const res = await runScript(args);
  return { ok: Boolean(res?.ok), window: win, bounds: { w: finalW, h: finalH, x: finalX, y: finalY } };
}

async function closeWindow(query, { force = false } = {}) {
  const win = typeof query === 'object' && query?.hwnd ? query : await findWindow(query);
  if (!win) throw new Error(`Pencere bulunamadı: "${query}"`);

  const args = ['-Action', 'close', '-Hwnd', String(win.hwnd)];
  if (force) args.push('-Force');

  const res = await runScript(args);
  return { ok: Boolean(res?.ok), window: win, forced: force };
}

// Opens or focuses an application on the main screen.
// If already open, brings it to foreground and restores if minimized.
// If not open, attempts to launch it.
async function openOrFocusApp(name, { launchModule } = {}) {
  const target = String(name || '').trim();
  if (!target) throw new Error('Uygulama adı belirtilmedi');

  // 1. Try to find an existing window first
  const existing = await findWindow(target);
  if (existing) {
    await focusWindow(existing);
    return { action: 'focused', window: existing, message: `"${existing.title}" ana ekrana getirildi.` };
  }

  // 2. Not running: launch through launch module or shell
  if (launchModule?.find && launchModule?.launch) {
    const item = await launchModule.find(target);
    if (item) {
      await launchModule.launch(item);
      return { action: 'launched', item, message: `"${item.name}" başlatıldı ve ana ekranda açılıyor.` };
    }
  }

  // Fallback: spawn via explorer
  spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
  return { action: 'spawned', message: `"${target}" başlatma komutu verildi.` };
}

module.exports = {
  listWindows,
  findWindow,
  focusWindow,
  minimizeWindow,
  maximizeWindow,
  restoreWindow,
  resizeWindow,
  closeWindow,
  openOrFocusApp,
};

