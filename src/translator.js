import { buildRequest, extractTranslation, LRU } from './core.js';

export class Translator {
  constructor(fetcher = fetch) { this.fetcher = fetcher; this.cache = new LRU(); this.inflight = new Map(); this.controllers = new Set(); this.generation = 0; }
  clear() { this.generation++; this.cache.clear(); for (const c of this.controllers) c.abort(); this.inflight.clear(); }
  async translate(profile, text, language) {
    if (typeof text !== 'string' || !text.trim() || text.length > 6000) throw new Error('文本须为 1–6000 个字符');
    const key = JSON.stringify([this.generation, profile.baseUrl, profile.protocol, profile.model, profile.promptStyle, language, text]);
    const cached = this.cache.get(key);
    if (cached !== undefined) return { text: cached, cached: true, ms: 0 };
    if (this.inflight.has(key)) return this.inflight.get(key);
    const task = this.request(profile, text, language).then(result => {
      if (key.startsWith(`[${this.generation},`)) this.cache.set(key, result.text);
      return result;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }
  async request(profile, text, language) {
    const request = buildRequest(profile, text, language);
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), (profile.timeout || 25) * 1000);
    const start = Date.now();
    try {
      const response = await this.fetcher(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal, redirect: 'error', credentials: 'omit' });
      if (!response.ok) {
        const hints = { 403: '模型服务拒绝了扩展请求：直连 Ollama 需设置 OLLAMA_ORIGINS=chrome-extension://* 后重启 Ollama', 404: '接口路径或模型不存在，请确认已 ollama pull 该模型' };
        throw new Error(hints[response.status] || `模型服务返回 HTTP ${response.status}`);
      }
      const raw = await response.text();
      if (raw.length > 150000) throw new Error('模型响应过大');
      let data; try { data = JSON.parse(raw); } catch { throw new Error('接口没有返回 JSON，请检查 Base URL 和协议'); }
      return { text: extractTranslation(data, profile.protocol), cached: false, ms: Date.now() - start };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('翻译已取消或超时；请检查模型速度和连接');
      if (error instanceof TypeError) throw new Error(`无法连接模型（${error.message.slice(0, 120)}），请检查模型服务是否运行、地址与主机授权；直连 Ollama 需设置 OLLAMA_ORIGINS`);
      throw error;
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
}
