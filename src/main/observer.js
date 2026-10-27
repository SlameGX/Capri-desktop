'use strict';

// Desktop Context Engine for Windows UI Automation
// Observes and describes the Windows desktop through accessibility information (strictly read-only).

const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const { spawn, execFile } = require('node:child_process');

const OBSERVER_DIR = path.join(__dirname, 'observer').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const OBSERVER_EXE = path.join(OBSERVER_DIR, 'CapriObserver.exe');
const OBSERVER_CS = path.join(OBSERVER_DIR, 'CapriObserver.cs');
const CSC_PATH = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

let helperProcess = null;
let reqCounter = 0;
const pendingRequests = new Map(); // reqId -> { resolve, reject, timer }
let latestObservation = null;
let latestForeground = null;
let updateCallbacks = new Set();
let debounceTimer = null;
let restarts = 0;
let isStopping = false;

// Compile C# observer if binary doesn't exist
async function ensureBinary() {
  if (fs.existsSync(OBSERVER_EXE)) return true;
  if (!fs.existsSync(CSC_PATH)) {
    console.error('[capri:observer] csc.exe compiler not found at', CSC_PATH);
    return false;
  }
  if (!fs.existsSync(OBSERVER_CS)) {
    console.error('[capri:observer] CapriObserver.cs source file missing at', OBSERVER_CS);
    return false;
  }

  return new Promise((resolve) => {
    const wpfDir = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\WPF';
    const refs = [
      path.join(wpfDir, 'UIAutomationClient.dll'),
      path.join(wpfDir, 'UIAutomationTypes.dll'),
      path.join(wpfDir, 'WindowsBase.dll'),
      'System.dll',
    ].join(',');

    const args = [
      '/nologo',
      '/optimize+',
      '/target:exe',
      `/r:${refs}`,
      `/out:${OBSERVER_EXE}`,
      OBSERVER_CS,
    ];

    execFile(CSC_PATH, args, (err) => {
      if (err) {
        console.error('[capri:observer] Compilation failed:', err.message);
        resolve(false);
      } else {
        console.log('[capri:observer] Compiled CapriObserver.exe successfully');
        resolve(true);
      }
    });
  });
}

function startObserverHelper({ overlayHwnd = 0 } = {}) {
  if (process.platform !== 'win32') return;
  if (helperProcess) return;
  isStopping = false;

  if (!fs.existsSync(OBSERVER_EXE)) {
    ensureBinary().then((ok) => {
      if (ok) startObserverHelper({ overlayHwnd });
    });
    return;
  }

  const args = [
    '--self', String(overlayHwnd || 0),
    '--parent', String(process.pid),
  ];

  try {
    helperProcess = spawn(OBSERVER_EXE, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error('[capri:observer] Failed to spawn helper:', err.message);
    return;
  }

  const rl = readline.createInterface({ input: helperProcess.stdout });

  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    try {
      const msg = JSON.parse(line);
      handleHelperMessage(msg);
    } catch {
      // Non-JSON line (debug output)
    }
  });

  helperProcess.stderr.on('data', (d) => {
    const txt = String(d).trim();
    if (txt) console.error('[capri:observer stderr]', txt);
  });

  helperProcess.on('exit', (code) => {
    helperProcess = null;
    for (const [id, req] of pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(new Error(`Observer process exited with code ${code}`));
      pendingRequests.delete(id);
    }

    if (!isStopping && restarts++ < 3) {
      console.log('[capri:observer] Process exited, restarting in 2s...');
      setTimeout(() => startObserverHelper({ overlayHwnd }), 2000);
    }
  });
}

function handleHelperMessage(msg) {
  if (msg.type === 'response') {
    const pending = pendingRequests.get(msg.reqId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRequests.delete(msg.reqId);

    if (msg.ok) {
      const normalized = normalizeObservation(msg.payload);
      latestObservation = normalized;
      pending.resolve(normalized);
    } else {
      pending.reject(new Error(msg.payload?.error || 'Observer request failed'));
    }
    return;
  }

  if (msg.type === 'event') {
    if (msg.name === 'foreground_changed') {
      latestForeground = msg.data;
      // Debounce automatic background refresh
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        observe({ maxDepth: 18, maxElements: 400, timeoutMs: 3500 })
          .then((obs) => notifyUpdate(obs))
          .catch(() => {});
      }, 400);
    }
  }
}

function notifyUpdate(obs) {
  for (const cb of updateCallbacks) {
    try { cb(obs); } catch { }
  }
}

