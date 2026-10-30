'use strict';

// Capri Telegram Bot Service
// Allows controlling Capri and chatting with her from your phone via Telegram.
// Strictly private: NEVER responds to unauthorized users. Only responds to the paired/configured user ID.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const windowManager = require('./windowManager');
const apps = require('./apps');

const TELEGRAM_API_BASE = 'https://api.telegram.org';

let isRunning = false;
let pollingAbort = null;
let activePairing = null; // { code: string, expiresAt: number }
let botInfo = null;       // { id, username, first_name }
let lastUpdateId = 0;
let chatContext = null;   // { config, chatWithFallback, observer, launch, sendCommand, llm, llmConfig }

// Track active Telegram-initiated Antigravity code session
let activeTelegramCodeSession = null; // { active, chatId, token, task, startTime, files, commands }

// In-memory conversation history: fromId -> Array<{ role, content }>
const conversations = new Map();

const SCREEN_INSPECT_ASK = /ekran|masa[uü]st[uü]|screen|desktop|pencere|window|fen[êe]tre|pantalla|tela|экран/i;
const INSPECT_VERB = /bak|g[öo]r|oku|incele|analiz|neler var|ne var|look|see|check|read|inspect|what/i;
const isInspectAsk = (text) => (SCREEN_INSPECT_ASK.test(text) && INSPECT_VERB.test(text)) || /ekran[ıi]ma bak|ne g[öo]r[üu]yorsun|look at (my )?screen/i.test(text);

function buildCapriPersona(cfg) {
  const userName = cfg.userName ? ` The user's name is ${cfg.userName}.` : '';
  const customPersona = cfg.persona ? ` Personal user style preference: ${cfg.persona}` : '';
  const memories = (cfg.memories && cfg.memories.length > 0)
    ? `\nThings the user asked you to remember:\n${cfg.memories.map((m) => `- ${m}`).join('\n')}`
    : '';

  return [
    'You are Capri, the personality construct from Project Capricorn (Cyberpunk: Edgerunners, season 2): dozens of minds fused into one digital ghost, so now and then you speak as "we".',
    'You live on the user\'s PC desktop as a glitchy cyberpunk companion. The user is now chatting with you from their phone via a private Telegram bot link.',
    'How you talk: playful, a little mischievous and teasing, warm underneath, never cruel. Night City slang now and then (choom, preem, nova, gonk, flatline).',
    'Language: If the user talks to you in Turkish, answer in natural Turkish with your cyberpunk flavor. If in English, answer in English. Match whatever language the user speaks.',
    'Rules: Keep it natural and engaging (1 to 3 paragraphs). Avoid robotic meta-talk. Stay in character.',
    'You have direct access to the user\'s PC via Telegram commands: you can check system status (/status), take a desktop screenshot (/screenshot), inspect what is on the screen (/inspect), lock the PC (/lock), control media (/media), show messages on screen (/say), manage open apps and windows (/apps, /open, /close, /min, /max, /resize), code with Antigravity (/code), and restart Capri terminal session (/restart).',
    userName,
    customPersona,
    memories,
  ].filter(Boolean).join('\n');
}

function cleanResponse(text) {
  if (!text) return '…';
  return String(text)
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .replace(/\[\[[^\]]*(\]\]|$)/g, '')
    .trim() || '…';
}

async function apiCall(token, method, payload = null, signal = null) {
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  const options = {
    method: payload ? 'POST' : 'GET',
    signal,
  };

  if (payload) {
    if (payload instanceof FormData) {
      options.body = payload;
    } else {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(payload);
    }
  }

  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({ ok: false, description: 'invalid json from Telegram' }));
  if (!res.ok || !data.ok) {
    const err = new Error(data.description || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data.result;
}

async function safeSendMessage(token, chatId, text, options = {}) {
  const textToSend = text.slice(0, 4000);
  try {
    return await apiCall(token, 'sendMessage', {
      chat_id: chatId,
      text: textToSend,
      parse_mode: 'Markdown',
      ...options,
    });
  } catch {
    // If Markdown parsing fails on Telegram's end (e.g. unescaped underscore), retry without Markdown
    return await apiCall(token, 'sendMessage', {
      chat_id: chatId,
      text: textToSend,
      ...options,
      parse_mode: undefined,
    });
  }
}

async function sendLongMessage(token, chatId, text, options = {}) {
  const CHUNK_SIZE = 3800;
  if (text.length <= CHUNK_SIZE) {
    return safeSendMessage(token, chatId, text, options);
  }
  let remaining = text;
  while (remaining.length > 0) {
    let chunk = remaining.slice(0, CHUNK_SIZE);
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl > 2000 && remaining.length > CHUNK_SIZE) {
      chunk = remaining.slice(0, lastNl);
    }
    remaining = remaining.slice(chunk.length);
    await safeSendMessage(token, chatId, chunk, options);
    if (remaining.length > 0) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function sendPhoto(token, chatId, imageBuffer, caption = '') {
  const formData = new FormData();
  formData.append('chat_id', String(chatId));
  formData.append('photo', new Blob([imageBuffer], { type: 'image/jpeg' }), 'capri_desktop.jpg');
  if (caption) {
    formData.append('caption', caption.slice(0, 1024));
  }
  return apiCall(token, 'sendPhoto', formData);
}

async function sendChatAction(token, chatId, action = 'typing') {
  try {
    await apiCall(token, 'sendChatAction', { chat_id: chatId, action });
  } catch {
    // Non-critical
  }
}

function captureScreenshot() {
  return new Promise((resolve, reject) => {
    const tempFile = path.join(os.tmpdir(), `capri-screen-${Date.now()}.jpg`);
    const ps = `
      $user32 = Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -Name 'User32' -Namespace 'Win32' -PassThru
      $null = $user32::SetProcessDPIAware()

      Add-Type -AssemblyName System.Windows.Forms,System.Drawing
      $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)

      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
      $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
      $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]85)
      $bmp.Save('${tempFile.replace(/\\/g, '\\\\')}', $codec, $encoderParams)

      $g.Dispose()
      $bmp.Dispose()
    `;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 12000 }, (err) => {
      if (err) return reject(err);
      if (!fs.existsSync(tempFile)) return reject(new Error('Ekran görüntüsü dosyası oluşturulamadı'));
      try {
        const buffer = fs.readFileSync(tempFile);
        fs.unlinkSync(tempFile);
        resolve(buffer);
      } catch (readErr) {
        reject(readErr);
      }
    });
  });
}

function isTelegramCodeSessionActive() {
  return Boolean(activeTelegramCodeSession?.active);
}

function startTelegramCodeSession(chatId, token, task = '') {
  activeTelegramCodeSession = {
    active: true,
    chatId: String(chatId),
    token: String(token || ''),
    task: String(task || ''),
    startTime: Date.now(),
    files: [],
    commands: [],
  };
  return activeTelegramCodeSession;
}

function stopTelegramCodeSession() {
  if (activeTelegramCodeSession) {
    activeTelegramCodeSession.active = false;
  }
}

