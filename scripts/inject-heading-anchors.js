#!/usr/bin/env node
/**
 * 원본 Jekyll .md 의 헤딩에 붙어있던 `<a name="X"></a>` HTML anchor 정보를
 * 변환된 Docusaurus .mdx 의 동일 헤딩에 `{#X}` (Markdown heading-id) 로 부착한다.
 *
 *   원본:
 *     ### <a name="model-number"></a>**[Model Number (0)](#model-number-0)**
 *     ### <a name="cw-angle-limit"></a><a name="ccw-angle-limit"></a>**[CW/CCW Angle Limit(6, 8)](...)**
 *
 *   변환된 mdx (현재):
 *     #### Model Number (0)
 *     #### CW/CCW Angle Limit(6, 8)
 *
 *   결과:
 *     <a id="model-number" />
 *     #### Model Number (0)
 *     <a id="cw-angle-limit" />
 *     <a id="ccw-angle-limit" />
 *     #### CW/CCW Angle Limit(6, 8)
 *
 *     (MDX 3에서는 `{#X}` heading-id 구문이 JSX expression 파싱과 충돌하므로
 *      invisible `<a id="..." />` 를 헤딩 직전(또는 직후)에 둔다. 브라우저
 *      anchor scroll은 거의 동일한 위치로 이동한다.)
 *
 *   사용법:
 *     node scripts/inject-heading-anchors.js dxl/ax
 *       → source/docs/{en,kr}/dxl/ax/*.md  ↔  docusaurus/docs/dxl/ax/*.mdx
 *         + docusaurus/i18n/ko/.../dxl/ax/*.mdx
 *
 *   동일 시리즈를 다시 실행하면 이미 부착된 `{#...}` 는 건너뛴다(idempotent).
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

function usage() {
  console.error('usage: node scripts/inject-heading-anchors.js <relative/series>');
  console.error('  e.g.  node scripts/inject-heading-anchors.js dxl/ax');
  process.exit(2);
}

const series = process.argv[2];
if (!series) usage();

const SOURCE_EN = path.join(REPO_ROOT, 'source', 'docs', 'en', series);
const SOURCE_KR = path.join(REPO_ROOT, 'source', 'docs', 'kr', series);
const OUT_EN = path.join(REPO_ROOT, 'docusaurus', 'docs', series);
const OUT_KO = path.join(
  REPO_ROOT,
  'docusaurus',
  'i18n',
  'ko',
  'docusaurus-plugin-content-docs',
  'current',
  series,
);

/**
 * 원본 .md에서 헤딩별 anchor 정보를 추출.
 *   { visibleText: "Model Number (0)", anchors: ["model-number"], rawLine: "..." }
 */
function extractHeadingAnchors(filepath) {
  const txt = fs.readFileSync(filepath, 'utf8');
  const result = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    const headingBody = m[2];

    // anchor: <a name="X"></a> 패턴 (여러 개 가능)
    const anchors = [];
    const reA = /<a\s+name=["']([^"']+)["']\s*>\s*<\/a>/gi;
    let mm;
    while ((mm = reA.exec(headingBody)) !== null) {
      anchors.push(mm[1]);
    }
    if (anchors.length === 0) continue;

    // visible text: <a> 태그 + 마크다운 링크 + bold 마크다운 제거
    let visible = headingBody
      .replace(/<a\s+[^>]*>\s*<\/a>/gi, '')
      .replace(/<\/?[^>]+>/g, '')
      .trim();
    // **[Foo (0)](#foo-0)** → Foo (0)
    visible = visible.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    visible = visible.replace(/\*\*/g, '').trim();

    result.push({ visibleText: visible, anchors });
  }
  return result;
}

/** mdx 헤딩의 visible text 정규화 */
function normalize(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[​ ]/g, ' ')
    .trim();
}

/**
 * .mdx에 anchor 부착.
 *   같은 visible text를 가진 헤딩을 찾아서 첫 anchor를 `{#x}` 로 부착,
 *   추가 anchor는 헤딩 다음 줄에 invisible span 으로 삽입.
 *   이미 `{#...}` 가 붙은 헤딩은 건너뜀.
 */
