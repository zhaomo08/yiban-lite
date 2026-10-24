import { DEFAULT_SETTINGS, LANGUAGES, normalizeSettings, permissionOrigin } from './core.js';

const $ = selector => document.querySelector(selector);
const extension = !!globalThis.chrome?.runtime?.id;
let settings = structuredClone(DEFAULT_SETTINGS), toastTimer;
const request = async message => {
  if (!extension) {
    if (message.type === 'GET_SETTINGS') return settings;
    throw new Error('这是界面预览；请在 Chrome 中加载扩展后使用此功能');
  }
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '扩展后台未响应，请重新加载扩展');
  return result.data;
};
function toast(text, error = false) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').classList.toggle('error', error); $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, error ? 8000 : 3500); }
function showPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.hidden = p.id !== `panel-${name}`);
  document.querySelectorAll('.tab').forEach(tab => { const selected = tab.dataset.panel === name; tab.classList.toggle('active', selected); tab.setAttribute('aria-selected', String(selected)); });
  $('main').scrollTop = 0;
}
function loadModel() {
  const m = settings.model;
  $('#protocol').value = m.protocol; $('#base-url').value = m.baseUrl; $('#model').value = m.model; $('#prompt-style').value = m.promptStyle;
  $('#relay-command').textContent = extension ? `npm run relay -- --extension-id ${chrome.runtime.id}` : 'npm run relay';
  $('#test-result').hidden = true;
}
function readModel() {
  Object.assign(settings.model, { protocol: $('#protocol').value, baseUrl: $('#base-url').value.trim(), model: $('#model').value.trim(), promptStyle: $('#prompt-style').value });
}
function readPreferences() {
  settings.sourceLanguage = $('#source-language').value; settings.targetLanguage = $('#target-language').value; settings.autoSubtitles = $('#auto-subtitles').checked;
  settings.subtitleSize = +$('#subtitle-size').value; settings.subtitleBottom = +$('#subtitle-bottom').value; settings.lookAhead = +$('#look-ahead').value;
}
function updateModelBadge() {
  const m = settings.model; $('#active-model-name').textContent = m.model; $('#active-model-detail').textContent = `${m.protocol === 'ollama' ? 'Ollama' : 'OpenAI 兼容'} · ${new URL(m.baseUrl).host}`;
}
function preview() {
  $('#size-value').textContent = `${$('#subtitle-size').value} px`; $('#bottom-value').textContent = `${$('#subtitle-bottom').value}%`; $('#ahead-value').textContent = `${$('#look-ahead').value} 秒`;
  $('#subtitle-preview').style.setProperty('--preview-size', `${+$('#subtitle-size').value * .55}px`); $('#subtitle-preview').style.setProperty('--preview-bottom', `${+$('#subtitle-bottom').value + 6}%`);
}
function populate() {
  $('#source-language').replaceChildren(new Option('自动 / 当前 CC', 'auto'), ...Object.entries(LANGUAGES).map(([code, label]) => new Option(label, code)));
  $('#target-language').replaceChildren(...Object.entries(LANGUAGES).map(([code, label]) => new Option(label, code)));
  $('#source-language').value = settings.sourceLanguage; $('#target-language').value = settings.targetLanguage; $('#auto-subtitles').checked = settings.autoSubtitles;
  $('#subtitle-size').value = settings.subtitleSize; $('#subtitle-bottom').value = settings.subtitleBottom; $('#look-ahead').value = settings.lookAhead;
  loadModel(); updateModelBadge(); preview();
}
// Chrome 弹出主机授权框时会关掉工具栏弹窗，未保存的填写内容随之丢失；先暂存草稿，重开弹窗时恢复。
// 存 storage.session（仅内存，浏览器关闭即清空），10 分钟内有效，保存成功后清除。
const DRAFT = 'popup:draft';
function saveDraft() { if (extension) { readModel(); chrome.storage.session.set({ [DRAFT]: { at: Date.now(), model: settings.model } }).catch(() => {}); } }
async function restoreDraft() {
  const draft = extension && (await chrome.storage.session.get(DRAFT).catch(() => ({})))[DRAFT];
  if (!draft?.model || Date.now() - draft.at > 600000) return;
  Object.assign(settings.model, draft.model); loadModel(); showPanel('models');
  toast('已恢复未保存的模型配置；授权完成后请再点一次「测试翻译」或「保存」');
}
async function authorize(profile) {
  if (!extension) throw new Error('界面预览无法授予扩展权限，请先加载扩展');
  // 必须由用户点击事件直接触发，不在后台申请广泛的网页权限。
  if (!await chrome.permissions.request({ origins: [permissionOrigin(profile.baseUrl)] })) throw new Error('未授权模型接口主机，配置没有保存');
}
async function save({ model = false } = {}) {
  readModel(); readPreferences();
  const candidate = normalizeSettings(settings);
  await authorize(candidate.model);
  settings = await request({ type: 'SAVE_SETTINGS', settings: candidate }); updateModelBadge(); toast('已保存，设置立即生效');
  if (model && extension) chrome.storage.session.remove(DRAFT).catch(() => {});
}
async function pageAction(action, enabled) {
  const result = await request({ type: 'PAGE_ACTION', action, enabled });
  if (!result?.ok) throw new Error(result?.error || '当前网页没有响应，请刷新页面');
  const state = result.data;
  $('#subtitles').checked = state.subtitles; $('#subtitle-status').textContent = state.subtitles ? `已开启 · ${state.mode}${state.cues ? ` · ${state.cues} 条` : ''}${state.note ? `（${state.note}）` : ''}` : '开启后读取英文 CC 字幕';
  $('#page-status').textContent = state.pageStatus;
  return state;
}
function busy(button, action) {
  return async event => { event?.preventDefault(); button.disabled = true; try { await action(); } catch (error) { toast(error.message, true); } finally { button.disabled = false; } };
}

