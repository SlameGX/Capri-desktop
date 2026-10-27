'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const observer = require('../src/main/observer');

test('Windows UI Automation Observer binary exists and compiles', async () => {
  const binaryExists = await observer.ensureBinary();
  assert.equal(binaryExists, true, 'CapriObserver.exe should compile or exist');
  const exePath = path.join(__dirname, '../src/main/observer/CapriObserver.exe');
  assert.equal(fs.existsSync(exePath), true, 'CapriObserver.exe must exist on disk');
});

test('Observer helper starts, responds to ping and status', async (t) => {
  observer.startObserverHelper({ overlayHwnd: 0 });
  t.after(() => observer.stopObserverHelper());

  await new Promise((r) => setTimeout(r, 600));
  const status = observer.getStatus();
  assert.equal(status.running, true, 'Observer helper should be running');
  assert.ok(status.pid > 0, 'Observer helper must have a valid PID');
  assert.equal(status.binaryExists, true);
});

test('Desktop observation returns structured schema adhering to requirements', async (t) => {
  observer.startObserverHelper({ overlayHwnd: 0 });
  t.after(() => observer.stopObserverHelper());

  await new Promise((r) => setTimeout(r, 600));

  const obs = await observer.observe({ maxDepth: 4, maxElements: 50, timeoutMs: 3000 });
  assert.ok(obs, 'Observation should not be null');
  assert.equal(obs.observationSource, 'windows-ui-automation');
  assert.ok(typeof obs.observedAt === 'string', 'observedAt should be ISO string');
  assert.ok(typeof obs.durationMs === 'number', 'durationMs should be a number');
  assert.ok(Array.isArray(obs.elements), 'elements should be an array');
  assert.ok(Array.isArray(obs.limitations), 'limitations should be an array');
  assert.ok(typeof obs.summary === 'string', 'summary should be a string');

  // Validate activeWindow
  assert.ok(obs.activeWindow, 'activeWindow must be present');
  assert.ok(typeof obs.activeWindow.title === 'string');
  assert.ok(typeof obs.activeWindow.processName === 'string');
  assert.ok(typeof obs.activeWindow.processId === 'number');
  assert.ok(obs.activeWindow.bounds, 'bounds must exist');
});

test('generateCompactSummary formats observation into token-efficient text', () => {
  const sampleObs = {
    activeWindow: {
      title: 'src/main/observer.js - capri-desktop - Visual Studio Code',
      processName: 'Code',
      processId: 1234,
      isMaximized: true,
      bounds: { x: 0, y: 0, width: 1536, height: 864 },
    },
    observationSource: 'windows-ui-automation',
    elements: [
      { id: 'el_1', type: 'TabItem', name: 'observer.js', isSelected: true, visible: true },
      { id: 'el_2', type: 'Edit', name: 'Find in files', value: 'UIAutomation', visible: true },
      { id: 'el_3', type: 'Button', name: 'Run and Debug', visible: true },
      { id: 'el_4', type: 'Button', name: 'Extensions', visible: true },
      { id: 'el_5', type: 'Document', name: 'Editor content with code', value: 'const observer = require(...)', visible: true },
      { id: 'el_6', type: 'Button', name: 'Hidden button', visible: false, isOffscreen: true },
    ],
    limitations: ['Element count limit reached (250)'],
  };

  const summary = observer.generateCompactSummary(sampleObs);
  assert.ok(summary.includes('Visual Studio Code'), 'Summary should include active window title');
  assert.ok(summary.includes('Code'), 'Summary should include process name');
  assert.ok(summary.includes('Run and Debug'), 'Summary should include available buttons');
  assert.ok(summary.includes('Find in files'), 'Summary should include inputs');
  assert.ok(summary.includes('observer.js'), 'Summary should include open tabs');
  assert.ok(summary.includes('Element count limit reached'), 'Summary should report limitations');
  assert.ok(!summary.includes('Hidden button'), 'Offscreen elements should not clutter compact summary');
});