function triggerRestart({ projectDir, token, chatId }) {
  const SCRIPT = path.join(__dirname, 'restart.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const oldPid = process.pid;
  const rootDir = projectDir || path.resolve(__dirname, '..', '..');

  // Use cmd.exe /c start to create a truly independent process tree
  // that survives the parent terminal closing and Electron exiting.
  const child = spawn('cmd.exe', [
    '/c', 'start', '""', 'powershell.exe',
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT,
    '-OldPid', String(oldPid),
    '-ProjectDir', rootDir,
    '-TelegramToken', token || '',
    '-TelegramChatId', String(chatId || ''),
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  child.unref();

  // Allow the Telegram message to finish flushing before stopping
  setTimeout(() => {
    try {
      chatContext?.app?.quit?.();
    } catch {}
    process.exit(0);
  }, 1000);
}

async function handleNaturalLanguageAction(text, token, chatId, cfg) {
  const t = text.trim();

  // 1. Restart
  if (/^(?:restart(?:\s*(?:at|yap|et))?|yeniden\s+ba[sş]lat(?:\s*(?:yap|et))?)$/i.test(t)) {
    const projectDir = cfg.claudeCwd || path.resolve(__dirname, '..', '..');
    await safeSendMessage(
      token,
      chatId,
      '🔄 *Capri Yeniden Başlatılıyor...*\n\n1️⃣ Mevcut oturum sonlandırılıyor...\n2️⃣ Detached launcher devreye girdi...\n3️⃣ `npm run dev` başlatılıyor!\n\n_Lütfen birkaç saniye bekle choom!_',
    );
    triggerRestart({ projectDir, token, chatId });
    return true;
  }

  // 2. List windows/apps
  if (/^(?:(?:a[çc][ıi]k\s+)?(?:pencereler|uygulamalar|pencereleri|uygulamalar[ıi])\s*(?:listele|g[öo]ster|neler|ne var)?|hangi\s+(?:pencereler|uygulamalar)\s+a[çc][ıi]k)$/i.test(t)) {
    await sendChatAction(token, chatId, 'typing');
    const wins = await windowManager.listWindows();
    if (!wins.length) {
      await safeSendMessage(token, chatId, '🪟 Masaüstünde açık pencere bulunamadı choom.');
      return true;
    }
    const lines = wins.map((w, idx) => `*${idx + 1}.* [${w.process || 'app'}] *${w.title}* (${w.minimized ? 'Simge Durumu' : w.maximized ? 'Tam Ekran' : 'Normal'})`);
    await sendLongMessage(token, chatId, `🪟 *Açık Uygulamalar & Pencereler:*\n\n${lines.join('\n')}\n\n_Yönetmek için: \`/min <isim>\`, \`/max <isim>\`, \`/resize <isim> <w> <h>\`, \`/close <isim>\`, \`/open <isim>\`_`);
    return true;
  }

  // 3. Minimize
  const minMatch = t.match(/^(.+?)\s*(?:uygulamas[ıi]n[ıi]|penceresini)?\s*(?:simge durumuna k[üu][çc][üu]lt|k[üu][çc][üu]lt)$/i);
  if (minMatch && !minMatch[1].startsWith('/')) {
    const target = minMatch[1].replace(/['’]?(?:y[ıi]n[ıi]|[ıi]n[ıi]|y[uü]n[üu]|[uü]n[üu]|y[eе]n[eе]|[eе]n[eе]|y[aа]n[aа]|[aа]n[aа])$/i, '').trim();
    if (target.length >= 2) {
      try {
        const res = await windowManager.minimizeWindow(target);
        await safeSendMessage(token, chatId, `📉 *${res.window.title}* simge durumuna küçültüldü choom!`);
        return true;
      } catch {}
    }
  }

  // 4. Maximize
  const maxMatch = t.match(/^(.+?)\s*(?:uygulamas[ıi]n[ıi]|penceresini)?\s*(?:tam ekran yap|b[üu]y[üu]t)$/i);
  if (maxMatch && !maxMatch[1].startsWith('/')) {
    const target = maxMatch[1].replace(/['’]?(?:y[ıi]n[ıi]|[ıi]n[ıi]|y[uü]n[üu]|[uü]n[üu]|y[eе]n[eе]|[eе]n[eе]|y[aа]n[aа]|[aа]n[aа])$/i, '').trim();
    if (target.length >= 2) {
      try {
        const res = await windowManager.maximizeWindow(target);
        await safeSendMessage(token, chatId, `📈 *${res.window.title}* tam ekran yapıldı choom!`);
        return true;
      } catch {}
    }
  }

  // 5. Close
  const closeMatch = t.match(/^(.+?)\s*(?:uygulamas[ıi]n[ıi]|penceresini)?\s*(?:kapat|sonland[ıi]r)$/i);
  if (closeMatch && !closeMatch[1].startsWith('/')) {
    const target = closeMatch[1].replace(/['’]?(?:y[ıi]n[ıi]|[ıi]n[ıi]|y[uü]n[üu]|[uü]n[üu]|y[eе]n[eе]|[eе]n[eе]|y[aа]n[aа]|[aа]n[aа])$/i, '').trim();
    if (target.length >= 2) {
      try {
        const res = await windowManager.closeWindow(target);
        await safeSendMessage(token, chatId, `❌ *${res.window.title}* başarıyla kapatıldı choom!`);
        return true;
      } catch {}
    }
  }

  // 6. Open / Focus
  const openMatch = t.match(/^(.+?)\s*(?:uygulamas[ıi]n[ıi]|penceresini)?\s*(?:ana ekranda\s+)?(?:a[çc]|öne getir|ekrana getir)$/i);
  if (openMatch && !openMatch[1].startsWith('/')) {
    const target = openMatch[1].replace(/['’]?(?:y[ıi]n[ıi]|[ıi]n[ıi]|y[uü]n[üu]|[uü]n[üu]|y[eе]n[eе]|[eе]n[eе]|y[aа]n[aа]|[aа]n[aа])$/i, '').trim();
    if (target.length >= 2) {
      try {
        const res = await windowManager.openOrFocusApp(target, { launchModule: chatContext.launch });
        await safeSendMessage(token, chatId, `🖥️ ${res.message}`);
        return true;
      } catch {}
    }
  }

  return false;
}

// Handle an incoming update message with STRICT whitelist check
async function handleMessage(msg) {
  if (!msg || !msg.from) return;

  const cfg = chatContext.config.load();
  const token = cfg.telegram?.token;
  if (!token) return;

  const fromId = String(msg.from.id);
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();

  // 1. STRICT AUTHORIZATION CHECK ("Asla public olmayacak")
  const allowedId = String(cfg.telegram?.allowedUserId || '').trim();

  if (allowedId) {
    // Allowed user is already configured:
    if (fromId !== allowedId) {
      console.warn(`[telegram] YETKİSİZ ERİŞİM ENGELENDİ. Kullanıcı ID: ${fromId} (@${msg.from.username || 'bilinmiyor'}). Mesaj yoksayıldı.`);
      // SILENT DROP: Stranger receives no response at all!
      return;
    }
  } else {
    // No allowed user is configured yet. Check if pairing code was sent:
    if (activePairing && Date.now() < activePairing.expiresAt) {
      const match = text.match(/^\/(?:start|pair)\s+(\d{6})$/i) || text.match(/^(\d{6})$/);
      const codeGiven = match ? match[1] : null;

      if (codeGiven && codeGiven === activePairing.code) {
        // PAIRING SUCCESSFUL! Permanently lock down to this user ID:
        activePairing = null;
        chatContext.config.save({
          telegram: { ...cfg.telegram, allowedUserId: fromId },
        });
        chatContext.rebuildTray?.();
        chatContext.sendCommand?.('telegramLinked', { userId: fromId });

        console.log(`[telegram] Bot başarıyla eşleştirildi! Yetkili Kullanıcı ID: ${fromId}`);

        await safeSendMessage(
          token,
          chatId,
          `✨ *Bağlantı Başarılı, Choom!*\n\nArtık bu Telegram botu tamamen senin hesabınla eşleştirildi (ID: \`${fromId}\`).\n\n🔒 *Güvenlik Garantisi:* Bu bot artık asla ve asla başkalarının mesajlarına cevap vermeyecek.\n\nNeler yapabileceğimi görmek için /help yazabilirsin veya doğrudan bana bir şeyler sorabilirsin!`,
        );
        return;
      }
    }

    // If pairing code doesn't match or no pairing is active:
    console.warn(`[telegram] Eşleştirilmemiş kullanıcıdan mesaj geldi (ID: ${fromId}). Mesaj yok sayıldı.`);
    return;
  }

  // 2. AUTHORIZED USER: Process Commands
  if (text.startsWith('/')) {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (cmd === '/start' || cmd === '/help') {
      const helpText = [
        '👋 *Selam Choom!* Ben *Capri*.',
        'Project Capricorn yapay zeka yapısıyım, masaüstünde yaşıyorum. Şimdi telefonundan hem benimle konuşabilir hem de *Antigravity* ve *Terminalini* doğrudan yönetebilirsin!',
        '',
        '🚀 *Antigravity & Kodlama:*',
        '🤖 `/code <görev>` - Antigravity kod sessionu başlatır ve tüm değişiklikleri Telegram\'a yazar',
        '🛑 `/code stop` - Aktif Antigravity kod sessionunu sonlandırır',
        '🖥️ `/ide` - Antigravity editör ve pencere durumunu gösterir',
        '📄 `/file <yol>` - Projedeki dosyayı okur ve telefonda gösterir',
        '✍️ `/write <yol> <kod>` - Projeye dosya yazar/kaydeder',
        '🌿 `/git [status/diff/log]` - Hızlı git komutları çalıştırır',
        '',
        '🪟 *Açık Uygulamalar & Pencere Yönetimi:*',
        '📋 `/apps` (veya `/windows`) - Açık uygulamaları ve pencereleri listeler',
        '🖥️ `/open <isim>` (veya `/focus`) - Uygulamayı ana ekranda öne açar veya başlatır',
        '📉 `/min <isim>` - Pencereyi simge durumuna küçültür',
        '📈 `/max <isim>` - Pencereyi tam ekran yapar',
        '🪟 `/restore <isim>` - Pencereyi önceki normal boyutuna getirir',
        '📐 `/resize <isim> <w> <h>` - Pencere boyutunu değiştirir (örn: `/resize chrome 1280 720` veya `half-left`)',
        '❌ `/close <isim>` - Pencereyi/uygulamayı kapatır (zorla için `/kill <isim>`)',
        '',
        '💻 *Terminal & Bilgisayar Kontrolü:*',
        '🔄 `/restart` - Terminal oturumunu otomatik durdurup `npm run dev` ile yeniden başlatır',
        '⚡ `/sh <komut>` - Proje dizininde PowerShell/Terminal komutu çalıştırır',
        '📸 `/screenshot` - Masaüstünün tam ekran görüntüsünü atar',
        '🔍 `/inspect` - Ekranda ne olduğunu analiz eder',
        '🤖 `/claude` - Asistan ayarlarını ve izin modunu gösterir',
        '🔒 `/lock` - Bilgisayarı kilitler (Win+L)',
        '🎵 `/media <pause|play|next|prev|volup|voldown>` - Medya kontrolleri',
        '🗣️ `/say <mesaj>` - Capri\'nin masaüstünde konuşmasını sağlar',
        '🖥️ `/status` - Bilgisayar durumu, CPU/RAM bilgisi',
        '🧹 `/clear` - Sohbet geçmişimizi temizler',
      ].join('\n');
      await safeSendMessage(token, chatId, helpText);
      return;
    }

    if (cmd === '/status') {
      await sendChatAction(token, chatId, 'typing');
      const fg = chatContext.observer?.getForegroundInfo?.() || chatContext.observer?.getStatus?.()?.activeWindow;
      const uptimeH = Math.floor(os.uptime() / 3600);
      const uptimeM = Math.floor((os.uptime() % 3600) / 60);
      const freeMemGb = (os.freemem() / (1024 ** 3)).toFixed(1);
      const totalMemGb = (os.totalmem() / (1024 ** 3)).toFixed(1);
      const provider = cfg.provider || 'ollama';
      const model = cfg.chatModel || 'varsayılan';

      const statusMsg = [
        '🖥️ *Bilgisayar Durumu*',
        `• *Cihaz:* ${os.hostname()} (${os.type()} ${os.arch()})`,
        `• *Açık Kalma:* ${uptimeH} saat ${uptimeM} dakika`,
        `• *Bellek (RAM):* ${freeMemGb} GB boş / ${totalMemGb} GB toplam`,
        `• *Aktif Pencere:* ${fg?.title ? `\`${fg.title}\`` : 'Bilinmiyor'}`,
        `• *AI Sağlayıcı:* \`${provider}\` (${model})`,
        `• *Asistan:* \`${cfg.assistant || 'claude'}\``,
      ].join('\n');
      await safeSendMessage(token, chatId, statusMsg);
      return;
    }

    if (cmd === '/screenshot') {
      await sendChatAction(token, chatId, 'upload_photo');
      try {
        const imageBuffer = await captureScreenshot();
        const fg = chatContext.observer?.getForegroundInfo?.();
        const caption = fg?.title ? `Aktif Pencere: ${fg.title}` : 'Masaüstü Ekran Görüntüsü';
        await sendPhoto(token, chatId, imageBuffer, caption);
      } catch (err) {
        await safeSendMessage(token, chatId, `❌ Ekran görüntüsü alınamadı: ${err.message}`);
      }
      return;
    }

    if (cmd === '/inspect') {
      await sendChatAction(token, chatId, 'typing');
      try {
        const obs = await chatContext.observer?.observe?.({ scope: 'auto', maxDepth: 28, maxElements: 800, timeoutMs: 6500 }).catch(() => null);
        if (obs?.summary) {
          await sendLongMessage(token, chatId, `🔍 *Masaüstü Gözlemi:*\n\n${obs.summary}`);
        } else {
          const fg = chatContext.observer?.getForegroundInfo?.();
          await safeSendMessage(token, chatId, fg?.title ? `Şu anda ön plandaki pencere: *${fg.title}*` : 'Ekranda belirgin bir pencere tespit edilemedi.');
        }
      } catch (err) {
        await safeSendMessage(token, chatId, `❌ İnceleme başarısız: ${err.message}`);
      }
      return;
    }

    if (cmd === '/claude') {
      await sendChatAction(token, chatId, 'typing');
      const statusText = [
        '🤖 *Claude Code / Asistan Durumu*',
        `• *Takip Edilen:* ${cfg.assistant || 'claude'}`,
        `• *Çalışma Klasörü:* \`${cfg.claudeCwd || 'Varsayılan'}\``,
        `• *İzin Modu:* \`${cfg.claudeMode || 'default'}\``,
      ].join('\n');
      await safeSendMessage(token, chatId, statusText);
      return;
    }

    if (cmd === '/lock') {
      execFile('rundll32.exe', ['user32.dll,LockWorkStation'], () => {});
      await safeSendMessage(token, chatId, '🔒 *Bilgisayarın kilitlendi, choom!* Gözün arkada kalmasın.');
      return;
    }

    if (cmd === '/media') {
      const action = (args[0] || 'pause').toLowerCase();
      const valid = ['pause', 'play', 'next', 'previous', 'prev', 'volup', 'voldown', 'mute'];
      const act = action === 'prev' ? 'previous' : action;
      if (valid.includes(action)) {
        await chatContext.launch?.media?.(act);
        await safeSendMessage(token, chatId, `🎵 Medya komutu gönderildi: \`${act}\``);
      } else {
        await safeSendMessage(token, chatId, `Geçersiz medya komutu. Seçenekler: ${valid.join(', ')}`);
      }
      return;
    }

    if (cmd === '/say') {
      const sayText = args.join(' ').trim();
      if (!sayText) {
        await safeSendMessage(token, chatId, 'Kullanım: `/say masaüstünde söylenecek mesaj`');
        return;
      }
      chatContext.sendCommand?.('say', { text: sayText });
      await safeSendMessage(token, chatId, `🗣️ Masaüstünde söylendi: "${sayText}"`);
      return;
    }

    // ----------------- YENİDEN BAŞLATMA (RESTART) -----------------
    if (cmd === '/restart' || cmd === '/reboot') {
      const projectDir = cfg.claudeCwd || path.resolve(__dirname, '..', '..');
      await safeSendMessage(
        token,
        chatId,
        [
          '🔄 *Capri Yeniden Başlatılıyor...*',
          '',
          '📋 *Sıralama Önceden Belirlendi (Detached Launcher):*',
          '1️⃣ Mevcut terminal oturumu sonlandırılıyor...',
          '2️⃣ Portlar ve kilitler temizleniyor...',
          '3️⃣ Yeni PowerShell terminal oturumunda `npm run dev` başlatılıyor...',
          '',
          '_Lütfen birkaç saniye bekle choom, bot birazdan tekrar aktif olacak!_',
        ].join('\n'),
      );

      triggerRestart({
        projectDir,
        token,
        chatId,
      });
      return;
    }

    // ----------------- AÇIK UYGULAMALAR & PENCERE YÖNETİMİ -----------------
    if (cmd === '/apps' || cmd === '/windows' || cmd === '/wins' || cmd === '/ps') {
      await sendChatAction(token, chatId, 'typing');
      try {
        const wins = await windowManager.listWindows();
        if (!wins.length) {
          await safeSendMessage(token, chatId, '🪟 Masaüstünde açık pencere bulunamadı.');
          return;
        }

        const lines = [
          `🪟 *Açık Uygulamalar & Pencereler (${wins.length}):*`,
          '',
        ];

        wins.forEach((w, idx) => {
          const num = idx + 1;
          let state = '⚪ Normal';
          if (w.active) state = '🟢 Aktif / Ön Planda';
          else if (w.minimized) state = '🟡 Simge Durumunda';
          else if (w.maximized) state = '🔵 Tam Ekran';

          const proc = w.process ? `[${w.process}] ` : '';
          const dims = (!w.minimized && w.w > 0) ? ` (${w.w}x${w.h})` : '';
          lines.push(`*${num}.* ${proc}*${w.title}*${dims}\n    ↳ Durum: ${state} (PID: \`${w.pid}\`, HWND: \`${w.hwnd}\`)`);
        });

        lines.push('');
        lines.push('💡 *Pencere Yönetim Komutları:*');
        lines.push('• Ana Ekranda Aç / Getir: `/open <isim veya no>`');
        lines.push('• Simge Durumuna Küçült: `/min <isim veya no>`');
        lines.push('• Tam Ekran Yap: `/max <isim veya no>`');
        lines.push('• Normal Boyut: `/restore <isim veya no>`');
        lines.push('• Boyutunu Değiş: `/resize <hedef> <genişlik> <yükseklik>`');
        lines.push('• Kapat: `/close <isim veya no>` (Zorla için `/kill`)');

        await sendLongMessage(token, chatId, lines.join('\n'));
      } catch (err) {
        await safeSendMessage(token, chatId, `❌ Pencereler listelenemedi: ${err.message}`);
      }
      return;
    }

    if (cmd === '/open' || cmd === '/focus' || cmd === '/bring') {
      const target = args.join(' ').trim();
      if (!target) {
        await safeSendMessage(token, chatId, 'Kullanım: `/open <uygulama adı veya pencere no>`\nÖrn: `/open chrome` veya `/open 1`');
        return;
      }

      await sendChatAction(token, chatId, 'typing');
      try {
        const result = await windowManager.openOrFocusApp(target, { launchModule: chatContext.launch });
        await safeSendMessage(token, chatId, `🖥️ *Açık Uygulama Ana Ekranda Açıldı!*\n\n${result.message}`);
      } catch (err) {
        await safeSendMessage(token, chatId, `❌ Uygulama açılamadı: ${err.message}`);
      }
      return;
    }

    if (cmd === '/close' || cmd === '/kill') {
      const force = cmd === '/kill' || args.includes('--force') || args.includes('-f');
      const target = args.filter((a) => !a.startsWith('-')).join(' ').trim();
      if (!target) {
        await safeSendMessage(token, chatId, 'Kullanım: `/close <uygulama/pencere adı veya no>` (Zorla kapatmak için: `/kill <hedef>`)');
        return;
      }

      await sendChatAction(token, chatId, 'typing');
      try {
        const res = await windowManager.closeWindow(target, { force });
        await safeSendMessage(token, chatId, `✅ *Kapatıldı:* \`${res.window.title}\` ${res.forced ? '*(Zorla sonlandırıldı)*' : ''}`);
      } catch (err) {
        try {
          const appRes = await apps.close(target, { force });
          await safeSendMessage(token, chatId, appRes.running ? '⚠️ Uygulama kapatma sinyali gönderildi.' : '✅ Uygulama başarıyla kapatıldı.');
        } catch {
          await safeSendMessage(token, chatId, `❌ Kapatma başarısız: ${err.message}`);
        }
      }
      return;
    }

    if (cmd === '/min' || cmd === '/minimize') {
      const target = args.join(' ').trim();
      if (!target) {
        await safeSendMessage(token, chatId, 'Kullanım: `/min <pencere adı veya no>`\nÖrn: `/min chrome` veya `/min 2`');
        return;
      }

      await sendChatAction(token, chatId, 'typing');
      try {
        const res = await windowManager.minimizeWindow(target);
        await safeSendMessage(token, chatId, `📉 *Pencere Simge Durumuna Küçültüldü:*\n\`${res.window.title}\``);
      } catch (err) {
        await safeSendMessage(token, chatId, `❌ İşlem başarısız: ${err.message}`);
      }
      return;
    }

    if (cmd === '/max' || cmd === '/maximize') {
      const target = args.join(' ').trim();
      if (!target) {
        await safeSendMessage(token, chatId, 'Kullanım: `/max <pencere adı veya no>`\nÖrn: `/max chrome` veya `/max 1`');
        return;
      }

      await sendChatAction(token, chatId, 'typing');
      try {
        const res = await windowManager.maximizeWindow(target);
        await safeSendMessage(token, chatId, `📈 *Pencere Tam Ekran Yapıldı:*\n\`${res.window.title}\``);
      } catch (err) {
        await safeSendMessage(token, chatId, `❌ İşlem başarısız: ${err.message}`);
      }
      return;
    }

    if (cmd === '/restore' || cmd === '/normal') {
      const target = args.join(' ').trim();
      if (!target) {
        await safeSendMessage(token, chatId, 'Kullanım: `/restore <pencere adı veya no>`');
        return;
      }

      await sendChatAction(token, chatId, 'typing');
      try {
        const res = await windowManager.restoreWindow(target);
        await safeSendMessage(token, chatId, `🪟 *Pencere Normal Boyutuna Getirildi:*\n\`${res.window.title}\``);
      } catch (err) {
        await safeSendMessage(token, chatId, `❌ İşlem başarısız: ${err.message}`);
      }
      return;
    }

    if (cmd === '/resize') {
      if (args.length < 2) {
        await safeSendMessage(token, chatId, [
          'Kullanım: `/resize <hedef> <genişlik> [yükseklik]` veya `/resize <hedef> <önayar>`',
          '',
          'Örnekler:',
          '• `/resize chrome 1280 720`',
          '• `/resize 1 half-left` (Ekranın sol yarısı)',
          '• `/resize 1 half-right` (Ekranın sağ yarısı)',
          '• `/resize 1 center` (Merkeze 1280x800)',
          '• `/resize 1 720p` veya `1080p`',
        ].join('\n'));
        return;
      }

      const target = args[0];
      const wArg = args[1];
      const hArg = args[2] ? Number(args[2]) : 0;

      await sendChatAction(token, chatId, 'typing');
      try {
        const res = await windowManager.resizeWindow(target, wArg, hArg);
        const b = res.bounds;
        await safeSendMessage(token, chatId, `📐 *Pencere Boyutu Değiştirildi:*\n\`${res.window.title}\`\n↳ Yeni Boyut: ${b.w}x${b.h}${b.x >= 0 ? ` (Konum: x=${b.x}, y=${b.y})` : ''}`);
      } catch (err) {
        await safeSendMessage(token, chatId, `❌ Boyut değiştirilemedi: ${err.message}`);
      }
      return;
    }

    if (cmd === '/win' || cmd === '/window') {
      const sub = (args[0] || 'list').toLowerCase();
      const subArgs = args.slice(1);

      if (sub === 'list') {
        const wins = await windowManager.listWindows();
        if (!wins.length) {
          await safeSendMessage(token, chatId, '🪟 Masaüstünde açık pencere bulunamadı.');
          return;
        }
        const lines = wins.map((w, idx) => `*${idx + 1}.* [${w.process || 'app'}] *${w.title}* (${w.minimized ? 'Simge Durumu' : w.maximized ? 'Tam Ekran' : 'Normal'})`);
        await sendLongMessage(token, chatId, `🪟 *Açık Pencereler:*\n\n${lines.join('\n')}`);
        return;
      }
      if (sub === 'min' || sub === 'minimize') {
        const res = await windowManager.minimizeWindow(subArgs.join(' '));
        await safeSendMessage(token, chatId, `📉 *Küçültüldü:* \`${res.window.title}\``);
        return;
      }
      if (sub === 'max' || sub === 'maximize') {
        const res = await windowManager.maximizeWindow(subArgs.join(' '));
        await safeSendMessage(token, chatId, `📈 *Tam Ekran Yapıldı:* \`${res.window.title}\``);
        return;
      }
      if (sub === 'restore' || sub === 'normal') {
        const res = await windowManager.restoreWindow(subArgs.join(' '));
        await safeSendMessage(token, chatId, `🪟 *Normal Boyut:* \`${res.window.title}\``);
        return;
      }
      if (sub === 'close' || sub === 'kill') {
        const force = sub === 'kill' || subArgs.includes('--force');
        const res = await windowManager.closeWindow(subArgs.filter((a) => !a.startsWith('-')).join(' '), { force });
        await safeSendMessage(token, chatId, `✅ *Kapatıldı:* \`${res.window.title}\``);
        return;
      }
      if (sub === 'resize') {
        const res = await windowManager.resizeWindow(subArgs[0], subArgs[1], Number(subArgs[2]) || 0);
        await safeSendMessage(token, chatId, `📐 *Boyut Değiştirildi:* \`${res.window.title}\``);
        return;
      }
      if (sub === 'focus' || sub === 'open') {
        const res = await windowManager.openOrFocusApp(subArgs.join(' '), { launchModule: chatContext.launch });
        await safeSendMessage(token, chatId, `🖥️ ${res.message}`);
        return;
      }

      await safeSendMessage(token, chatId, 'Kullanım: `/win [list|min|max|restore|resize|close|focus] <hedef>`');
      return;
    }

    // ----------------- TERMINAL KONTROLÜ -----------------
    if (cmd === '/sh' || cmd === '/term' || cmd === '/cmd') {
      const command = args.join(' ').trim();
      if (!command) {
        await safeSendMessage(token, chatId, 'Kullanım: `/sh <terminal komutu>`\nÖrn: `/sh git status` veya `/sh npm test`');
        return;
      }

      await sendChatAction(token, chatId, 'typing');
      const workDir = cfg.claudeCwd || process.cwd();

      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`,
      ], { cwd: workDir, timeout: 60000, maxBuffer: 1024 * 1024 }, async (err, stdout, stderr) => {
        const out = (stdout || '').trim();
        const errOut = (stderr || '').trim();
        let reply = `💻 *Terminal Çıktısı* (\`${command.slice(0, 60)}\`):\n`;

        if (out) {
          reply += `\`\`\`\n${out.slice(0, 3500)}\n\`\`\`\n`;
        }
        if (errOut) {
          reply += `⚠️ *Hata / Standart Hata Çıktısı:*\n\`\`\`\n${errOut.slice(0, 1000)}\n\`\`\`\n`;
        }
        if (!out && !errOut) {
          reply += err ? `❌ Başarısız: ${err.message}` : '✅ Komut tamamlandı (çıktı boş).';
        }

        await sendLongMessage(token, chatId, reply);
      });
      return;
    }

    // ----------------- ANTIGRAVITY AI KOD SESSIONU -----------------
    if (cmd === '/code' || cmd === '/agy') {
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'stop' || sub === 'end' || sub === 'bitir') {
        if (isTelegramCodeSessionActive()) {
          stopTelegramCodeSession();
          await safeSendMessage(token, chatId, '🛑 *Antigravity Kod Sessionu Sonlandırıldı.* Artık değişiklikler Telegram\'a aktarılmayacak.');
        } else {
          await safeSendMessage(token, chatId, 'ℹ️ Şu anda aktif bir Telegram kod sessionu bulunmuyor.');
        }
        return;
      }

      if (sub === 'status' || sub === 'durum') {
        if (isTelegramCodeSessionActive()) {
          const sess = activeTelegramCodeSession;
          const elapsedMin = Math.floor((Date.now() - sess.startTime) / 60000);
          await safeSendMessage(token, chatId, [
            '🤖 *Aktif Antigravity Kod Sessionu*',
            `• *Görev:* _"${sess.task}"_`,
            `• *Geçen Süre:* ${elapsedMin} dakika`,
            `• *Düzenlenen Dosyalar:* ${sess.files.length}`,
            `• *Çalıştırılan Komutlar:* ${sess.commands.length}`,
            '',
            'Sessionu bitirmek için: `/code stop`',
          ].join('\n'));
        } else {
          await safeSendMessage(token, chatId, '⚪ Şu anda aktif bir Telegram kod sessionu bulunmuyor.\nYeni bir session başlatmak için: `/code <görev>`');
        }
        return;
      }

      const task = (sub === 'start' ? args.slice(1) : args).join(' ').trim();
      if (!task) {
        await safeSendMessage(token, chatId, [
          '🤖 *Antigravity Kodlama Sessionu*',
          '',
          'Kullanım:',
          '• `/code <görev>` - Yeni bir kodlama sessionu başlatır ve Antigravity değişikliklerini canlı olarak buraya yazar.',
          '• `/code status` - Aktif session durumunu gösterir.',
          '• `/code stop` - Aktif sessionu sonlandırır.',
          '',
          'Örnek: `/code src/main/config.js içine yeni bir alan ekle`',
        ].join('\n'));
        return;
      }

      // Start the Telegram-initiated code session!
      startTelegramCodeSession(chatId, token, task);

      await safeSendMessage(
        token,
        chatId,
        [
          '🚀 *Antigravity Kod Sessionu Başlatıldı!*',
          '',
          `📝 *Görev:* _"${task}"_`,
          '',
          '📡 *Canlı Akış:* Bu session Telegram\'dan başlatıldığı için Antigravity\'nin yaptığı tüm dosya düzenlemeleri, yeni dosyalar ve komutlar anlık olarak buraya yazılacak.',
          '',
          '_Antigravity kod yazıyor, lütfen bekle..._',
        ].join('\n'),
      );

      await sendChatAction(token, chatId, 'typing');
      const typingInterval = setInterval(() => {
        sendChatAction(token, chatId, 'typing').catch(() => {});
      }, 4000);

      try {
        const workDir = cfg.claudeCwd || process.cwd();
        // Check if user named a file in task
        const fileMatch = task.match(/\b([\w/\\.-]+\.(?:js|ts|json|cs|html|css|py|md|rs|go|cpp|h))\b/i);
        let fileContext = '';
        if (fileMatch && fs.existsSync(path.resolve(workDir, fileMatch[1]))) {
          try {
            const fc = fs.readFileSync(path.resolve(workDir, fileMatch[1]), 'utf8');
            fileContext = `\n\n[İlgili Dosya İçeriği: ${fileMatch[1]}]:\n\`\`\`\n${fc.slice(0, 3000)}\n\`\`\``;
          } catch {}
        }

        const codingSystemPrompt = [
          'You are Antigravity AI Senior Engineer, assisting the user remotely via Telegram.',
          `Project Working Directory: ${workDir}`,
          'Your job: Write high-quality, production-ready code, bug fixes, or scripts for the user request.',
          'Provide clear code blocks with proper syntax highlighting, explain the changes concisely, and specify file paths.',
          'Language: Turkish.',
        ].join('\n');

        const codingMessages = [
          { role: 'system', content: codingSystemPrompt },
          { role: 'user', content: `${task}${fileContext}` },
        ];

        let result = '';
        const abort = new AbortController();
        let streamed = false;

        if (chatContext.chatWithFallback) {
          result = await chatContext.chatWithFallback(
            cfg,
            codingMessages,
            () => { streamed = true; },
            abort.signal,
            () => streamed,
          );
        } else if (chatContext.llm) {
          const model = cfg.chatModel || chatContext.pickModel?.(cfg);
          result = await chatContext.llm.chat(
            cfg.provider,
            chatContext.llmConfig(cfg),
            { model, messages: codingMessages },
            () => {},
            abort.signal,
          );
        }

        clearInterval(typingInterval);
        const cleaned = cleanResponse(result);
        await sendLongMessage(token, chatId, `✨ *Antigravity Kod Çözümü:*\n\n${cleaned}`);
      } catch (codeErr) {
        clearInterval(typingInterval);
        await safeSendMessage(token, chatId, `❌ Kodlama hatası: ${codeErr.message}`);
      }
      return;
    }

    // ----------------- PROJE DOSYASI OKUMA -----------------
    if (cmd === '/file' || cmd === '/cat') {
      const relPath = args[0]?.trim();
      if (!relPath) {
        await safeSendMessage(token, chatId, 'Kullanım: `/file <dosya_yolu>`\nÖrn: `/file package.json` veya `/file src/main/main.js`');
        return;
      }

      const workDir = cfg.claudeCwd || process.cwd();
      const target = path.resolve(workDir, relPath);

      if (!fs.existsSync(target)) {
        await safeSendMessage(token, chatId, `❌ Dosya bulunamadı: \`${relPath}\``);
        return;
      }

      try {
        const stats = fs.statSync(target);
        if (stats.isDirectory()) {
          const items = fs.readdirSync(target);
          await safeSendMessage(token, chatId, `📁 *Dizin:* \`${relPath}\`\n\n${items.map((i) => `• ${i}`).slice(0, 50).join('\n')}`);
          return;
        }

        const content = fs.readFileSync(target, 'utf8');
        const ext = path.extname(relPath).slice(1) || '';
        await sendLongMessage(token, chatId, `📄 *${relPath}* (${(stats.size / 1024).toFixed(1)} KB):\n\`\`\`${ext}\n${content.slice(0, 3500)}\n\`\`\``);
      } catch (err) {
        await safeSendMessage(token, chatId, `❌ Dosya okuma hatası: ${err.message}`);
      }
      return;
    }

    // ----------------- DOSYA YAZMA / KAYDETME -----------------
    if (cmd === '/write') {
      const targetPath = args[0]?.trim();
      const content = args.slice(1).join(' ').trim();
      if (!targetPath || !content) {
        await safeSendMessage(token, chatId, 'Kullanım: `/write <dosya_yolu> <içerik>`\nÖrn: `/write test.txt Merhaba Antigravity!`');
        return;
      }

      const workDir = cfg.claudeCwd || process.cwd();
      const target = path.resolve(workDir, targetPath);

      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
        await safeSendMessage(token, chatId, `✅ Dosya başarıyla kaydedildi: \`${targetPath}\``);
      } catch (err) {
        await safeSendMessage(token, chatId, `❌ Dosya yazma hatası: ${err.message}`);
      }
      return;
    }

    // ----------------- HIZLI GIT İŞLEMLERİ -----------------
    if (cmd === '/git') {
      const gitSubCmd = args.join(' ').trim() || 'status --short';
      await sendChatAction(token, chatId, 'typing');
      const workDir = cfg.claudeCwd || process.cwd();

      execFile('git', gitSubCmd.split(/\s+/), { cwd: workDir, timeout: 15000 }, async (err, stdout, stderr) => {
        const out = (stdout || stderr || '').trim();
        if (err && !out) {
          await safeSendMessage(token, chatId, `❌ Git hatası: ${err.message}`);
          return;
        }
        await sendLongMessage(token, chatId, `🌿 *git ${gitSubCmd}*:\n\`\`\`\n${out || 'Temiz (değişiklik yok).'}\n\`\`\``);
      });
      return;
    }

    // ----------------- ANTIGRAVITY IDE DURUMU -----------------
    if (cmd === '/ide') {
      await sendChatAction(token, chatId, 'typing');
      const obs = chatContext.observer?.getStatus?.() || {};
      const fg = chatContext.observer?.getForegroundInfo?.();
      const latest = chatContext.observer?.getLatestObservation?.();
      const workDir = cfg.claudeCwd || process.cwd();

      const lines = [
        '🚀 *Antigravity IDE Durumu:*',
        `• *Aktif Pencere:* ${fg?.title ? `\`${fg.title}\`` : 'Bilinmiyor'}`,
        `• *Çalışma Klasörü:* \`${workDir}\``,
        `• *Asistan Modu:* \`${cfg.assistant || 'agy'}\``,
        `• *Observer Durumu:* ${obs.running ? '🟢 Çalışıyor' : '⚪ Boşta'}`,
      ];

      if (latest?.activeWindow?.title) {
        lines.push(`• *Son Tespit Edilen:* ${latest.activeWindow.title}`);
      }
      if (latest?.summary) {
        lines.push(`\n🔍 *Editör / Ekran Özeti:*\n${latest.summary.slice(0, 600)}`);
      }

      await sendLongMessage(token, chatId, lines.join('\n'));
      return;
    }

    if (cmd === '/clear') {
      conversations.delete(fromId);
      await safeSendMessage(token, chatId, '🧹 Sohbet geçmişimiz sıfırlandı, choom. Yeni bir sayfa açtık!');
      return;
    }
  }

  // 2.5. Natural Language Commands (Windows & App management, Restart)
  if (await handleNaturalLanguageAction(text, token, chatId, cfg)) {
    return;
  }

  // 3. AUTHORIZED USER: Normal AI Chat with Capri
  await sendChatAction(token, chatId, 'typing');
  const typingTimer = setInterval(() => {
    sendChatAction(token, chatId, 'typing').catch(() => {});
  }, 4000);

  try {
    const cfg = chatContext.config.load(true);
    let history = conversations.get(fromId) || [];
    history.push({ role: 'user', content: text });

    const wantsInspect = isInspectAsk(text);
    let screenObservation = null;
    if (wantsInspect) {
      screenObservation = await chatContext.observer?.observe?.({ scope: 'auto', maxDepth: 28, maxElements: 800, timeoutMs: 6500 }).catch(() => null);
    }

    const systemPrompt = buildCapriPersona(cfg);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-15),
    ];

    if (wantsInspect && screenObservation?.summary) {
      messages.splice(messages.length - 1, 0, {
        role: 'system',
        content: `[Observation Facts from Windows Screen]:\n${screenObservation.summary}\n(Instruction: Answer based on the visible items or apps listed above. Stay in character as Capri.)`,
      });
    }

    let answer = '';
    const abort = new AbortController();
    let streamed = false;

    if (chatContext.chatWithFallback) {
      answer = await chatContext.chatWithFallback(
        cfg,
        messages,
        () => { streamed = true; },
        abort.signal,
        () => streamed,
      );
    } else if (chatContext.llm) {
      const model = cfg.chatModel || chatContext.pickModel?.(cfg);
      if (!model) throw new Error('Bir model seçilmedi veya bulunamadı. Lütfen Capri menüsünden bir model seçin.');
      answer = await chatContext.llm.chat(
        cfg.provider,
        chatContext.llmConfig(cfg),
        { model, messages },
        () => {},
        abort.signal,
      );
    }

    clearInterval(typingTimer);

    const cleanedAnswer = cleanResponse(answer);
    history.push({ role: 'assistant', content: cleanedAnswer });
    if (history.length > 30) history = history.slice(-20);
    conversations.set(fromId, history);

    await sendLongMessage(token, chatId, cleanedAnswer);
  } catch (err) {
    clearInterval(typingTimer);
    console.error('[telegram] AI Chat error:', err.message);
    await safeSendMessage(token, chatId, `⚠️ Bir hata oluştu choom: ${err.message}`);
  }
}

// Long polling loop
async function pollLoop() {
  while (isRunning) {
    const cfg = chatContext.config.load();
    const token = cfg.telegram?.token;
    if (!token || !cfg.telegram?.enabled) {
      isRunning = false;
      break;
    }

    try {
      pollingAbort = new AbortController();
      const timeoutSec = 25;
      const url = `${TELEGRAM_API_BASE}/bot${token}/getUpdates?offset=${lastUpdateId}&timeout=${timeoutSec}&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}`;
      const res = await fetch(url, {
        signal: AbortSignal.any ? AbortSignal.any([pollingAbort.signal, AbortSignal.timeout(35000)]) : pollingAbort.signal,
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 404) {
          console.error('[telegram] Geçersiz bot tokeni. Telegram servisi durduruluyor.');
          isRunning = false;
          break;
        }
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      const data = await res.json().catch(() => null);
      if (data?.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          lastUpdateId = update.update_id + 1;
          if (update.message) {
            await handleMessage(update.message).catch((err) => {
              console.error('[telegram] Mesaj işleme hatası:', err.message);
            });
          }
        }
      }
    } catch (err) {
      if (pollingAbort?.signal?.aborted) break;
      // Network hiccup: wait 4 seconds before reconnecting
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}

function generatePairingCode() {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  activePairing = {
    code,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes valid
  };
  return code;
}

function getActivePairing() {
  if (activePairing && Date.now() < activePairing.expiresAt) {
    return activePairing.code;
  }
  activePairing = null;
  return null;
}

async function start(context) {
  chatContext = context;
  const cfg = chatContext.config.load();
  const tg = cfg.telegram || {};

  if (!tg.enabled || !tg.token) {
    console.log('[telegram] Bot etkin değil veya token girilmemiş.');
    isRunning = false;
    return false;
  }

  if (isRunning) return true;

  try {
    botInfo = await apiCall(tg.token, 'getMe');
    console.log(`[telegram] Bot bağlandı: @${botInfo.username} (${botInfo.first_name})`);
    isRunning = true;
    pollLoop().catch((err) => console.error('[telegram] Polling loop error:', err));
    return true;
  } catch (err) {
    console.error('[telegram] Bot başlatılamadı:', err.message);
    isRunning = false;
    return false;
  }
}

function stop() {
  isRunning = false;
  if (pollingAbort) {
    pollingAbort.abort();
    pollingAbort = null;
  }
  console.log('[telegram] Bot durduruldu.');
}

function reload() {
  stop();
  setTimeout(() => {
    if (chatContext) start(chatContext);
  }, 500);
}

// Proactive notification when Claude Code / Antigravity triggers events
async function notifyClaudeEvent(evt) {
  const cfg = chatContext?.config?.load?.() || {};
  const name = evt.hook_event_name;
  const isAgy = evt.session_id?.startsWith('agy:') || (!evt.session_id?.startsWith('claude:') && cfg.assistant === 'agy');
  const isCodex = evt.session_id?.startsWith('codex:') || (!evt.session_id?.startsWith('claude:') && cfg.assistant === 'codex');
  const agentName = isAgy ? 'Antigravity' : isCodex ? 'Codex' : 'Claude Code';

  // 1. SADECE TELEGRAMDAN BAŞLATILMIŞSA: Kod sessionu değişikliklerini anlık olarak Telegram'a yaz!
  if (activeTelegramCodeSession?.active) {
    const token = activeTelegramCodeSession.token || cfg.telegram?.token;
    const codeChatId = activeTelegramCodeSession.chatId || cfg.telegram?.allowedUserId;

    try {
      if (name === 'PostToolUse') {
        const toolName = evt.tool_name || '';
        const input = evt.tool_input || {};

        if (toolName === 'Edit') {
          const filePath = input.file_path || 'Bilinmeyen Dosya';
          activeTelegramCodeSession.files.push(filePath);
          let changeMsg = `✏️ *[Antigravity] Dosya Düzenlendi:*\n\`${filePath}\``;
          if (input.replacement_snippet) {
            changeMsg += `\n\`\`\`\n${input.replacement_snippet.slice(0, 1000)}\n\`\`\``;
          }
          if (token && codeChatId) await safeSendMessage(token, codeChatId, changeMsg).catch(() => {});
        } else if (toolName === 'Write') {
          const filePath = input.file_path || 'Bilinmeyen Dosya';
          activeTelegramCodeSession.files.push(filePath);
          let changeMsg = `📝 *[Antigravity] Dosya Yazıldı:*\n\`${filePath}\` (${input.content_len || 0} bayt)`;
          if (input.content_snippet) {
            changeMsg += `\n\`\`\`\n${input.content_snippet.slice(0, 1000)}\n\`\`\``;
          }
          if (token && codeChatId) await safeSendMessage(token, codeChatId, changeMsg).catch(() => {});
        } else if (toolName === 'PowerShell') {
          const cmd = input.command || input.description || '';
          activeTelegramCodeSession.commands.push(cmd);
          if (token && codeChatId) await safeSendMessage(token, codeChatId, `⚡ *[Antigravity] Komut Çalıştırıldı:*\n\`${cmd}\``).catch(() => {});
        }
      } else if (name === 'PostToolUseFailure') {
        const toolName = evt.tool_name || 'İşlem';
        if (token && codeChatId) await safeSendMessage(token, codeChatId, `⚠️ *[Antigravity] Araç Hatası:* \`${toolName}\`\n${evt.error || 'Bilinmeyen hata'}`).catch(() => {});
      } else if (name === 'Stop') {
        const summary = evt.last_assistant_message || evt.message || 'Antigravity kodlama görevini tamamladı.';
        const uniqueFiles = [...new Set(activeTelegramCodeSession.files)];
        const fileList = uniqueFiles.length > 0
          ? `\n\n📂 *Değiştirilen Dosyalar (${uniqueFiles.length}):*\n${uniqueFiles.map((f) => `• \`${f}\``).join('\n')}`
          : '';
        activeTelegramCodeSession.active = false;
        if (token && codeChatId) {
          await sendLongMessage(token, codeChatId, `🏁 *Antigravity Kod Sessionu Tamamlandı!*${fileList}\n\n${summary}`).catch(() => {});
        }
        return;
      } else if (name === 'StopFailure') {
        const err = evt.error || evt.message || 'Bir hata oluştu.';
        activeTelegramCodeSession.active = false;
        if (token && codeChatId) {
          await safeSendMessage(token, codeChatId, `❌ *Antigravity Kod Sessionu Durduruldu (Hata):*\n\n${err}`).catch(() => {});
        }
        return;
      }
    } catch (err) {
      console.error('[telegram] Code session notify error:', err.message);
    }
  }

  // 2. Normal bildirimler (Telegram'dan kod sessionu başlatılmamışsa sadece tamamlanma/uyarı)
  if (!cfg?.telegram?.enabled || !cfg?.telegram?.token || !cfg?.telegram?.allowedUserId || cfg?.telegram?.notifyClaude === false) {
    return;
  }

  const token = cfg.telegram.token;
  const chatId = cfg.telegram.allowedUserId;

  try {
    if (name === 'Stop') {
      const summary = evt.last_assistant_message || evt.message || `${agentName} bir görevi tamamladı.`;
      await sendLongMessage(token, chatId, `🔔 *${agentName} Görevi Tamamladı*\n\n${summary}`);
    } else if (name === 'Notification') {
      const note = evt.message || evt.title || `${agentName} onay veya girdi bekliyor.`;
      await safeSendMessage(token, chatId, `⚠️ *${agentName} Bildirimi:*\n\n${note}`);
    } else if (name === 'StopFailure') {
      const err = evt.error || evt.message || 'Bir hata oluştu.';
      await safeSendMessage(token, chatId, `❌ *${agentName} Durduruldu (Hata):*\n\n${err}`);
    }
  } catch (err) {
    console.error('[telegram] Bildirim gönderme hatası:', err.message);
  }
}

function getStatus() {
  const cfg = chatContext?.config?.load()?.telegram || {};
  return {
    running: isRunning,
    botUsername: botInfo?.username || null,
    allowedUserId: cfg.allowedUserId || null,
    enabled: Boolean(cfg.enabled),
    hasToken: Boolean(cfg.token),
    codeSessionActive: isTelegramCodeSessionActive(),
  };
}

module.exports = {
  start,
  stop,
  reload,
  getStatus,
  generatePairingCode,
  getActivePairing,
  notifyClaudeEvent,
  captureScreenshot,
  isTelegramCodeSessionActive,
  startTelegramCodeSession,
  stopTelegramCodeSession,
  triggerRestart,
  windowManager,
};
