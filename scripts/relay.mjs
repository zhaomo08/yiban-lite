import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = await realpath(resolve(import.meta.dirname, '..'));
const args = process.argv.slice(2), position = args.indexOf('--extension-id');
// 未指定时使用 Chrome 对项目根目录生成的路径 ID。
const extensionId = position >= 0 ? args[position + 1] : createHash('sha256').update(root).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, n => String.fromCharCode(97 + parseInt(n, 16)));
if (!/^[a-p]{32}$/.test(extensionId || '')) throw new Error('扩展 ID 无效，请在模型设置中复制连接助手命令');
const allowedOrigin = `chrome-extension://${extensionId}`;
const port = Number(process.env.RELAY_PORT || 11435);
const tunnelPort = Number(process.env.RELAY_TUNNEL_PORT || 11437);
// 默认转发到本机的 Ollama（11434）与语音转写服务（server/asr.py，11440）；
// --ssh <主机>：模型在另一台机器上，经 SSH 隧道转发，对方端口无需对外开放
const sshAt = args.indexOf('--ssh'), sshHost = sshAt >= 0 ? args[sshAt + 1] : '';
if (sshAt >= 0 && !/^[\w.@-]+$/.test(sshHost || '')) throw new Error('--ssh 后请填写 SSH 主机名或 user@host');
const upstream = sshHost ? `http://127.0.0.1:${tunnelPort}` : 'http://127.0.0.1:11434';
const asrUpstream = sshHost ? `http://127.0.0.1:${tunnelPort + 1}` : 'http://127.0.0.1:11440';
const routes = new Set(['/api/generate', '/v1/chat/completions', '/api/tags', '/v1/models']);
let tunnel, closing = false;
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  // 浏览器请求一定带 Sec-Fetch-Site；Node fetch 也会带 Sec-Fetch-Mode，不能用它区分。
  const cli = !origin && !req.headers['sec-fetch-site'];
  if (origin !== allowedOrigin && !cli) { res.writeHead(403); res.end('此连接助手只允许指定的译伴扩展访问'); return; }
  if (origin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin'); res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.writeHead(204); res.end(); return;
  }
  if (req.method === 'GET' && req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, service: '译伴连接助手', extensionId })); return; }
  if (req.method === 'GET' && /^\/asr\?v=[\w-]{11}(&start=\d+(\.\d+)?)?$/.test(req.url)) {
    try {
      const result = await fetch(`${asrUpstream}${req.url}`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(await result.text());
    } catch { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'error', error: '无法连接语音转写服务（server/asr.py）' })); }
    return;
  }
  if (!routes.has(req.url) || (req.method !== 'POST' && req.method !== 'GET') || (req.method === 'GET' && !['/api/tags', '/v1/models'].includes(req.url)) || (req.method === 'POST' && !['/api/generate', '/v1/chat/completions'].includes(req.url))) { res.writeHead(404); res.end(); return; }
  let body = '', bytes = 0;
  try {
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 80000) { res.writeHead(413); res.end(); return; } body += chunk; }
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 28000);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      // 只转发 JSON 请求，不转发浏览器的 Origin、Cookie 或客户端授权头。
      const result = await fetch(`${upstream}${req.url}`, { method: req.method, headers: { 'Content-Type': 'application/json' }, body: req.method === 'POST' ? body : undefined, signal: controller.signal, redirect: 'error' });
      const data = await result.text();
      res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(data);
    } finally { clearTimeout(timeout); }
  } catch { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '无法连接 Ollama，请检查模型服务或 SSH 连接' })); }
});
function close() { if (closing) return; closing = true; tunnel?.kill('SIGTERM'); server.close(); setTimeout(() => process.exit(0), 200).unref(); }
process.on('SIGINT', close); process.on('SIGTERM', close);
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `本机 ${port} 端口已被占用，请关闭旧的 SSH 转发或连接助手后重试` : '连接助手无法启动'); close(); process.exitCode = 1; });
try {
  try { await fetch(`${upstream}/api/tags`, { signal: AbortSignal.timeout(800) }); }
  catch {
    if (!sshHost) throw new Error('本机 Ollama（127.0.0.1:11434）没有响应，请先启动 Ollama，或用 --ssh 连接另一台机器');
    tunnel = spawn('ssh', ['-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=30', '-N', '-L', `127.0.0.1:${tunnelPort}:127.0.0.1:11434`, '-L', `127.0.0.1:${tunnelPort + 1}:127.0.0.1:11440`, sshHost], { stdio: ['ignore', 'ignore', 'inherit'] });
    tunnel.on('error', () => { console.error('无法启动 ssh，请检查 SSH 配置'); close(); });
    tunnel.on('exit', () => { if (!closing) { console.error('SSH 通道已断开'); close(); } });
    const deadline = Date.now() + 10000;
    let connected = false;
    while (Date.now() < deadline && !closing) {
      try { const response = await fetch(`${upstream}/api/tags`, { signal: AbortSignal.timeout(600) }); if (response.ok) { connected = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!connected) throw new Error(`未能建立到 ${sshHost} 的 SSH 通道`);
  }
  if (!closing) server.listen(port, '127.0.0.1', () => { console.log(`连接助手已启动：http://127.0.0.1:${port}${sshHost ? `（经 SSH 转发到 ${sshHost}）` : ''}`); console.log(`仅允许扩展：${extensionId}；按 Ctrl+C 停止。`); });
} catch (error) { console.error(error.message); close(); process.exitCode = 1; }
