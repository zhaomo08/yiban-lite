import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Translator } from '../src/translator.js';
import { DEFAULT_SETTINGS } from '../src/core.js';

test('真实 HTTP 链路：Ollama / OpenAI 协议、并发去重、缓存隔离', async () => {
  let count = 0;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); count++;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/generate') { assert.match(data.prompt, /hello/); res.end(JSON.stringify({ response: '你好' })); }
    else { assert.equal(req.url, '/v1/chat/completions'); assert.equal(data.messages[0].role, 'user'); res.end(JSON.stringify({ choices: [{ message: { content: '您好' } }] })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const p = { ...DEFAULT_SETTINGS.model, baseUrl: url };
    const translator = new Translator();
    const [a, b] = await Promise.all([translator.translate(p, 'hello', 'zh-CN'), translator.translate(p, 'hello', 'zh-CN')]);
    assert.equal(a.text, '你好'); assert.equal(b.text, a.text); assert.equal(count, 1);
    assert.equal((await translator.translate(p, 'hello', 'zh-CN')).cached, true);
    assert.equal((await translator.translate({ ...p, protocol: 'openai', baseUrl: `${url}/v1` }, 'hello', 'zh-CN')).text, '您好');
    assert.equal(count, 2);
    translator.clear(); await translator.translate(p, 'hello', 'zh-CN'); assert.equal(count, 3);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('响应体不进入用户错误信息，403 提示 OLLAMA_ORIGINS', async () => {
  const translator = new Translator(async () => new Response('internal-detail', { status: 403 }));
  await assert.rejects(translator.translate(DEFAULT_SETTINGS.model, 'hi', 'zh-CN'), error => /OLLAMA_ORIGINS/.test(error.message) && !error.message.includes('internal-detail'));
});
test('超时会终止实际 fetch', async () => {
  const translator = new Translator((url, options) => new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(new Error('aborted'))); }));
  await assert.rejects(translator.translate({ ...DEFAULT_SETTINGS.model, timeout: .01 }, 'hello', 'zh-CN'), /超时/);
});
test('保存新设置后，旧请求不能写回缓存', async () => {
  let resolve;
  const translator = new Translator(() => new Promise(done => resolve = done));
  const pending = translator.translate(DEFAULT_SETTINGS.model, 'hello', 'zh-CN');
  translator.clear(); resolve(new Response(JSON.stringify({ response: '旧结果' })));
  await pending; assert.equal(translator.cache.map.size, 0);
});
