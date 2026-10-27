// Desktop Observation Inspection Panel (strictly read-only)
// Displays extracted Windows UI Automation hierarchy, controls, text, and metadata.

export class Inspector {
  constructor({ panel, host, capri, voice, brain }) {
    this.panel = panel;
    this.host = host;
    this.capri = capri;
    this.voice = voice;
    this.brain = brain;
    this.latest = null;
    this.busy = false;

    // Listen for background updates
    this.host.onDesktopObservation?.((obs) => {
      this.latest = obs;
      if (this.isOpen) this.render(obs);
    });
  }

  get isOpen() {
    return this.panel.visible && this.panel.current?.tag === 'UI Automation';
  }

  async open() {
    this.capri.wake();
    this.capri.perform('curious', this.capri.towardCenter());
    this.voice.play('blip');

    // Show scanning state
    this.panel.say({
      kind: 'info',
      face: 'look',
      badge: 'UIA · GÖZLEM',
      tag: 'UI Automation',
      line: 'Masaüstü taranıyor...',
      quote: 'Pencere ve erişilebilirlik ağacı okunuyor (Salt Okunur / Read-Only)...',
      hold: null,
    });

    await this.refresh();
  }

  async refresh() {
    if (this.busy) return;
    this.busy = true;

    try {
      this.capri.pulse();
      const obs = await this.host.observeDesktop({ scope: 'screen', maxDepth: 6, maxElements: 500, timeoutMs: 5000 });
      this.latest = obs;
      this.render(obs);
    } catch (err) {
      this.panel.say({
        kind: 'error',
        face: 'aside',
        badge: 'UIA · HATA',
        tag: 'UI Automation',
        line: 'Gözlem Başarısız Oldu',
        quote: err.message,
        actions: [
          { id: 'retry', label: 'Tekrar Dene (Retry)', primary: true },
          { id: 'close', label: 'Kapat (Close)' },
        ],
        onAction: (id) => (id === 'retry' ? this.refresh() : this.panel.hide()),
      });
    } finally {
      this.busy = false;
    }
  }

