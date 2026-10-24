import { DEFAULT_SETTINGS, normalizeSettings, permissionOrigin } from './core.js';
import { Translator } from './translator.js';

const ready = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
let creating;
async function offscreenFetch(url, { signal, ...init }) {
  if (!await chrome.offscreen.hasDocument()) {
    creating ??= chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: '在扩展页面中请求本机或局域网翻译模型' }).finally(() => { creating = null; });
    await creating;
  }
  const id = crypto.randomUUID();
  const abort = () => chrome.runtime.sendMessage({ target: 'offscreen', type: 'ABORT', id }).catch(() => {});
  signal?.addEventListener('abort', abort);
  try {
    const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'FETCH', id, url, init });
    if (result?.error === 'abort') throw new DOMException('请求已取消', 'AbortError');
    if (!result || result.error) throw new TypeError(result?.error || 'offscreen 页面未响应');
    return { ok: result.ok, status: result.status, text: async () => result.text };
  } finally { signal?.removeEventListener('abort', abort); }
}
const translator = new Translator(offscreenFetch);
const counts = new Map();
async function getSettings() { await ready; return normalizeSettings((await chrome.storage.local.get('settings')).settings || DEFAULT_SETTINGS); }
function isUI(sender) { return sender.id === chrome.runtime.id && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL('popup.html'); }
async function getAccess(id) { return (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`] || {}; }
async function setAccess(id, value) { await chrome.storage.session.set({ [`tab:${id}`]: value }); }
async function checkPermission(profile) { if (!await chrome.permissions.contains({ origins: [permissionOrigin(profile.baseUrl)] })) throw new Error('请先在模型设置中保存并授权接口主机'); }

async function checkAccess(sender, kind, settings) {
  const access = await getAccess(sender.tab.id);
  const youtube = /^https:\/\/(www|m)\.youtube\.com\//.test(sender.tab.url || sender.url || '');
  if (!access[kind] && !(kind === 'subtitle' && youtube && settings.autoSubtitles)) throw new Error('请先在扩展中开启当前页面的翻译');
}

// 没有 CC 的视频：经连接助手（scripts/relay.mjs）请求整片语音转写（server/asr.py），返回已转好的字幕时间轴
async function fetchAsr(settings, videoId, start) {
  await checkPermission(settings.model);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await offscreenFetch(`${new URL(settings.model.baseUrl).origin}/asr?v=${videoId}&start=${Math.max(0, Math.floor(Number(start) || 0))}`, { method: 'GET', credentials: 'omit', redirect: 'error', signal: controller.signal });
    if (response.status === 404) throw new Error('没有 CC：语音转写需要通过连接助手访问模型，见 README');
    if (!response.ok) throw new Error(`语音转写服务返回 HTTP ${response.status}`);
    const raw = await response.text();
    if (raw.length > 3000000) throw new Error('语音转写结果过大');
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof TypeError || error.name === 'AbortError') throw new Error('无法连接语音转写服务，请确认连接助手正在运行');
    throw error;
  } finally { clearTimeout(timer); }
}

async function handle(message, sender) {
  if (!message || typeof message.type !== 'string') throw new Error('无效的请求');
  const settings = await getSettings();
  if (message.type === 'PUBLIC_SETTINGS') {
    return { targetLanguage: settings.targetLanguage, sourceLanguage: settings.sourceLanguage, autoSubtitles: settings.autoSubtitles, subtitleSize: settings.subtitleSize, subtitleBottom: settings.subtitleBottom, lookAhead: settings.lookAhead, model: settings.model.model, access: sender.tab ? await getAccess(sender.tab.id) : {} };
  }
  if (message.type === 'TRANSLATE') {
    if (!sender.tab || !['page', 'subtitle'].includes(message.kind)) throw new Error('请求来源无效');
    await checkAccess(sender, message.kind, settings);
    const inUse = counts.get(sender.tab.id) || 0;
    if (inUse >= 2) throw new Error('当前页面的翻译任务过多，请稍后再试');
    await checkPermission(settings.model);
    counts.set(sender.tab.id, inUse + 1);
    try { return await translator.translate(settings.model, message.text, settings.targetLanguage); }
    finally { counts.set(sender.tab.id, Math.max(0, (counts.get(sender.tab.id) || 1) - 1)); }
  }
  if (message.type === 'ASR') {
    if (!sender.tab || !/^[\w-]{11}$/.test(message.videoId || '')) throw new Error('请求来源无效');
    await checkAccess(sender, 'subtitle', settings);
    return fetchAsr(settings, message.videoId, message.start);
  }
  if (message.type === 'STOP_SUBTITLES' && sender.tab) { await setAccess(sender.tab.id, { ...await getAccess(sender.tab.id), subtitle: false }); return {}; }
  if (!isUI(sender)) throw new Error('此操作仅允许在扩展设置中执行');
  if (message.type === 'GET_SETTINGS') return settings;
  if (message.type === 'SAVE_SETTINGS') {
    const next = normalizeSettings(message.settings);
    await checkPermission(next.model);
    await chrome.storage.local.set({ settings: next }); translator.clear();
    for (const tab of await chrome.tabs.query({})) if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_CHANGED' }).catch(() => {});
    return next;
  }
  if (message.type === 'TEST') {
    const next = normalizeSettings(message.settings); await checkPermission(next.model);
    return translator.request(next.model, 'How many of you have heard of the infinite monkey theorem?', next.targetLanguage);
  }
  if (message.type === 'PREVIEW_STYLE') {
    // 只预览不保存：拖动滑块时同步到当前视频，保存后才写入设置
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const { subtitleSize, subtitleBottom } = normalizeSettings({ ...settings, subtitleSize: message.subtitleSize, subtitleBottom: message.subtitleBottom });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'STYLE', subtitleSize, subtitleBottom }).catch(() => {});
    return {};
  }
  if (message.type === 'CLEAR_CACHE') { translator.clear(); return {}; }
  if (message.type === 'PAGE_ACTION') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('请在普通网页或 YouTube 视频页面打开扩展');
    if (!['subtitles', 'translatePage', 'restorePage', 'status'].includes(message.action)) throw new Error('不支持的页面操作');
    const access = await getAccess(tab.id);
    if (message.action === 'subtitles') access.subtitle = message.enabled === true;
    if (message.action === 'translatePage') access.page = true;
    if (message.action === 'restorePage') access.page = false;
    await setAccess(tab.id, access);
    try { await chrome.tabs.sendMessage(tab.id, { type: 'PING' }); }
    catch { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); }
    return chrome.tabs.sendMessage(tab.id, { type: 'ACTION', action: message.action, enabled: message.enabled });
  }
  throw new Error('不支持的操作');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target === 'offscreen') return;
  handle(message, sender).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message || '操作失败' }));
  return true;
});
chrome.tabs.onRemoved.addListener(id => { counts.delete(id); chrome.storage.session.remove(`tab:${id}`); });
chrome.tabs.onUpdated.addListener((id, change) => { if (change.status === 'loading') chrome.storage.session.remove(`tab:${id}`); });
