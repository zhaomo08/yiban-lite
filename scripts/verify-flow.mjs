import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { Translator } from '../src/translator.js';
import { DEFAULT_SETTINGS } from '../src/core.js';

// 合成播放器 DOM + 真实本地模型。此检查不代表真实 YouTube 已验证。
const dom = new JSDOM('<!doctype html><html><body><div id="movie_player"><video></video><button class="ytp-subtitles-button" aria-pressed="true"></button><div class="ytp-caption-window-container"><div class="caption-window"><span class="ytp-caption-segment"></span></div></div></div><article><p id="article">This course introduces self-improving AI agents.</p></article></body></html>', { url: 'https://www.youtube.com/watch?v=synthetic-fixture', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const translator = new Translator();
const profile = { ...DEFAULT_SETTINGS.model, baseUrl: process.env.BASE_URL || 'http://127.0.0.1:11434', model: process.env.MODEL || DEFAULT_SETTINGS.model.model };
const config = { ...DEFAULT_SETTINGS, model: profile.model, access: {} };
let listener, calls = 0;
window.IntersectionObserver = class {
  constructor(callback) { this.callback = callback; }
  observe(node) { this.callback([{ target: node, isIntersecting: true }]); }
  unobserve() {}
  disconnect() {}
};
window.chrome = { runtime: { id: 'synthetic-test', onMessage: { addListener(callback) { listener = callback; } }, async sendMessage(message) {
  if (message.type === 'PUBLIC_SETTINGS') return { ok: true, data: config };
  if (message.type === 'STOP_SUBTITLES') return { ok: true, data: {} };
  if (message.type === 'TRANSLATE') { calls++; try { return { ok: true, data: await translator.translate(profile, message.text, 'zh-CN') }; } catch (error) { return { ok: false, error: error.message }; } }
} } };
window.eval(await readFile(new URL('../dist/content.js', import.meta.url), 'utf8'));
const action = (name, enabled) => new Promise(resolve => listener({ type: 'ACTION', action: name, enabled }, { id: 'synthetic-test' }, resolve));
const wait = async predicate => { const end = Date.now() + 15000; while (!predicate()) { if (Date.now() > end) throw new Error('真实模型链路检查超时'); await new Promise(resolve => setTimeout(resolve, 50)); } };
try {
  await action('subtitles', true);
  const source = 'How many of you have heard of the infinite monkey theorem?';
  window.document.querySelector('.ytp-caption-segment').textContent = source;
  await wait(() => /猴/.test(window.document.querySelector('#yiban-root')?.shadowRoot.querySelector('.target')?.textContent));
  const live = window.document.querySelector('#yiban-root').shadowRoot.querySelector('.target').textContent;
  assert.equal(window.document.querySelector('#yiban-root').shadowRoot.querySelector('.source').textContent, source);
  window.document.querySelector('video').currentTime = 1221;
  window.dispatchEvent(new window.MessageEvent('message', { source: window, origin: window.location.origin, data: { channel: 'yiban-lite:captions:v1', videoId: 'synthetic-fixture', language: 'en', cues: [{ start: 1220, end: 1230, text: 'Large language models can generate many candidate solutions.' }] } }));
  await wait(() => /候选/.test(window.document.querySelector('#yiban-root')?.shadowRoot.querySelector('.target')?.textContent));
  const timeline = window.document.querySelector('#yiban-root').shadowRoot.querySelector('.target').textContent;
  await action('subtitles', false); assert.equal(window.document.querySelector('#yiban-root'), null); assert.equal(window.document.querySelector('[data-yiban="native"]'), null);
  const article = window.document.querySelector('#article').outerHTML;
  await action('translatePage');
  await wait(() => window.document.querySelector('.yiban-ready'));
  const page = window.document.querySelector('.yiban-ready').textContent;
  assert.match(page, /[\u4e00-\u9fff]/);
  await action('restorePage'); assert.equal(window.document.querySelector('#article').outerHTML, article); assert.equal(window.document.querySelector('.yiban-translation'), null);
  console.log(JSON.stringify({ evidence: '合成播放器DOM + 真实本地模型，非真实YouTube', live, timeline, page, restored: true, calls }));
} finally { translator.clear(); dom.window.close(); }
