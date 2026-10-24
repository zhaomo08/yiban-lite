import { Translator } from '../src/translator.js';
import { DEFAULT_SETTINGS } from '../src/core.js';
// 用真实模型服务检查两种协议；BASE_URL 指向 Ollama 或连接助手
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:11434';
const model = process.env.MODEL || DEFAULT_SETTINGS.model.model;
const translator = new Translator();
const sample = 'How many of you have heard of the infinite monkey theorem?';
for (const protocol of ['ollama', 'openai']) {
  const profile = { ...DEFAULT_SETTINGS.model, baseUrl: protocol === 'openai' ? `${baseUrl}/v1` : baseUrl, model, protocol };
  const result = await translator.translate(profile, sample, 'zh-CN');
  const cached = await translator.translate(profile, sample, 'zh-CN');
  if (!/[\u4e00-\u9fff]/.test(result.text) || !cached.cached) throw new Error('实际译文或缓存验证失败');
  console.log(JSON.stringify({ protocol, model, translation: result.text, ms: result.ms, cacheHit: cached.cached }));
}
