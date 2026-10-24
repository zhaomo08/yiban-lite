import { cleanText, findCue, LatestTask, LRU } from './core.js';
import { PageTranslator } from './page.js';

(() => {
  if (globalThis.__yibanLite) return;
  globalThis.__yibanLite = true;
  const isYouTube = /(^|\.)youtube\.com$/.test(location.hostname);
  let config, enabled = false, pageEnabled = false, cues = [], trackLanguage = '', videoId = '', source = '', sourceChangedAt = 0, epoch = 0, timer, observer, fallbackTask, errorUntil = 0, lastError = '', cueBusy = false, debounce, overlay, root, original, translation, statusRow, badge, hint, nativeStyle;
  let pageStatus = '尚未翻译正文';
  // 语音转写（没有 CC 时）：captionCues 表示已拿到 YouTube 真字幕，转写结果不再覆盖
  let asrTimer, asrStatus = '', captionCues = false, captionNote = '';
  const cache = new LRU(1000);
  const QUIET = new Set(['', '预取字幕', '实时字幕', '正在预译…', '正在翻译…']);
  const send = async message => { const result = await chrome.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error || '扩展已更新，请刷新网页'); return result.data; };
  const translate = (text, kind = 'subtitle') => send({ type: 'TRANSLATE', text, kind });

  const pageStyle = document.createElement('style'); pageStyle.dataset.yiban = 'style';
  pageStyle.textContent = '.yiban-translation{color:#23735f;background:#eef7f1;border-left:2px solid #84b4a0;padding:10px 14px;margin:8px 0 16px;font-size:.95em;line-height:1.8;white-space:pre-wrap;font-family:inherit;overflow-wrap:anywhere}.yiban-error{color:#a14b36;background:#fff3ec}';
  document.documentElement.append(pageStyle);
  const page = new PageTranslator(document, text => translate(text, 'page'), status => { pageStatus = status; });

  function mount() {
    if (root?.isConnected) return;
    // 重新加载扩展后旧脚本留下的字幕层与样式（新旧脚本在不同隔离环境，互相看不到变量）
    document.querySelectorAll('[data-yiban="overlay"], style[data-yiban="native"]').forEach(node => node.remove());
    root = document.createElement('div'); root.id = 'yiban-root'; root.dataset.yiban = 'overlay';
    const shadow = root.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `:host{all:initial;position:absolute;inset:0;pointer-events:none;z-index:2147483000;font-family:"PingFang SC","Microsoft YaHei",sans-serif}*{box-sizing:border-box}.panel{position:absolute;bottom:var(--bottom,8%);left:5%;width:90%;display:flex;flex-direction:column;align-items:center;text-align:center;gap:5px}.source,.target{max-width:100%;padding:3px 12px;white-space:pre-line;overflow-wrap:anywhere;border-radius:6px;line-height:1.45;background:rgba(12,20,18,.86);color:white;text-shadow:0 1px 2px #000;pointer-events:auto}.source{font-size:var(--size,22px);font-weight:500}.target{font-size:calc(var(--size,22px) * 1.03);font-weight:600;color:#d7f6da}.empty{display:none}.status{display:flex;align-items:center;gap:8px;background:rgba(12,20,18,.75);color:#dce9df;font-size:11px;padding:3px 8px;border-radius:4px;pointer-events:auto}.close{background:none;border:0;color:#dce9df;font-size:14px;cursor:pointer;padding:0 3px}.hint{font-size:12px;color:#ffe0b3;max-width:100%}.badge{opacity:.85}.status[hidden]{display:none}`;
    shadow.append(style);
    overlay = document.createElement('div'); overlay.className = 'panel';
    original = document.createElement('div'); original.className = 'source empty'; original.setAttribute('lang', config?.sourceLanguage || 'en');
    translation = document.createElement('div'); translation.className = 'target empty'; translation.setAttribute('lang', config?.targetLanguage || 'zh-CN');
    statusRow = document.createElement('div'); statusRow.className = 'status';
    badge = document.createElement('span'); badge.className = 'badge';
    hint = document.createElement('span'); hint.className = 'hint';
    const close = document.createElement('button'); close.className = 'close'; close.textContent = '×'; close.title = '关闭双语字幕'; close.setAttribute('aria-label', '关闭双语字幕');
    close.onclick = () => { stop(); send({ type: 'STOP_SUBTITLES' }).catch(() => {}); };
    statusRow.append(badge, hint, close); overlay.append(original, translation, statusRow); shadow.append(overlay);
    const player = document.querySelector('#movie_player') || document.querySelector('video')?.parentElement;
    (player || document.body).append(root);
    root.style.setProperty('--size', `${config?.subtitleSize || 22}px`); root.style.setProperty('--bottom', `${config?.subtitleBottom || 8}%`);
    nativeStyle = document.createElement('style'); nativeStyle.dataset.yiban = 'native'; nativeStyle.textContent = '.ytp-caption-window-container{opacity:0!important}';
    document.documentElement.append(nativeStyle);
  }
  function render(text = '', target = '', status = '') {
    mount(); if (original.textContent !== text) original.textContent = text; original.classList.toggle('empty', !text); if (translation.textContent !== target) translation.textContent = target; translation.classList.toggle('empty', !target);
    const modelLabel = `译伴 · ${config?.model || '本地模型'}`; if (badge.textContent !== modelLabel) badge.textContent = modelLabel; if (hint.textContent !== status) hint.textContent = status;
    // 正常播放不显示状态栏，只在出错或需要用户操作时出现
    statusRow.hidden = QUIET.has(status);
  }
  function scheduleAsr(delay = 6000) {
    clearTimeout(asrTimer); asrStatus = ''; captionCues = false;
    asrTimer = setTimeout(() => { if (enabled && !cues.length && !nativeText()) pollAsr(epoch); }, delay);
  }
  async function pollAsr(token) {
    if (!enabled || token !== epoch || captionCues) return;
    asrStatus = asrStatus || 'starting';
    try {
      const data = await send({ type: 'ASR', videoId: getVideoId(), start: video()?.currentTime || 0 });
      if (!enabled || token !== epoch || captionCues) return;
      asrStatus = data.status;
      const safe = (Array.isArray(data.cues) ? data.cues : []).filter(c => Number.isFinite(c.start) && c.start >= 0 && Number.isFinite(c.end) && c.end > c.start && typeof c.text === 'string' && c.text && c.text.length <= 2000).slice(0, 20000);
      if (safe.length > cues.length) { cues = safe; trackLanguage = String(data.language || config.sourceLanguage).slice(0, 16); }
      if (data.status === 'error') { report(new Error(`语音转写失败：${String(data.error || '').slice(-120)}`)); return; }
      if (data.status !== 'done') asrTimer = setTimeout(() => pollAsr(token), 4000);
    } catch (error) { if (token === epoch) { asrStatus = 'error'; report(error); } }
  }
  function waitingHint() { return asrStatus && asrStatus !== 'done' && asrStatus !== 'error' ? '没有 CC，正在识别语音…（首次约 30 秒）' : '请在播放器开启英文 CC 字幕'; }
  function report(error) { lastError = error.message; errorUntil = Date.now() + 8000; render(source, '', lastError); }
  function validTrack() { return cues.length && (config.sourceLanguage === 'auto' || trackLanguage.split('-')[0] === config.sourceLanguage.split('-')[0]); }
  function video() { return document.querySelector('video'); }
  function getVideoId() { return new URL(location.href).searchParams.get('v') || location.pathname; }
  function nativeText() { return [...document.querySelectorAll('.ytp-caption-window-container .caption-window')].map(window => [...window.querySelectorAll('.ytp-caption-segment')].map(s => s.textContent).join(' ')).map(cleanText).filter(Boolean).join('\n'); }
  function makeFallback() {
    fallbackTask?.dispose();
    const token = epoch;
    fallbackTask = new LatestTask(async text => {
      const cached = cache.get(text); if (cached) return cached;
      const result = await translate(text); if (token === epoch && enabled) cache.set(text, result.text); return result.text;
    }, (error, value, text) => { if (error) report(error); else if (enabled && source === text) { lastError = ''; render(text, value, '实时字幕'); } });
  }
  function nativeChanged() {
    if (!enabled || validTrack()) return;
    const text = nativeText();
    if (text === source) return;
    source = text; sourceChangedAt = Date.now(); clearTimeout(debounce);
    fallbackTask.submit('');
    if (!text) { render('', '', '等待英文 CC 字幕'); return; }
    const cached = cache.get(text); render(text, cached || '', cached ? '实时字幕' : '正在翻译…');
    if (!cached && Date.now() >= errorUntil) debounce = setTimeout(() => { if (enabled && source === text) fallbackTask.submit(text); }, 200);
  }
  async function prefetch(time) {
    if (cueBusy || Date.now() < errorUntil || !enabled) return;
    const token = epoch; const i = cues.findIndex(c => c.end > time);
    if (i < 0) return;
    const next = cues.slice(i).find(c => c.start <= time + config.lookAhead && !cache.get(c.text));
    if (!next) return;
    cueBusy = true;
    try { const result = await translate(next.text); if (token === epoch) { cache.set(next.text, result.text); lastError = ''; } }
    catch (error) { if (token === epoch) report(error); }
    finally { cueBusy = false; }
  }
  function tick() {
    if (!enabled) return;
    if (!chrome.runtime?.id) { stop(); return; } // 扩展已重新加载，本脚本失效
    if (getVideoId() !== videoId) { cues = []; trackLanguage = ''; source = ''; videoId = getVideoId(); epoch++; cache.clear(); makeFallback(); scheduleAsr(); render('', '', '请开启英文 CC 字幕'); window.postMessage({ channel: 'yiban-lite:request-captions:v1' }, location.origin); }
    if (!root?.isConnected) mount();
    const media = video();
    if (!media) { render('', '', '等待播放器'); return; }
    if (validTrack()) {
      const i = findCue(cues, media.currentTime); const cue = cues[i]; source = cue?.text || '';
      const target = source ? cache.get(source) : '';
      render(source, target || '', lastError && Date.now() < errorUntil ? lastError : (source && !target ? '正在预译…' : (!source && asrStatus === 'transcribing' ? '语音识别中…' : '预取字幕')));
      prefetch(media.currentTime);
    } else {
      nativeChanged();
      if (!source) render('', '', lastError && Date.now() < errorUntil ? lastError : waitingHint());
      else if (!cache.get(source) && !fallbackTask.busy && !fallbackTask.pending && Date.now() >= errorUntil && Date.now() - sourceChangedAt >= 200) fallbackTask.submit(source);
    }
  }
  async function start() {
    if (!isYouTube || !location.pathname.startsWith('/watch')) throw new Error('双语字幕目前支持 YouTube /watch 视频页');
    if (enabled) return;
    enabled = true; epoch++; errorUntil = 0; lastError = ''; videoId = getVideoId(); source = '';
    makeFallback(); mount(); render('', '', '请在播放器开启英文 CC 字幕'); scheduleAsr();
    const cc = document.querySelector('.ytp-subtitles-button');
    if (cc?.getAttribute('aria-pressed') === 'false') cc.click();
    observer = new MutationObserver(nativeChanged); observer.observe(document.querySelector('#movie_player') || document.body, { childList: true, characterData: true, subtree: true });
    window.postMessage({ channel: 'yiban-lite:request-captions:v1' }, location.origin);
    timer = setInterval(tick, 250); tick();
  }
  function stop() { enabled = false; epoch++; clearInterval(timer); clearTimeout(asrTimer); asrStatus = ''; clearTimeout(debounce); observer?.disconnect(); fallbackTask?.dispose(); root?.remove(); nativeStyle?.remove(); source = ''; }
  function timelineNote() {
    if (validTrack()) return '';
    if (cues.length) return `字幕语言 ${trackLanguage || '未知'} 与原文语言设置 ${config.sourceLanguage} 不一致`;
    return captionNote || '未截获到字幕请求';
  }
  function state() { return { subtitles: enabled, page: pageEnabled, pageStatus, mode: validTrack() ? '预取字幕' : '实时字幕', cues: cues.length, note: enabled ? timelineNote() : '', error: lastError }; }

  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source === window && event.origin === location.origin && data?.channel === 'yiban-lite:caption-note:v1') { captionNote = String(data.text || '').slice(0, 80); return; }
    if (event.source !== window || event.origin !== location.origin || data?.channel !== 'yiban-lite:captions:v1' || data.videoId !== getVideoId() || !Array.isArray(data.cues) || data.cues.length > 6000) return;
    const safe = data.cues.filter(c => Number.isFinite(c.start) && c.start >= 0 && Number.isFinite(c.end) && c.end > c.start && typeof c.text === 'string' && c.text.length > 0 && c.text.length <= 2000).sort((a, b) => a.start - b.start);
    if (!safe.length) return;
    cues = safe; trackLanguage = String(data.language || '').slice(0, 16); captionCues = true; captionNote = ''; clearTimeout(asrTimer); asrStatus = ''; if (enabled) { epoch++; makeFallback(); tick(); }
  });
  document.addEventListener('yt-navigate-start', () => { if (enabled) { cues = []; trackLanguage = ''; cache.clear(); epoch++; makeFallback(); scheduleAsr(); } });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'PING') { respond({ ok: true }); return; }
    if (message.type === 'STYLE') { root?.style.setProperty('--size', `${message.subtitleSize}px`); root?.style.setProperty('--bottom', `${message.subtitleBottom}%`); return; }
    (async () => {
      if (message.type === 'CONFIG_CHANGED') {
        config = await send({ type: 'PUBLIC_SETTINGS' }); cache.clear(); const wasEnabled = enabled; stop();
        if (pageEnabled) { page.restore(); pageEnabled = false; pageStatus = '模型设置已更新，请重新翻译正文'; }
        if (wasEnabled || (isYouTube && location.pathname.startsWith('/watch') && config.autoSubtitles)) await start();
      } else if (message.type === 'ACTION') {
        config = await send({ type: 'PUBLIC_SETTINGS' });
        if (message.action === 'subtitles') { if (message.enabled) await start(); else stop(); }
        if (message.action === 'translatePage') { pageEnabled = true; await page.start(); }
        if (message.action === 'restorePage') { pageEnabled = false; page.restore(); pageStatus = '已恢复原文'; }
      }
      return state();
    })().then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
    return true;
  });
  send({ type: 'PUBLIC_SETTINGS' }).then(result => { config = result; if (isYouTube && location.pathname.startsWith('/watch') && (config.autoSubtitles || config.access.subtitle)) start().catch(report); }).catch(() => {});
})();
