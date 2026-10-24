import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/core.js';

test('扩展消息边界：设置仅在扩展 UI 可读，翻译需启用页面，按主机授权', async () => {
  const values = { settings: structuredClone(DEFAULT_SETTINGS) }, session = {};
  let listener, trusted = false, authorized = false, networkCalls = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkCalls++; return new Response(JSON.stringify({ response: '你好' })); };
  globalThis.chrome = {
    storage: {
      local: { setAccessLevel: async ({ accessLevel }) => { trusted = accessLevel === 'TRUSTED_CONTEXTS'; }, get: async () => values, set: async next => Object.assign(values, next) },
      session: { get: async key => ({ [key]: session[key] }), set: async next => Object.assign(session, next), remove: async key => { delete session[key]; } }
    },
    runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`, onMessage: { addListener: cb => listener = cb },
      // 模拟 offscreen 页面代发请求
      sendMessage: async m => m.type === 'FETCH' ? fetch(m.url, m.init).then(async r => ({ ok: r.ok, status: r.status, text: await r.text() })) : undefined },
    offscreen: { hasDocument: async () => true },
    permissions: { contains: async () => authorized },
    tabs: { query: async () => [{ id: 1, url: 'https://www.youtube.com/watch?v=test' }], sendMessage: async () => ({ ok: true, data: {} }), onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
    scripting: { executeScript: async () => {} }
  };
  try {
    await import('../src/background.js');
    const send = (type, payload = {}, sender = { id: 'test-extension', tab: { id: 1, url: 'https://www.youtube.com/watch?v=test' }, url: 'https://www.youtube.com/watch?v=test' }) => new Promise(resolve => listener({ type, ...payload }, sender, resolve));
    const ui = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html?settings=1', tab: { id: 2 } };
    assert.equal(trusted, true);
    const publicResult = await send('PUBLIC_SETTINGS'); assert.equal(publicResult.ok, true); assert.equal(publicResult.data.model, DEFAULT_SETTINGS.model.model);
    assert.equal((await send('GET_SETTINGS')).ok, false);
    assert.equal((await send('GET_SETTINGS', {}, ui)).data.model.baseUrl, DEFAULT_SETTINGS.model.baseUrl);
    assert.equal((await send('TRANSLATE', { kind: 'subtitle', text: 'Hello' })).ok, false); assert.equal(networkCalls, 0);
    await send('PAGE_ACTION', { action: 'subtitles', enabled: true }, ui);
    assert.equal((await send('TRANSLATE', { kind: 'subtitle', text: 'Hello' })).ok, false); assert.equal(networkCalls, 0);
    authorized = true;
    assert.equal((await send('TRANSLATE', { kind: 'subtitle', text: 'Hello' })).data.text, '你好'); assert.equal(networkCalls, 1);
    assert.equal((await send('TRANSLATE', { kind: 'page', text: 'Hello' })).ok, false);
    await send('STOP_SUBTITLES'); assert.equal((await send('TRANSLATE', { kind: 'subtitle', text: 'Hello' })).ok, false);
    await send('TEST', { settings: values.settings }, ui); await send('TEST', { settings: values.settings }, ui);
    assert.equal(networkCalls, 3, '连接测试每次真实请求，不用缓存掩盖配置错误');
  } finally { globalThis.fetch = oldFetch; delete globalThis.chrome; }
});
