#!/usr/bin/env node
/**
 * 모든 mdx/md/tsx/ts/css/json 파일의 image src 의 `.png` 확장자를 `.webp` 로 일괄 치환.
 * (PNG → WebP 변환 후 후속)
 *
 * 매칭 패턴:
 *   - markdown image:  ![alt](/img/.../foo.png)  →  ![alt](/img/.../foo.webp)
 *   - HTML <img src="/img/.../foo.png">  →  ...foo.webp
 *   - import statement: from '@site/static/img/.../foo.png'  → ...foo.webp
 *   - background-image: url(/img/.../foo.png)  → ...foo.webp
 *
 * 사용법:
 *   node scripts/rewrite-png-references.js
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(REPO_ROOT, 'docusaurus', 'docs'),
  path.join(REPO_ROOT, 'docusaurus', 'i18n', 'ko', 'docusaurus-plugin-content-docs', 'current'),
  path.join(REPO_ROOT, 'docusaurus', 'src'),
];
const EXTS = new Set(['.mdx', '.md', '.tsx', '.ts', '.jsx', '.js', '.css', '.json']);

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function processFile(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  if (!EXTS.has(ext)) return 0;
  const original = fs.readFileSync(filepath, 'utf8');

  // 안전한 매칭: /img/<path>.png 또는 (/img/<path>.png) 또는 "/img/<path>.png" 등
  // 대소문자 무관 .png. URL 안의 자산 path만.
  // Step 1: /img/...png 같은 site-relative path
  let next = original.replace(/(\/img\/[A-Za-z0-9_\-./%+ⅠⅡⅢⅣⅤ가-힣]+?)\.png\b/gi, '$1.webp');
  // Step 2: import path 안 .png (사용 거의 없을 듯)
  next = next.replace(/(@site\/static\/img\/[^'"`)]+?)\.png\b/gi, '$1.webp');

  if (next === original) return 0;
  fs.writeFileSync(filepath, next, 'utf8');
  return 1;
}

function main() {
  let scanned = 0;
  let changed = 0;
  for (const root of TARGETS) {
    for (const f of walk(root)) {
      scanned++;
      if (processFile(f)) changed++;
    }
  }
  console.log(`scanned: ${scanned}`);
  console.log(`changed: ${changed}`);
}

main();
