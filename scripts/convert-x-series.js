#!/usr/bin/env node
/**
 * X 시리즈 변환 스크립트 (clean rewrite).
 *
 * 입력:
 *   - source/docs/{en,kr}/dxl/x/*.md          (38 페이지 × 2)
 *   - source/_includes/{en,kr}/dxl/x/<frag>.md (X 전용 fragment)
 *   - source/_includes/{en,kr}/dxl/<frag>.md   (공유 fragment)
 *
 * 출력:
 *   - docusaurus/docs/dxl/x/<ref>.mdx                   (en)
 *   - docusaurus/i18n/ko/.../current/dxl/x/<ref>.mdx    (ko)
 *   - docusaurus/docs/_partials/dxl/x/<frag>.mdx        (en)
 *   - docusaurus/i18n/ko/.../current/_partials/dxl/x/<frag>.mdx (ko)
 *
 * Liquid:
 *   - {% if cond %} ... {% elsif cond %} ... {% else %} ... {% endif %} 평가
 *   - {% assign foo = "bar" %}
 *   - {% capture foo %} ... {% endcapture %}
 *   - {% include path %}
 *   - {{ foo }} 변수 치환
 *   - {{ foo | markdownify }} → {{ foo }}
 *
 * Kramdown:
 *   - {: .notice}/{: .notice--warning}/{: .notice--info}/{: .notice--danger}
 *   - {::options ...} 제거
 *   - {:toc} / {: .blank} / {: .popup} / {: .text-center} 제거
 *   - <div class="notice..."> ... </div> → admonition
 *
 * 헤딩:
 *   - "## **[Title](#anchor)**" → "## Title"
 *   - "<a name=...>" 는 보존 → 후처리 (inject-heading-anchors.js) 가 변환된 mdx에 anchor 부착
 *
 * 이미지:
 *   - /assets/images/dxl/... → /img/dxl/...
 *   - /assets/images/... → /img/...
 *
 * 사용법: node scripts/convert-x-series.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SRC = (lang) => path.join(REPO, 'source', 'docs', lang, 'dxl', 'x');
const INC = (lang) => path.join(REPO, 'source', '_includes', lang, 'dxl');
const OUT_DOC_EN = path.join(REPO, 'docusaurus', 'docs', 'dxl', 'x');
const OUT_DOC_KO = path.join(REPO, 'docusaurus', 'i18n', 'ko', 'docusaurus-plugin-content-docs', 'current', 'dxl', 'x');
const OUT_PART_EN = path.join(REPO, 'docusaurus', 'docs', '_partials', 'dxl', 'x');
const OUT_PART_KO = path.join(REPO, 'docusaurus', 'i18n', 'ko', 'docusaurus-plugin-content-docs', 'current', '_partials', 'dxl', 'x');

// ----- 페이지 컨텍스트 -----
const PROFILES = {
  '2xc430-w250':   { product_group: 'dxl_x430' },
  '2xl430-w250':   { product_group: 'dxl_xl430' },
  'xc330-m181':    { product_group: 'xc330' },
  'xc330-m288':    { product_group: 'xc330' },
  'xc330-t181':    { product_group: 'xc330' },
  'xc330-t288':    { product_group: 'xc330' },
  'xc430-t150bb':  { product_group: 'dxl_x430' },
  'xc430-t240bb':  { product_group: 'dxl_x430' },
  'xc430-w150':    { product_group: 'dxl_x430' },
  'xc430-w240':    { product_group: 'dxl_x430' },
  'xd430-t210':    { product_group: 'dxl_x430' },
  'xd430-t350':    { product_group: 'dxl_x430' },
  'xd540-t150':    { product_group: 'dxl_x540' },
  'xd540-t270':    { product_group: 'dxl_x540' },
  'xh430-v210':    { product_group: 'dxl_x430' },
  'xh430-v350':    { product_group: 'dxl_x430' },
  'xh430-w210':    { product_group: 'dxl_x430' },
  'xh430-w350':    { product_group: 'dxl_x430' },
  'xh540-v150':    { product_group: 'dxl_x540' },
  'xh540-v270':    { product_group: 'dxl_x540' },
  'xh540-w150':    { product_group: 'dxl_x540' },
  'xh540-w270':    { product_group: 'dxl_x540' },
  'xl320':         { product_group: 'dxl_xl320' },
  'xl330-m077':    { product_group: 'xl330' },
  'xl330-m288':    { product_group: 'xl330' },
  'xl430-w250':    { product_group: 'dxl_xl430' },
  'xm335-t323':    { product_group: 'xm335' },
  'xm430-w210':    { product_group: 'dxl_x430' },
  'xm430-w350':    { product_group: 'dxl_x430' },
  'xm540-w150':    { product_group: 'dxl_x540' },
  'xm540-w270':    { product_group: 'dxl_x540' },
  'xw430-t200':    { product_group: 'dxl_xw430' },
  'xw430-t333':    { product_group: 'dxl_xw430' },
  'xw540-h260':    { product_group: 'dxl_xw540' },
  'xw540-t140':    { product_group: 'dxl_xw540' },
  'xw540-t260':    { product_group: 'dxl_xw540' },
  'x':             { product_group: 'dxl_x' },
};

// ----- 사양표 (specifications_x.md inline 처리용) -----
// dxl_x_info.yml은 anchor 오류로 직접 로딩 어려움 → Python으로 사전 추출되었다고 가정하거나 인라인 fallback
// 페이지에서 specifications 표는 문서마다 비슷한 형태이므로, 본 스크립트는 placeholder 주석만 남기고
// 사양표는 페이지 공통 처리에서 별도 partial(인라인된 사양 표)을 import 하지 않고 fallback 표로 대체.
// 우선은 공통 노트만 출력.
function specsTablePlaceholder(ref, lang) {
  const langLabel = lang === 'kr' ? '주요 사양' : 'Specifications';
  const note = lang === 'kr'
    ? `자세한 사양 정보는 [공식 사양 페이지](https://emanual.robotis.com/docs/en/dxl/x/${ref}/#specifications)를 참조하세요.`
    : `Refer to the [official specification page](https://emanual.robotis.com/docs/en/dxl/x/${ref}/#specifications) for detailed specifications.`;
  return `\n:::info\n\n${note}\n\n:::\n\n`;
}

// ----- Liquid parser -----
function tokenize(src) {
  const tokens = [];
  const re = /\{%-?\s*([\s\S]*?)\s*-?%\}|\{\{\s*([\s\S]*?)\s*\}\}/g;
  let last = 0, m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', value: src.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ type: 'tag', value: m[1].trim() });
    else tokens.push({ type: 'output', value: m[2].trim() });
    last = re.lastIndex;
  }
  if (last < src.length) tokens.push({ type: 'text', value: src.slice(last) });
  return tokens;
}

function evalAtomic(cond, ctx) {
  cond = cond.trim();
  let m;
  if ((m = cond.match(/^page\.(\w+)\s*(==|!=)\s*['"]([^'"]*)['"]$/))) {
    const v = ctx[m[1]];
    return m[2] === '==' ? v === m[3] : v !== m[3];
  }
  if ((m = cond.match(/^page\.(\w+)$/))) return Boolean(ctx[m[1]]);
  if ((m = cond.match(/^(\w+)\s*(==|!=)\s*['"]([^'"]*)['"]$/))) {
    const v = ctx.vars[m[1]];
    return m[2] === '==' ? v === m[3] : v !== m[3];
  }
  if ((m = cond.match(/^['"]([^'"]*)['"]\s*(==|!=)\s*['"]([^'"]*)['"]$/))) {
    return m[2] === '==' ? m[1] === m[3] : m[1] !== m[3];
  }
  return false;
}

function evalCond(expr, ctx) {
  expr = expr.replace(/^\s*(if|elsif|unless)\s+/, '').trim();
  if (expr.includes(' or ')) return expr.split(/\s+or\s+/).some(c => evalAtomic(c, ctx));
  if (expr.includes(' and ')) return expr.split(/\s+and\s+/).every(c => evalAtomic(c, ctx));
  return evalAtomic(expr, ctx);
}

function evalOutput(expr, ctx, dxlData) {
  const pipes = expr.split('|').map(s => s.trim());
  let base = pipes[0];
  let val;
  let m;
  if ((m = base.match(/^site\.data\.dxl_x_info\[page\.ref\]\.(\w+)$/))) {
    if (dxlData && dxlData[ctx.ref]) val = dxlData[ctx.ref][m[1]];
  } else if ((m = base.match(/^page\.(\w+)$/))) {
    val = ctx[m[1]];
  } else if (ctx.vars && Object.prototype.hasOwnProperty.call(ctx.vars, base)) {
    val = ctx.vars[base];
  }
  if (val === undefined) return `{{ ${expr} }}`;
  return String(val);
}

function render(tokens, ctx, includeHandler, dxlData) {
  let out = '';
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'text') { out += t.value; i++; continue; }
    if (t.type === 'output') { out += evalOutput(t.value, ctx, dxlData); i++; continue; }
    const tag = t.value;
    if (/^assign\s+/.test(tag)) {
      const m = tag.match(/^assign\s+(\w+)\s*=\s*(.+)$/);
      if (m) {
        let raw = m[2].trim();
        if ((raw[0] === '"' && raw.endsWith('"')) || (raw[0] === "'" && raw.endsWith("'"))) {
          ctx.vars[m[1]] = raw.slice(1, -1);
        } else if (/^\w+$/.test(raw) && Object.prototype.hasOwnProperty.call(ctx.vars, raw)) {
          ctx.vars[m[1]] = ctx.vars[raw];
        } else {
          ctx.vars[m[1]] = raw;
        }
      }
      i++; continue;
    }
    if (/^capture\s+/.test(tag)) {
      const name = tag.match(/^capture\s+(\w+)$/)[1];
      const sub = []; i++;
      let depth = 1;
      while (i < tokens.length && depth > 0) {
        const tt = tokens[i];
        if (tt.type === 'tag') {
          if (/^capture\s+/.test(tt.value)) { depth++; sub.push(tt); }
          else if (tt.value === 'endcapture') { depth--; if (depth === 0) { i++; break; } else sub.push(tt); }
          else sub.push(tt);
        } else sub.push(tt);
        i++;
      }
      ctx.vars[name] = render(sub, ctx, includeHandler, dxlData);
      continue;
    }
    if (/^if\b/.test(tag) || /^unless\b/.test(tag)) {
      const branches = [];
      let curCond = tag;
      let curTokens = [];
      i++;
      let depth = 1;
      while (i < tokens.length && depth > 0) {
        const tt = tokens[i];
        if (tt.type === 'tag') {
          if (/^if\b/.test(tt.value) || /^unless\b/.test(tt.value)) { depth++; curTokens.push(tt); }
          else if (tt.value === 'endif' || tt.value === 'endunless') {
            depth--;
            if (depth === 0) { branches.push({ cond: curCond, tokens: curTokens }); i++; break; }
            else curTokens.push(tt);
          } else if (depth === 1 && (/^elsif\b/.test(tt.value) || tt.value === 'else')) {
            branches.push({ cond: curCond, tokens: curTokens });
            curCond = tt.value;
            curTokens = [];
          } else curTokens.push(tt);
        } else curTokens.push(tt);
        i++;
      }
      let chosen = null;
      for (const b of branches) {
        if (b.cond === 'else') { chosen = b; break; }
        if (/^unless\b/.test(b.cond)) {
          if (!evalCond(b.cond.replace(/^unless\b/, 'if'), ctx)) { chosen = b; break; }
        } else if (evalCond(b.cond, ctx)) { chosen = b; break; }
      }
      if (chosen) out += render(chosen.tokens, ctx, includeHandler, dxlData);
      continue;
    }
    if (/^include\s+/.test(tag)) {
      const m = tag.match(/^include\s+(\S+)/);
      if (m && includeHandler) out += includeHandler(m[1].replace(/^\//, ''));
      i++; continue;
    }
    // unknown tag → skip silently (raw, comment, etc.)
    i++;
  }
  return out;
}

// ----- Frontmatter -----
function splitFrontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { fm: {}, body: src };
  const fmRaw = m[1];
  const body = src.slice(m[0].length);
  const fm = {};
  let curKey = null;
  fmRaw.split(/\r?\n/).forEach(line => {
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

// ----- 헬퍼 -----
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function writeOut(p, c) { ensureDir(path.dirname(p)); fs.writeFileSync(p, c); }
function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

function pascalCaseSegments(s) {
  let r = s.split(/[_\-\/]+/).filter(Boolean)
    .map(x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()).join('');
  // 변수명은 숫자로 시작 불가 → prefix 'X' 추가
  if (/^\d/.test(r)) r = 'X' + r;
  return r;
}
// 각 partial 이름은 (예) control_table_id → ControlTableId
function importVarFor(partialKey) {
  return pascalCaseSegments(partialKey);
}

// ----- Kramdown → MDX -----
// MDX는 본문 brace를 JSX expression으로 해석함. 수식/공식 brace를 &#123; &#125; 로 escape.
// 보호: code, JSX 주석, 단순 식별자.
function escapeMdxBraces(src) {
  const lines = src.split('\n');
  let inFence = false;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    // process inline code regions
    const out = [];
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === '`') {
        // copy until matching backtick
        const end = line.indexOf('`', i + 1);
        if (end === -1) { out.push(line.slice(i)); i = line.length; }
        else { out.push(line.slice(i, end + 1)); i = end + 1; }
        continue;
      }
      if (ch === '{') {
        // JSX comment open?
        if (line.slice(i, i + 2) === '{/' && line.slice(i, i + 3) === '{/*') {
          // copy through matching */}
          const end = line.indexOf('*/}', i + 3);
          if (end === -1) { out.push(line.slice(i)); i = line.length; }
          else { out.push(line.slice(i, end + 3)); i = end + 3; }
          continue;
        }
        // find matching '}' (not nested for simplicity)
        const close = line.indexOf('}', i + 1);
        if (close === -1) {
          // unmatched — escape this single brace
          out.push('&#123;');
          i++;
          continue;
        }
        const inner = line.slice(i + 1, close).trim();
        // pure identifier (e.g. {Foo}) or empty → leave as JSX expression
        if (/^[A-Za-z_$][\w$]*$/.test(inner) || inner === '') {
          out.push(line.slice(i, close + 1));
        } else {
          // escape braces
          out.push('&#123;' + line.slice(i + 1, close) + '&#125;');
        }
        i = close + 1;
        continue;
      }
      out.push(ch);
      i++;
    }
    lines[li] = out.join('');
  }
  return lines.join('\n');
}

