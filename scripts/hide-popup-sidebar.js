#!/usr/bin/env node
/**
 * popup 페이지는 modal/reference 카드 성격이라 sidebar 트리에 노출하지 않는다.
 *   1. 각 popup .mdx frontmatter 에 `displayed_sidebar: false` 를 삽입.
 *      (이미 있으면 건너뜀)
 *   2. popup 디렉터리의 `_category_.json` 의 className 키 정리 (의미 없으면 제거).
 *
 *   대상:
 *     docusaurus/docs/popup/**.mdx
 *     docusaurus/i18n/ko/.../current/popup/**.mdx
 *
 *   사용법:
 *     node scripts/hide-popup-sidebar.js
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(REPO_ROOT, 'docusaurus', 'docs', 'popup'),
  path.join(REPO_ROOT, 'docusaurus', 'i18n', 'ko', 'docusaurus-plugin-content-docs', 'current', 'popup'),
];

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function ensureDisplayedSidebarNull(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
  if (!raw.startsWith('---\n')) return false;
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return false;
  let fm = raw.slice(4, end);

  // 잘못된 boolean 값 (false) 이 있으면 null로 교체. 없으면 새로 추가.
  if (/^displayed_sidebar:\s*false\s*$/m.test(fm)) {
    fm = fm.replace(/^displayed_sidebar:\s*false\s*$/m, 'displayed_sidebar: null');
  } else if (!/^displayed_sidebar:/m.test(fm)) {
    fm = fm.endsWith('\n') ? fm + 'displayed_sidebar: null\n' : fm + '\ndisplayed_sidebar: null\n';
  } else {
    return false; // 이미 올바른 값
  }
  const body = raw.slice(end);
  fs.writeFileSync(filepath, `---\n${fm}${body}`, 'utf8');
  return true;
}

function cleanCategoryJson(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  let changed = false;
  // className 'sidebar-hidden' 등 임시 식별자는 의미 없음 — 제거
  if ('className' in parsed) {
    delete parsed.className;
    changed = true;
  }
  // collapsible: false (popup은 보통 트리 펼치지 않음)
  if (parsed.collapsible !== false) {
    parsed.collapsible = false;
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(filepath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  }
  return changed;
}

function main() {
  let mdxChanged = 0;
  let mdxScanned = 0;
  let categoryChanged = 0;

  for (const root of TARGETS) {
    for (const f of walk(root)) {
      if (f.endsWith('.mdx') || f.endsWith('.md')) {
        mdxScanned++;
        if (ensureDisplayedSidebarNull(f)) mdxChanged++;
      } else if (path.basename(f) === '_category_.json') {
        if (cleanCategoryJson(f)) categoryChanged++;
      }
    }
  }

  console.log(`mdx scanned: ${mdxScanned}`);
  console.log(`mdx with displayed_sidebar: false added: ${mdxChanged}`);
  console.log(`_category_.json cleaned: ${categoryChanged}`);
}

main();
