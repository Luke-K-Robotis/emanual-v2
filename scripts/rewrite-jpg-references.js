#!/usr/bin/env node
/**
 * .mdx/.md/.tsx/.ts/.css/.json 의 image src `.jpg`/`.jpeg` 확장자 → `.webp`.
 *   단, 같은 stem의 .webp 파일이 실제 docusaurus/static/img 에 존재할 때만 치환.
 *   (basename collision으로 미변환 JPG 14개는 .jpg 그대로 유지)
 *
 * 사용법:
 *   node scripts/rewrite-jpg-references.js
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const STATIC_IMG = path.join(REPO_ROOT, 'docusaurus', 'static', 'img');
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

/** /img/<...>.<ext> URL → static/img 안 실제 파일이 .webp로 존재하는지 검증 */
function webpExistsFor(imgUrlPath) {
  // imgUrlPath: /img/foo/bar.jpg
  const rel = imgUrlPath.replace(/^\/img\//, '').replace(/\.(jpg|jpeg)$/i, '.webp');
  const full = path.join(STATIC_IMG, rel);
  return fs.existsSync(full);
}

function processFile(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  if (!EXTS.has(ext)) return 0;
  const original = fs.readFileSync(filepath, 'utf8');

  let edits = 0;
  // /img/<path>.jpg or .jpeg
  const next = original.replace(/(\/img\/[A-Za-z0-9_\-./%+ⅠⅡⅢⅣⅤ가-힣 ]+?)\.(jpg|jpeg)\b/gi, (full, head) => {
    if (webpExistsFor(`${head}.jpg`)) {
      edits++;
      return `${head}.webp`;
    }
    return full;
  });

  if (edits === 0) return 0;
  fs.writeFileSync(filepath, next, 'utf8');
  return edits;
}

function main() {
  let scannedFiles = 0;
  let changedFiles = 0;
  let totalEdits = 0;
  for (const root of TARGETS) {
    for (const f of walk(root)) {
      scannedFiles++;
      const e = processFile(f);
      if (e > 0) {
        changedFiles++;
        totalEdits += e;
      }
    }
  }
  console.log(`scanned files: ${scannedFiles}`);
  console.log(`changed files: ${changedFiles}`);
  console.log(`total references rewritten: ${totalEdits}`);
}

main();