function admonitionConvert(src, marker, kind) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (marker.test(lines[i])) {
      // Find body block above (until empty line or top of out)
      let start = out.length - 1;
      while (start >= 0 && out[start].trim() !== '') start--;
      const body = out.splice(start + 1).join('\n').trim();
      out.push('', `:::${kind}`, '', body, '', ':::', '');
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

function kramdownToMdx(src) {
  src = src.replace(/\{::options[^}]*\/\}/g, '');
  src = src.replace(/^\s*\*\s*\n\s*\{:toc\}\s*$/gm, '');
  src = src.replace(/\{:toc\}/g, '');
  src = src.replace(/\{:\s*\.text-center\}/g, '');
  src = src.replace(/\{:\s*\.blank\}/g, '');
  src = src.replace(/\{:\s*\.popup\}/g, '');

  // notice 변환 (순서 주의: --warning 가 .notice 보다 먼저)
  src = admonitionConvert(src, /^\s*\{:\s*\.notice--danger\}\s*$/, 'danger');
  src = admonitionConvert(src, /^\s*\{:\s*\.notice--warning\}\s*$/, 'warning');
  src = admonitionConvert(src, /^\s*\{:\s*\.notice--info\}\s*$/, 'info');
  src = admonitionConvert(src, /^\s*\{:\s*\.notice--success\}\s*$/, 'tip');
  src = admonitionConvert(src, /^\s*\{:\s*\.notice\}\s*$/, 'note');

  // div notices
  src = src.replace(/<div\s+class="notice--warning">([\s\S]*?)<\/div>/g, (_, b) => `\n:::warning\n\n${b.trim()}\n\n:::\n`);
  src = src.replace(/<div\s+class="notice--info">([\s\S]*?)<\/div>/g, (_, b) => `\n:::info\n\n${b.trim()}\n\n:::\n`);
  src = src.replace(/<div\s+class="notice--danger">([\s\S]*?)<\/div>/g, (_, b) => `\n:::danger\n\n${b.trim()}\n\n:::\n`);
  src = src.replace(/<div\s+class="notice">([\s\S]*?)<\/div>/g, (_, b) => `\n:::note\n\n${b.trim()}\n\n:::\n`);

  // 이미지 경로
  src = src.replace(/\/assets\/images\/dxl\//g, '/img/dxl/');
  src = src.replace(/\/assets\/images\//g, '/img/');

  // /docs/en/... 또는 /docs/kr/... 절대 링크 → 외부 emanual.robotis.com URL 로 강등
  src = src.replace(
    /\]\(\/docs\/(en|kr)\/([^)#\s]+)(#[^)\s]*)?\)/g,
    (_, lang, p, hash) => `](https://emanual.robotis.com/docs/${lang}/${p}${hash || ''})`
  );
  src = src.replace(
    /^(\[[^\]]+\]):\s*\/docs\/(en|kr)\/([^\s#]+)(#[^\s]*)?$/gm,
    (_, label, lang, p, hash) => `${label}: https://emanual.robotis.com/docs/${lang}/${p}${hash || ''}`
  );

  // 정적 자산(.jpg/.png/.gif/.svg/.pdf 등)을 가리키는 reference 정의는 broken-link 검사에서
  // 상대 docs 경로로 오인됨. 정의 자체를 제거하고, 본문 reference [label] 사용처는 직접 외부 anchor 로 변환.
  {
    const refs = new Map(); // labelKey → url
    src = src.replace(
      /^\[([^\]]+)\]:\s*(\/img\/[^\s]+)\s*$/gm,
      (m, label, url) => {
        refs.set(label.trim().toLowerCase(), url);
        return '';
      }
    );
    if (refs.size > 0) {
      src = src.replace(/\[([^\]]+)\]/g, (m, label) => {
        const url = refs.get(label.trim().toLowerCase());
        if (!url) return m;
        return `<a href="${url}" target="_blank">${label}</a>`;
      });
    }
  }

  // 인라인 링크 [label](/img/...)는 broken-link 검사에서 docs URL로 오인됨 → 외부 anchor 변환
  src = src.replace(
    /\[([^\]]+)\]\((\/img\/[^)\s]+\.(?:jpg|jpeg|png|gif|svg|pdf|webp))\)/g,
    (_, label, url) => `<a href="${url}" target="_blank">${label}</a>`
  );

  // 원본 typo: 인라인 링크 `(anchor-name)` (`#` 누락) — 제어 테이블 anchor 패턴이면 `#` 추가
  // 예: [Foo](hardware-error-status70) → [Foo](#hardware-error-status70)
  src = src.replace(
    /\]\(([a-z][a-z0-9-]+(?:-?\d+)?)\)/g,
    (m, anchor) => {
      // 외부 URL이나 이미지 경로는 건드리지 않음 (위에서 이미 처리됨)
      // 단순 슬러그(영문소문자+하이픈+숫자)이고 도메인/슬래시 없음 → anchor로 가정
      if (/[\/\.:]/.test(anchor)) return m;
      return `](#${anchor})`;
    }
  );

  // HTML 주석 — 본문 자체를 제거 (콘텐츠 노이즈 방지)
  src = src.replace(/<!--[\s\S]*?-->/g, '');

  // <br> → <br /> (self-closing)
  src = src.replace(/<br\s*>/g, '<br />');
  // <hr> → <hr />
  src = src.replace(/<hr\s*>/g, '<hr />');
  // <img> 단독 → <img /> (단, 이미 self-closing이면 건너뜀)
  src = src.replace(/<img([^>]*[^\/])>/g, '<img$1 />');

  // MDX: 본문에 등장하는 `{` `}` (수식/식 표현)은 JSX expression 으로 오인됨.
  // - 코드 블록(`...`) 안은 보호
  // - 이미 처리된 admonition `:::xxx`, JSX comment `{/* */}`, import 라인은 보호
  // - 수식 패턴: `{anything * anything}` 처럼 단어가 아닌 경우 — escape
  src = escapeMdxBraces(src);

  // 헤딩 정리 — 헤딩에 인라인된 <a name="..."> 는 제거 (inject-heading-anchors 가 후처리)
  // ## **[Title](#anchor)**  →  ## Title
  // ### <a name="x"></a>**[Title(0)](#x)**  →  ### Title(0)
  // ### <a name="x"></a><a name="y"></a>**[Title](#x)**  →  ### Title
  // ### <a name="x"></a> Title  →  ### Title (이미 link 제거된 경우)

  // 1) 헤딩에 인라인된 <a name>를 모두 제거
  src = src.replace(
    /^(#{1,6})((?:\s*<a name="[^"]+"><\/a>)+)(.*)$/gm,
    (m, h, anchors, rest) => `${h}${rest}`
  );
  // 2) **[Title](#anchor)** 형태 처리
  src = src.replace(
    /^(#{1,6})\s*\*\*\[([^\]]+?)\]\(#[^)]+\)\*\*\s*$/gm,
    '$1 $2'
  );
  src = src.replace(
    /^(#{1,6})\s*\[([^\]]+?)\]\(#[^)]+\)\s*$/gm,
    '$1 $2'
  );
  // 3) ## **Title**
  src = src.replace(
    /^(#{1,6})\s*\*\*([^*]+)\*\*\s*$/gm,
    '$1 $2'
  );
  // 4) ## **[A](#x)**, **[B](#y)** (multiple links)
  src = src.replace(
    /^(#{1,6})\s*(\*\*\[[^\]]+\]\(#[^)]+\)\*\*(?:[,\s]+\*\*\[[^\]]+\]\(#[^)]+\)\*\*)+)\s*$/gm,
    (m, h, links) => {
      const cleaned = links.replace(/\*\*\[([^\]]+?)\]\(#[^)]+\)\*\*/g, '$1');
      return `${h} ${cleaned}`;
    }
  );

  return src;
}

// ----- Frontmatter rebuild -----
function buildFmYaml(fm) {
  const lines = ['---'];
  if (fm.id) lines.push(`id: ${fm.id}`);
  if (fm.title) lines.push(`title: ${JSON.stringify(fm.title)}`);
  if (fm.sidebar_label) lines.push(`sidebar_label: ${JSON.stringify(fm.sidebar_label)}`);
  if (fm.tags && fm.tags.length) lines.push(`tags: [${fm.tags.join(', ')}]`);
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

// ----- 변환 본체 -----
const PARTIAL_QUEUE = []; // { partialKey, includeSpec, lang }
const PARTIAL_DONE = new Set();

/**
 * include path → partial key + import path
 * include "en/dxl/x/control_table.md" → key "control_table"
 * include "en/dxl/control_table_id.md" → key "control_table_id"
 * include "en/dxl/assembly/xl_xc430_horn_assembly.md" → key "assembly_xl_xc430_horn_assembly"
 * include "en/dxl/drawing/xl430_drawing.md" → key "drawing_xl430_drawing"
 * include "common/compatible_dxl/compatible_x430.md" → inline placeholder (skipped)
 */
function partialKeyFor(includeSpec) {
  const norm = includeSpec.replace(/^\/+/, '');
  let m = norm.match(/^(?:en|kr)\/dxl\/(.+)\.md$/);
  if (!m) return null;
  let path = m[1];
  if (path.startsWith('x/')) return path.slice(2).replace(/[\/\-]/g, '_');
  if (path.startsWith('assembly/')) return 'assembly_' + path.slice(9).replace(/[\/\-]/g, '_');
  if (path.startsWith('drawing/')) return 'drawing_' + path.slice(8).replace(/[\/\-]/g, '_');
  return path.replace(/[\/\-]/g, '_');
}

function convertPage(srcPath, ref, lang) {
  const raw = readSafe(srcPath);
  if (raw === null) return null;
  const { fm, body } = splitFrontmatter(raw);
  const profile = PROFILES[ref] || {};
  const ctx = {
    ref: fm.ref || ref,
    product_group: fm.product_group || profile.product_group,
    lang,
    vars: {},
  };

  const importsMap = new Map(); // key → varName

  function handleInclude(spec) {
    if (spec.includes('common/compatible_dxl/')) {
      // inline placeholder — JSX 호환 주석 사용
      return `\n{/* TODO: compatible_dxl table — ${spec} */}\n`;
    }
    if (/dxl\/specifications_x\.md/.test(spec)) {
      return specsTablePlaceholder(ctx.ref, lang);
    }
    if (/dxl\/warning\.md/.test(spec)) {
      // warning include는 partial로
    }
    const key = partialKeyFor(spec);
    if (!key) return `\n{/* include: ${spec} */}\n`;
    const varName = importVarFor(key);
    importsMap.set(key, varName);
    PARTIAL_QUEUE.push({ key, spec, lang });
    return `\n<${varName} />\n`;
  }

  const tokens = tokenize(body);
  let rendered = render(tokens, ctx, handleInclude, null);
  rendered = kramdownToMdx(rendered);
  // 끝부분 line-reference 정리 (`[X]: url` 형태 — 그대로 두지만 `permalink` 형태는 외부로)

  // 새 frontmatter — id는 파일명(=ref 인자) 사용, 중복 방지
  const newFm = {
    id: ref,
    title: (fm.sidebar && fm.sidebar.title) || fm.title || ref.toUpperCase(),
    sidebar_label: (fm.sidebar && fm.sidebar.title) || undefined,
    tags: fm.product_group ? [fm.product_group] : [],
  };
  const fmStr = buildFmYaml(newFm);
  const importLines = [];
  for (const [key, varName] of importsMap) {
    importLines.push(`import ${varName} from '@site/docs/_partials/dxl/x/${key}.mdx';`);
  }
  const importsBlock = importLines.length ? importLines.join('\n') + '\n\n' : '';

  return fmStr + importsBlock + rendered.trim() + '\n';
}

// partial 변환: include spec → mdx content
function convertPartial(spec, lang, refForCtx, productGroupForCtx) {
  const norm = spec.replace(/^\/+/, '');
  // locale 교체 (lang 인자 사용)
  const localized = norm.replace(/^(en|kr)\//, lang + '/');
  const full = path.join(REPO, 'source', '_includes', localized);
  let raw = readSafe(full);
  if (raw === null) {
    // 일부 fragment는 ko에 없을 수 있음 — en으로 fallback
    if (lang === 'kr') {
      const fallback = path.join(REPO, 'source', '_includes', norm.replace(/^kr\//, 'en/'));
      raw = readSafe(fallback);
    }
    if (raw === null) return null;
  }
  const ctx = {
    ref: refForCtx || 'xl430-w250',
    product_group: productGroupForCtx || 'dxl_xl430',
    lang,
    vars: {},
  };
  function nestedInclude(s) {
    // partial 안의 include는 다시 partial import — 단순화: skip (대부분 X 시리즈에는 nested include 없음)
    return `\n{/* nested include: ${s} */}\n`;
  }
  const tokens = tokenize(raw);
  let rendered = render(tokens, ctx, nestedInclude, null);
  rendered = kramdownToMdx(rendered);
  return rendered.trim() + '\n';
}

// ----- 실행 -----
function run() {
  ensureDir(OUT_DOC_EN);
  ensureDir(OUT_DOC_KO);
  ensureDir(OUT_PART_EN);
  ensureDir(OUT_PART_KO);

  // _category_.json
  writeOut(
    path.join(OUT_DOC_EN, '_category_.json'),
    JSON.stringify({ label: 'X Series', position: 1, link: { type: 'generated-index' } }, null, 2) + '\n'
  );
  writeOut(
    path.join(OUT_DOC_KO, '_category_.json'),
    JSON.stringify({ label: 'X Series', position: 1, link: { type: 'generated-index' } }, null, 2) + '\n'
  );

  const stats = { en: 0, ko: 0, partials_en: 0, partials_ko: 0, errors: [] };

  // ko 디렉터리 파일명 다름 → 매핑
  const KO_FILENAME_OVERRIDES = {
    'xc330-m181': 'xc330-m181-t',
    'xc330-m288': 'xc330-m288-t',
    'xc330-t181': 'xc330-t181-t',
    'xc330-t288': 'xc330-t288-t',
    'xc430-t150bb': 'xc430-w150bb',
    'xc430-t240bb': 'xc430-w240bb',
    'xl330-m077': 'xl330-m077-t',
    'xl330-m288': 'xl330-m288-t',
  };

  // x.md (X 시리즈 인덱스)
  {
    const enSrc = path.join(SRC('en'), 'x.md');
    const koSrc = path.join(SRC('kr'), 'x.md');
    if (fs.existsSync(enSrc)) {
      try {
        const out = convertPage(enSrc, 'x', 'en');
        if (out) { writeOut(path.join(OUT_DOC_EN, 'index.mdx'), out); stats.en++; }
      } catch (e) { stats.errors.push(`en/index: ${e.message}`); }
    }
    if (fs.existsSync(koSrc)) {
      try {
        const out = convertPage(koSrc, 'x', 'kr');
        if (out) { writeOut(path.join(OUT_DOC_KO, 'index.mdx'), out); stats.ko++; }
      } catch (e) { stats.errors.push(`ko/index: ${e.message}`); }
    }
  }

  // xl430-w250_test 는 변환 제외 (테스트 페이지)

  // 페이지 변환 (xl320 포함, xl430-w250_test, x.md는 별도)
  for (const ref of Object.keys(PROFILES).filter(r => r !== 'x')) {
    const enSrc = path.join(SRC('en'), `${ref}.md`);
    const koFilename = KO_FILENAME_OVERRIDES[ref] || ref;
    const koSrc = path.join(SRC('kr'), `${koFilename}.md`);
    if (fs.existsSync(enSrc)) {
      try {
        const out = convertPage(enSrc, ref, 'en');
        if (out) { writeOut(path.join(OUT_DOC_EN, `${ref}.mdx`), out); stats.en++; }
      } catch (e) { stats.errors.push(`en/${ref}: ${e.message}`); }
    }
    if (fs.existsSync(koSrc)) {
      try {
        const out = convertPage(koSrc, ref, 'kr');
        if (out) { writeOut(path.join(OUT_DOC_KO, `${ref}.mdx`), out); stats.ko++; }
      } catch (e) { stats.errors.push(`ko/${ref}: ${e.message}`); }
    }
  }

  // partial flush — 각 (key, lang) 단 한 번만
  for (const q of PARTIAL_QUEUE) {
    const sig = `${q.lang}|${q.key}`;
    if (PARTIAL_DONE.has(sig)) continue;
    PARTIAL_DONE.add(sig);
    try {
      const content = convertPartial(q.spec, q.lang, 'xl430-w250', 'dxl_xl430');
      if (content === null) continue;
      const dir = q.lang === 'en' ? OUT_PART_EN : OUT_PART_KO;
      writeOut(path.join(dir, `${q.key}.mdx`), content);
      if (q.lang === 'en') stats.partials_en++; else stats.partials_ko++;
    } catch (e) { stats.errors.push(`partial ${q.lang}/${q.key}: ${e.message}`); }
  }

  console.log('Done.', stats);
}

run();
