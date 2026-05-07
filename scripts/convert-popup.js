#!/usr/bin/env node
/**
 * Popup (~243 페이지 en + ~12 ko) Jekyll Markdown → Docusaurus MDX 변환.
 *
 *   원본 Jekyll 사이트의 popup 페이지들은 modal/lightbox 형태로 노출되던
 *   짧은 reference cards (호환성 표, 핀아웃, 회로도, ROS msg/srv 정의,
 *   펌웨어 다운로드 가이드 등). Docusaurus에서는 popup 컴포넌트가 없으므로
 *   일반 page로 변환하되 sidebar에 노출되지 않는 reference 페이지로 둔다.
 *
 *   서브카테고리 분포 (en):
 *     popup/                  : ~140
 *     popup/op3_ros2/          : ~37
 *     popup/arduino_api/       : ~45
 *     popup/general/           : ~3
 *     popup/engineer/          : ~8
 *     popup/turtlebot3/        : ~1
 *
 *   파일명에 `(...)` 또는 `.msg`/`.srv` 등이 포함되면 URL-안전하게 sanitize.
 *   원본 URL `/docs/en/popup/<file>/` 호환을 위해 sanitization은 보수적으로:
 *     - `(...)` → `_<inside>_` 그대로 유지하되 괄호만 제거
 *     - `.msg` / `.srv` / `.yaml` / `.cpp` / `.h` / `.txt` / `.xml` / `.world`
 *       / `.launch` 등 확장자 토큰 → `_msg` 등으로 치환 (Docusaurus가 .md 외 dot
 *       을 ID 일부로 받지 못함)
 *     - 결과 출력: docusaurus/docs/popup/<sanitized-rel>.mdx + ko mirror
 *
 *   추가:
 *     - source/docs/en/popup/* 와 동일 구조의 kr 페어링이 있으면 ko로,
 *       없으면 영문 mirror + 한국어 번역 안내 admonition.
 *     - kr 전용 페이지 (apk_install, usb_driver_install, faq_protocol_compatibility_table 등)
 *       도 포함.
 *     - 변환 후 이미 변환된 상위 docs (faq, edu, software 등) 의
 *       `https://emanual.robotis.com/docs/en/popup/<x>` 외부 링크를
 *       내부 `/docs/popup/<sanitized>` 로 재작성.
 *     - `docusaurus/docs/popup/_category_.json` 에 sidebar 비노출 설정.
 *
 *   사용: node scripts/convert-popup.js
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

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function writeOut(p, content) { ensureDir(path.dirname(p)); fs.writeFileSync(p, content); }
function copyFile(src, dst) {
  if (!fs.existsSync(src)) return false;
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  return true;
}
function exists(p) { return fs.existsSync(p); }
function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }

const FENCE_NORMALIZE = {
  '': 'text', c: 'c', cpp: 'cpp', 'c++': 'cpp',
  python: 'python', py: 'python', java: 'java',
  cs: 'csharp', csharp: 'csharp',
  bash: 'bash', shell: 'bash', sh: 'bash',
  json: 'json', yaml: 'yaml', yml: 'yaml',
  text: 'text', cmake: 'cmake', xml: 'xml', html: 'html',
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
      if (v === '') { fm[top[1]] = {}; curKey = top[1]; }
      else { fm[top[1]] = v.replace(/^['"]|['"]$/g, ''); curKey = null; }
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
  if (fm.sidebar_class_name) lines.push(`sidebar_class_name: ${fm.sidebar_class_name}`);
  if (fm.hide_table_of_contents) lines.push(`hide_table_of_contents: ${fm.hide_table_of_contents}`);
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

// ------------------------------------------------------------
// Liquid include resolver (popup엔 거의 없지만 안전망)
// ------------------------------------------------------------
function resolveInclude(includePath, ctx, depth = 0) {
  if (depth > 5) return `<!-- include depth limit: ${includePath} -->`;
  const candidates = [path.join(SRC_INCLUDES, includePath)];
  let full = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) { full = c; break; }
  }
  if (!full) return null;
  let txt = fs.readFileSync(full, 'utf8');
  txt = txt.replace(/\{%\s*include\s+([^\s%]+)\s*%\}/g, (_, p) => {
    const inc = resolveInclude(p, ctx, depth + 1);
    return inc === null ? `<!-- unresolved include: ${p} -->` : inc;
  });
  return txt;
}

// ------------------------------------------------------------
// Liquid capture / endcapture / markdownify
// ------------------------------------------------------------
function transformLiquidCapture(src) {
  const captures = {};
  src = src.replace(
    /\{%\s*capture\s+(\w+)\s*%\}([\s\S]*?)\{%\s*endcapture\s*%\}/g,
    (_, name, content) => { captures[name] = content.trim(); return ''; },
  );
  src = src.replace(
    /<div\s+class="notice(?:--([a-z]+))?"\s*>\s*\{\{\s*(\w+)\s*\|\s*markdownify\s*\}\}\s*<\/div>/g,
    (_, variant, name) => {
      const body = captures[name];
      if (body === undefined) return '';
      let admType = 'note';
      if (!variant) admType = 'note';
      else if (variant === 'info' || variant === 'primary') admType = 'info';
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
// <div class="notice--xxx"> → admonition
// ------------------------------------------------------------
function transformDivNotices(src) {
  const variants = [
    ['notice--danger', 'danger'],
    ['notice--warning', 'warning'],
    ['notice--success', 'tip'],
    ['notice--info', 'info'],
    ['notice--primary', 'note'],
    ['notice', 'note'],
  ];
  for (const [cls, kind] of variants) {
    const re = new RegExp(`<div\\s+class="${cls}"\\s*>([\\s\\S]*?)<\\/div>`, 'g');
    src = src.replace(re, (_, body) => `\n:::${kind}\n\n${body.trim()}\n\n:::\n`);
  }
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
    // `{: .notice}`, `{: .notice--info}`, `{: .notice --info}` (오타) 모두 매치
    const m = line.match(/^\s*\{:\s*\.notice\s*(?:--?\s*)?([a-z]+)?\s*\}\s*$/);
    if (!m) { out.push(line); continue; }
    const variant = (m[1] || '').toLowerCase();
    let admType = 'note';
    if (variant === 'info') admType = 'info';
    else if (variant === 'warning') admType = 'warning';
    else if (variant === 'success') admType = 'tip';
    else if (variant === 'danger') admType = 'danger';
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
        out.push('```'); inFence = false; fenceIndent = '';
        continue;
      }
      if (fenceIndent && line.startsWith(fenceIndent)) out.push(line.slice(fenceIndent.length));
      else out.push(line);
    }
  }
  return out.join('\n');
}

// ------------------------------------------------------------
// MDX safe escape
// ------------------------------------------------------------
function mdxEscapeOutsideFences(src) {
  const lines = src.split('\n');
  let inFence = false;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    let out = '';
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === '`') {
        const end = line.indexOf('`', i + 1);
        if (end === -1) { out += line.slice(i); i = line.length; }
        else { out += line.slice(i, end + 1); i = end + 1; }
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
            const inner = m[0].slice(1, -1).replace(/</g, '&lt;').replace(/>/g, '&gt;');
            out += '&lt;' + inner + '&gt;';
            i += m[0].length;
            continue;
          }
          out += m[0];
          i += m[0].length;
          continue;
        }
        out += '&lt;'; i++; continue;
      }
      if (ch === '{') { out += '&#123;'; i++; continue; }
      if (ch === '}') { out += '&#125;'; i++; continue; }
      out += ch; i++;
    }
    lines[li] = out;
  }
  return lines.join('\n');
}

function collapseBlankLines(src) { return src.replace(/\n{3,}/g, '\n\n'); }

// ------------------------------------------------------------
// 이미지/링크 재작성
// ------------------------------------------------------------
function rewriteAssetPaths(body) {
  body = body.replace(/\/assets\/images\/edu\//g, '/img/edu/');
  body = body.replace(/\/assets\/images\/faq\//g, '/img/faq/');
  body = body.replace(/\/assets\/images\/parts\//g, '/img/parts/');
  body = body.replace(/\/assets\/images\/sw\//g, '/img/software/');
  body = body.replace(/\/assets\/images\/dxl\//g, '/img/dxl/');
  body = body.replace(/\/assets\/images\/platform\//g, '/img/platform/');
  body = body.replace(/\/assets\/images\/popup\//g, '/img/popup/');
  body = body.replace(/\/assets\/images\/icon_warning\.png/g, '/img/icon_warning.png');
  body = body.replace(/\/assets\/images\/icon_unfold\.png/g, '/img/icon_unfold.png');
  body = body.replace(/\(\/assets\/images\//g, '(/img/');
  body = body.replace(/\]\(\/assets\/([^)\s]+)\)/g, (_, p) => `](https://emanual.robotis.com/assets/${p})`);
  return body;
}

// ------------------------------------------------------------
// popup 파일 sanitization
//   - 디렉터리 segment 는 그대로
//   - 파일 stem 의 `(...)` → `__namespace__` 형태로
//   - `.msg` / `.srv` / `.yaml` / `.cpp` / `.h` / `.txt` / `.xml` / `.world`
//     / `.launch` / `.cn` 같은 의미 토큰 dot → `_`
// ------------------------------------------------------------
function sanitizePopupId(stem) {
  let s = stem;
  // (foo) → _foo_
  s = s.replace(/\(([^)]*)\)/g, '_$1_');
  // 모든 dot을 underscore 로 (파일명에 .msg, .srv, .yaml 등이 들어가도 안전)
  s = s.replace(/\./g, '_');
  // 중복 underscore
  s = s.replace(/_+/g, '_');
  // leading/trailing underscore
  s = s.replace(/^_|_$/g, '');
  return s;
}

function sanitizePopupRel(srcRel) {
  // srcRel: 예) "popup/(foo)JointTorqueOnOff.msg.md" 또는 "popup/op3_ros2/foo.md"
  const dir = path.posix.dirname(srcRel);
  const base = path.posix.basename(srcRel).replace(/\.md$/, '');
  const id = sanitizePopupId(base);
  return { rel: dir === '.' ? `${id}.mdx` : `${dir}/${id}.mdx`, id };
}

// ------------------------------------------------------------
// 변환된 페이지 path 수집용 (원본 popup URL → 출력 URL 매핑)
// ------------------------------------------------------------
const popupUrlMap = new Map(); // key: '/docs/en/popup/<original-stem>' → '/docs/popup/<sanitized>'

function rewriteInternalLinks(body) {
  // popup 내부 링크: /docs/<lang>/popup/<rest> → /docs/popup/<rest> (sanitized)
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/popup\/([^)\s#]+?)\/?(#[^)\s]*)?\)/g,
    (m, lang, p, hash) => {
      const sanitized = sanitizePopupRelStr(p);
      return `](/docs/popup/${sanitized}${hash || ''})`;
    },
  );
  body = body.replace(
    /^(\s*\[[^\]]+\]):\s*\/docs\/(en|kr)\/popup\/([^\s#]+?)\/?(#[^\s]*)?\s*$/gm,
    (m, label, lang, p, hash) => {
      const sanitized = sanitizePopupRelStr(p);
      return `${label}: /docs/popup/${sanitized}${hash || ''}`;
    },
  );

  // 다른 영역 링크 정리
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/(edu|faq|parts|software|dxl|platform)\/([^)\s#]+?)\/?(#[^)\s]*)?\)/g,
    (_, lang, area, p, hash) => `](/docs/${area}/${p}${hash || ''})`,
  );
  body = body.replace(
    /^(\s*\[[^\]]+\]):\s*\/docs\/(en|kr)\/(edu|faq|parts|software|dxl|platform)\/([^\s#]+?)\/?(#[^\s]*)?\s*$/gm,
    (_, label, lang, area, p, hash) => `${label}: /docs/${area}/${p}${hash || ''}`,
  );

  // 그 외 /docs/<lang>/... → 외부 강등
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/([^)\s#]+?)\/?(#[^)\s]*)?\)/g,
    (_, lang, p, hash) => `](https://emanual.robotis.com/docs/${lang}/${p}/${hash || ''})`,
  );

  return body;
}

function sanitizePopupRelStr(p) {
  // 'general/cm_100_download_task' → 'general/cm_100_download_task'
  // '(foo)JointTorqueOnOff.msg' → '_foo_JointTorqueOnOff_msg'
  const segs = p.split('/');
  const last = segs.pop();
  const sanitized = sanitizePopupId(last);
  return segs.length ? `${segs.join('/')}/${sanitized}` : sanitized;
}

// ------------------------------------------------------------
// 헤딩 정리
// ------------------------------------------------------------
function cleanHeadings(body, title) {
  body = body.replace(
    /^(#{1,6})\s+\[([^\]]+)\]\(#[^)]*\)\s*$/gm,
    (_, h, t) => `${h} ${t.trim()}`,
  );
  body = body.replace(
    /^(#{1,6})\s+\*\*\[([^\]]+)\]\(#[^)]*\)\*\*\s*$/gm,
    (_, h, t) => `${h} ${t.trim()}`,
  );
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
        if (textNorm === titleNorm) {
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
// 본문 변환
// ------------------------------------------------------------
function convertBody(body, ctx = {}) {
  // Liquid include
  body = body.replace(/\{%\s*include\s+([^\s%]+)\s*%\}/g, (_, p) => {
    const inc = resolveInclude(p, ctx);
    return inc === null ? `<!-- unresolved include: ${p} -->` : inc;
  });

  // Liquid capture / markdownify
  body = transformLiquidCapture(body);

  // Liquid 잔여 변수 / 조건문 토큰 제거 (popup엔 거의 없음)
  body = body.replace(/\{%[-\s]*assign[\s\S]*?%\}/g, '');
  body = body.replace(/\{%[-\s]*(if|elsif|else|endif|unless|endunless|capture|endcapture)[\s\S]*?%\}/g, '');
  body = body.replace(/\{\{[\s\S]*?\}\}/g, '');

  body = body.replace(/<style>[\s\S]*?<\/style>/g, '');
  body = body.replace(/<div\s+style="counter-reset:[^"]*"\s*><\/div>/g, '');
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  body = body.replace(/^\s*\{::options[^}]*\}\s*$/gm, '');
  body = body.replace(/^\s*\{:toc\}\s*$/gm, '');
  body = body.replace(/<a\s+name=["'][^"']*["']\s*>?\s*<\/a>/gi, '');
  body = body.replace(/<a\s+name=["'][^"']*["']\s*<\/a>/gi, '');
  body = body.replace(/<div\s+class="main-header"\s*>[\s\S]*?<\/div>/g, '');

  body = body.replace(/<br\s*\/?\s*>/gi, '<br />');
  body = body.replace(/<hr\s*\/?\s*>/gi, '<hr />');
  body = body.replace(/<img\b([^>]*?)(?<!\/)>/gi, '<img$1 />');

  body = body.replace(/\{:\s*\.popup\s*\}/g, '');
  body = body.replace(/\{:\s*\.button\s*\}/g, '');
  body = body.replace(/\{:\s*\.blank\s*\}/g, '');
  body = body.replace(/\{:\s*\.text-center\s*\}/g, '');
  body = body.replace(/\{:\s*\.align-center\s*\}/g, '');

  body = cleanHeadings(body, ctx.title);

  body = body.replace(/<section[^>]*>/g, '');
  body = body.replace(/<\/section>/g, '');

  body = transformDivNotices(body);
  body = transformKramdownNotices(body);

  body = body.replace(/^\s*\{:\s*\.[a-z\-]+(?:--[a-z]+)?\s*\}\s*$/gm, '');
  body = body.replace(/\{:\s*\.[a-z\-]+(?:--[a-z]+)?\s*\}/g, '');
  body = body.replace(/\{:\s*[^}]*\}/g, '');

  body = normalizeFences(body);
  body = rewriteAssetPaths(body);
  body = rewriteInternalLinks(body);

  body = mdxEscapeOutsideFences(body);

  body = body.replace(/style="([^"]*)"/g, (m, css) => {
    const decls = css.split(';').map(s => s.trim()).filter(Boolean);
    const pairs = [];
    for (const d of decls) {
      const idx = d.indexOf(':');
      if (idx < 0) continue;
      let prop = d.slice(0, idx).trim();
      let val = d.slice(idx + 1).trim();
      prop = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const valEsc = val.replace(/'/g, "\\'");
      pairs.push(`${prop}: '${valEsc}'`);
    }
    if (pairs.length === 0) return '';
    return `style={{${pairs.join(', ')}}}`;
  });

  body = collapseBlankLines(body);
  return body;
}

// ------------------------------------------------------------
// title 추출 (frontmatter엔 없으므로 본문 첫 H1 또는 파일명)
// ------------------------------------------------------------
function extractTitle(body, fallbackId) {
  const m = body.match(/^\s*#\s+(?:\[[^\]]*\]\([^)]*\)\s*\*?\*?|.*?)\s*$/m);
  if (m) {
    let line = m[0].replace(/^\s*#\s+/, '').trim();
    // [Foo](#foo) → Foo
    const bracket = line.match(/^\[([^\]]+)\]\([^)]*\)\*?\*?$/);
    if (bracket) line = bracket[1].trim();
    // **[Foo](#foo)** → Foo
    const boldBracket = line.match(/^\*\*\[([^\]]+)\]\([^)]*\)\*\*$/);
    if (boldBracket) line = boldBracket[1].trim();
    // 일반 텍스트
    return line;
  }
  // fallback: id를 인간 가독 형식으로
  return fallbackId.replace(/_/g, ' ');
}

// ------------------------------------------------------------
// ko mirror notice
// ------------------------------------------------------------
function buildKoMirror(enContent) {
  const m = enContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return enContent;
  const fmText = m[1];
  const bodyText = m[2];
  const notice = '\n:::info\n\n한국어 번역 준비 중입니다. 아래는 영문 원본입니다.\n\n:::\n\n';
  return `---\n${fmText}\n---\n${notice}${bodyText}`;
}

// ------------------------------------------------------------
// 파일 변환
// ------------------------------------------------------------
function convertOnePopup(srcEnFull, srcKrFull, srcRelFromPopup) {
  // srcRelFromPopup: 예) "(foo)JointTorqueOnOff.msg.md" 또는 "op3_ros2/foo.md"
  const { rel: outRelFromPopup, id } = sanitizePopupRel(srcRelFromPopup);
  const outRel = `popup/${outRelFromPopup}`;

  const enRaw = readUtf8(srcEnFull);
  const { fm: enFm, body: enBody } = splitFrontmatter(enRaw);

  const title = enFm.title || extractTitle(enBody, id);

  const enCtx = {
    title,
    lang: 'en',
    ref: id,
    product_group: 'popup',
    vars: {},
  };
  let converted = convertBody(enBody, enCtx);

  const newFm = {
    id,
    title,
    sidebar_label: title,
    hide_table_of_contents: false,
  };
  const enContent = buildFmYaml(newFm) + converted.trimStart() + '\n';
  writeOut(path.join(OUT_EN_ROOT, outRel), enContent);

  const outKoFull = path.join(OUT_KO_ROOT, outRel);
  if (srcKrFull && fs.existsSync(srcKrFull)) {
    const krRaw = readUtf8(srcKrFull);
    const { fm: krFm, body: krBody } = splitFrontmatter(krRaw);
    const koTitle = krFm.title || extractTitle(krBody, id) || title;
    const koCtx = {
      title: koTitle,
      lang: 'kr',
      ref: id,
      product_group: 'popup',
      vars: {},
    };
    let koConverted = convertBody(krBody, koCtx);
    const koFm = { ...newFm, title: koTitle, sidebar_label: koTitle };
    const koContent = buildFmYaml(koFm) + koConverted.trimStart() + '\n';
    writeOut(outKoFull, koContent);
  } else {
    writeOut(outKoFull, buildKoMirror(enContent));
  }

  // 원본 popup URL → 출력 URL 매핑
  const origStem = srcRelFromPopup.replace(/\.md$/, '');
  popupUrlMap.set(`/docs/en/popup/${origStem}`, `/docs/popup/${outRelFromPopup.replace(/\.mdx$/, '')}`);
  popupUrlMap.set(`/docs/kr/popup/${origStem}`, `/docs/popup/${outRelFromPopup.replace(/\.mdx$/, '')}`);

  return { id, outRel };
}

// ------------------------------------------------------------
// 자산 복사 (popup 전용 이미지가 있을 경우)
// ------------------------------------------------------------
function copyAssets() {
  let count = 0;
  function walkCopy(srcRoot, dstRoot) {
    if (!exists(srcRoot)) return;
    function walk(d, rel) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        const next = rel ? path.join(rel, e.name) : e.name;
        if (e.isDirectory()) walk(full, next);
        else if (e.isFile()) {
          const dst = path.join(dstRoot, next);
          if (!exists(dst)) {
            copyFile(full, dst);
            count++;
          }
        }
      }
    }
    walk(srcRoot, '');
  }
  // popup-specific assets (있으면)
  walkCopy(path.join(ASSET_SRC_ROOT, 'images/popup'), path.join(ASSET_OUT_ROOT, 'popup'));
  // sw/mobile (apk_install 등) - ko-only 페이지가 사용
  walkCopy(path.join(ASSET_SRC_ROOT, 'images/sw'), path.join(ASSET_OUT_ROOT, 'software'));
  return count;
}

// ------------------------------------------------------------
// _category_.json 생성 — popup은 sidebar 비노출
// ------------------------------------------------------------
function writePopupCategory() {
  // sidebar에 노출하지 않으려면 sidebars.ts에서 popup 디렉터리를 제외하는 방식이 정석.
  // 여기서는 _category_.json으로 명시: collapsed + 가능한 한 단순.
  const data = {
    label: 'Popup Reference',
    position: 999,
    collapsed: true,
    collapsible: true,
    link: { type: 'generated-index' },
    className: 'sidebar-hidden',
  };
  writeOut(path.join(OUT_EN_ROOT, 'popup/_category_.json'), JSON.stringify(data, null, 2) + '\n');
  writeOut(path.join(OUT_KO_ROOT, 'popup/_category_.json'), JSON.stringify(data, null, 2) + '\n');
  // 서브카테고리도 동일
  for (const sub of ['arduino_api', 'op3_ros2', 'general', 'engineer', 'turtlebot3']) {
    const subData = {
      label: sub,
      collapsed: true,
      collapsible: true,
      link: { type: 'generated-index' },
      className: 'sidebar-hidden',
    };
    const enSubDir = path.join(OUT_EN_ROOT, 'popup', sub);
    const koSubDir = path.join(OUT_KO_ROOT, 'popup', sub);
    if (exists(enSubDir)) writeOut(path.join(enSubDir, '_category_.json'), JSON.stringify(subData, null, 2) + '\n');
    if (exists(koSubDir)) writeOut(path.join(koSubDir, '_category_.json'), JSON.stringify(subData, null, 2) + '\n');
  }
}

// ------------------------------------------------------------
// popup index 생성
// ------------------------------------------------------------
function buildPopupIndex() {
  const meta = {
    id: 'popup',
    title: 'Popup Reference',
    sidebarLabel: 'Popup Reference',
    sidebarPosition: 999,
    slug: '/popup',
  };
  const enBody = `# Popup Reference

This section contains reference cards (compatibility tables, ROS message/service definitions, firmware download guides, pinouts, etc.) that were previously displayed as modal popups in the legacy emanual site.

These pages are typically linked from product documentation rather than browsed directly.
`;
  const koBody = `# 팝업 참조

이 영역에는 기존 emanual에서 모달 팝업으로 표시되던 reference card (호환성 표, ROS 메시지/서비스 정의, 펌웨어 다운로드 가이드, 핀아웃 등)가 포함됩니다.

각 페이지는 일반적으로 제품 문서에서 링크로 참조되며, 직접 탐색용은 아닙니다.
`;
  const newFm = {
    id: meta.id,
    title: meta.title,
    sidebar_label: meta.sidebarLabel,
    sidebar_position: meta.sidebarPosition,
    slug: meta.slug,
  };
  writeOut(path.join(OUT_EN_ROOT, 'popup/index.mdx'), buildFmYaml(newFm) + enBody);
  writeOut(path.join(OUT_KO_ROOT, 'popup/index.mdx'), buildFmYaml(newFm) + koBody);
}

// ------------------------------------------------------------
// 변환 후처리: 이미 변환된 docs의 popup 외부 링크 → 내부 링크
// ------------------------------------------------------------
function rewritePopupLinksInOtherDocs() {
  let changedFiles = 0;
  let changedLinks = 0;
  const roots = [
    OUT_EN_ROOT,
    OUT_KO_ROOT,
  ];

  function* walk(dir) {
    if (!exists(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) yield* walk(full);
      else if (e.isFile() && /\.(md|mdx)$/.test(e.name)) yield full;
    }
  }

  for (const root of roots) {
    for (const f of walk(root)) {
      // popup 디렉터리 자체는 스킵 (이미 위에서 처리됨)
      if (f.includes(`${path.sep}popup${path.sep}`)) continue;
      let txt = readUtf8(f);
      const orig = txt;

      // https://emanual.robotis.com/docs/en/popup/<rest> 또는 /docs/kr/popup/<rest>
      // 경로 segment 와 trailing slash 옵션을 모두 처리
      txt = txt.replace(
        /https?:\/\/emanual\.robotis\.com\/docs\/(?:en|kr)\/popup\/([^)\s#]+?)\/?(#[^)\s]*)?(?=[)\s])/g,
        (m, p, hash) => {
          const sanitized = sanitizePopupRelStr(p);
          return `/docs/popup/${sanitized}${hash || ''}`;
        },
      );
      // reference link form `[label]: https://....popup/x/`
      txt = txt.replace(
        /^(\[[^\]]+\]):\s*https?:\/\/emanual\.robotis\.com\/docs\/(?:en|kr)\/popup\/([^\s#]+?)\/?(#[^\s]*)?\s*$/gm,
        (m, label, p, hash) => {
          const sanitized = sanitizePopupRelStr(p);
          return `${label}: /docs/popup/${sanitized}${hash || ''}`;
        },
      );

      // 이전 변환 단계에서 이미 `/docs/popup/<orig>` (sanitize 누락) 으로 출력된 링크.
      // 예: `/docs/popup/(op3_tuning_module_msgs)JointOffsetData.msg/` → `/docs/popup/_op3_tuning_module_msgs_JointOffsetData_msg`
      // p 가 이미 sanitized 형태(_가 들어있고 ./( 없음)이면 그대로 둠.
      txt = txt.replace(
        /\]\(\/docs\/popup\/([^)\s#]+?)\/?(#[^)\s]*)?\)/g,
        (m, p, hash) => {
          if (!/[().]/.test(p)) return m; // 이미 sanitize 된 형태
          const sanitized = sanitizePopupRelStr(p);
          return `](/docs/popup/${sanitized}${hash || ''})`;
        },
      );
      txt = txt.replace(
        /^(\[[^\]]+\]):\s*\/docs\/popup\/([^\s#]+?)\/?(#[^\s]*)?\s*$/gm,
        (m, label, p, hash) => {
          if (!/[().]/.test(p)) return m;
          const sanitized = sanitizePopupRelStr(p);
          return `${label}: /docs/popup/${sanitized}${hash || ''}`;
        },
      );

      if (txt !== orig) {
        // count rewrites by comparing
        const beforeCount = (orig.match(/popup/g) || []).length;
        fs.writeFileSync(f, txt);
        changedFiles++;
        // 한 파일 내 링크 수는 정확히 못 셈 — diff line 단위로 단순화
        const diffLines = orig.split('\n').filter((l, i) => l !== txt.split('\n')[i]).length;
        changedLinks += diffLines;
      }
    }
  }

  return { changedFiles, changedLinks };
}

// ------------------------------------------------------------
// 메인
// ------------------------------------------------------------
function* walkPopupSrc(root) {
  if (!exists(root)) return;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) yield* walkPopupSrc(full);
    else if (e.isFile() && e.name.endsWith('.md')) yield full;
  }
}

function relFromPopup(absPath, base) {
  return path.relative(base, absPath).split(path.sep).join('/');
}

function main() {
  const stats = {
    enPages: 0,
    koPaired: 0,
    koMirrored: 0,
    koOnly: 0,
    duplicateIdSkipped: 0,
    assets: 0,
  };

  const popupEnRoot = path.join(SRC_EN, 'popup');
  const popupKrRoot = path.join(SRC_KR, 'popup');
  const seenOutRel = new Set();

  // 1) en 파일 모두 변환 (kr 미러 페어링 시도)
  for (const f of walkPopupSrc(popupEnRoot)) {
    const relFromPopupRoot = relFromPopup(f, popupEnRoot); // 예: "(foo)JointTorqueOnOff.msg.md"
    const krCandidate = path.join(popupKrRoot, relFromPopupRoot);
    const result = convertOnePopup(f, krCandidate, relFromPopupRoot);
    if (seenOutRel.has(result.outRel)) {
      stats.duplicateIdSkipped++;
      // 첫 번째가 우선; 나중 항목은 덮어쓰지만 통계만 기록
    }
    seenOutRel.add(result.outRel);
    stats.enPages++;
    if (exists(krCandidate)) stats.koPaired++;
    else stats.koMirrored++;
  }

  // 2) kr-only 파일 (en에 없는 것)
  if (exists(popupKrRoot)) {
    for (const f of walkPopupSrc(popupKrRoot)) {
      const relFromPopupRoot = relFromPopup(f, popupKrRoot);
      const enCandidate = path.join(popupEnRoot, relFromPopupRoot);
      if (exists(enCandidate)) continue; // 이미 처리됨
      // ko-only: ko를 영문/한국어 동시 출력
      const { rel: outRelFromPopup, id } = sanitizePopupRel(relFromPopupRoot);
      const outRel = `popup/${outRelFromPopup}`;
      const krRaw = readUtf8(f);
      const { fm: krFm, body: krBody } = splitFrontmatter(krRaw);
      const koTitle = krFm.title || extractTitle(krBody, id);
      const koCtx = { title: koTitle, lang: 'kr', ref: id, product_group: 'popup', vars: {} };
      const koConverted = convertBody(krBody, koCtx);
      const newFm = { id, title: koTitle, sidebar_label: koTitle };
      const koContent = buildFmYaml(newFm) + koConverted.trimStart() + '\n';
      writeOut(path.join(OUT_KO_ROOT, outRel), koContent);
      // en stub
      const stubBody = `:::info\n\nThis page is currently available in Korean only. The original Korean content is shown below.\n\n:::\n\n${koConverted.trimStart()}\n`;
      writeOut(path.join(OUT_EN_ROOT, outRel), buildFmYaml(newFm) + stubBody);
      stats.koOnly++;
      seenOutRel.add(outRel);
      const origStem = relFromPopupRoot.replace(/\.md$/, '');
      popupUrlMap.set(`/docs/en/popup/${origStem}`, `/docs/popup/${outRelFromPopup.replace(/\.mdx$/, '')}`);
      popupUrlMap.set(`/docs/kr/popup/${origStem}`, `/docs/popup/${outRelFromPopup.replace(/\.mdx$/, '')}`);
    }
  }

  // 3) index, _category_.json
  buildPopupIndex();
  writePopupCategory();

  // 4) 자산 복사
  stats.assets = copyAssets();

  // 5) 다른 docs의 popup 외부 링크 재작성
  const linkStats = rewritePopupLinksInOtherDocs();

  // 6) 알려진 case-insensitive / 이름 변경된 popup 링크 보정
  //    (다른 변환 단계에서 만들어진 깨진 popup 링크)
  const orphanFixes = fixKnownOrphanPopupLinks();

  // 7) 미존재 내부 링크 외부 강등 (popup 페이지 내부 + 다른 영역)
  const downgraded = downgradeUnresolvedInternalLinks();

  console.log('Popup conversion complete.');
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v}`);
  console.log(`  link rewrites: changedFiles=${linkStats.changedFiles}`);
  console.log(`  orphan fixes: ${orphanFixes}`);
  console.log(`  downgraded internal: ${downgraded}`);
}

// ------------------------------------------------------------
// 알려진 case-insensitive / 이름 변경 popup 링크 보정
// ------------------------------------------------------------
function fixKnownOrphanPopupLinks() {
  // before → after 매핑
  const aliases = {
    'std_msgs_float64_msg': 'std_msgs_Float64_msg',
    'std_msgs_header': 'std_msgs_Header',
    'std_msgs_int32multiarray_msg': 'std_msgs_Int32MultiArray_msg',
    'std_msgs_empty_msg': 'std_msgs_Empty_msg',
    'sensor_msgs_imu_msg': 'sensor_msgs_IMU_msg',
    'sensor_msgs_camerainfo_msg': 'sensor_msgs_CameraInfo_msg',
    'sensor_msgs_jointstate_msg': 'sensor_msgs_JointState_msg',
    'sensor_msgs_pointcloud2_msg': 'sensor_msgs_PointCloud2_msg',
    'sensor_msgs_image': 'sensor_msgs_Image',
    'visualization_msgs_markerarray_msg': 'visualization_msgs_MarkerArray_msg',
    'thormang3_manager_cpp': 'thormang_manager_cpp',
    'open_manipulator_p_coordinates': 'open_manipulator_coordinates',
  };

  let changed = 0;
  function* walkAll() {
    for (const root of [OUT_EN_ROOT, OUT_KO_ROOT]) {
      if (!exists(root)) continue;
      yield* walkMd(root);
    }
  }
  function* walkMd(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) yield* walkMd(full);
      else if (e.isFile() && /\.(md|mdx)$/.test(e.name)) yield full;
    }
  }
  for (const f of walkAll()) {
    let txt = readUtf8(f);
    const orig = txt;
    for (const [from, to] of Object.entries(aliases)) {
      const re = new RegExp(`/docs/popup/${from}\\b`, 'g');
      txt = txt.replace(re, `/docs/popup/${to}`);
    }
    if (txt !== orig) {
      fs.writeFileSync(f, txt);
      changed++;
    }
  }
  return changed;
}

// ------------------------------------------------------------
// popup 페이지 내부 링크 중 미존재 내부 페이지 → 외부 URL 강등
// ------------------------------------------------------------
function collectExistingPaths() {
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
  return paths;
}

function downgradeUnresolvedInternalLinks() {
  const valid = collectExistingPaths();
  let downgraded = 0;
  function* walkPopupOut() {
    const root = path.join(OUT_EN_ROOT, 'popup');
    const koRoot = path.join(OUT_KO_ROOT, 'popup');
    for (const r of [root, koRoot]) {
      if (!exists(r)) continue;
      for (const e of fs.readdirSync(r, { withFileTypes: true })) {
        const full = path.join(r, e.name);
        if (e.isDirectory()) yield* walkPopupSub(full);
        else if (e.isFile() && /\.(md|mdx)$/.test(e.name)) yield full;
      }
    }
  }
  function* walkPopupSub(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) yield* walkPopupSub(full);
      else if (e.isFile() && /\.(md|mdx)$/.test(e.name)) yield full;
    }
  }
  for (const f of walkPopupOut()) {
    let txt = readUtf8(f);
    const orig = txt;
    txt = txt.replace(
      /\]\(\/docs\/([A-Za-z][A-Za-z0-9_\-/]*?)(#[^)\s]*)?\)/g,
      (m, p, hash) => {
        const target = '/docs/' + p.replace(/\/+$/, '');
        if (valid.has(target)) return m;
        downgraded++;
        return `](https://emanual.robotis.com/docs/en/${p}/${hash || ''})`;
      },
    );
    txt = txt.replace(
      /^(\[[^\]]+\]):\s*\/docs\/([A-Za-z][A-Za-z0-9_\-/]*?)\/?(#[^\s]*)?\s*$/gm,
      (m, label, p, hash) => {
        const target = '/docs/' + p.replace(/\/+$/, '');
        if (valid.has(target)) return m;
        downgraded++;
        return `${label}: https://emanual.robotis.com/docs/en/${p}/${hash || ''}`;
      },
    );
    if (txt !== orig) fs.writeFileSync(f, txt);
  }
  return downgraded;
}

main();
