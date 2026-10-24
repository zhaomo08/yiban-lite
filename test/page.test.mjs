import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { collectBlocks, PageTranslator } from '../src/page.js';

test('正文扫描跳过密码、表单、代码、编辑区与已有译文', () => {
  const doc = new JSDOM('<nav><p>Skip navigation text</p></nav><form><p>Private account details</p><input type="password"></form><p contenteditable="true">Draft should never leave</p><pre><p>secret code example</p></pre><p>Regular article paragraph.</p><ul><li><p>Nested article paragraph.</p></li></ul><p translate="no">Do not translate this one.</p><div data-yiban="translation"><p>Generated output text.</p></div>').window.document;
  assert.deepEqual(collectBlocks(doc).map(b => b.text), ['Regular article paragraph.', 'Nested article paragraph.']);
});
test('译文为纯文本，恢复不改动原文结构，进行中的请求不会重新插入译文', async () => {
  const dom = new JSDOM('<article><p>Hello <a href="/docs">documentation</a> world.</p></article>');
  const doc = dom.window.document; const original = doc.querySelector('article').innerHTML;
  let callback, pending;
  globalThis.IntersectionObserver = class { constructor(cb) { callback = cb; } observe() {} unobserve() {} disconnect() {} };
  const translator = new PageTranslator(doc, () => new Promise(resolve => pending = resolve), () => {});
  await translator.start(); callback([{ isIntersecting: true, target: doc.querySelector('p') }]);
  pending({ text: '<img src=x onerror="alert(1)">' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.querySelector('.yiban-translation img'), null); assert.match(doc.querySelector('.yiban-translation').textContent, /<img/);
  translator.restore(); assert.equal(doc.querySelector('article').innerHTML, original);
  await translator.start(); callback([{ isIntersecting: true, target: doc.querySelector('p') }]); translator.restore(); pending({ text: '迟到的译文' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.querySelector('article').innerHTML, original); delete globalThis.IntersectionObserver;
});
