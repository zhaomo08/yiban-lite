import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve(import.meta.dirname, '../dist');
const port = Number(process.env.PORT || 4318);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.writeHead(302, { Location: '/popup.html?settings=1' }); res.end(); return; }
  const file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try { const bytes = await readFile(file); res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(bytes); }
  catch { res.writeHead(404); res.end('未找到文件'); }
}).listen(port, '127.0.0.1', () => console.log(`界面预览：http://127.0.0.1:${port}（扩展功能需在 Chrome 加载 dist/）`));