document.querySelectorAll('[data-panel]').forEach(button => button.onclick = () => showPanel(button.dataset.panel));
$('#model-form').addEventListener('input', saveDraft); $('#model-form').addEventListener('change', saveDraft);
$('#goto-models').onclick = () => showPanel('models');
$('#open-settings').onclick = () => { if (extension) chrome.runtime.openOptionsPage(); else location.search = '?settings=1'; };
$('#model-form').onsubmit = busy($('#model-form button[type="submit"]'), () => save({ model: true }));
$('#save-preferences').onclick = busy($('#save-preferences'), () => save());
$('#save-display').onclick = busy($('#save-display'), () => save());
$('#test-connection').onclick = busy($('#test-connection'), async () => {
  readModel(); readPreferences(); const candidate = normalizeSettings(settings);
  await authorize(candidate.model);
  $('#test-result').hidden = false; $('#test-result').classList.remove('error'); $('#test-result').textContent = '正在向模型发送测试句子…（首次加载模型可能稍慢）';
  try {
    const result = await request({ type: 'TEST', settings: candidate });
    $('#test-result').textContent = `连接成功 · ${(result.ms / 1000).toFixed(2)} 秒\n${result.text}`;
    $('#connection-tag').textContent = '已检测';
  } catch (error) { $('#test-result').textContent = error.message; $('#test-result').classList.add('error'); throw error; }
});
$('#subtitles').onchange = async () => {
  const desired = $('#subtitles').checked;
  try { await pageAction('subtitles', desired); } catch (error) { $('#subtitles').checked = !desired; toast(error.message, true); }
};
$('#translate-page').onclick = busy($('#translate-page'), async () => { await pageAction('translatePage'); toast('开始翻译正文，滚动页面可加载更多'); });
$('#restore-page').onclick = busy($('#restore-page'), async () => { await pageAction('restorePage'); toast('已移除译文，原文保持完整'); });
$('#clear-cache').onclick = busy($('#clear-cache'), async () => { await request({ type: 'CLEAR_CACHE' }); toast('后台缓存已清空；刷新视频可同时清空页面缓存'); });
['subtitle-size', 'subtitle-bottom', 'look-ahead'].forEach(id => $(`#${id}`).oninput = preview);
['subtitle-size', 'subtitle-bottom'].forEach(id => $(`#${id}`).addEventListener('input', () => { if (extension) request({ type: 'PREVIEW_STYLE', subtitleSize: +$('#subtitle-size').value, subtitleBottom: +$('#subtitle-bottom').value }).catch(() => {}); }));
if (new URLSearchParams(location.search).has('settings')) document.body.classList.add('options');
if (!extension) $('#preview-label').hidden = false;
try { settings = await request({ type: 'GET_SETTINGS' }); populate(); if (extension && !document.body.classList.contains('options')) await pageAction('status'); }
catch (error) { populate(); toast(error.message, true); }
await restoreDraft(); // 放在最后：读取页面状态失败时 catch 会重新 populate，不能盖掉草稿
