#!/usr/bin/env node
/**
 * Software 영역의 나머지 페이지 변환 스크립트.
 *
 * 처리 대상 (~55 페이지):
 *   1. dynamixel/wizard2, workbench (2)
 *   2. dynamixel/dynamixel_easy_sdk/*.md (17)
 *   3. embedded_sdk/*.md (4)
 *   4. opencm_ide/*.md (2)
 *   5. robotis_framework_packages/*.md (2)
 *   6. robotis_manipulator_libs/*.md (1)
 *   7. mobile_app/*.md (1)
 *   8. arduino_ide.md (1)
 *   9. all-software.md → docs/software/index.mdx (placeholder 교체)
 *  10. rplus1/*.md (8 incl. rplus1/task/*)
 *  11. rplus2/*.md (6)
 *  12. rplustask3/*.md (7)
 *  13. rplus_mobile/*.md (3)
 *
 * 사용: node scripts/convert-software-rest.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SRC_EN = path.join(REPO, 'source/docs/en');
const SRC_KR = path.join(REPO, 'source/docs/kr');
const SRC_INCLUDES = path.join(REPO, 'source/_includes');
const OUT_EN_ROOT = path.join(REPO, 'docusaurus/docs');
const OUT_KO_ROOT = path.join(
  REPO,
  'docusaurus/i18n/ko/docusaurus-plugin-content-docs/current',
);
const ASSET_SRC_ROOT = path.join(REPO, 'source/assets');
const ASSET_OUT_ROOT = path.join(REPO, 'docusaurus/static/img');

// ------------------------------------------------------------
// 유틸
// ------------------------------------------------------------
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function writeOut(p, content) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content);
}
function copyFile(src, dst) {
  if (!fs.existsSync(src)) return false;
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  return true;
}
function exists(p) {
  return fs.existsSync(p);
}
function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}

const FENCE_NORMALIZE = {
  '': 'text',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  python: 'python',
  py: 'python',
  java: 'java',
  cs: 'csharp',
  csharp: 'csharp',
  m: 'matlab',
  matlab: 'matlab',
  bash: 'bash',
  shell: 'bash',
  sh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  text: 'text',
};

// ------------------------------------------------------------
// Frontmatter
// ------------------------------------------------------------
function splitFrontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: src };
  const fmRaw = m[1];
  const body = src.slice(m[0].length);
  const fm = {};
  let curKey = null;
  fmRaw.split(/\r?\n/).forEach((line) => {
    const top = line.match(/^([A-Za-z_][\w]*)\s*:\s*(.*)$/);
    if (top) {
      const v = top[2].trim();
      if (v === '') {
        fm[top[1]] = {};
        curKey = top[1];
      } else {
        fm[top[1]] = v.replace(/^['"]|['"]$/g, '');
        curKey = null;
      }
    } else if (/^\s+/.test(line) && curKey && typeof fm[curKey] === 'object') {
      const sub = line.trim().match(/^([A-Za-z_][\w]*)\s*:\s*(.*)$/);
      if (sub) fm[curKey][sub[1]] = sub[2].replace(/^['"]|['"]$/g, '');
    }
  });
  return { fm, body };
}

function buildFmYaml(fm) {
  const lines = ['---'];
  if (fm.id) lines.push(`id: ${fm.id}`);
  if (fm.title) lines.push(`title: ${JSON.stringify(fm.title)}`);
  if (fm.sidebar_label) lines.push(`sidebar_label: ${JSON.stringify(fm.sidebar_label)}`);
  if (fm.sidebar_position !== undefined) lines.push(`sidebar_position: ${fm.sidebar_position}`);
  if (fm.slug) lines.push(`slug: ${fm.slug}`);
  if (fm.tags && fm.tags.length) lines.push(`tags: [${fm.tags.join(', ')}]`);
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

// ------------------------------------------------------------
// Liquid include resolver (재귀)
// ------------------------------------------------------------
function resolveInclude(includePath, depth = 0) {
  if (depth > 5) return `<!-- include depth limit: ${includePath} -->`;
  const full = path.join(SRC_INCLUDES, includePath);
  if (!fs.existsSync(full)) return null;
  let txt = fs.readFileSync(full, 'utf8');
  txt = txt.replace(/\{%\s*include\s+([^\s%]+)\s*%\}/g, (_, p) => {
    const inc = resolveInclude(p, depth + 1);
    return inc === null ? `<!-- unresolved include: ${p} -->` : inc;
  });
  return txt;
}

// ------------------------------------------------------------
// Liquid capture / endcapture / markdownify 처리
// ------------------------------------------------------------
function transformLiquidCapture(src) {
  const captures = {};
  src = src.replace(
    /\{%\s*capture\s+(\w+)\s*%\}([\s\S]*?)\{%\s*endcapture\s*%\}/g,
    (_, name, content) => {
      captures[name] = content.trim();
      return '';
    },
  );
  src = src.replace(
    /<div\s+class="notice(?:--([a-z]+))?"\s*>\s*\{\{\s*(\w+)\s*\|\s*markdownify\s*\}\}\s*<\/div>/g,
    (_, variant, name) => {
      const body = captures[name];
      if (body === undefined) return '';
      let admType = 'note';
      if (!variant || variant === 'info' || variant === 'primary') admType = 'info';
      else if (variant === 'warning') admType = 'warning';
      else if (variant === 'success') admType = 'tip';
      else if (variant === 'danger') admType = 'danger';
      return `\n:::${admType}\n\n${body}\n\n:::\n`;
    },
  );
  src = src.replace(/\{\{\s*\w+\s*\|\s*markdownify\s*\}\}/g, '');
  return src;
}

// ------------------------------------------------------------
// kramdown notice 블록
// ------------------------------------------------------------
function transformKramdownNotices(src) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*\{:\s*\.notice(?:--([a-z]+))?\s*\}\s*$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const variant = m[1] || 'info';
    let admType = 'note';
    if (variant === 'info') admType = 'info';
    else if (variant === 'warning') admType = 'warning';
    else if (variant === 'success') admType = 'tip';
    else if (variant === 'danger') admType = 'danger';
    else if (variant === 'primary') admType = 'note';
    else if (variant === 'download') admType = 'note';

    let j = out.length - 1;
    while (j >= 0 && out[j].trim() === '') j--;
    let start = j;
    while (start - 1 >= 0 && out[start - 1].trim() !== '') start--;
    if (start < 0) start = 0;
    const paragraph = out.splice(start, j - start + 1);
    out.push('');
    out.push(`:::${admType}`);
    out.push('');
    paragraph.forEach((l) => out.push(l));
    out.push('');
    out.push(':::');
    out.push('');
  }
  return out.join('\n');
}

// ------------------------------------------------------------
// 코드 fence 정규화
// ------------------------------------------------------------
function normalizeFences(src) {
  const lines = src.split('\n');
  const out = [];
  let inFence = false;
  let fenceIndent = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFence) {
      const m = line.match(/^(\s*)```\s*([A-Za-z0-9_+\-#.]*)?\s*$/);
      if (m) {
        fenceIndent = m[1] || '';
        let lang = (m[2] || '').toLowerCase();
        if (lang in FENCE_NORMALIZE) lang = FENCE_NORMALIZE[lang];
        out.push('```' + lang);
        inFence = true;
        continue;
      }
      out.push(line);
    } else {
      const closing = line.match(/^(\s*)```\s*$/);
      if (closing) {
        out.push('```');
        inFence = false;
        fenceIndent = '';
        continue;
      }
      if (fenceIndent && line.startsWith(fenceIndent)) {
        out.push(line.slice(fenceIndent.length));
      } else {
        out.push(line);
      }
    }
  }
  return out.join('\n');
}

// ------------------------------------------------------------
// MDX safe escape (코드블록 외부의 stray angle brackets 처리)
// ------------------------------------------------------------
function mdxEscapeOutsideFences(src) {
  const lines = src.split('\n');
  let inFence = false;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    let out = '';
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === '`') {
        const end = line.indexOf('`', i + 1);
        if (end === -1) {
          out += line.slice(i);
          i = line.length;
        } else {
          out += line.slice(i, end + 1);
          i = end + 1;
        }
        continue;
      }
      if (ch === '<') {
        const m = line.slice(i).match(/^<\/?([A-Za-z][A-Za-z0-9._\-]*)([^>]*)>/);
        if (m) {
          const tag = m[1].toLowerCase();
          const safeTags = new Set([
            'br', 'hr', 'img', 'a', 'b', 'i', 'em', 'strong', 'span', 'div',
            'p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'sub', 'sup', 'code', 'pre',
            'tabs', 'tabitem', 'details', 'summary', 'iframe', 'kbd', 'section',
            'small', 'figure', 'figcaption', 'caption', 'video', 'source',
            'center', 'u', 's', 'big', 'font',
          ]);
          if (!safeTags.has(tag)) {
            // 내부에 또 다른 `<` 가 있을 수 있으니 (예: Result<std::vector<...>>) 모두 escape
            const inner = m[0].slice(1, -1).replace(/</g, '&lt;').replace(/>/g, '&gt;');
            out += '&lt;' + inner + '&gt;';
            i += m[0].length;
            continue;
          }
          // safe 태그라도 attribute 안에 `<` 가 또 들어 있으면 위험 — 단순 처리: 그대로 두되 공백 뒤 `<` 는 escape
          out += m[0];
          i += m[0].length;
          continue;
        }
        // <…> 가 매치 안 됨 → bare `<` (e.g. `<= value`, `< 5`, table cell)
        // MDX 안전을 위해 escape
        out += '&lt;';
        i++;
        continue;
      }
      if (ch === '{') {
        // `{` MDX expression — 그러나 본문에 자주 등장 (예: 코드 prose 'brackets {, }')
        // 단순화: 모든 `{` → `&#123;`, `}` → `&#125;`
        out += '&#123;';
        i++;
        continue;
      }
      if (ch === '}') {
        out += '&#125;';
        i++;
        continue;
      }
      out += ch;
      i++;
    }
    lines[li] = out;
  }
  return lines.join('\n');
}

function collapseBlankLines(src) {
  return src.replace(/\n{3,}/g, '\n\n');
}

// ------------------------------------------------------------
// 이미지/링크 재작성
// ------------------------------------------------------------
//   /assets/images/sw/<rest> → /img/software/<rest>
//   /assets/images/parts/<rest> → /img/parts/<rest>
//   /assets/images/<rest> → /img/<rest>
function rewriteAssetPaths(body) {
  body = body.replace(/\/assets\/images\/sw\//g, '/img/software/');
  body = body.replace(/\/assets\/images\/parts\//g, '/img/parts/');
  body = body.replace(/\/assets\/images\/platform\//g, '/img/platform/');
  body = body.replace(/\/assets\/images\/edu\//g, '/img/edu/');
  body = body.replace(/\/assets\/images\/dxl\//g, '/img/dxl/');
  body = body.replace(/\/assets\/images\/icon_unfold\.png/g, '/img/icon_unfold.png');
  // 그 외 /assets/* 가 등장하면 외부 강등
  body = body.replace(/\]\(\/assets\/([^)\s]+)\)/g, (_, p) => `](https://emanual.robotis.com/assets/${p})`);
  body = body.replace(/\(\/assets\/images\//g, '(/img/');
  return body;
}

//   /docs/<lang>/software/<rest> → 변환된 것은 /docs/software/<rest>, 아닌 것은 외부 강등
//   변환된 페이지 path 목록은 globalConvertedPaths 에 누적.
const globalConvertedPaths = new Set();
function rewriteInternalLinks(body) {
  // 0) 누락된 leading `/` 보정 (잘못된 source link): `(docs/en/...)` → `(/docs/en/...)`
  body = body.replace(/\]\((docs\/(?:en|kr)\/[^)\s]+)\)/g, (_, p) => `](/${p})`);
  // 1) 변환되는 software 영역 link 는 /docs/software/<rest> 로
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/software\/([^)\s#]+?)\/?(#[^)\s]*)?\)/g,
    (_, lang, p, hash) => `](/docs/software/${p}${hash || ''})`,
  );
  // 2) 그 외 /docs/<lang>/<rest> → 외부 emanual 강등
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/([^)\s#]+?)\/?(#[^)\s]*)?\)/g,
    (_, lang, p, hash) => `](https://emanual.robotis.com/docs/${lang}/${p}/${hash || ''})`,
  );
  // 3) reference-style link def downgrade
  body = body.replace(
    /^(\[[^\]]+\]):\s*\/docs\/(en|kr)\/(software\/[^\s]+?)\/?\s*$/gm,
    (_, label, lang, p) => `${label}: /docs/${p}/`,
  );
  body = body.replace(
    /^(\[[^\]]+\]):\s*\/docs\/(en|kr)\/(\S+?)\/?\s*$/gm,
    (_, label, lang, p) => `${label}: https://emanual.robotis.com/docs/${lang}/${p}/`,
  );
  // 4) 상대 anchor-only 링크 `(ollo-class)` 같은 fragment 누락 보정 → `(#ollo-class)` 로
  //    ASCII + 비ASCII (한글) 모두 매치
  body = body.replace(/\]\(([^)\s/#]+?)\)/g, (m, frag) => {
    if (/^https?:\/\//.test(frag)) return m;
    if (/^mailto:/.test(frag)) return m;
    if (frag.startsWith('/')) return m;
    if (frag.includes('.')) return m; // image/file extension 또는 도메인
    if (frag === '') return m;
    // 단일 단어 (하이픈/언더스코어 없음)는 변환하지 않음 — 무엇인지 모호
    if (!/[-_]/.test(frag) && !/[ㄱ-힝]/.test(frag)) return m;
    return `](#${frag})`;
  });
  return body;
}

// ------------------------------------------------------------
// 자기 self-link 헤딩 정리 + scaffolding 헤딩 제거
// ------------------------------------------------------------
function cleanHeadings(body, title) {
  // `### [Foo](#foo)` → `### Foo`
  body = body.replace(
    /^(#{1,6})\s+\[([^\]]+)\]\(#[^)]*\)\s*$/gm,
    (_, hashes, txt) => `${hashes} ${txt.trim()}`,
  );
  // `### **[Foo](#foo)**` → `### Foo`
  body = body.replace(
    /^(#{1,6})\s+\*\*\[([^\]]+)\]\(#[^)]*\)\*\*\s*$/gm,
    (_, hashes, txt) => `${hashes} ${txt.trim()}`,
  );
  // 제거 leading h1 if matches title
  if (title) {
    const lines = body.split('\n');
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') i++;
    while (i < lines.length) {
      const line = lines[i];
      if (/^#{1,3}\s+\S/.test(line)) {
        const text = line.replace(/^#{1,3}\s+/, '').trim();
        const titleNorm = title.toLowerCase().replace(/\s+/g, ' ').trim();
        const textNorm = text.toLowerCase().replace(/\s+/g, ' ').trim();
        let isOurTitle = textNorm === titleNorm;
        if (!isOurTitle) {
          const stripped = textNorm.replace(/&lt;[^&]*&gt;/g, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
          isOurTitle = stripped === titleNorm;
        }
        if (isOurTitle) {
          lines.splice(i, 1);
          while (i < lines.length && lines[i].trim() === '') lines.splice(i, 1);
          continue;
        }
      }
      break;
    }
    body = lines.join('\n');
  }
  return body;
}

// ------------------------------------------------------------
// 본문 변환 파이프라인
// ------------------------------------------------------------
function convertBody(body, ctx = {}) {
  // Liquid include
  body = body.replace(/\{%\s*include\s+([^\s%]+)\s*%\}/g, (_, p) => {
    const inc = resolveInclude(p);
    return inc === null ? `<!-- unresolved include: ${p} -->` : inc;
  });
  // Liquid capture
  body = transformLiquidCapture(body);

  // remove jekyll scaffolding
  body = body.replace(/<style>[\s\S]*?<\/style>/g, '');
  body = body.replace(/<div\s+style="counter-reset:[^"]*"\s*><\/div>/g, '');
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  body = body.replace(/^\s*\{::options[^}]*\}\s*$/gm, '');
  body = body.replace(/^\s*\{:toc\}\s*$/gm, '');
  // 헤딩에 붙은 <a name="..."> 류 anchor 제거 (이미 inject-heading-anchors 스크립트가 별도 부착함)
  // 정상형 + 깨진 형태 모두 매치 (e.g. `<a name="x"</a>`)
  body = body.replace(/<a\s+name=["'][^"']*["']\s*>?\s*<\/a>/gi, '');
  body = body.replace(/<a\s+name=["'][^"']*["']\s*<\/a>/gi, '');
  // main-header 블록 제거 (제목은 frontmatter title)
  body = body.replace(/<div\s+class="main-header"\s*>[\s\S]*?<\/div>/g, '');

  // <br> 정규화
  body = body.replace(/(?:<br\s*\/?\s*>\s*){2,}/g, '\n');
  body = body.replace(/<br\s*>/g, '<br/>');
  body = body.replace(/<hr\s*>/g, '<hr/>');
  // <img ...> 자체 닫기 (HTML void element → JSX self-close)
  body = body.replace(/<img\b([^>]*?)(?<!\/)>/g, '<img$1/>');

  // .popup / .button kramdown 잔여 제거 (단순화)
  body = body.replace(/\{:\s*\.popup\s*\}/g, '');
  body = body.replace(/\{:\s*\.button\s*\}/g, '');
  body = body.replace(/\{:\s*\.text-center\s*\}/g, '');
  body = body.replace(/\{:\s*\.align-center\s*\}/g, '');
  body = body.replace(/\{:\s*\.[a-z\-]+\s*\}/g, ''); // catch-all

  // self-link 헤딩 단순화
  body = cleanHeadings(body, ctx.title);

  // <section data-id> 블록 → 라벨 prefix 단순 변환 (탭으로 묶기엔 인접성 판정이 복잡)
  // 한 페이지에 tab_title1/2 가 있으면 Tabs 그룹으로 묶는다.
  if (ctx.tabTitles && ctx.tabTitles.length >= 2) {
    body = wrapSectionsAsTabs(body, ctx.tabTitles);
    ctx.usedTabs = true;
  } else {
    // 일반 section: 단순 본문화
    body = body.replace(/<section[^>]*>/g, '');
    body = body.replace(/<\/section>/g, '');
  }

  // kramdown notice
  body = transformKramdownNotices(body);

  // 코드 fence 정규화
  body = normalizeFences(body);

  // 이미지/링크 재작성
  body = rewriteAssetPaths(body);
  body = rewriteInternalLinks(body);

  // MDX safe escape
  body = mdxEscapeOutsideFences(body);

  // 빈 줄 정리
  body = collapseBlankLines(body);

  return body;
}

// section data-id="{{ page.tab_titleN }}" 블록을 인접 그룹 Tabs로 묶기
function wrapSectionsAsTabs(body, tabTitles) {
  // 모든 section 블록을 마커로 변환
  body = body.replace(
    /<section\s+data-id="\{\{\s*page\.(tab_title\d)\s*\}\}"[^>]*>/g,
    (_, key) => `\n@@SECTION_START:${key}@@\n`,
  );
  body = body.replace(/<\/section>/g, `\n@@SECTION_END@@\n`);

  const lines = body.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.match(/^@@SECTION_START:(tab_title\d)@@$/)) {
      // 인접 섹션 그룹 수집
      const sections = [];
      while (i < lines.length) {
        const sm = lines[i].match(/^@@SECTION_START:(tab_title(\d))@@$/);
        if (!sm) break;
        const idx = parseInt(sm[2], 10) - 1;
        const label = tabTitles[idx] || `Tab ${sm[2]}`;
        i++;
        const buf = [];
        while (i < lines.length && lines[i] !== '@@SECTION_END@@') {
          buf.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++;
        // 빈 줄 다음에 다시 섹션이 오면 같은 그룹
        let j = i;
        while (j < lines.length && lines[j].trim() === '') j++;
        const isNextSection = j < lines.length && /^@@SECTION_START:tab_title\d@@$/.test(lines[j]);
        if (isNextSection) i = j;
        sections.push({ label, content: buf.join('\n').trim() });
        if (!isNextSection) break;
      }
      if (sections.length === 1) {
        out.push('');
        out.push(sections[0].content);
        out.push('');
      } else {
        out.push('<Tabs groupId="easy-sdk-langs" queryString>');
        sections.forEach((s, idx) => {
          const value = s.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
          out.push(`<TabItem value="${value}" label="${s.label}"${idx === 0 ? ' default' : ''}>`);
          out.push('');
          out.push(s.content);
          out.push('');
          out.push('</TabItem>');
        });
        out.push('</Tabs>');
        out.push('');
      }
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

// ------------------------------------------------------------
// ko mirror
// ------------------------------------------------------------
function buildKoMirror(enContent, extraNotice) {
  const m = enContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return enContent;
  const fmText = m[1];
  const bodyText = m[2];
  const notice = extraNotice || '\n:::info\n\n한국어 번역 준비 중입니다. 아래는 영문 원본입니다.\n\n:::\n\n';
  return `---\n${fmText}\n---\n${notice}${bodyText}`;
}

// ------------------------------------------------------------
// _category_.json
// ------------------------------------------------------------
function writeCategoryJson(dir, label, position, opts = {}) {
  const data = { label, position };
  if (opts.linkType === 'doc' && opts.linkId) {
    data.link = { type: 'doc', id: opts.linkId };
  } else {
    data.link = { type: 'generated-index' };
  }
  if (opts.key) data.key = opts.key;
  writeOut(path.join(dir, '_category_.json'), JSON.stringify(data, null, 2) + '\n');
}

// ------------------------------------------------------------
// 페이지 변환 (단일 .md → .mdx)
// ------------------------------------------------------------
//   srcEnPath: source/docs/en/...md
//   srcKrPath: source/docs/kr/...md (없으면 null)
//   outRel: 결과 docusaurus 상대 경로 (예: 'software/arduino_ide.mdx')
//   meta: { id, title, sidebarLabel, sidebarPosition, tags }
function convertSinglePage(srcEnPath, srcKrPath, outRel, meta) {
  const enRaw = readUtf8(srcEnPath);
  const { fm: enFm, body: enBody } = splitFrontmatter(enRaw);
  const tabTitles = [];
  for (const k of ['tab_title1', 'tab_title2', 'tab_title3', 'tab_title4']) {
    if (enFm[k]) tabTitles.push(enFm[k]);
  }
  const ctx = { title: meta.title, tabTitles, usedTabs: false };
  let converted = convertBody(enBody, ctx);
  let imports = '';
  if (ctx.usedTabs) {
    imports = `import Tabs from '@theme/Tabs';\nimport TabItem from '@theme/TabItem';\n\n`;
  }

  const newFm = {
    id: meta.id,
    title: meta.title,
    sidebar_label: meta.sidebarLabel || meta.title,
    sidebar_position: meta.sidebarPosition,
    slug: meta.slug,
    tags: meta.tags,
  };
  const enContent = buildFmYaml(newFm) + imports + converted.trimStart() + '\n';
  const outEnFull = path.join(OUT_EN_ROOT, outRel);
  writeOut(outEnFull, enContent);
  globalConvertedPaths.add('/docs/' + outRel.replace(/\\/g, '/').replace(/\.mdx$/, '').replace(/\/index$/, ''));

  // ko: kr 원본이 있으면 그것 변환, 없으면 en mirror
  const outKoFull = path.join(OUT_KO_ROOT, outRel);
  if (srcKrPath && fs.existsSync(srcKrPath)) {
    const krRaw = readUtf8(srcKrPath);
    const { fm: krFm, body: krBody } = splitFrontmatter(krRaw);
    const krTabTitles = [];
    for (const k of ['tab_title1', 'tab_title2', 'tab_title3', 'tab_title4']) {
      if (krFm[k]) krTabTitles.push(krFm[k]);
    }
    const koCtx = { title: meta.title, tabTitles: krTabTitles, usedTabs: false };
    let koConverted = convertBody(krBody, koCtx);
    let koImports = '';
    if (koCtx.usedTabs) {
      koImports = `import Tabs from '@theme/Tabs';\nimport TabItem from '@theme/TabItem';\n\n`;
    }
    const koContent = buildFmYaml(newFm) + koImports + koConverted.trimStart() + '\n';
    writeOut(outKoFull, koContent);
  } else {
    writeOut(outKoFull, buildKoMirror(enContent));
  }
}

// ------------------------------------------------------------
// 변환 대상 정의
// ------------------------------------------------------------
//   { srcEn, srcKr, outRel, meta:{...} }
const PAGES = [];

// 단일 파일들
PAGES.push({
  srcEn: 'software/arduino_ide.md',
  srcKr: 'software/arduino_ide.md',
  outRel: 'software/arduino_ide.mdx',
  meta: { id: 'arduino_ide', title: 'Arduino IDE', sidebarLabel: 'Arduino IDE', sidebarPosition: 30, tags: ['software', 'arduino_ide'] },
});
PAGES.push({
  srcEn: 'software/dynamixel/dynamixel_wizard2.md',
  srcKr: 'software/dynamixel/dynamixel_wizard2.md',
  outRel: 'software/dynamixel/dynamixel_wizard2.mdx',
  meta: { id: 'dynamixel_wizard2', title: 'DYNAMIXEL Wizard 2.0', sidebarLabel: 'DYNAMIXEL Wizard 2.0', sidebarPosition: 1, tags: ['software', 'dynamixel', 'wizard2'] },
});
PAGES.push({
  srcEn: 'software/dynamixel/dynamixel_workbench.md',
  srcKr: 'software/dynamixel/dynamixel_workbench.md',
  outRel: 'software/dynamixel/dynamixel_workbench.mdx',
  meta: { id: 'dynamixel_workbench', title: 'DYNAMIXEL Workbench', sidebarLabel: 'DYNAMIXEL Workbench', sidebarPosition: 3, tags: ['software', 'dynamixel', 'workbench'] },
});
PAGES.push({
  srcEn: 'software/robotis_manipulator_libs/robotis_manipulator_libs.md',
  srcKr: 'software/robotis_manipulator_libs/robotis_manipulator_libs.md',
  outRel: 'software/robotis_manipulator_libs.mdx',
  meta: { id: 'robotis_manipulator_libs', title: 'ROBOTIS Manipulator Library', sidebarLabel: 'ROBOTIS Manipulator Library', sidebarPosition: 70, tags: ['software', 'manipulator'] },
});
PAGES.push({
  srcEn: 'software/mobile_app/mini_app.md',
  srcKr: 'software/mobile_app/mini_app.md',
  outRel: 'software/mobile_app/mini_app.mdx',
  meta: { id: 'mini_app', title: 'ROBOTIS MINI App', sidebarLabel: 'ROBOTIS MINI App', sidebarPosition: 1, tags: ['software', 'mobile_app', 'mini'] },
});

// dynamixel_easy_sdk
const EASY_SDK = [
  { name: 'introduction', title: 'Introduction', pos: 1 },
  { name: 'getting_started', title: 'Getting Started', pos: 2 },
  { name: 'single_motor_tutorial', title: 'Single Motor Tutorial', pos: 3 },
  { name: 'single_motor_tutorial_step1', title: 'Step 1: Moving Dynamixel', pos: 4 },
  { name: 'single_motor_tutorial_step2', title: 'Step 2: Read Data from Dynamixel', pos: 5 },
  { name: 'single_motor_tutorial_step3', title: 'Step 3: Leader and Follower', pos: 6 },
  { name: 'single_motor_tutorial_step4', title: 'Step 4: OMX Teleoperation', pos: 7 },
  { name: 'group_motor_tutorial', title: 'Group Motor Tutorial', pos: 8 },
  { name: 'group_motor_tutorial_step5', title: 'Step 5: Multi Motor Sync Read/Write', pos: 9 },
  { name: 'group_motor_tutorial_step6', title: 'Step 6: Multi Motor Bulk Read/Write', pos: 10 },
  { name: 'group_motor_tutorial_step7', title: 'Step 7: Group Motor Teleoperation', pos: 11 },
  { name: 'api_reference', title: 'API Reference', pos: 12 },
  { name: 'api_reference_connector', title: 'API Reference: Connector', pos: 13 },
  { name: 'api_reference_motor', title: 'API Reference: Motor', pos: 14 },
  { name: 'api_reference_group_executor', title: 'API Reference: Group Executor', pos: 15 },
  { name: 'api_reference_data_types', title: 'API Reference: Data Types', pos: 16 },
  { name: 'api_reference_dynamixel_error', title: 'API Reference: DYNAMIXEL Error', pos: 17 },
];
EASY_SDK.forEach((p) => {
  PAGES.push({
    srcEn: `software/dynamixel/dynamixel_easy_sdk/${p.name}.md`,
    srcKr: null,
    outRel: `software/dynamixel/dynamixel_easy_sdk/${p.name}.mdx`,
    meta: { id: p.name, title: p.title, sidebarLabel: p.title, sidebarPosition: p.pos, tags: ['software', 'dynamixel', 'easy_sdk'] },
  });
});

// embedded_sdk (4)
PAGES.push({
  srcEn: 'software/embedded_sdk/index.md',
  srcKr: 'software/embedded_sdk/index.md',
  outRel: 'software/embedded_sdk/index.mdx',
  meta: { id: 'embedded_sdk', title: 'Embedded SDK', sidebarLabel: 'Embedded SDK', sidebarPosition: 1, tags: ['software', 'embedded_sdk'] },
});
PAGES.push({
  srcEn: 'software/embedded_sdk/embedded_c_cm510.md',
  srcKr: 'software/embedded_sdk/embedded_c_cm510.md',
  outRel: 'software/embedded_sdk/embedded_c_cm510.mdx',
  meta: { id: 'embedded_c_cm510', title: 'Embedded C (CM-510/700)', sidebarLabel: 'Embedded C (CM-510/700)', sidebarPosition: 2, tags: ['software', 'embedded_sdk'] },
});
PAGES.push({
  srcEn: 'software/embedded_sdk/embedded_c_cm530.md',
  srcKr: 'software/embedded_sdk/embedded_c_cm530.md',
  outRel: 'software/embedded_sdk/embedded_c_cm530.mdx',
  meta: { id: 'embedded_c_cm530', title: 'Embedded C (CM-530)', sidebarLabel: 'Embedded C (CM-530)', sidebarPosition: 3, tags: ['software', 'embedded_sdk'] },
});
PAGES.push({
  srcEn: 'software/embedded_sdk/zigbee_sdk.md',
  srcKr: 'software/embedded_sdk/zigbee_sdk.md',
  outRel: 'software/embedded_sdk/zigbee_sdk.mdx',
  meta: { id: 'zigbee_sdk', title: 'ZIGBEE SDK', sidebarLabel: 'ZIGBEE SDK', sidebarPosition: 4, tags: ['software', 'embedded_sdk'] },
});

// opencm_ide (2)
PAGES.push({
  srcEn: 'software/opencm_ide/getting_started.md',
  srcKr: 'software/opencm_ide/getting_started.md',
  outRel: 'software/opencm_ide/getting_started.mdx',
  meta: { id: 'getting_started', title: 'OpenCM IDE - Getting Started', sidebarLabel: 'Getting Started', sidebarPosition: 1, tags: ['software', 'opencm_ide'] },
});
PAGES.push({
  srcEn: 'software/opencm_ide/api_reference.md',
  srcKr: 'software/opencm_ide/api_reference.md',
  outRel: 'software/opencm_ide/api_reference.mdx',
  meta: { id: 'api_reference', title: 'OpenCM IDE - API Reference', sidebarLabel: 'API Reference', sidebarPosition: 2, tags: ['software', 'opencm_ide'] },
});

// robotis_framework_packages (2) — kr 원본 없음
PAGES.push({
  srcEn: 'software/robotis_framework_packages/robotis_framework_packages.md',
  srcKr: null,
  outRel: 'software/robotis_framework_packages/robotis_framework_packages.mdx',
  meta: { id: 'robotis_framework_packages', title: 'ROBOTIS Framework Packages', sidebarLabel: 'Overview', sidebarPosition: 1, tags: ['software', 'framework'] },
});
PAGES.push({
  srcEn: 'software/robotis_framework_packages/tutorials.md',
  srcKr: null,
  outRel: 'software/robotis_framework_packages/tutorials.mdx',
  meta: { id: 'tutorials', title: 'Framework Tutorials', sidebarLabel: 'Tutorials', sidebarPosition: 2, tags: ['software', 'framework'] },
});

// rplus1 (8: 5 top + 3 task subdir leaf + 1 task index will be auto)
PAGES.push({
  srcEn: 'software/rplus1/manager.md',
  srcKr: 'software/rplus1/manager.md',
  outRel: 'software/rplus1/manager.mdx',
  meta: { id: 'manager', title: 'R+ Manager 1.0', sidebarLabel: 'R+ Manager', sidebarPosition: 1, tags: ['software', 'rplus1'] },
});
PAGES.push({
  srcEn: 'software/rplus1/motion.md',
  srcKr: 'software/rplus1/motion.md',
  outRel: 'software/rplus1/motion.mdx',
  meta: { id: 'motion', title: 'R+ Motion 1.0', sidebarLabel: 'R+ Motion', sidebarPosition: 2, tags: ['software', 'rplus1'] },
});
PAGES.push({
  srcEn: 'software/rplus1/dynamixel_wizard.md',
  srcKr: 'software/rplus1/dynamixel_wizard.md',
  outRel: 'software/rplus1/dynamixel_wizard.mdx',
  meta: { id: 'dynamixel_wizard', title: 'Dynamixel Wizard (R+ 1.0)', sidebarLabel: 'DYNAMIXEL Wizard', sidebarPosition: 3, tags: ['software', 'rplus1'] },
});
PAGES.push({
  srcEn: 'software/rplus1/terminal.md',
  srcKr: 'software/rplus1/terminal.md',
  outRel: 'software/rplus1/terminal.mdx',
  meta: { id: 'terminal', title: 'R+ Terminal', sidebarLabel: 'R+ Terminal', sidebarPosition: 4, tags: ['software', 'rplus1'] },
});
// rplus1 task — 4 pages
PAGES.push({
  srcEn: 'software/rplus1/task/getting_started.md',
  srcKr: 'software/rplus1/task/getting_started.md',
  outRel: 'software/rplus1/task/getting_started.mdx',
  meta: { id: 'getting_started', title: 'R+ Task 1.0 - Getting Started', sidebarLabel: 'Getting Started', sidebarPosition: 1, tags: ['software', 'rplus1', 'task'] },
});
PAGES.push({
  srcEn: 'software/rplus1/task/programming_01.md',
  srcKr: 'software/rplus1/task/programming_01.md',
  outRel: 'software/rplus1/task/programming_01.mdx',
  meta: { id: 'programming_01', title: 'R+ Task 1.0 - Programming Basics', sidebarLabel: 'Programming Basics', sidebarPosition: 2, tags: ['software', 'rplus1', 'task'] },
});
PAGES.push({
  srcEn: 'software/rplus1/task/programming_02.md',
  srcKr: 'software/rplus1/task/programming_02.md',
  outRel: 'software/rplus1/task/programming_02.mdx',
  meta: { id: 'programming_02', title: 'R+ Task 1.0 - Programming Advanced', sidebarLabel: 'Programming Advanced', sidebarPosition: 3, tags: ['software', 'rplus1', 'task'] },
});
PAGES.push({
  srcEn: 'software/rplus1/task/task_misc.md',
  srcKr: 'software/rplus1/task/task_misc.md',
  outRel: 'software/rplus1/task/task_misc.mdx',
  meta: { id: 'task_misc', title: 'R+ Task 1.0 - Miscellaneous', sidebarLabel: 'Miscellaneous', sidebarPosition: 4, tags: ['software', 'rplus1', 'task'] },
});

// rplus2 (6)
PAGES.push({
  srcEn: 'software/rplus2/manager.md',
  srcKr: 'software/rplus2/manager.md',
  outRel: 'software/rplus2/manager.mdx',
  meta: { id: 'manager', title: 'R+ Manager 2.0', sidebarLabel: 'R+ Manager 2.0', sidebarPosition: 1, tags: ['software', 'rplus2'] },
});
PAGES.push({
  srcEn: 'software/rplus2/task.md',
  srcKr: 'software/rplus2/task.md',
  outRel: 'software/rplus2/task.mdx',
  meta: { id: 'task', title: 'R+ Task 2.0', sidebarLabel: 'R+ Task 2.0', sidebarPosition: 2, tags: ['software', 'rplus2'] },
});
PAGES.push({
  srcEn: 'software/rplus2/motion.md',
  srcKr: 'software/rplus2/motion.md',
  outRel: 'software/rplus2/motion.mdx',
  meta: { id: 'motion', title: 'R+ Motion 2.0', sidebarLabel: 'R+ Motion 2.0', sidebarPosition: 3, tags: ['software', 'rplus2'] },
});
PAGES.push({
  srcEn: 'software/rplus2/design.md',
  srcKr: 'software/rplus2/design.md',
  outRel: 'software/rplus2/design.mdx',
  meta: { id: 'design', title: 'R+ Design 2.0', sidebarLabel: 'R+ Design 2.0', sidebarPosition: 4, tags: ['software', 'rplus2'] },
});
PAGES.push({
  srcEn: 'software/rplus2/scratch.md',
  srcKr: 'software/rplus2/scratch.md',
  outRel: 'software/rplus2/scratch.mdx',
  meta: { id: 'scratch', title: 'R+ Scratch', sidebarLabel: 'R+ Scratch', sidebarPosition: 5, tags: ['software', 'rplus2'] },
});
PAGES.push({
  srcEn: 'software/rplus2/rplus2_block.md',
  srcKr: 'software/rplus2/rplus2_block.md',
  outRel: 'software/rplus2/rplus2_block.mdx',
  meta: { id: 'rplus2_block', title: 'R+ Block', sidebarLabel: 'R+ Block', sidebarPosition: 6, tags: ['software', 'rplus2'] },
});

// rplustask3 (7)
PAGES.push({
  srcEn: 'software/rplustask3/overview.md',
  srcKr: 'software/rplustask3/overview.md',
  outRel: 'software/rplustask3/overview.mdx',
  meta: { id: 'rplustask3-overview', title: 'R+ Task 3.0 Overview', sidebarLabel: 'Overview', sidebarPosition: 1, tags: ['software', 'rplustask3'], slug: '/software/rplustask3' },
});
PAGES.push({
  srcEn: 'software/rplustask3/task_programming.md',
  srcKr: 'software/rplustask3/task_programming.md',
  outRel: 'software/rplustask3/task_programming.mdx',
  meta: { id: 'task_programming', title: 'R+ Task 3.0 - Task Programming', sidebarLabel: 'Task Programming', sidebarPosition: 2, tags: ['software', 'rplustask3'] },
});
PAGES.push({
  srcEn: 'software/rplustask3/task_instructions.md',
  srcKr: 'software/rplustask3/task_instructions.md',
  outRel: 'software/rplustask3/task_instructions.mdx',
  meta: { id: 'task_instructions', title: 'R+ Task 3.0 - Task Instructions', sidebarLabel: 'Task Instructions', sidebarPosition: 3, tags: ['software', 'rplustask3'] },
});
PAGES.push({
  srcEn: 'software/rplustask3/task_parameters.md',
  srcKr: 'software/rplustask3/task_parameters.md',
  outRel: 'software/rplustask3/task_parameters.mdx',
  meta: { id: 'task_parameters', title: 'R+ Task 3.0 - Task Parameters', sidebarLabel: 'Task Parameters', sidebarPosition: 4, tags: ['software', 'rplustask3'] },
});
PAGES.push({
  srcEn: 'software/rplustask3/motion_programming.md',
  srcKr: 'software/rplustask3/motion_programming.md',
  outRel: 'software/rplustask3/motion_programming.mdx',
  meta: { id: 'motion_programming', title: 'R+ Task 3.0 - Motion Programming', sidebarLabel: 'Motion Programming', sidebarPosition: 5, tags: ['software', 'rplustask3'] },
});
PAGES.push({
  srcEn: 'software/rplustask3/python_api.md',
  srcKr: 'software/rplustask3/python_api.md',
  outRel: 'software/rplustask3/python_api.mdx',
  meta: { id: 'python_api', title: 'R+ Task 3.0 - Python API', sidebarLabel: 'Python API', sidebarPosition: 6, tags: ['software', 'rplustask3'] },
});
PAGES.push({
  srcEn: 'software/rplustask3/useful_tips.md',
  srcKr: 'software/rplustask3/useful_tips.md',
  outRel: 'software/rplustask3/useful_tips.mdx',
  meta: { id: 'useful_tips', title: 'R+ Task 3.0 - Useful Tips', sidebarLabel: 'Useful Tips', sidebarPosition: 7, tags: ['software', 'rplustask3'] },
});

// rplus_mobile (3)
PAGES.push({
  srcEn: 'software/rplus_mobile/mtask20.md',
  srcKr: 'software/rplus_mobile/mtask20.md',
  outRel: 'software/rplus_mobile/mtask20.mdx',
  meta: { id: 'mtask20', title: 'R+ m.Task 2.0', sidebarLabel: 'R+ m.Task 2.0', sidebarPosition: 1, tags: ['software', 'rplus_mobile'] },
});
PAGES.push({
  srcEn: 'software/rplus_mobile/mmotion.md',
  srcKr: 'software/rplus_mobile/mmotion.md',
  outRel: 'software/rplus_mobile/mmotion.mdx',
  meta: { id: 'mmotion', title: 'R+ m.Motion 2.0', sidebarLabel: 'R+ m.Motion 2.0', sidebarPosition: 2, tags: ['software', 'rplus_mobile'] },
});
PAGES.push({
  srcEn: 'software/rplus_mobile/mdesign.md',
  srcKr: 'software/rplus_mobile/mdesign.md',
  outRel: 'software/rplus_mobile/mdesign.mdx',
  meta: { id: 'mdesign', title: 'R+ m.Design 2.0', sidebarLabel: 'R+ m.Design 2.0', sidebarPosition: 3, tags: ['software', 'rplus_mobile'] },
});

// ------------------------------------------------------------
// 카테고리 정의
// ------------------------------------------------------------
const CATEGORIES = [
  { dir: 'software/dynamixel/dynamixel_easy_sdk', label: 'DYNAMIXEL Easy SDK', koLabel: 'DYNAMIXEL Easy SDK', position: 2 },
  { dir: 'software/embedded_sdk', label: 'Embedded SDK', koLabel: 'Embedded SDK', position: 40, linkType: 'doc', linkId: 'embedded_sdk' },
  { dir: 'software/opencm_ide', label: 'OpenCM IDE', koLabel: 'OpenCM IDE', position: 50 },
  { dir: 'software/robotis_framework_packages', label: 'ROBOTIS Framework Packages', koLabel: 'ROBOTIS Framework Packages', position: 60 },
  { dir: 'software/mobile_app', label: 'Mobile App', koLabel: '모바일 앱', position: 80 },
  { dir: 'software/rplus1', label: 'R+ 1.0', koLabel: 'R+ 1.0', position: 110 },
  { dir: 'software/rplus1/task', label: 'R+ Task 1.0', koLabel: 'R+ Task 1.0', position: 5 },
  { dir: 'software/rplus2', label: 'R+ 2.0', koLabel: 'R+ 2.0', position: 100 },
  { dir: 'software/rplustask3', label: 'R+ Task 3.0', koLabel: 'R+ Task 3.0', position: 90, linkType: 'doc', linkId: 'rplustask3-overview' },
  { dir: 'software/rplus_mobile', label: 'R+ Mobile Apps', koLabel: 'R+ 모바일 앱', position: 95 },
];

// 자산 복사 규칙
//   source/assets/images/sw/<sub> → docusaurus/static/img/software/<sub>
const ASSET_SW_DIRS = [
  'dynamixel/wizard2',
  'dynamixel/dynamixel_workbench',
  'dynamixel_easy_sdk',
  'all_software',
  'opencm_ide',
  'mobile',
  'robotis_manipulator',
  'rplus1',
  'rplus2',
  'rplus_mobile',
  'rplus_task3',
  'rplus_task3_kr',
  'sdk', // 미러 (embedded용 일부 사용 가능성)
];

// 추가 단일 파일들
const SINGLE_ASSETS = [
  ['images/sw/roboplus_install.png', 'software/roboplus_install.png'],
  ['images/sw/roboplus_install_en.png', 'software/roboplus_install_en.png'],
  ['images/sw/motion_download_01.jpg', 'software/motion_download_01.jpg'],
  ['images/sw/motion_download_02.jpg', 'software/motion_download_02.jpg'],
  ['images/sw/motion_download_03.jpg', 'software/motion_download_03.jpg'],
  ['images/sw/motion_download_04.jpg', 'software/motion_download_04.jpg'],
];

function copyAssets() {
  let count = 0;
  for (const sub of ASSET_SW_DIRS) {
    const src = path.join(ASSET_SRC_ROOT, 'images/sw', sub);
    const dst = path.join(ASSET_OUT_ROOT, 'software', sub);
    if (!exists(src)) continue;
    function walk(d, rel) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        const next = rel ? path.join(rel, e.name) : e.name;
        if (e.isDirectory()) walk(full, next);
        else if (e.isFile()) {
          copyFile(full, path.join(dst, next));
          count++;
        }
      }
    }
    walk(src, '');
  }
  for (const [s, d] of SINGLE_ASSETS) {
    if (copyFile(path.join(ASSET_SRC_ROOT, s), path.join(ASSET_OUT_ROOT, d))) count++;
  }
  // parts 이미지 일부 (arduino_ide 등에서 사용)
  function copyParts(sub) {
    const src = path.join(ASSET_SRC_ROOT, 'images/parts', sub);
    const dst = path.join(ASSET_OUT_ROOT, 'parts', sub);
    if (!exists(src)) return;
    function walk(d, rel) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        const next = rel ? path.join(rel, e.name) : e.name;
        if (e.isDirectory()) walk(full, next);
        else if (e.isFile()) {
          if (!exists(path.join(dst, next))) {
            copyFile(full, path.join(dst, next));
            count++;
          }
        }
      }
    }
    walk(src, '');
  }
  copyParts('controller/opencr10');
  copyParts('controller/opencm904');
  copyParts('interface');
  // platform turtlebot3 preparation (arduino_ide)
  function copyPlatform(sub) {
    const src = path.join(ASSET_SRC_ROOT, 'images/platform', sub);
    const dst = path.join(ASSET_OUT_ROOT, 'platform', sub);
    if (!exists(src)) return;
    function walk(d, rel) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        const next = rel ? path.join(rel, e.name) : e.name;
        if (e.isDirectory()) walk(full, next);
        else if (e.isFile()) {
          if (!exists(path.join(dst, next))) {
            copyFile(full, path.join(dst, next));
            count++;
          }
        }
      }
    }
    walk(src, '');
  }
  copyPlatform('turtlebot3/preparation');
  return count;
}

// ------------------------------------------------------------
// dynamixel/_category_.json (이미 존재하면 유지)
// ------------------------------------------------------------
function ensureDynamixelCategory() {
  const cat = path.join(OUT_EN_ROOT, 'software/dynamixel/_category_.json');
  if (!exists(cat)) {
    writeCategoryJson(path.join(OUT_EN_ROOT, 'software/dynamixel'), 'DYNAMIXEL Software', 1);
  }
  const koCat = path.join(OUT_KO_ROOT, 'software/dynamixel/_category_.json');
  if (!exists(koCat)) {
    writeCategoryJson(path.join(OUT_KO_ROOT, 'software/dynamixel'), 'DYNAMIXEL 소프트웨어', 1);
  }
}

// ------------------------------------------------------------
// software/index.mdx (placeholder 교체)
// ------------------------------------------------------------
function buildSoftwareIndex() {
  const srcEn = path.join(SRC_EN, 'software/all-software.md');
  const srcKr = path.join(SRC_KR, 'software/all-software.md');
  const meta = {
    id: 'software',
    title: 'Software',
    sidebarLabel: 'Software',
    sidebarPosition: 1,
    tags: ['software'],
  };
  const enRaw = readUtf8(srcEn);
  const { body: enBody } = splitFrontmatter(enRaw);
  const ctx = { title: 'Software', tabTitles: [], usedTabs: false };
  let converted = convertBody(enBody, ctx);
  const newFm = {
    id: meta.id,
    title: meta.title,
    sidebar_label: meta.sidebarLabel,
    sidebar_position: meta.sidebarPosition,
    tags: meta.tags,
  };
  const enContent = buildFmYaml(newFm) + converted.trimStart() + '\n';
  // 기존 index.md 가 있으면 .mdx 로 대체
  const oldIndex = path.join(OUT_EN_ROOT, 'software/index.md');
  if (exists(oldIndex)) {
    fs.unlinkSync(oldIndex);
  }
  writeOut(path.join(OUT_EN_ROOT, 'software/index.mdx'), enContent);

  if (exists(srcKr)) {
    const krRaw = readUtf8(srcKr);
    const { body: krBody } = splitFrontmatter(krRaw);
    const koCtx = { title: 'Software', tabTitles: [], usedTabs: false };
    let koConverted = convertBody(krBody, koCtx);
    const koContent = buildFmYaml(newFm) + koConverted.trimStart() + '\n';
    const oldKo = path.join(OUT_KO_ROOT, 'software/index.md');
    if (exists(oldKo)) fs.unlinkSync(oldKo);
    writeOut(path.join(OUT_KO_ROOT, 'software/index.mdx'), koContent);
  } else {
    const oldKo = path.join(OUT_KO_ROOT, 'software/index.md');
    if (exists(oldKo)) fs.unlinkSync(oldKo);
    writeOut(path.join(OUT_KO_ROOT, 'software/index.mdx'), buildKoMirror(enContent));
  }
}

// ------------------------------------------------------------
// 후처리: 변환된 페이지 외 software 링크는 외부 강등
// ------------------------------------------------------------
function collectExistingSoftwarePaths() {
  const paths = new Set();
  function walkDocs(d, rel) {
    if (!exists(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const next = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walkDocs(full, next);
      else if (e.isFile() && (e.name.endsWith('.mdx') || e.name.endsWith('.md'))) {
        const stem = e.name.replace(/\.(mdx|md)$/, '');
        const dir = rel || '';
        const url = stem === 'index'
          ? '/docs/' + dir
          : '/docs/' + (dir ? dir + '/' : '') + stem;
        paths.add(url.replace(/\/+$/, ''));
      }
    }
  }
  walkDocs(OUT_EN_ROOT, '');
  // generated-index 디렉터리도 valid (any directory with _category_.json)
  function walkDirs(d, rel) {
    if (!exists(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const next = rel ? rel + '/' + e.name : e.name;
      const cat = path.join(d, e.name, '_category_.json');
      if (exists(cat)) {
        paths.add(('/docs/' + next).replace(/\/+$/, ''));
      }
      walkDirs(path.join(d, e.name), next);
    }
  }
  walkDirs(OUT_EN_ROOT, '');
  return paths;
}

function postProcessOrphanLinks() {
  const valid = collectExistingSoftwarePaths();
  const allFiles = [];
  function walk(d) {
    if (!exists(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && (e.name.endsWith('.mdx') || e.name.endsWith('.md'))) {
        // 이번 작업 대상 software/ 하위 파일만
        if (full.includes(path.sep + 'software' + path.sep) || full.endsWith(path.sep + 'software' + path.sep + 'index.mdx')) {
          allFiles.push(full);
        }
      }
    }
  }
  walk(path.join(OUT_EN_ROOT, 'software'));
  walk(path.join(OUT_KO_ROOT, 'software'));

  let downgraded = 0;
  for (const file of allFiles) {
    let txt = readUtf8(file);
    // inline links
    txt = txt.replace(
      /\]\(\/docs\/software\/([^)\s#]+?)(#[^)\s]*)?\)/g,
      (m, p, hash) => {
        const target = '/docs/software/' + p.replace(/\/+$/, '');
        if (valid.has(target)) return m;
        downgraded++;
        return `](https://emanual.robotis.com/docs/en/software/${p}/${hash || ''})`;
      },
    );
    // reference-style definitions
    txt = txt.replace(
      /^(\[[^\]]+\]):\s*\/docs\/software\/(\S+?)\/?\s*$/gm,
      (m, label, p) => {
        const target = '/docs/software/' + p.replace(/\/+$/, '');
        if (valid.has(target)) return m;
        downgraded++;
        return `${label}: https://emanual.robotis.com/docs/en/software/${p}/`;
      },
    );
    fs.writeFileSync(file, txt);
  }
  console.log(`postprocess: orphan links downgraded: ${downgraded}`);
}

// ------------------------------------------------------------
// 메인
// ------------------------------------------------------------
function main() {
  const stats = { pages: 0, missing: 0, categories: 0, assets: 0 };

  for (const p of PAGES) {
    const srcEnFull = path.join(SRC_EN, p.srcEn);
    if (!exists(srcEnFull)) {
      console.error(`[skip] missing en source: ${p.srcEn}`);
      stats.missing++;
      continue;
    }
    const srcKrFull = p.srcKr ? path.join(SRC_KR, p.srcKr) : null;
    convertSinglePage(srcEnFull, srcKrFull, p.outRel, p.meta);
    stats.pages++;
  }

  // 카테고리
  for (const c of CATEGORIES) {
    const enDir = path.join(OUT_EN_ROOT, c.dir);
    const koDir = path.join(OUT_KO_ROOT, c.dir);
    if (!exists(enDir)) continue;
    const opts = {};
    if (c.linkType) opts.linkType = c.linkType;
    if (c.linkId) opts.linkId = c.linkId;
    writeCategoryJson(enDir, c.label, c.position, opts);
    writeCategoryJson(koDir, c.koLabel, c.position, opts);
    stats.categories++;
  }
  ensureDynamixelCategory();

  // index 페이지
  buildSoftwareIndex();

  // 자산
  stats.assets = copyAssets();

  // 후처리
  postProcessOrphanLinks();

  console.log('Software rest conversion complete.');
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v}`);
}

main();
