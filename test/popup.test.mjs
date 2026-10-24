import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { DEFAULT_SETTINGS } from '../src/core.js';

// 授权框会关掉弹窗：填写内容要能在重开弹窗后恢复
async function open(session) {
  const html = (await readFile(new URL('../popup.html', import.meta.url), 'utf8')).replace(/<script[^>]*><\/script>/, '');
  const dom = new JSDOM(html, { url: 'chrome-extension://test/popup.html' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Option: dom.window.Option, location: dom.window.location });
  globalThis.chrome = {
    runtime: { id: 'test', sendMessage: async m => m.type === 'GET_SETTINGS' ? { ok: true, data: structuredClone(DEFAULT_SETTINGS) } : { ok: true, data: { ok: true, data: { subtitles: false, pageStatus: '' } } } },
    storage: { session: { get: async key => ({ [key]: session[key] }), set: async v => Object.assign(session, v), remove: async key => { delete session[key]; } } }
  };
  await import(`../src/popup.js?${Math.random()}`);
  return dom.window.document;
}

test('弹窗被授权框关掉后，重开能恢复未保存的模型配置', async () => {
  const session = {};
  let doc = await open(session);
  doc.querySelector('#base-url').value = 'http://192.168.1.20:11434';
  doc.querySelector('#model').value = 'translategemma:4b';
  doc.querySelector('#model-form').dispatchEvent(new doc.defaultView.Event('input'));
  await new Promise(r => setTimeout(r, 10));
  doc = await open(session); // 模拟弹窗被关掉后重新打开
  assert.equal(doc.querySelector('#base-url').value, 'http://192.168.1.20:11434');
  assert.equal(doc.querySelector('#model').value, 'translategemma:4b');
  assert.equal(doc.querySelector('#panel-models').hidden, false);
});
