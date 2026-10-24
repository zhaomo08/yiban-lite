import { build } from 'esbuild';
import { mkdir, cp, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
await mkdir(`${root}/dist/assets`, { recursive: true });
for (const entry of ['background', 'popup', 'content', 'bridge', 'offscreen']) {
  await build({ entryPoints: [`${root}/src/${entry}.js`], outfile: `${root}/dist/${entry}.js`, bundle: true, format: ['content', 'bridge'].includes(entry) ? 'iife' : 'esm', target: 'chrome116', legalComments: 'none', sourcemap: false });
}
for (const file of ['manifest.json', 'popup.html', 'popup.css', 'offscreen.html']) await cp(`${root}/${file}`, `${root}/dist/${file}`);
// 无外部图片或字体依赖；生成透明圆角的双语标记。
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function chunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const b of payload) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, payload, checksum]);
}
for (const size of [16, 48, 128]) {
  const data = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size; const i = y * (size * 4 + 1) + 1 + x * 4;
    const cornerX = Math.max(.19 - u, u - .81, 0), cornerY = Math.max(.19 - v, v - .81, 0);
    let color = cornerX * cornerX + cornerY * cornerY > .19 ** 2 ? [0, 0, 0, 0] : [33, 61, 52, 255];
    if ((u > .2 && u < .56 && v > .25 && v < .32) || (u > .2 && u < .56 && v > .42 && v < .49) || (u > .2 && u < .44 && v > .59 && v < .66)) color = [228, 239, 209, 255];
    if (u > .62 && u < .82 && v > .6 && v < .82) color = [182, 209, 150, 255];
    color.forEach((c, n) => data[i + n] = c);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  await writeFile(`${root}/dist/assets/icon${size}.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0))]));
}
// 项目根目录与 dist/ 都可加载，避免误选根目录时报缺少脚本。
for (const file of ['background.js', 'popup.js', 'content.js', 'bridge.js', 'offscreen.js']) await cp(`${root}/dist/${file}`, `${root}/${file}`);
await cp(`${root}/dist/assets`, `${root}/assets`, { recursive: true });
console.log('已构建可直接加载的扩展：dist/（项目根目录也可直接加载）');
