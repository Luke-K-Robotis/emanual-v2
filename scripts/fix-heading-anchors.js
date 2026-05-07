#!/usr/bin/env node
/**
 * heading line 내부에 markdown self-link `[text](#X)` 또는 인라인 `<a name="X"></a>`,
 * `<a id="X"></a>` 가 남아있으면 빌드 시 nested <a> 태그가 되어 HTML minifier
 * SSG-warning 발생. 이를 정리한다.
 *
 *   처리:
 *     ## [Camera Calibration](#camera-calibration)<a name="camera-calibration"></a>
 *       →  <a id="camera-calibration"></a>
 *           ## Camera Calibration
 *
 *     ### [Velocity PI Gain(524, 526), Feedforward 2nd Gains(536)](#velocity-pi-gain524-526, ...)
 *       →  ### Velocity PI Gain(524, 526), Feedforward 2nd Gains(536)
 *
 *     # [Getting Started](#getting-started) - (~ 2023)
 *       →  # Getting Started - (~ 2023)
 *
 *   사용법:
 *     node scripts/fix-heading-anchors.js
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
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

/** heading line에서 markdown link[text](#...)와 <a> 태그를 제거. anchor는 헤딩 직전으로 분리 */
function fixHeadingLine(line) {
  const m = line.match(/^(#{1,6})\s+(.*)$/);
  if (!m) return { changed: false, before: [], heading: line };

  const hashes = m[1];
  let body = m[2];

  // <a name="X"></a> 또는 <a id="X"></a> 추출
  const anchors = [];
  body = body.replace(/<a\s+(?:name|id)=["']([^"']+)["']\s*>\s*<\/a>/gi, (_, id) => {
    anchors.push(id);
    return '';
  });

  // markdown link [text](#anything) — 첫 # 으로 시작하는 target 만
  // greedy하지 않게 처리 (inner parens 케이스 대응 위해 lazy)
  body = body.replace(/\[([^\]]+)\]\(#[^\)]*\)/g, '$1');

  // 다중 공백 정리
  body = body.replace(/\s+/g, ' ').trim();

  const before = anchors.map((a) => `<a id="${a}"></a>`);
  const heading = `${hashes} ${body}`;

  // 변경 여부 판단
  const changed = anchors.length > 0 || heading !== line;
  return { changed, before, heading };
}

function processFile(filepath) {
  const original = fs.readFileSync(filepath, 'utf8');
  const lines = original.split(/\r?\n/);
  const out = [];
  let edits = 0;

  for (const line of lines) {
    const r = fixHeadingLine(line);
    if (!r.changed) {
      out.push(line);
      continue;
    }
    // 이전 줄이 이미 같은 anchor면 중복 부착 방지
    const prevLine = out.length > 0 ? out[out.length - 1] : '';
    for (const anchorLine of r.before) {
      if (prevLine.trim() !== anchorLine) {
        out.push(anchorLine);
      }
    }
    out.push(r.heading);
    edits++;
  }

  if (edits === 0) return 0;
  fs.writeFileSync(filepath, out.join('\n'), 'utf8');
  return edits;
}

function main() {
  let filesChanged = 0;
  let totalEdits = 0;
  for (const root of TARGETS) {
    for (const f of walk(root)) {
      if (!f.endsWith('.mdx') && !f.endsWith('.md')) continue;
      const edits = processFile(f);
      if (edits > 0) {
        filesChanged++;
        totalEdits += edits;
      }
    }
  }
  console.log(`files changed: ${filesChanged}`);
  console.log(`heading lines fixed: ${totalEdits}`);
}

main();
