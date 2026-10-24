import { cleanText, splitText } from './core.js';

const IGNORE = 'script,style,pre,code,textarea,input,select,button,nav,header,footer,form,[contenteditable]:not([contenteditable="false"]),[translate="no"],[data-yiban],#yiban-root';
const BLOCKS = 'h1,h2,h3,h4,p,li,blockquote,figcaption,td,th';

export function collectBlocks(doc, limit = 120) {
  const blocks = [];
  for (const node of doc.querySelectorAll(BLOCKS)) {
    if (node.closest(IGNORE) || node.closest('[hidden],[aria-hidden="true"]') || node.querySelector(BLOCKS) || node.querySelector('input,textarea,[contenteditable="true"]')) continue;
    const copy = node.cloneNode(true);
    copy.querySelectorAll(IGNORE).forEach(n => n.remove());
    const text = cleanText(copy.textContent);
    if (text.length < 12 || text.length > 6000 || !/[a-zA-Z\u3040-\u30ff\u4e00-\u9fff]/.test(text)) continue;
    blocks.push({ node, text });
    if (blocks.length >= limit) break;
  }
  return blocks;
}

export class PageTranslator {
  constructor(doc, translate, status) { this.doc = doc; this.translate = translate; this.status = status; this.epoch = 0; this.outputs = new Set(); }
  async start() {
    this.restore();
    const epoch = this.epoch;
    const blocks = collectBlocks(this.doc);
    this.total = blocks.length; this.done = 0; this.failed = 0;
    if (!blocks.length) { this.status('没有找到可翻译的正文段落'); return; }
    this.status(`正文翻译中 · 0/${blocks.length}`);
    const queue = [];
    let running = false;
    const process = async () => {
      if (running || epoch !== this.epoch) return;
      running = true;
      while (queue.length && epoch === this.epoch) {
        const block = queue.shift();
        if (!block.node.isConnected) continue;
        const output = this.doc.createElement('div'); output.dataset.yiban = 'translation'; output.className = 'yiban-translation'; output.textContent = '正在翻译…';
        if (block.node.matches('li,td,th,blockquote')) block.node.append(output); else block.node.after(output);
        this.outputs.add(output);
        try {
          const parts = [];
          for (const chunk of splitText(block.text)) {
            if (epoch !== this.epoch) break;
            parts.push((await this.translate(chunk)).text);
          }
          if (epoch !== this.epoch) break;
          output.textContent = parts.join('\n'); output.classList.add('yiban-ready');
          this.done++;
        } catch (error) {
          if (epoch !== this.epoch) break;
          output.textContent = `翻译失败：${error.message}`; output.classList.add('yiban-error'); this.failed++;
          // 连接失败时停止排队，避免对整页反复发送失败请求。
          this.status(error.message); this.observer?.disconnect(); running = false; return;
        }
        this.status(`正文翻译 · ${this.done}/${this.total}${this.failed ? ` · ${this.failed} 段失败` : ''}`);
      }
      running = false;
    };
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { const block = blocks.find(b => b.node === entry.target); if (block) queue.push(block); this.observer.unobserve(entry.target); }
      process();
    }, { rootMargin: '240px' });
    blocks.forEach(b => this.observer.observe(b.node));
  }
  restore() { this.epoch++; this.observer?.disconnect(); for (const output of this.outputs) output.remove(); this.outputs.clear(); this.total = this.done = this.failed = 0; }
}
