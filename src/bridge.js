import { parseJson3, cleanText } from './core.js';

// 只观察 YouTube 自己请求的字幕响应，不读取 Cookie，不构造签名 URL。
(() => {
  if (window.__yibanCaptionBridge) return;
  window.__yibanCaptionBridge = true;
  let latest = null;
  const channel = 'yiban-lite:captions:v1';
  function trackInfo(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      if (!/(^|\.)youtube\.com$/.test(url.hostname) || !url.pathname.endsWith('/timedtext')) return null;
      return { videoId: url.searchParams.get('v') || new URL(location.href).searchParams.get('v'), language: url.searchParams.get('lang') || '', translated: url.searchParams.has('tlang') };
    } catch { return null; }
  }
  // 截获失败时把原因告诉 content，弹窗里能看到为什么退回实时字幕
  function note(text) { window.postMessage({ channel: 'yiban-lite:caption-note:v1', text }, location.origin); }
  function accept(raw, info) {
    if (!info) return;
    if (info.translated) { note('当前 CC 是 YouTube 自动翻译轨道，请在播放器字幕里改选原文'); return; }
    if (typeof raw !== 'string' || raw.length > 3000000) { note('字幕响应格式不支持'); return; }
    let cues = [];
    try { cues = parseJson3(JSON.parse(raw)); }
    catch {
      try {
        const xml = new DOMParser().parseFromString(raw, 'application/xml');
        cues = [...xml.querySelectorAll('text, p')].slice(0, 6000).map(node => {
          const srv3 = node.hasAttribute('t');
          const start = Number(node.getAttribute(srv3 ? 't' : 'start')) / (srv3 ? 1000 : 1);
          const duration = Number(node.getAttribute(srv3 ? 'd' : 'dur') || (srv3 ? 4000 : 4)) / (srv3 ? 1000 : 1);
          return { start, end: start + duration, text: cleanText(node.textContent) };
        }).filter(c => c.text && c.text.length <= 2000 && Number.isFinite(c.start) && c.end > c.start);
      } catch { note('字幕响应无法解析'); return; }
    }
    if (!cues.length) { note('截获到字幕请求，但内容为空'); return; }
    latest = { channel, ...info, cues };
    window.postMessage(latest, location.origin);
  }
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const info = trackInfo(typeof args[0] === 'string' ? args[0] : args[0]?.url);
    const result = Reflect.apply(originalFetch, this, args);
    if (info) result.then(response => { if (response.ok) response.clone().text().then(raw => accept(raw, info)).catch(() => {}); }).catch(() => {});
    return result;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const tracks = new WeakMap();
  XMLHttpRequest.prototype.open = function (...args) {
    tracks.set(this, trackInfo(args[1]));
    this.addEventListener('load', () => {
      if (this.responseType === '' || this.responseType === 'text') accept(this.responseText, tracks.get(this));
      else if (this.responseType === 'json') accept(JSON.stringify(this.response), tracks.get(this));
      else if (tracks.get(this)) note(`字幕响应类型 ${this.responseType} 不支持`);
    }, { once: true });
    return Reflect.apply(originalOpen, this, args);
  };
  window.addEventListener('message', event => {
    if (event.source === window && event.origin === location.origin && event.data?.channel === 'yiban-lite:request-captions:v1' && latest?.videoId === new URL(location.href).searchParams.get('v')) window.postMessage(latest, location.origin);
  });
})();
