import { copyFileSync, mkdirSync } from 'node:fs';
const target = new URL('../dist/vendor/tencent-weixin/', import.meta.url);
mkdirSync(target, { recursive: true });
for (const name of ['LICENSE', 'SOURCES.md']) copyFileSync(new URL(`../src/vendor/tencent-weixin/${name}`, import.meta.url), new URL(name, target));
