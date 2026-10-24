import { mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
await mkdir(`${root}/release`, { recursive: true });
const { version } = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
execFileSync('/usr/bin/zip', ['-qr', `${root}/release/yiban-lite-${version}.zip`, '.'], { cwd: `${root}/dist` });
console.log(`已打包：release/yiban-lite-${version}.zip`);