function stopObserverHelper() {
  isStopping = true;
  if (!helperProcess) return;
  try {
    helperProcess.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n');
  } catch {}
  setTimeout(() => {
    if (helperProcess) {
      try { helperProcess.kill(); } catch {}
      helperProcess = null;
    }
  }, 400);
}

// Sends a command to the native helper
function sendCommand(cmd, payload = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!helperProcess || !helperProcess.stdin.writable) {
      return reject(new Error('UI Automation observer helper is not running'));
    }

    const reqId = ++reqCounter;
    const timer = setTimeout(() => {
      pendingRequests.delete(reqId);
      try {
        helperProcess?.stdin.write(JSON.stringify({ cmd: 'cancel' }) + '\n');
      } catch {}
      reject(new Error(`Observer request ${reqId} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(reqId, { resolve, reject, timer });

    const message = JSON.stringify({ ...payload, cmd, reqId }) + '\n';
    helperProcess.stdin.write(message, 'utf8', (err) => {
      if (err) {
        clearTimeout(timer);
        pendingRequests.delete(reqId);
        reject(err);
      }
    });
  });
}

// Request an on-demand desktop observation
async function observe(options = {}) {
  const {
    hwnd = 0,
    scope = 'auto',
    maxDepth = 28,
    maxElements = 1000,
    timeoutMs = 6500,
  } = options;

  if (!helperProcess) {
    await ensureBinary();
    startObserverHelper();
    // Wait briefly for helper ready
    await new Promise((r) => setTimeout(r, 200));
  }

  return sendCommand('observe', { hwnd, scope, maxDepth, maxElements, timeoutMs }, timeoutMs + 1000);
}

// Quick foreground window info
async function getForegroundInfo() {
  if (!helperProcess) return null;
  return sendCommand('foreground', {}, 1500).catch(() => null);
}

// Normalizes raw helper output into the structured Desktop Context Engine representation
function normalizeObservation(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      activeWindow: { title: 'Unknown', processName: 'Unknown', processId: 0 },
      observationSource: 'windows-ui-automation',
      observedAt: new Date().toISOString(),
      elements: [],
      limitations: ['No observation data returned'],
      summary: 'No active window information could be read.',
    };
  }

  const activeWindow = {
    title: String(raw.activeWindow?.title || '').trim() || 'Untitled Window',
    processName: String(raw.activeWindow?.processName || 'Unknown'),
    processId: Number(raw.activeWindow?.processId) || 0,
    hwnd: raw.activeWindow?.hwnd || 0,
    executablePath: raw.activeWindow?.executablePath || '',
    bounds: raw.activeWindow?.bounds || { x: 0, y: 0, width: 0, height: 0 },
    isMinimized: Boolean(raw.activeWindow?.isMinimized),
    isMaximized: Boolean(raw.activeWindow?.isMaximized),
    isVisible: Boolean(raw.activeWindow?.isVisible),
  };

  const rawElements = Array.isArray(raw.elements) ? raw.elements : [];
  const limitations = Array.isArray(raw.limitations) ? [...raw.limitations] : [];

  // Deduplicate and normalize elements
  const elements = [];
  const seenIds = new Set();
  const nameCounts = new Map();

  for (const el of rawElements) {
    if (!el || typeof el !== 'object') continue;

    let id = String(el.id || `el_${elements.length + 1}`);
    if (seenIds.has(id)) {
      id = `${id}_${elements.length + 1}`;
    }
    seenIds.add(id);

    const name = String(el.name || '').trim();
    const type = String(el.type || 'Unknown');

    // Track duplicate names per type
    const key = `${type}:${name}`;
    const count = (nameCounts.get(key) || 0) + 1;
    nameCounts.set(key, count);

    elements.push({
      id,
      parentId: el.parentId || null,
      type,
      name,
      value: el.value != null ? String(el.value).trim() : null,
      className: el.className || '',
      automationId: el.automationId || '',
      category: el.category || null,
      visible: Boolean(el.visible),
      isOffscreen: Boolean(el.isOffscreen),
      isEnabled: el.isEnabled !== false,
      isFocused: Boolean(el.isFocused),
      bounds: el.bounds || { x: 0, y: 0, width: 0, height: 0 },
      patterns: Array.isArray(el.patterns) ? el.patterns : [],
      toggleState: el.toggleState || null,
      isSelected: el.isSelected != null ? Boolean(el.isSelected) : null,
      rangeValue: el.rangeValue != null ? Number(el.rangeValue) : null,
      childrenCount: Number(el.childrenCount) || 0,
    });
  }

  // Detect limitations honestly
  if (elements.length === 0) {
    limitations.push('Application exposed no accessible UI elements (may use custom non-standard rendering or hardware canvas)');
  }

  const observation = {
    activeWindow,
    observationSource: 'windows-ui-automation',
    observedAt: raw.observedAt || new Date().toISOString(),
    durationMs: raw.durationMs || 0,
    elementCount: elements.length,
    elements,
    limitations,
  };

  // Generate compact, token-efficient semantic summary for LLM consumption
  observation.summary = generateCompactSummary(observation);

  return observation;
}

// Cleans up and extracts actual code / text lines from IDE workbench documents or multi-line editors
function extractEditorContent(rawText, activeTitle = '', selectedTab = '') {
  if (!rawText || typeof rawText !== 'string') return '';
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';

  // If already clean code/markdown lines without IDE chrome, return directly
  if (!rawText.includes('File\nEdit') && !rawText.includes('Explorer Views') && lines.length < 50) {
    return lines.slice(0, 50).join('\n');
  }

  // Find target file name: selectedTab takes highest priority, or file extension token from title
  let targetFile = selectedTab || '';
  if (!targetFile && activeTitle) {
    const fileMatch = /\b([a-zA-Z0-9_\\-]+\.[a-zA-Z0-9]{1,8})\b/.exec(activeTitle);
    if (fileMatch) targetFile = fileMatch[1];
  }

  let startIndex = -1;
  if (targetFile) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === targetFile || line.endsWith(targetFile) || line.includes(targetFile)) {
        startIndex = i; // keep going to find the last occurrence (the tab bar right before editor)
      }
    }
  }

  if (startIndex !== -1) {
    const editorLines = [];
    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      // Stop when hitting bottom panels or status bar
      if (/^(Problems|Output|Debug Console|Terminal|Ports|Launch Profile|LF|UTF-8|Markdown|Antigravity - Settings)$/i.test(line)) {
        break;
      }
      // Skip single PUA codicons
      if (line.length === 1 && line.charCodeAt(0) > 0xe000) continue;
      // Skip git status badges
      if (/^[MUA]$/.test(line)) continue;
      // Skip standalone line numbers
      if (/^\d+$/.test(line)) continue;

      editorLines.push(line);
      if (editorLines.length >= 60) break;
    }

    if (editorLines.length > 0) {
      return editorLines.join('\n');
    }
  }

  // Fallback: filter out obvious IDE chrome and return content lines
  return lines
    .filter((l) => l.length > 3 && !/^(File|Edit|Selection|View|Go|Run|Terminal|Help|Explorer|Outline|Timeline)$/i.test(l))
    .slice(0, 45)
    .join('\n');
}

// Generates a compact, token-efficient summary for LLMs (200-500 tokens)
function generateCompactSummary(obs) {
  const { activeWindow, elements = [], limitations = [] } = obs;
  const lines = [];

  const isDesktop = activeWindow.title.toLowerCase().includes('desktop') ||
                    activeWindow.processName.toLowerCase() === 'explorer' ||
                    elements.some((e) => e.category === 'desktop-icon');

  const isYouTube = activeWindow.title.toLowerCase().includes('youtube') ||
                    elements.some((e) => (e.name || '').toLowerCase().includes('youtube'));

  lines.push(`[Active Window / Screen Context] Application: "${activeWindow.processName}", Title: "${activeWindow.title}"`);
  if (activeWindow.isMaximized) lines.push('State: Maximized');
  else if (activeWindow.isMinimized) lines.push('State: Minimized');

  // Find focused element
  const focused = elements.find((e) => e.isFocused);
  if (focused) {
    lines.push(`Focused Element: [${focused.type}] "${focused.name || focused.value || '(unnamed)'}"`);
  }

  // Separate desktop icons, taskbar, video titles, headings, and application controls
  const desktopIcons = [];
  const taskbarItems = [];
  const documentContents = [];
  const videoTitles = [];
  const videoDetails = [];
  const headings = [];
  const links = [];
  const buttons = [];
  const inputs = [];
  const texts = [];
  const tabs = [];
  const generalItems = [];

  const screenWidth = activeWindow.bounds?.width > 0 ? activeWindow.bounds.width : 1920;

  for (const el of elements) {
    if (!el.visible && el.isOffscreen) continue;

    // Check for document / editor content before shortLabel truncation
    if (el.category === 'document-content' || el.type === 'Document' || (el.type === 'Edit' && el.value && el.value.length > 60)) {
      const raw = el.value || el.name || '';
      if (raw.length > 15) {
        const selectedTab = elements.find((e) => e.type === 'TabItem' && e.isSelected)?.name || '';
        const cleaned = extractEditorContent(raw, activeWindow.title, selectedTab);
        if (cleaned && !documentContents.includes(cleaned)) {
          documentContents.push(cleaned);
        }
      }
      if (el.type === 'Document') continue;
    }

    const label = (el.name || el.value || '').trim();
    if (!label && el.type !== 'Edit') continue;

    const shortLabel = label.length > 90 ? label.slice(0, 87) + '...' : label;

    if (el.category === 'desktop-icon' || (isDesktop && el.type === 'ListItem')) {
      desktopIcons.push({
        name: shortLabel,
        x: el.bounds?.x || 0,
        y: el.bounds?.y || 0,
      });
      continue;
    }

    if (el.category === 'taskbar') {
      taskbarItems.push(shortLabel);
      continue;
    }

    switch (el.type) {
      case 'Heading':
        headings.push(shortLabel);
        if (isYouTube && shortLabel.length > 3) {
          videoTitles.push(shortLabel);
        }
        break;
      case 'Hyperlink':
        links.push(shortLabel);
        if (isYouTube && shortLabel.length > 5) {
          if (!/^(home|subscriptions|explore|trending|library|history|watch later|liked videos|settings|report|help|feedback|about|press|copyright|contact us|creators|advertise|developers|terms|privacy|policy|switch account|sign out|sign in|oturum a[çc]|ana sayfa|trendler|abonelikler|ge[çc]mi[sş])$/i.test(shortLabel)) {
            videoTitles.push(shortLabel);
          }
        }
        break;
      case 'Button':
        buttons.push(`"${shortLabel}"`);
        break;
      case 'Edit':
        inputs.push(`[${el.name || 'Input'}]: "${el.value || '(empty)'}"`);
        break;
      case 'Document':
      case 'Text':
        if (shortLabel.length > 2) {
          texts.push(shortLabel);
          if (isYouTube) {
            const isNav = /^(t[üu]m[üu]|oyun|m[üu]zik|mix'ler|canl[ıi]|animasyon|turizm|abonelikler|shorts|ana sayfa|kitapl[ıi]k|ge[çc]mi[sş]|daha sonra izle|be[ğg]endi[ğg]im videolar|ayarlar|bildirimler|olu[sş]tur|ara|search)$/i.test(shortLabel);
            if (!isNav) {
              if (shortLabel.length >= 12 && !videoTitles.includes(shortLabel)) {
                videoTitles.push(shortLabel);
              } else if (shortLabel.length >= 3) {
                videoDetails.push(shortLabel);
              }
            }
          }
        }
        break;
      case 'TabItem':
        tabs.push(`"${shortLabel}"${el.isSelected ? ' (Selected)' : ''}`);
        break;
      case 'ListItem':
      case 'TreeItem':
      case 'MenuItem':
        generalItems.push(`[${el.type}] "${shortLabel}"`);
        break;
    }
  }

  // 1. Active Document / Editor Content (for IDEs like VS Code, Antigravity, Notepad)
  if (documentContents.length > 0) {
    const uniqueDocs = [...new Set(documentContents)].slice(0, 2);
    lines.push(`\n[Active Document / Editor Content]:\n${uniqueDocs.join('\n---\n')}`);
  }

  // 2. YouTube Video Titles / Headings
  if (videoTitles.length > 0) {
    const uniqueTitles = [...new Set(videoTitles)].slice(0, 30);
    lines.push(`\n[Visible YouTube Video Titles & Content (${uniqueTitles.length})]:\n${uniqueTitles.map((t) => `• "${t}"`).join('\n')}`);
  } else if (headings.length > 0) {
    const uniqueHeadings = [...new Set(headings)].slice(0, 20);
    lines.push(`\n[Page Headings & Titles (${uniqueHeadings.length})]:\n${uniqueHeadings.map((h) => `• "${h}"`).join('\n')}`);
  }

  // Subtitles / details under videos
  if (videoDetails.length > 0) {
    const uniqueDetails = [...new Set(videoDetails)].slice(0, 20);
    lines.push(`\n[Visible Video Subtitles & Details (${uniqueDetails.length})]:\n${uniqueDetails.map((d) => `• ${d}`).join('\n')}`);
  }

  // 2. Web Links / Hyperlinks (if not already represented in video titles)
  if (links.length > 0 && videoTitles.length === 0) {
    const uniqueLinks = [...new Set(links)].slice(0, 25);
    lines.push(`Web Links (${uniqueLinks.length}): ${uniqueLinks.join(', ')}`);
  }

  // 3. Desktop Icons: group spatially across the entire screen
  if (desktopIcons.length > 0) {
    const leftIcons = [];
    const centerIcons = [];
    const rightIcons = [];
    const folderIcons = [];

    const isFolder = (name) => {
      const lower = name.toLowerCase();
      return /maligpu|checkpoint|html cv|moto|server|folder|klas[öo]r|yeni klas[öo]r/i.test(lower);
    };

    for (const icon of desktopIcons) {
      if (isFolder(icon.name)) {
        folderIcons.push(icon.name);
      }
      if (icon.x < screenWidth * 0.38) {
        leftIcons.push(icon.name);
      } else if (icon.x > screenWidth * 0.62) {
        rightIcons.push(icon.name);
      } else {
        centerIcons.push(icon.name);
      }
    }

    lines.push(`\n[Full Desktop Scan - ${desktopIcons.length} Icons Across Entire Screen]:`);
    if (leftIcons.length > 0) {
      lines.push(`• Left Side Icons (${leftIcons.length}): ${leftIcons.join(', ')}`);
    }
    if (centerIcons.length > 0) {
      lines.push(`• Center Area Icons (${centerIcons.length}): ${centerIcons.join(', ')}`);
    }
    if (rightIcons.length > 0) {
      lines.push(`• Right Side Icons & Games (${rightIcons.length}): ${rightIcons.join(', ')}`);
    }
    if (folderIcons.length > 0) {
      lines.push(`• Desktop Folders (${folderIcons.length}): ${[...new Set(folderIcons)].join(', ')}`);
    }
  }

  // 4. Taskbar items
  if (taskbarItems.length > 0) {
    const uniqueTaskbar = [...new Set(taskbarItems)];
    lines.push(`\n[Taskbar & Pinned/Running Apps (${uniqueTaskbar.length})]:\n${uniqueTaskbar.join(', ')}`);
  }

  // 5. Application controls
  if (tabs.length) {
    lines.push(`Open Tabs: ${tabs.slice(0, 12).join(', ')}`);
  }

  if (inputs.length) {
    lines.push(`Input Fields: ${inputs.slice(0, 10).join('; ')}`);
  }

  if (buttons.length) {
    lines.push(`Available Buttons/Controls: ${buttons.slice(0, 25).join(', ')}`);
  }

  if (texts.length) {
    const uniqueTexts = [...new Set(texts)].slice(0, 16);
    lines.push(`Visible Content & Labels:\n${uniqueTexts.map((t) => `• ${t}`).join('\n')}`);
  }

  if (generalItems.length) {
    const itemsToShow = generalItems.slice(0, 30);
    const suffix = generalItems.length > 30 ? ` ... (+${generalItems.length - 30} more)` : '';
    lines.push(`Items / Navigation: ${itemsToShow.join(', ')}${suffix}`);
  }

  // Filter out spurious depth limit if we actually extracted plenty of elements, documents, or video content
  const cleanLimitations = limitations.filter((lim) => {
    if (lim.startsWith('Max depth limit reached') && (documentContents.length > 0 || videoTitles.length > 0 || headings.length > 0 || elements.length >= 8)) return false;
    return true;
  });

  if (cleanLimitations.length) {
    lines.push(`Observation Limitations: ${cleanLimitations.join('; ')}`);
  }

  return lines.join('\n');
}

function onObservationUpdate(fn) {
  updateCallbacks.add(fn);
  return () => updateCallbacks.delete(fn);
}

function getLatestObservation() {
  return latestObservation;
}

function getStatus() {
  return {
    running: Boolean(helperProcess && !helperProcess.killed),
    pid: helperProcess?.pid || null,
    binaryExists: fs.existsSync(OBSERVER_EXE),
    latestObservedAt: latestObservation?.observedAt || null,
    activeWindow: latestObservation?.activeWindow || latestForeground || null,
  };
}

module.exports = {
  startObserverHelper,
  stopObserverHelper,
  observe,
  getForegroundInfo,
  getLatestObservation,
  onObservationUpdate,
  getStatus,
  generateCompactSummary,
  extractEditorContent,
  ensureBinary,
};
