import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { Translator } from '../src/translator.js';
import { DEFAULT_SETTINGS } from '../src/core.js';

// 合成播放器 DOM（没有任何 CC）+ 真实连接助手 + 语音转写与翻译。此检查不代表真实 YouTube 已验证。
const base = process.env.RELAY_URL || 'http://127.0.0.1:11435'; // 必须是连接助手，Ollama 本身没有 /asr
const videoId = process.env.ASR_VIDEO || '6YnLB0XbTnI';
const dom = new JSDOM('<!doctype html><html><body><div id="movie_player"><video></video></div></body></html>', { url: `https://www.youtube.com/watch?v=${videoId}`, runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const translator = new Translator();
const profile = { ...DEFAULT_SETTINGS.model, baseUrl: base, model: process.env.MODEL || DEFAULT_SETTINGS.model.model };
let listener, asrCalls = 0;
window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
window.chrome = { runtime: { id: 'synthetic-test', onMessage: { addListener(callback) { listener = callback; } }, async sendMessage(message) {
  try {
    if (message.type === 'PUBLIC_SETTINGS') return { ok: true, data: { ...DEFAULT_SETTINGS, model: profile.model, access: {} } };
    if (message.type === 'ASR') { asrCalls++; return { ok: true, data: await (await fetch(`${base}/asr?v=${message.videoId}&start=${Math.floor(message.start)}`)).json() }; }
    if (message.type === 'TRANSLATE') return { ok: true, data: await translator.translate(profile, message.text, 'zh-CN') };
    return { ok: true, data: {} };
  } catch (error) { return { ok: false, error: error.message }; }
} } };
window.eval(await readFile(new URL('../dist/content.js', import.meta.url), 'utf8'));
const shadow = () => window.document.querySelector('#yiban-root')?.shadowRoot;
const wait = async (predicate, ms) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error(`等待超时：${shadow()?.querySelector('.hint')?.textContent}`); await new Promise(r => setTimeout(r, 100)); } };
try {
  window.document.querySelector('video').currentTime = 1221;
  await new Promise(resolve => listener({ type: 'ACTION', action: 'subtitles', enabled: true }, { id: 'synthetic-test' }, resolve));
  await wait(() => /[一-鿿]/.test(shadow()?.querySelector('.target')?.textContent || ''), 120000);
  const result = { evidence: '合成播放器DOM（无CC）+ 真实转写与翻译，非真实YouTube', asrCalls, source: shadow().querySelector('.source').textContent, target: shadow().querySelector('.target').textContent };
  assert.ok(asrCalls >= 1); assert.match(result.source, /[a-z]/i);
  console.log(JSON.stringify(result));
} finally { await new Promise(resolve => listener({ type: 'ACTION', action: 'subtitles', enabled: false }, { id: 'synthetic-test' }, resolve)); translator.clear(); window.close(); }
