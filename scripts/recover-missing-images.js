#!/usr/bin/env node
/**
 * 빌드 워닝에 누적된 broken-image들을 source에서 찾아 docusaurus/static/img/ 로 복사.
 *
 *   1. 모든 .mdx의 markdown image URL `/img/<path>` 추출
 *   2. docusaurus/static/img/<path> 가 없으면 source에서 동명 파일 검색
 *      후보: source/assets/images/<path>, source/assets/images/<basename>
 *   3. 찾으면 복사
 *   4. 또한 본문의 backslash path (`/assets/images\foo\bar`) → forward slash
 *      로 정규화
 *
 *   사용법:
 *     node scripts/recover-missing-images.js
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_ASSETS = path.join(REPO_ROOT, 'source', 'assets', 'images');
const DOCUSAURUS_IMG = path.join(REPO_ROOT, 'docusaurus', 'static', 'img');
const TARGETS = [
  path.join(REPO_ROOT, 'docusaurus', 'docs'),
  path.join(REPO_ROOT, 'docusaurus', 'i18n', 'ko', 'docusaurus-plugin-content-docs', 'current'),
];

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/** source/assets/images 에 basename 일치하는 파일 검색 (case-insensitive) */
function findInSource(rel, basename) {
  // 직접 경로 시도
  const direct = path.join(SOURCE_ASSETS, rel);
  if (fs.existsSync(direct)) return direct;
  // case-variant 시도
  const dirOf = path.dirname(direct);
  if (fs.existsSync(dirOf)) {
    for (const name of fs.readdirSync(dirOf)) {
      if (name.toLowerCase() === basename.toLowerCase()) {
        return path.join(dirOf, name);
      }
    }
  }
  // 전역 basename 검색 (느림 — 마지막 수단)
  for (const f of walk(SOURCE_ASSETS)) {
    if (path.basename(f).toLowerCase() === basename.toLowerCase()) {
      return f;
    }
  }
  return null;
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function main() {
  // 1단계: backslash path 정규화 (mdx 파일 내부)
  let bsFixed = 0;
  for (const root of TARGETS) {
    for (const f of walk(root)) {
      if (!f.endsWith('.mdx') && !f.endsWith('.md')) continue;
      const original = fs.readFileSync(f, 'utf8');
      // /assets/images\foo\bar 또는 /img\foo\bar 같은 backslash path
      const next = original.replace(/(\/(?:assets\/images|img))((?:\\[^\s)"'>]+)+)/g, (_, head, rest) => {
        return head + rest.replace(/\\/g, '/');
      });
      if (next !== original) {
        fs.writeFileSync(f, next, 'utf8');
        bsFixed++;
      }
    }
  }
  console.log(`backslash path normalized in: ${bsFixed} files`);

  // 2단계: 모든 .mdx 의 /img/<path> 참조 수집
  const referenced = new Set();
  for (const root of TARGETS) {
    for (const f of walk(root)) {
      if (!f.endsWith('.mdx') && !f.endsWith('.md')) continue;
      const txt = fs.readFileSync(f, 'utf8');
      // markdown image: ![](path) or ![alt](path)
      // 또는 src="..." HTML 이미지
      const re = /!\[[^\]]*\]\((\/img\/[^)\s)]+)\)|src=["'](\/img\/[^"']+)["']/g;
      let m;
      while ((m = re.exec(txt)) !== null) {
        referenced.add(m[1] || m[2]);
      }
    }
  }
  console.log(`unique /img/* references: ${referenced.size}`);

  // 3단계: 없는 파일은 source에서 찾아 복사
  let copied = 0;
  let stillMissing = 0;
  const missingSamples = [];
  for (const ref of referenced) {
    const rel = ref.replace(/^\/img\//, '');
    const dst = path.join(DOCUSAURUS_IMG, rel);
    if (fs.existsSync(dst)) continue;
    const found = findInSource(rel, path.basename(rel));
    if (!found) {
      stillMissing++;
      if (missingSamples.length < 8) missingSamples.push(ref);
      continue;
    }
    ensureDir(dst);
    fs.copyFileSync(found, dst);
    copied++;
  }
  console.log(`copied from source: ${copied}`);
  console.log(`still missing: ${stillMissing}`);
  if (missingSamples.length) {
    console.log(`missing samples:`);
    for (const s of missingSamples) console.log(`  - ${s}`);
  }
}

main();