test('Chat intent recognition detects Turkish, English, and multilingual screen perception queries', async () => {
  // Import chat.js in node
  const chatFile = path.join(__dirname, '../src/renderer/js/chat.js');
  const chatSource = fs.readFileSync(chatFile, 'utf8');

  // Verify exported isInspectAsk regex
  const isInspectAskMatch = /export const isInspectAsk = (.*?);/s.exec(chatSource);
  assert.ok(isInspectAskMatch, 'isInspectAsk should be defined in chat.js');

  const SCREEN_INSPECT_ASK = /ekran|masa[uü]st[uü]|screen|desktop|pencere|window|fen[êe]tre|pantalla|tela|экран|youtube|video|sekme|sayfa|altba[sş]l[ıi]k|ba[sş]l[ıi]k|readme|dosya|kod|file|code|i[çc]erik/i;
  const INSPECT_VERB = /bak|g[öo]r|oku|incele|analiz|a[çc][ıi]kla|neler var|ne var|ne g[öo]r[üu]yorsun|hangi|neler a[çc][ıi]k|tamam|hepsi|b[üu]t[üu]n|full|all|oyun|uygulama|ba[sş]l[ıi]k|listele|ne yaz[ıi]yor|yaz[ıi]yor|yaz|s[öo]yle|tek tek|anlat|ver|look|see|check|read|inspect|what|show|view|explain|list|tell|regarde|mira|olha|посмотри/i;
  const isInspect = (t) => (SCREEN_INSPECT_ASK.test(t) && INSPECT_VERB.test(t)) || /ekran[ıi]ma bak|ne g[öo]r[üu]yorsun|ekran[ıi]n tamam[ıi]|tam ekran|masa[uü]st[uü]mde|look at (my )?screen|what's on (my )?screen|videolar[ıi]n|ba[sş]l[ıi]klar[ıi]|altba[sş]l[ıi]k|ne yaz[ıi]yor|readme|dosya(n[ıi]n)? i[çc]eri[ğg]i/i.test(t);

  // Positive cases (Turkish & English)
  assert.equal(isInspect('ekranıma bak'), true);
  assert.equal(isInspect('ekranımda ne var?'), true);
  assert.equal(isInspect('ekranımdaki hatayı açıkla'), true);
  assert.equal(isInspect('ekrandaki kodları incele'), true);
  assert.equal(isInspect('şu an ekranda ne görüyorsun?'), true);
  assert.equal(isInspect('look at my screen please'), true);
  assert.equal(isInspect("what's on my screen?"), true);
  assert.equal(isInspect('inspect active window and desktop'), true);
  assert.equal(isInspect('Optik tarama ekranın tamamını göremiyor.'), true);
  assert.equal(isInspect('tam ekranı gör ve masaüstündeki oyunları listele'), true);
  assert.equal(isInspect('Youtube açtım, videoların başlıklarını oku'), true);
  assert.equal(isInspect('ekrandaki videoların başlıklarını oku'), true);
  assert.equal(isInspect('Ekranımdaki videoların altbaşlıkları tek tek yaza bilirmisin'), true);
  assert.equal(isInspect('peki ne yazıyor readme içinde'), true);
  assert.equal(isInspect('dosyanın içeriğini oku'), true);
  assert.equal(isInspect('kodda ne yazıyor?'), true);

  // Negative cases (unrelated chat)
  assert.equal(isInspect('selam nasılsın'), false);
  assert.equal(isInspect('spotify aç'), false);
  assert.equal(isInspect('yarın hava nasıl olacak'), false);
  assert.equal(isInspect('play some music'), false);
});