function injectIntoMdx(mdxPath, headings) {
  if (!fs.existsSync(mdxPath)) return { skipped: true };

  const original = fs.readFileSync(mdxPath, 'utf8');
  const lines = original.split(/\r?\n/);

  // visibleText → headings entry  (multimap 가능, 순서 유지)
  const queues = new Map();
  for (const h of headings) {
    const key = normalize(h.visibleText);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(h);
  }

  const out = [];
  let injected = 0;
  let alreadyHadId = 0;
  let unmatched = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (!m) {
      out.push(line);
      continue;
    }

    let body = m[2];

    // mdx의 visible text 정규화 (이미 <a name>가 인라인되어 있으면 제거)
    const visibleNorm = normalize(
      body
        .replace(/<a\s+name=["'][^"']+["']\s*>\s*<\/a>/gi, '')
        .replace(/<a\s+id=["'][^"']+["']\s*\/?\s*>\s*(?:<\/a>)?/gi, '')
        .replace(/\*\*/g, '')
    );
    const queue = queues.get(visibleNorm);
    if (!queue || queue.length === 0) {
      out.push(line);
      continue;
    }

    // 직전 줄들이 이미 우리가 부착한 <a id="..." /> 이면 skip (idempotent)
    const prevLine = out.length > 0 ? out[out.length - 1] : '';
    if (/^<a id="[^"]+"\s*><\/a>$/.test(prevLine.trim())) {
      out.push(line);
      alreadyHadId++;
      // queue에서 소비 (중복 부착 방지)
      queue.shift();
      continue;
    }

    const h = queue.shift();
    // 모든 anchor를 헤딩 직전 invisible span 으로 부착
    for (const a of h.anchors) {
      out.push(`<a id="${a}"></a>`);
      injected++;
    }
    out.push(line);
  }

  // unmatched: source에 있었지만 mdx에서 못 찾은 것
  for (const [, q] of queues) unmatched += q.length;

  const next = out.join('\n');
  if (next === original) return { changed: false, injected, alreadyHadId, unmatched };

  fs.writeFileSync(mdxPath, next, 'utf8');
  return { changed: true, injected, alreadyHadId, unmatched };
}

function processFile(stem, sourceEnPath, sourceKrPath) {
  const r = { stem, en: null, ko: null };

  // en
  const sourceEn = sourceEnPath || path.join(SOURCE_EN, `${stem}.md`);
  const mdxEn = path.join(OUT_EN, `${stem}.mdx`);
  if (fs.existsSync(sourceEn) && fs.existsSync(mdxEn)) {
    const h = extractHeadingAnchors(sourceEn);
    r.en = { anchors: h.length, ...injectIntoMdx(mdxEn, h) };
  }

  // ko
  const sourceKr = sourceKrPath || path.join(SOURCE_KR, `${stem}.md`);
  const mdxKo = path.join(OUT_KO, `${stem}.mdx`);
  if (fs.existsSync(sourceKr) && fs.existsSync(mdxKo)) {
    const h = extractHeadingAnchors(sourceKr);
    r.ko = { anchors: h.length, ...injectIntoMdx(mdxKo, h) };
  }

  return r;
}

/** 재귀적으로 .md 파일을 찾아 stem 매핑 생성 (서브디렉터리 포함) */
function collectStemsRecursive(rootDir) {
  const map = new Map(); // stem (basename without .md) → fullPath
  if (!fs.existsSync(rootDir)) return map;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const stem = entry.name.replace(/\.md$/, '');
        // first wins
        if (!map.has(stem)) map.set(stem, full);
      }
    }
  }
  walk(rootDir);
  return map;
}

function main() {
  if (!fs.existsSync(SOURCE_EN)) {
    console.error(`source not found: ${SOURCE_EN}`);
    process.exit(1);
  }
  // 출력 mdx 파일들을 기준으로 stems 결정 (변환 스크립트가 출력한 파일들이 진실)
  const mdxStems = fs.existsSync(OUT_EN)
    ? fs.readdirSync(OUT_EN).filter((f) => f.endsWith('.mdx')).map((f) => f.replace(/\.mdx$/, ''))
    : [];

  // 원본은 서브디렉터리 가능 → 재귀 인덱스
  const enIndex = collectStemsRecursive(SOURCE_EN);
  const krIndex = collectStemsRecursive(SOURCE_KR);

  // 루트 .md 파일만 있을 때를 대비해 평면 stems도 포함
  const flatStems = fs
    .readdirSync(SOURCE_EN)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
  const stems = mdxStems.length > 0 ? mdxStems : flatStems;

  let total = { injected: 0, alreadyHadId: 0, unmatched: 0, files: 0 };
  for (const stem of stems) {
    const r = processFile(stem, enIndex.get(stem), krIndex.get(stem));
    if (!r.en && !r.ko) continue;
    total.files++;

    const enS = r.en ? `en: +${r.en.injected} (skipped ${r.en.alreadyHadId}, unmatched ${r.en.unmatched})` : 'en: -';
    const koS = r.ko ? `ko: +${r.ko.injected} (skipped ${r.ko.alreadyHadId}, unmatched ${r.ko.unmatched})` : 'ko: -';
    console.log(`${series}/${stem} → ${enS} | ${koS}`);

    for (const k of ['en', 'ko']) {
      if (r[k]) {
        total.injected += r[k].injected;
        total.alreadyHadId += r[k].alreadyHadId;
        total.unmatched += r[k].unmatched;
      }
    }
  }
  console.log('---');
  console.log(`total files processed: ${total.files}`);
  console.log(`anchors injected: ${total.injected}`);
  console.log(`headings already had id (skipped): ${total.alreadyHadId}`);
  console.log(`source anchors not matched in mdx: ${total.unmatched}`);
}

main();
