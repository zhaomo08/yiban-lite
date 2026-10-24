import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, validateBaseUrl, endpoint, buildRequest, extractTranslation, parseJson3, findCue, LatestTask, LRU } from '../src/core.js';

test('不同接口路径，只允许本机或局域网地址', () => {
  assert.equal(endpoint({ protocol: 'ollama', baseUrl: 'http://127.0.0.1:11435/' }), 'http://127.0.0.1:11435/api/generate');
  assert.equal(endpoint({ protocol: 'openai', baseUrl: 'http://localhost:1234/v1' }), 'http://localhost:1234/v1/chat/completions');
  assert.equal(endpoint({ protocol: 'openai', baseUrl: 'http://10.0.0.2:8080/v1/chat/completions' }), 'http://10.0.0.2:8080/v1/chat/completions');
  for (const invalid of ['file:///etc/passwd', 'http://user:secret@127.0.0.1', 'http://cloud.example.com/v1', 'https://api.deepseek.com/v1', 'http://127.0.0.1?key=1']) assert.throws(() => validateBaseUrl(invalid));
  assert.equal(validateBaseUrl('http://192.168.1.20:11434'), 'http://192.168.1.20:11434');
});
test('默认值不被修改、旧版多配置迁移、HY-MT 提示词', () => {
  const settings = normalizeSettings(); settings.model.model = 'changed';
  assert.notEqual(normalizeSettings().model.model, 'changed');
  assert.throws(() => normalizeSettings({ targetLanguage: 'invalid' }));
  const old = normalizeSettings({ activeProfile: 'api', profiles: { mini: { name: 'Mini', baseUrl: 'http://127.0.0.1:11435', model: 'hy-mt2-1.8b:latest', apiKey: 'x' }, api: { baseUrl: 'https://api.deepseek.com/v1' } } });
  assert.deepEqual([old.model.baseUrl, old.model.model, 'apiKey' in old.model, 'profiles' in old], ['http://127.0.0.1:11435', 'hy-mt2-1.8b:latest', false, false]);
  const p = normalizeSettings().model;
  const r = buildRequest(p, 'Hello world', 'zh-CN');
  assert.match(r.body.prompt, /简体中文/); assert.match(r.body.prompt, /Hello world/); assert.equal(r.headers.Authorization, undefined);
  assert.match(buildRequest(p, 'Hallo', 'ja').body.prompt, /^Translate the following segment into Japanese/);
  assert.equal(buildRequest({ ...p, protocol: 'openai' }, 'hello', 'en').body.stream, false);
});
test('拒绝 HTTP 200 中的业务错误、空译文与截断译文', () => {
  assert.throws(() => extractTranslation({ error: { message: 'secret-key' } }, 'openai'), error => !error.message.includes('secret-key'));
  assert.throws(() => extractTranslation({ choices: [{ message: { content: '' } }] }, 'openai'));
  assert.throws(() => extractTranslation({ choices: [{ finish_reason: 'length', message: { content: '不完整' } }] }, 'openai'));
  assert.equal(extractTranslation({ response: '<think>reasoning</think> 你好' }, 'ollama'), '你好');
});
test('字幕时间轴、边界与稀疏区间', () => {
  const cues = parseJson3({ events: [{ tStartMs: 1000, dDurationMs: 5000, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] }, { tStartMs: 3500, dDurationMs: 1000, segs: [{ utf8: 'Next' }] }, { tStartMs: 6000, segs: [{ utf8: '\n' }] }] });
  assert.deepEqual(cues, [{ start: 1, end: 3.5, text: 'Hello world' }, { start: 3.5, end: 4.5, text: 'Next' }]);
  assert.equal(findCue(cues, .9), -1); assert.equal(findCue(cues, 3.5), 1); assert.equal(findCue(cues, 4.5), -1);
});
test('滚动字幕只保留最新任务，旧回复不能覆盖新字幕', async () => {
  const resolvers = [], delivered = [], calls = [];
  const worker = new LatestTask(text => { calls.push(text); return new Promise(resolve => resolvers.push(resolve)); }, (e, value, text) => delivered.push([text, value]));
  worker.submit('A'); worker.submit('B'); worker.submit('C');
  resolvers.shift()('旧译文'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['A', 'C']); assert.deepEqual(delivered, []);
  resolvers.shift()('最新译文'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(delivered, [['C', '最新译文']]);
  worker.submit('D'); worker.dispose(); resolvers.shift()('不应显示'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered.length, 1);
});
test('缓存有上限，访问时更新淘汰顺序', () => { const cache = new LRU(2); cache.set('a', 1); cache.set('b', 2); cache.get('a'); cache.set('c', 3); assert.equal(cache.get('b'), undefined); assert.equal(cache.get('a'), 1); });