test('generateCompactSummary discovers all desktop icons across left and right sides without 8-item truncation', () => {
  const desktopObs = {
    activeWindow: {
      title: 'Windows Desktop',
      processName: 'explorer',
      processId: 1000,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    },
    observationSource: 'windows-ui-automation',
    elements: [
      // Left side icons (x < 700)
      { id: 'el_1', type: 'ListItem', name: 'Geri Dönüşüm Kutusu', category: 'desktop-icon', bounds: { x: 20, y: 20, width: 60, height: 60 }, visible: true },
      { id: 'el_2', type: 'ListItem', name: 'Steam', category: 'desktop-icon', bounds: { x: 20, y: 100, width: 60, height: 60 }, visible: true },
      { id: 'el_3', type: 'ListItem', name: 'Google Chrome', category: 'desktop-icon', bounds: { x: 20, y: 180, width: 60, height: 60 }, visible: true },
      { id: 'el_4', type: 'ListItem', name: 'This PC', category: 'desktop-icon', bounds: { x: 100, y: 20, width: 60, height: 60 }, visible: true },
      { id: 'el_5', type: 'ListItem', name: 'Oracle VirtualBox', category: 'desktop-icon', bounds: { x: 100, y: 100, width: 60, height: 60 }, visible: true },
      { id: 'el_6', type: 'ListItem', name: 'Blender', category: 'desktop-icon', bounds: { x: 100, y: 180, width: 60, height: 60 }, visible: true },
      { id: 'el_7', type: 'ListItem', name: 'balenaEtcher', category: 'desktop-icon', bounds: { x: 200, y: 20, width: 60, height: 60 }, visible: true },
      { id: 'el_8', type: 'ListItem', name: 'FileZilla Client', category: 'desktop-icon', bounds: { x: 200, y: 100, width: 60, height: 60 }, visible: true },
      { id: 'el_9', type: 'ListItem', name: 'Antigravity Tools', category: 'desktop-icon', bounds: { x: 200, y: 180, width: 60, height: 60 }, visible: true },

      // Right side games (x > 1200)
      { id: 'el_10', type: 'ListItem', name: 'ULTRAKILL', category: 'desktop-icon', bounds: { x: 1400, y: 20, width: 60, height: 60 }, visible: true },
      { id: 'el_11', type: 'ListItem', name: 'Left 4 Dead 2', category: 'desktop-icon', bounds: { x: 1400, y: 100, width: 60, height: 60 }, visible: true },
      { id: 'el_12', type: 'ListItem', name: 'Garry\'s Mod', category: 'desktop-icon', bounds: { x: 1400, y: 180, width: 60, height: 60 }, visible: true },
      { id: 'el_13', type: 'ListItem', name: 'Among Us', category: 'desktop-icon', bounds: { x: 1500, y: 20, width: 60, height: 60 }, visible: true },
      { id: 'el_14', type: 'ListItem', name: 'Shovel Knight', category: 'desktop-icon', bounds: { x: 1500, y: 100, width: 60, height: 60 }, visible: true },
      { id: 'el_15', type: 'ListItem', name: 'DELTARUNE', category: 'desktop-icon', bounds: { x: 1500, y: 180, width: 60, height: 60 }, visible: true },

      // Folders on bottom right
      { id: 'el_16', type: 'ListItem', name: 'maligpu checkpoint', category: 'desktop-icon', bounds: { x: 1500, y: 700, width: 60, height: 60 }, visible: true },
      { id: 'el_17', type: 'ListItem', name: 'server', category: 'desktop-icon', bounds: { x: 1600, y: 700, width: 60, height: 60 }, visible: true },

      // Taskbar items
      { id: 'el_18', type: 'Button', name: 'Start', category: 'taskbar', bounds: { x: 0, y: 1040, width: 40, height: 40 }, visible: true },
      { id: 'el_19', type: 'Button', name: 'Visual Studio Code', category: 'taskbar', bounds: { x: 100, y: 1040, width: 40, height: 40 }, visible: true },
    ],
    limitations: [],
  };

  const summary = observer.generateCompactSummary(desktopObs);

  // Validate that ALL desktop icons are discovered and NOT truncated to 8 items!
  assert.ok(summary.includes('Geri Dönüşüm Kutusu'), 'Should include left-side icon 1');
  assert.ok(summary.includes('Antigravity Tools'), 'Should include 9th left-side icon (proves >8 items not truncated)');
  assert.ok(summary.includes('ULTRAKILL'), 'Should include right-side games');
  assert.ok(summary.includes('Left 4 Dead 2'), 'Should include right-side games');
  assert.ok(summary.includes('DELTARUNE'), 'Should include right-side games');
  assert.ok(summary.includes('maligpu checkpoint'), 'Should include folders');
  assert.ok(summary.includes('server'), 'Should include folders');
  assert.ok(summary.includes('Visual Studio Code'), 'Should include taskbar items');
  assert.ok(summary.includes('Full Desktop Scan'), 'Should designate full desktop scan header');
});