  render(obs) {
    const { activeWindow, elementCount, durationMs, elements = [], limitations = [], observationSource } = obs;
    const timeStr = new Date(obs.observedAt || Date.now()).toLocaleTimeString();

    const isDesktop = activeWindow.title.toLowerCase().includes('desktop') ||
                      activeWindow.processName.toLowerCase() === 'explorer' ||
                      elements.some((e) => e.category === 'desktop-icon');

    // Categorize elements
    const desktopIcons = [];
    const taskbarItems = [];
    const videoTitles = [];
    const headings = [];
    const links = [];
    const inputs = [];
    const buttons = [];
    const texts = [];
    const tabs = [];
    const others = [];

    const isYouTube = activeWindow.title.toLowerCase().includes('youtube') ||
                      elements.some((e) => (e.name || '').toLowerCase().includes('youtube'));

    for (const el of elements) {
      const label = el.name || el.value;
      if (!label && el.type !== 'Edit') continue;

      if (el.category === 'desktop-icon' || (isDesktop && el.type === 'ListItem')) {
        desktopIcons.push(el);
        continue;
      }

      if (el.category === 'taskbar') {
        taskbarItems.push(el);
        continue;
      }

      switch (el.type) {
        case 'Heading':
          headings.push(el);
          if (isYouTube && label.length > 3) videoTitles.push(el);
          break;
        case 'Hyperlink':
          links.push(el);
          if (isYouTube && label.length > 5) {
            if (!/^(home|subscriptions|explore|trending|library|history|watch later|liked videos|settings|report|help|feedback|about|press|copyright|contact us|creators|advertise|developers|terms|privacy|policy|switch account|sign out|sign in|oturum a[çc]|ana sayfa|trendler|abonelikler|ge[çc]mi[sş])$/i.test(label)) {
              videoTitles.push(el);
            }
          }
          break;
        case 'Edit':
          inputs.push(el);
          break;
        case 'Button':
          buttons.push(el);
          break;
        case 'Text':
        case 'Document':
          texts.push(el);
          break;
        case 'TabItem':
          tabs.push(el);
          break;
        default:
          others.push(el);
          break;
      }
    }

    // Build formatted inspection report
    const lines = [];

    // 1. Window metadata
    lines.push(`UYGULAMA / EKRAN: ${activeWindow.processName} (PID: ${activeWindow.processId}, HWND: ${activeWindow.hwnd})`);
    lines.push(`BAŞLIK / PENCERE: "${activeWindow.title}"`);
    lines.push(`ÇÖZÜNÜRLÜK: ${activeWindow.bounds?.width}x${activeWindow.bounds?.height} (${activeWindow.bounds?.x}, ${activeWindow.bounds?.y})`);
    lines.push(`DURUM: ${activeWindow.isMaximized ? 'Ekranı Kapla (Maximized)' : activeWindow.isMinimized ? 'Simge Durumu (Minimized)' : 'Normal'}`);
    lines.push(`KAYNAK: ${observationSource} · TOPLAM ÖGE: ${elementCount} · SÜRE: ${durationMs}ms`);
    lines.push('────────────────────────────────────────');

    // 2. Video Titles & Headings (YouTube / Web)
    if (videoTitles.length) {
      const uniqueTitles = [...new Set(videoTitles.map((v) => v.name).filter(Boolean))];
      lines.push(`VİDEO BAŞLIKLARI (${uniqueTitles.length}):`);
      for (const t of uniqueTitles.slice(0, 20)) {
        lines.push(` 🎬 "${t}"`);
      }
      lines.push('');
    } else if (headings.length) {
      const uniqueH = [...new Set(headings.map((h) => h.name).filter(Boolean))];
      lines.push(`BAŞLIKLAR VE BÖLÜMLER (${uniqueH.length}):`);
      for (const h of uniqueH.slice(0, 15)) {
        lines.push(` 📌 "${h}"`);
      }
      lines.push('');
    }

    // 3. Desktop Icons across entire screen
    if (desktopIcons.length) {
      const screenWidth = activeWindow.bounds?.width || 1920;
      lines.push(`MASAÜSTÜ SİMGELERİ VE OYUNLAR (${desktopIcons.length} Öge - Tam Ekran):`);
      for (const icon of desktopIcons) {
        const side = (icon.bounds?.x || 0) < screenWidth * 0.38 ? '[Sol]' :
                     (icon.bounds?.x || 0) > screenWidth * 0.62 ? '[Sağ]' : '[Orta]';
        lines.push(` • ${side} "${icon.name}"`);
      }
      lines.push('');
    }

    // 3. Taskbar Apps
    if (taskbarItems.length) {
      const uniqueTb = [...new Set(taskbarItems.map((t) => t.name).filter(Boolean))];
      lines.push(`GÖREV ÇUBUĞU VE AÇIK UYGULAMALAR (${uniqueTb.length}):`);
      for (const tb of uniqueTb.slice(0, 20)) {
        lines.push(` • "${tb}"`);
      }
      lines.push('');
    }

    // 4. Focused element
    const focused = elements.find((e) => e.isFocused);
    if (focused) {
      lines.push(`ODAKLANMIŞ ÖGE: [${focused.type}] "${focused.name || focused.value || '(isimsiz)'}" (ID: ${focused.id})`);
      lines.push('────────────────────────────────────────');
    }

    // 5. Inputs
    if (inputs.length) {
      lines.push(`GİRİŞ ALANLARI / METİN KUTULARI (${inputs.length}):`);
      for (const inp of inputs.slice(0, 10)) {
        const val = inp.value != null ? `"${inp.value}"` : '(boş)';
        lines.push(` • [${inp.id}] ${inp.name || 'Giriş'}: ${val}${inp.isReadOnly ? ' [Salt Okunur]' : ''}`);
      }
      lines.push('');
    }

    // 6. Buttons
    if (buttons.length) {
      lines.push(`BUTONLAR VE KONTROLLER (${buttons.length}):`);
      for (const btn of buttons.slice(0, 15)) {
        lines.push(` • [${btn.id}] "${btn.name}" (Durum: ${btn.isEnabled ? 'Aktif' : 'Devre Dışı'})`);
      }
      lines.push('');
    }

    // 5. Tabs
    if (tabs.length) {
      lines.push(`SEKMELER (${tabs.length}):`);
      for (const tab of tabs.slice(0, 8)) {
        lines.push(` • "${tab.name}" ${tab.isSelected ? '[Seçili]' : ''}`);
      }
      lines.push('');
    }

    // 6. Visible Content & Text
    if (texts.length) {
      lines.push(`GÖRÜNÜR METİNLER / ETİKETLER (${texts.length}):`);
      const textSamples = texts.map((t) => t.name || t.value).filter(Boolean);
      const uniqueTexts = [...new Set(textSamples)].slice(0, 12);
      for (const txt of uniqueTexts) {
        const clean = txt.length > 90 ? txt.slice(0, 87) + '...' : txt;
        lines.push(` • ${clean}`);
      }
      lines.push('');
    }

    // 7. Limitations & Inaccessible regions
    if (limitations.length) {
      lines.push('SINIRLAMALAR VE ERİŞİLEMEZ BÖLGELER:');
      for (const lim of limitations) {
        lines.push(` ⚠️ ${lim}`);
      }
      lines.push('');
    }

    const detailedText = lines.join('\n');

    this.panel.say({
      kind: 'info',
      face: 'smug',
      badge: 'UIA · GÖZLEM',
      tag: 'UI Automation',
      line: `${activeWindow.processName}: ${activeWindow.title || '(Başlıksız)'}`,
      quote: `${elementCount} öge keşfedildi · Salt okunur gözlem · ${durationMs}ms`,
      reply: detailedText,
      actions: [
        { id: 'refresh', label: 'Yenile / Refresh', primary: true },
        { id: 'close', label: 'Kapat / Close' },
      ],
      onAction: (id) => {
        if (id === 'refresh') this.refresh();
        else this.panel.hide();
      },
      hold: null,
    });
  }
}