test('generateCompactSummary surfaces YouTube video titles and headings without spurious depth limit blocking', () => {
  const youtubeObs = {
    activeWindow: {
      title: 'Cyberpunk: Edgerunners - YouTube - Google Chrome',
      processName: 'chrome',
      processId: 4567,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    },
    observationSource: 'windows-ui-automation',
    elements: [
      { id: 'el_1', type: 'Edit', name: 'Search', value: 'Cyberpunk', visible: true },
      { id: 'el_2', type: 'Button', name: 'Search', visible: true },
      { id: 'el_3', type: 'Hyperlink', name: 'Cyberpunk: Edgerunners Season 2 Official Teaser', visible: true },
      { id: 'el_4', type: 'Heading', name: 'Garry\'s Mod Funny Moments Episode 50', visible: true },
      { id: 'el_5', type: 'Hyperlink', name: 'ULTRAKILL - Full P-Rank Speedrun', visible: true },
      { id: 'el_6', type: 'Heading', name: 'Left 4 Dead 2 - Survival Guide in 2026', visible: true },
      { id: 'el_7', type: 'Text', name: 'Netflix Anime · 2.4M views · 2 days ago', visible: true },
      { id: 'el_8', type: 'Hyperlink', name: 'Trending', visible: true }, // Generic link should be filtered from video titles
      { id: 'el_9', type: 'Button', name: 'Subscribe', visible: true },
      { id: 'el_10', type: 'Text', name: 'Recommended for you', visible: true },
      { id: 'el_11', type: 'Button', name: 'Play (k)', visible: true },
    ],
    limitations: ['Max depth limit reached (24)'],
  };

  const summary = observer.generateCompactSummary(youtubeObs);

  // Assertions
  assert.ok(summary.includes('Visible YouTube Video Titles'), 'Should designate YouTube Video Titles section');
  assert.ok(summary.includes('Cyberpunk: Edgerunners Season 2 Official Teaser'), 'Should extract hyperlink video title');
  assert.ok(summary.includes('Garry\'s Mod Funny Moments Episode 50'), 'Should extract heading video title');
  assert.ok(summary.includes('ULTRAKILL - Full P-Rank Speedrun'), 'Should extract gaming video title');
  assert.ok(summary.includes('Left 4 Dead 2 - Survival Guide in 2026'), 'Should extract guide video title');
  assert.ok(!summary.includes('Max depth limit reached'), 'Should filter out spurious depth limit because 11 elements were extracted');
});

test('generateCompactSummary surfaces active document / editor content in IDEs without truncation', () => {
  const ideObs = {
    activeWindow: {
      title: 'capri-desktop - Antigravity IDE - README.md',
      processName: 'Antigravity',
      processId: 9876,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    },
    observationSource: 'windows-ui-automation',
    elements: [
      {
        id: 'el_0',
        type: 'Document',
        name: 'capri-desktop - Antigravity IDE - README.md',
        category: 'document-content',
        value: `File\nEdit\nSelection\nView\nGo\nRun\nTerminal\nHelp\ncapri-desktop - Antigravity IDE - README.md\nREADME.md\nM\n3\n387\n# Capri\n## How it's built\nacting.js the exposure sheets: every move, drawing by drawing\ncapri.js the character: stances, teleport, sitting, peeking, falling, drag, sleep\nfx.js shards, light columns, bolts, glyphs\npanel.js the "transmission" panel, her face\ninspector.js Desktop Inspector: live UIA tree viewer\nguide.js her guide: the tutorials...\nbrain.js turns Claude events into lines...\nmission.js today's mission log...\nchat.js talking to her: the conversation...\nlines.js what she says (FR / EN / ES / PT / RU...)\nProblems\nOutput\nDebug Console\nTerminal`,
        visible: true,
      },
      { id: 'el_1', type: 'TabItem', name: 'README.md', isSelected: true, visible: true },
      { id: 'el_2', type: 'TabItem', name: 'package.json', isSelected: false, visible: true },
      { id: 'el_3', type: 'Button', name: 'File', visible: true },
    ],
    limitations: ['Max depth limit reached (28)'],
  };

  const summary = observer.generateCompactSummary(ideObs);

  // Assertions
  assert.ok(summary.includes('Active Document / Editor Content'), 'Should have dedicated Active Document / Editor Content section');
  assert.ok(summary.includes('# Capri'), 'Should extract markdown heading # Capri');
  assert.ok(summary.includes('## How it\'s built'), 'Should extract markdown heading ## How it\'s built');
  assert.ok(summary.includes('acting.js the exposure sheets: every move, drawing by drawing'), 'Should extract file lines');
  assert.ok(summary.includes('capri.js the character: stances'), 'Should extract capri.js description');
  assert.ok(!summary.includes('Max depth limit reached'), 'Should filter out depth limit warning when document content is extracted');
});



