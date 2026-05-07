#!/usr/bin/env node
/**
 * Parts 영역 (60 페이지) Jekyll Markdown → Docusaurus MDX 변환.
 *
 *   subcategory별 페이지 수:
 *     communication 11, controller 19, display 2, interface 9, motor 6, sensor 12
 *     + parts/index.mdx (parts.md 또는 communication.md 사용)
 *     + 각 subcategory _category_.json (en + ko)
 *
 *   사용: node scripts/convert-parts.js
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
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

// ------------------------------------------------------------
// Liquid include resolver (parts 페이지의 includes는 product_group 분기가
// 거의 없거나, 분기 결과가 단순 — page context를 단순히 evaluate한다).
// ------------------------------------------------------------
function resolveInclude(includePath, ctx, depth = 0) {
  if (depth > 5) return `<!-- include depth limit: ${includePath} -->`;
  // kr/dxl/.../md 같은 형식도 들어옴 → 우선 그대로 시도, 없으면 fallback
  const candidates = [];
  // explicit lang
  const tryExplicit = path.join(SRC_INCLUDES, includePath);
  candidates.push(tryExplicit);
  // 'en/' → ctx.lang 로 swap
  if (ctx && ctx.lang === 'kr' && /^en\//.test(includePath)) {
    candidates.push(path.join(SRC_INCLUDES, 'kr/' + includePath.slice(3)));
    // fallback to en
  }
  if (ctx && ctx.lang === 'en' && /^kr\//.test(includePath)) {
    candidates.push(path.join(SRC_INCLUDES, 'en/' + includePath.slice(3)));
  }
  let full = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) { full = c; break; }
  }
  if (!full) return null;
  let txt = fs.readFileSync(full, 'utf8');
  // 재귀 include
  txt = txt.replace(/\{%\s*include\s+([^\s%]+)\s*%\}/g, (_, p) => {
    const inc = resolveInclude(p, ctx, depth + 1);
    return inc === null ? `<!-- unresolved include: ${p} -->` : inc;
  });
  // include 내부의 Liquid {% if %}/{% assign %}/{{ var }} 평가
  txt = evalLiquidConditionals(txt, ctx || {});
  return txt;
}

// ------------------------------------------------------------
// Liquid 조건문/변수 단순 평가기
// (parts 페이지 includes 안의 product_group 분기를 처리)
// ------------------------------------------------------------
function tokenizeLiquid(src) {
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
    const v = (ctx.vars || {})[m[1]];
    return m[2] === '==' ? v === m[3] : v !== m[3];
  }
  return false;
}
function evalCond(expr, ctx) {
  expr = expr.replace(/^\s*(if|elsif|unless)\s+/, '').trim();
  if (expr.includes(' or ')) return expr.split(/\s+or\s+/).some(c => evalAtomic(c, ctx));
  if (expr.includes(' and ')) return expr.split(/\s+and\s+/).every(c => evalAtomic(c, ctx));
  return evalAtomic(expr, ctx);
}
function evalOutput(expr, ctx) {
  const pipes = expr.split('|').map(s => s.trim());
  let base = pipes[0];
  let val;
  let m;
  if ((m = base.match(/^page\.(\w+)$/))) val = ctx[m[1]];
  else if (ctx.vars && Object.prototype.hasOwnProperty.call(ctx.vars, base)) val = ctx.vars[base];
  if (val === undefined) return '';
  return String(val);
}
function renderLiquid(tokens, ctx) {
  let out = '';
  let i = 0;
  ctx.vars = ctx.vars || {};
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'text') { out += t.value; i++; continue; }
    if (t.type === 'output') { out += evalOutput(t.value, ctx); i++; continue; }
    const tag = t.value;
    if (/^assign\s+/.test(tag)) {
      const m = tag.match(/^assign\s+(\w+)\s*=\s*(.+)$/);
      if (m) {
        let raw = m[2].trim();
        if ((raw[0] === '"' && raw.endsWith('"')) || (raw[0] === "'" && raw.endsWith("'"))) {
          ctx.vars[m[1]] = raw.slice(1, -1);
        } else {
          ctx.vars[m[1]] = raw;
        }
      }
      i++; continue;
    }
    if (/^capture\s+/.test(tag)) {
      const captureMatch = tag.match(/^capture\s+(\w+)/);
      if (!captureMatch) { i++; continue; }
      const name = captureMatch[1];
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
      ctx.vars[name] = renderLiquid(sub, ctx);
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
      if (chosen) out += renderLiquid(chosen.tokens, ctx);
      continue;
    }
    // {% include %} - leave for outer recursion
    if (/^include\s+/.test(tag)) {
      const m = tag.match(/^include\s+(\S+)/);
      if (m) out += `{% include ${m[1]} %}`;
      i++; continue;
    }
    i++;
  }
  return out;
}
function evalLiquidConditionals(src, ctx) {
  const tokens = tokenizeLiquid(src);
  return renderLiquid(tokens, ctx);
}

// ------------------------------------------------------------
// Liquid capture / endcapture / markdownify (본문 capture 처리)
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
      if (!variant || variant === 'info' || variant === 'primary') admType = variant ? 'info' : 'note';
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
// <div class="notice--xxx">…</div> → :::admonition
// (include 본문이 capture 후 inline 출력될 때 div 형식이 남는 경우)
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
    const m = line.match(/^\s*\{:\s*\.notice(?:--([a-z]+))?\s*\}\s*$/);
    if (!m) { out.push(line); continue; }
    const variant = m[1] || '';
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
  body = body.replace(/\/assets\/images\/parts\//g, '/img/parts/');
  body = body.replace(/\/assets\/images\/sw\//g, '/img/software/');
  body = body.replace(/\/assets\/images\/dxl\//g, '/img/dxl/');
  body = body.replace(/\/assets\/images\/edu\//g, '/img/edu/');
  body = body.replace(/\/assets\/images\/platform\//g, '/img/platform/');
  body = body.replace(/\/assets\/images\/icon_warning\.png/g, '/img/icon_warning.png');
  body = body.replace(/\/assets\/images\/icon_unfold\.png/g, '/img/icon_unfold.png');
  body = body.replace(/\(\/assets\/images\//g, '(/img/');
  // /assets/parts.png 같은 직접 자산은 외부 강등
  body = body.replace(/\]\(\/assets\/([^)\s]+)\)/g, (_, p) => `](https://emanual.robotis.com/assets/${p})`);
  return body;
}

// 변환된 parts 페이지 path 수집용
const globalConvertedPaths = new Set();

// 외부 강등 / 내부 변환
//   /docs/<lang>/parts/<rest> → 내부일 때 /docs/parts/<rest>
function rewriteInternalLinks(body) {
  // 누락 leading `/`
  body = body.replace(/\]\((docs\/(?:en|kr)\/[^)\s]+)\)/g, (_, p) => `](/${p})`);

  // 1) parts 영역 내부 링크 - 모두 /docs/parts/<rest> 로 (postprocess로 미존재는 강등)
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/parts\/([^)\s#]+?)\/?(#[^)\s]*)?\)/g,
    (_, lang, p, hash) => `](/docs/parts/${p}${hash || ''})`,
  );
  body = body.replace(
    /^(\s*\[[^\]]+\]):\s*\/docs\/(en|kr)\/parts\/([^\s#]+?)\/?(#[^\s]*)?\s*$/gm,
    (_, label, lang, p, hash) => `${label}: /docs/parts/${p}${hash || ''}`,
  );

  // 2) 그 외 /docs/<lang>/<rest> → 외부 강등
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/([^)\s#]+?)\/?(#[^)\s]*)?\)/g,
    (_, lang, p, hash) => `](https://emanual.robotis.com/docs/${lang}/${p}/${hash || ''})`,
  );
  body = body.replace(
    /^(\s*\[[^\]]+\]):\s*\/docs\/(en|kr)\/(\S+?)\/?\s*$/gm,
    (_, label, lang, p) => `${label}: https://emanual.robotis.com/docs/${lang}/${p}/`,
  );

  // 5a) /doc/<lang>/parts/foo (typo, missing 's') — internal
  body = body.replace(
    /\]\(\/doc\/(en|kr)\/(parts\/[^)\s#]+?)\/?(#[^)\s]*)?\)/g,
    (_, lang, p, hash) => `](/docs/${p}${hash || ''})`,
  );
  body = body.replace(
    /^(\s*\[[^\]]+\]):\s*\/doc\/(en|kr)\/(parts\/[^\s#]+?)\/?(#[^\s]*)?\s*$/gm,
    (_, label, lang, p, hash) => `${label}: /docs/${p}${hash || ''}`,
  );

  // 5b) /doc/kr/communication/foo (legacy ko-only typo: missing /parts/, 'connector' typo)
  body = body.replace(
    /\]\(\/doc\/(en|kr)\/((?:communication|controller|interface|sensor|motor|display|connector)\/[^)\s#]+?)\/?(#[^)\s]*)?\)/g,
    (_, lang, p, hash) => {
      const fixed = p.replace(/^connector\//, 'controller/');
      return `](/docs/parts/${fixed}${hash || ''})`;
    },
  );
  body = body.replace(
    /^(\s*\[[^\]]+\]):\s*\/doc\/(en|kr)\/((?:communication|controller|interface|sensor|motor|display|connector)\/[^\s#]+?)\/?(#[^\s]*)?\s*$/gm,
    (_, label, lang, p, hash) => {
      const fixed = p.replace(/^connector\//, 'controller/');
      return `${label}: /docs/parts/${fixed}${hash || ''}`;
    },
  );

  // 5c) 그 외 /doc/<lang>/ → 외부 강등
  body = body.replace(
    /\]\(\/doc\/(en|kr)\/([^)\s#]+?)\/?(#[^)\s]*)?\)/g,
    (_, lang, p, hash) => `](https://emanual.robotis.com/docs/${lang}/${p}/${hash || ''})`,
  );
  body = body.replace(
    /^(\s*\[[^\]]+\]):\s*\/doc\/(en|kr)\/(\S+?)\/?\s*$/gm,
    (_, label, lang, p) => `${label}: https://emanual.robotis.com/docs/${lang}/${p}/`,
  );

  // 3) bare anchor heading typo: `[Foo](slug-with-dashes)` → `[Foo](#slug-with-dashes)`
  body = body.replace(/\]\(([^)\s/#]+?)\)/g, (m, frag) => {
    if (/^https?:\/\//.test(frag)) return m;
    if (/^mailto:/.test(frag)) return m;
    if (frag.startsWith('/')) return m;
    if (frag === '') return m;
    if (frag.includes('.')) return m; // 이미지 / 도메인
    if (!/[-_]/.test(frag) && !/[ㄱ-힝]/.test(frag)) return m;
    return `](#${frag})`;
  });

  // 4) bare external domain in link target: `[Foo](www.example.com)` → external link
  body = body.replace(/\]\((www\.[^)\s]+)\)/g, (_, host) => `](https://${host})`);

  return body;
}

// ------------------------------------------------------------
// 헤딩 정리 (`### [Foo](#foo)` → `### Foo`)
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
// 본문 변환 파이프라인
// ------------------------------------------------------------
function convertBody(body, ctx = {}) {
  // Liquid include (재귀)
  body = body.replace(/\{%\s*include\s+([^\s%]+)\s*%\}/g, (_, p) => {
    const inc = resolveInclude(p, ctx);
    return inc === null ? `<!-- unresolved include: ${p} -->` : inc;
  });

  // Liquid 본문의 if/assign 을 page context 로 평가
  body = evalLiquidConditionals(body, ctx);

  // Liquid capture
  body = transformLiquidCapture(body);

  // jekyll scaffolding 제거
  body = body.replace(/<style>[\s\S]*?<\/style>/g, '');
  body = body.replace(/<div\s+style="counter-reset:[^"]*"\s*><\/div>/g, '');
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  body = body.replace(/^\s*\{::options[^}]*\}\s*$/gm, '');
  body = body.replace(/^\s*\{:toc\}\s*$/gm, '');
  body = body.replace(/<a\s+name=["'][^"']*["']\s*>?\s*<\/a>/gi, '');
  body = body.replace(/<a\s+name=["'][^"']*["']\s*<\/a>/gi, '');
  body = body.replace(/<div\s+class="main-header"\s*>[\s\S]*?<\/div>/g, '');

  // <br>/<hr>/<img> 정규화
  body = body.replace(/<br\s*\/?\s*>/g, '<br />');
  body = body.replace(/<hr\s*\/?\s*>/g, '<hr />');
  body = body.replace(/<img\b([^>]*?)(?<!\/)>/g, '<img$1 />');

  // .popup / .button / .text-center 잔여
  body = body.replace(/\{:\s*\.popup\s*\}/g, '');
  body = body.replace(/\{:\s*\.button\s*\}/g, '');
  body = body.replace(/\{:\s*\.text-center\s*\}/g, '');
  body = body.replace(/\{:\s*\.align-center\s*\}/g, '');

  // self-link 헤딩 단순화
  body = cleanHeadings(body, ctx.title);

  // section
  body = body.replace(/<section[^>]*>/g, '');
  body = body.replace(/<\/section>/g, '');

  // div notice 블록 (include 산출물 등)
  body = transformDivNotices(body);

  // kramdown notice
  body = transformKramdownNotices(body);

  // 잔여 catchall kramdown attribute 제거 (notice 변환 이후에 둬야 함)
  body = body.replace(/^\s*\{:\s*\.[a-z\-]+(?:--[a-z]+)?\s*\}\s*$/gm, '');
  body = body.replace(/\{:\s*\.[a-z\-]+(?:--[a-z]+)?\s*\}/g, '');
  body = body.replace(/\{:\s*[^}]*\}/g, '');

  // 코드 fence 정규화
  body = normalizeFences(body);

  // 이미지/링크 재작성
  body = rewriteAssetPaths(body);
  body = rewriteInternalLinks(body);

  // MDX safe escape
  body = mdxEscapeOutsideFences(body);

  body = collapseBlankLines(body);
  return body;
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
// _category_.json
// ------------------------------------------------------------
function writeCategoryJson(dir, label, position, opts = {}) {
  const data = { label, position };
  if (opts.linkType === 'doc' && opts.linkId) {
    data.link = { type: 'doc', id: opts.linkId };
  } else {
    data.link = { type: 'generated-index' };
  }
  writeOut(path.join(dir, '_category_.json'), JSON.stringify(data, null, 2) + '\n');
}

// ------------------------------------------------------------
// 페이지 변환
// ------------------------------------------------------------
function convertSinglePage(srcEnPath, srcKrPath, outRel, meta, productGroup) {
  const enRaw = readUtf8(srcEnPath);
  const { fm: enFm, body: enBody } = splitFrontmatter(enRaw);
  const enCtx = {
    title: meta.title,
    lang: 'en',
    ref: enFm.ref || meta.id,
    product_group: productGroup || enFm.product_group || meta.id,
    vars: {},
  };
  let converted = convertBody(enBody, enCtx);
  const newFm = {
    id: meta.id,
    title: meta.title,
    sidebar_label: meta.sidebarLabel || meta.title,
    sidebar_position: meta.sidebarPosition,
    slug: meta.slug,
    tags: meta.tags,
  };
  const enContent = buildFmYaml(newFm) + converted.trimStart() + '\n';
  const outEnFull = path.join(OUT_EN_ROOT, outRel);
  writeOut(outEnFull, enContent);
  globalConvertedPaths.add('/docs/' + outRel.replace(/\\/g, '/').replace(/\.mdx$/, '').replace(/\/index$/, ''));

  const outKoFull = path.join(OUT_KO_ROOT, outRel);
  if (srcKrPath && fs.existsSync(srcKrPath)) {
    const krRaw = readUtf8(srcKrPath);
    const { fm: krFm, body: krBody } = splitFrontmatter(krRaw);
    const koCtx = {
      title: meta.title,
      lang: 'kr',
      ref: krFm.ref || meta.id,
      product_group: productGroup || krFm.product_group || meta.id,
      vars: {},
    };
    let koConverted = convertBody(krBody, koCtx);
    const koContent = buildFmYaml(newFm) + koConverted.trimStart() + '\n';
    writeOut(outKoFull, koContent);
  } else {
    writeOut(outKoFull, buildKoMirror(enContent));
  }
}

// ------------------------------------------------------------
// 변환 대상 (60 페이지 + index)
// ------------------------------------------------------------
const PAGES = [];

// communication (11)
const COMMUNICATION = [
  { src: 'all-communication.md',  id: 'all-communication',  title: 'Communication',     pos: 1 },
  { src: 'bt-110.md',             id: 'bt-110',             title: 'BT-110A',           pos: 10 },
  { src: 'bt-210.md',             id: 'bt-210',             title: 'BT-210',            pos: 20 },
  { src: 'bt-410.md',             id: 'bt-410',             title: 'BT-410',            pos: 30 },
  { src: 'bt-410-dongle.md',      id: 'bt-410-dongle',      title: 'BT-410 Dongle',     pos: 31 },
  { src: 'bt-430-dongle.md',      id: 'bt-430-dongle',      title: 'BT-430 Dongle',     pos: 32 },
  { src: 'rc-100.md',             id: 'rc-100',             title: 'RC-100',            pos: 40 },
  { src: 'rc-200.md',             id: 'rc-200',             title: 'RC-200',            pos: 41 },
  { src: 'rc-300.md',             id: 'rc-300',             title: 'RC-300',            pos: 42 },
  { src: 'zig-110.md',            id: 'zig-110',            title: 'ZIG-110A',          pos: 50 },
  { src: 'zig2serial.md',         id: 'zig2serial',         title: 'ZIG2Serial',        pos: 51 },
];
for (const p of COMMUNICATION) {
  PAGES.push({
    srcEn: `parts/communication/${p.src}`,
    srcKr: `parts/communication/${p.src}`,
    outRel: `parts/communication/${p.id}.mdx`,
    meta: { id: p.id, title: p.title, sidebarLabel: p.title, sidebarPosition: p.pos, tags: ['parts', 'communication'] },
    productGroup: p.id,
  });
}

// controller (19)
const CONTROLLER = [
  { src: 'all-controller.md',        id: 'all-controller',        title: 'Controllers',                  pos: 1 },
  { src: 'controller_compatibility.md', id: 'controller_compatibility', title: 'Controller Compatibility',  pos: 2 },
  { src: 'openrb-150.md',            id: 'openrb-150',            title: 'OpenRB-150',                   pos: 10 },
  { src: 'opencr10.md',              id: 'opencr10',              title: 'OpenCR 1.0',                   pos: 20 },
  { src: 'opencm904.md',             id: 'opencm904',             title: 'OpenCM 9.04',                  pos: 30 },
  { src: 'opencm485exp.md',          id: 'opencm485exp',          title: 'OpenCM 485 EXP',               pos: 31 },
  { src: 'cm-550.md',                id: 'cm-550',                title: 'CM-550',                       pos: 40 },
  { src: 'cm-530.md',                id: 'cm-530',                title: 'CM-530',                       pos: 50 },
  { src: 'cm-510.md',                id: 'cm-510',                title: 'CM-510',                       pos: 51 },
  { src: 'cm-700.md',                id: 'cm-700',                title: 'CM-700',                       pos: 60 },
  { src: 'cm-900.md',                id: 'cm-900',                title: 'CM-900',                       pos: 61 },
  { src: 'cm-5.md',                  id: 'cm-5',                  title: 'CM-5',                         pos: 70 },
  { src: 'cm-50.md',                 id: 'cm-50',                 title: 'CM-50',                        pos: 71 },
  { src: 'cm-100.md',                id: 'cm-100',                title: 'CM-100A',                      pos: 80, krSrc: 'cm-100a.md' },
  { src: 'cm-150.md',                id: 'cm-150',                title: 'CM-150',                       pos: 90 },
  { src: 'cm-151.md',                id: 'cm-151',                title: 'CM-151',                       pos: 91 },
  { src: 'cm-200.md',                id: 'cm-200',                title: 'CM-200',                       pos: 100 },
  { src: 'rb-86.md',                 id: 'rb-86',                 title: 'RB-86',                        pos: 110 },
  { src: 'rb-88.md',                 id: 'rb-88',                 title: 'RB-88',                        pos: 111 },
];
for (const p of CONTROLLER) {
  PAGES.push({
    srcEn: `parts/controller/${p.src}`,
    srcKr: `parts/controller/${p.krSrc || p.src}`,
    outRel: `parts/controller/${p.id}.mdx`,
    meta: { id: p.id, title: p.title, sidebarLabel: p.title, sidebarPosition: p.pos, tags: ['parts', 'controller'] },
    productGroup: p.id,
  });
}

// display (2)
const DISPLAY = [
  { src: 'display.md',  id: 'display',  title: 'Display',          pos: 1 },
  { src: 'lm-10.md',    id: 'lm-10',    title: 'LED Module(LM-10)', pos: 10 },
];
for (const p of DISPLAY) {
  PAGES.push({
    srcEn: `parts/display/${p.src}`,
    srcKr: `parts/display/${p.src}`,
    outRel: `parts/display/${p.id}.mdx`,
    meta: { id: p.id, title: p.title, sidebarLabel: p.title, sidebarPosition: p.pos, tags: ['parts', 'display'] },
    productGroup: p.id,
  });
}

// interface (9)
const INTERFACE = [
  { src: 'all-interface.md',     id: 'all-interface',    title: 'Interfaces',           pos: 1 },
  { src: 'interface.md',         id: 'interface',        title: 'Interface',            pos: 2 },
  { src: 'u2d2.md',              id: 'u2d2',             title: 'U2D2',                 pos: 10 },
  { src: 'u2d2_power_hub.md',    id: 'u2d2_power_hub',   title: 'U2D2 Power Hub Board', pos: 11 },
  { src: 'dxl_bridge.md',        id: 'dxl_bridge',       title: 'DXL-Bridge',           pos: 20 },
  { src: 'dynamixel_shield.md',  id: 'dynamixel_shield', title: 'DYNAMIXEL Shield',     pos: 30 },
  { src: 'mkr_shield.md',        id: 'mkr_shield',       title: 'MKR Shield',           pos: 31 },
  { src: 'usb2dynamixel.md',     id: 'usb2dynamixel',    title: 'USB2Dynamixel',        pos: 40 },
  { src: 'ln-101.md',            id: 'ln-101',           title: 'LN-101',               pos: 50 },
];
for (const p of INTERFACE) {
  PAGES.push({
    srcEn: `parts/interface/${p.src}`,
    srcKr: `parts/interface/${p.src}`,
    outRel: `parts/interface/${p.id}.mdx`,
    meta: { id: p.id, title: p.title, sidebarLabel: p.title, sidebarPosition: p.pos, tags: ['parts', 'interface'] },
    productGroup: p.id,
  });
}

// motor (6)
const MOTOR = [
  { src: 'motor.md',                id: 'motor',                  title: 'Motors',                    pos: 1 },
  { src: 'all-motor.md',            id: 'all-motor',              title: 'All Motors',                pos: 2 },
  { src: 'geared_motor.md',         id: 'geared_motor',           title: 'Geared Motor (GM-10A)',     pos: 10, krSrc: 'grared_motor.md' },
  { src: 'h_speed_geared_motor.md', id: 'h_speed_geared_motor',   title: 'High Speed Geared Motor',   pos: 11 },
  { src: 'l_speed_geared_motor.md', id: 'l_speed_geared_motor',   title: 'Low Speed Geared Motor',    pos: 12 },
  { src: 'servo_motor.md',          id: 'servo_motor',            title: 'Servo Motor (SM-10)',       pos: 20 },
];
for (const p of MOTOR) {
  PAGES.push({
    srcEn: `parts/motor/${p.src}`,
    srcKr: `parts/motor/${p.krSrc || p.src}`,
    outRel: `parts/motor/${p.id}.mdx`,
    meta: { id: p.id, title: p.title, sidebarLabel: p.title, sidebarPosition: p.pos, tags: ['parts', 'motor'] },
    productGroup: p.id,
  });
}

// sensor (12 en + ko-only cds-10 / tms-10)
const SENSOR = [
  { src: 'sensor.md',     id: 'sensor',     title: 'Sensors',                       pos: 1 },
  { src: 'all-sensor.md', id: 'all-sensor', title: 'All Sensors',                   pos: 2 },
  { src: 'ax-s1.md',      id: 'ax-s1',      title: 'AX-S1',                         pos: 10 },
  { src: 'ir-array.md',   id: 'ir-array',   title: 'IR Sensor Array',               pos: 20, krSrc: 'ir_array.md' },
  { src: 'irss-10.md',    id: 'irss-10',    title: 'IR Sensor (IRSS-10)',           pos: 21 },
  { src: 'dms-80.md',     id: 'dms-80',     title: 'IR Distance Sensor (DMS-80)',   pos: 22 },
  { src: 'pir-10.md',     id: 'pir-10',     title: 'PIR Motion Sensor (PIR-10)',    pos: 23 },
  { src: 'ts-10.md',      id: 'ts-10',      title: 'Touch Sensor (TS-10)',          pos: 30 },
  { src: 'tps-10.md',     id: 'tps-10',     title: 'Tilt/Position Sensor (TPS-10)', pos: 31 },
  { src: 'mgss-10.md',    id: 'mgss-10',    title: 'Magnetic Sensor (MGSS-10)',     pos: 40 },
  { src: 'gs-12.md',      id: 'gs-12',      title: 'Gyro Sensor (GS-12)',           pos: 50 },
  { src: 'cs-10.md',      id: 'cs-10',      title: 'Color Sensor (CS-10)',          pos: 60 },
];
for (const p of SENSOR) {
  PAGES.push({
    srcEn: `parts/sensor/${p.src}`,
    srcKr: `parts/sensor/${p.krSrc || p.src}`,
    outRel: `parts/sensor/${p.id}.mdx`,
    meta: { id: p.id, title: p.title, sidebarLabel: p.title, sidebarPosition: p.pos, tags: ['parts', 'sensor'] },
    productGroup: p.id,
  });
}

// ------------------------------------------------------------
// 카테고리 정의
// ------------------------------------------------------------
const CATEGORIES = [
  { dir: 'parts/communication', label: 'Communication', koLabel: '통신',          position: 10 },
  { dir: 'parts/controller',    label: 'Controller',    koLabel: '컨트롤러',       position: 20 },
  { dir: 'parts/interface',     label: 'Interface',     koLabel: '인터페이스',     position: 30 },
  { dir: 'parts/sensor',        label: 'Sensor',        koLabel: '센서',          position: 40 },
  { dir: 'parts/motor',         label: 'Motor',         koLabel: '모터',          position: 50 },
  { dir: 'parts/display',       label: 'Display',       koLabel: '디스플레이',     position: 60 },
];

// ------------------------------------------------------------
// 자산 복사 (source/assets/images/parts/* → docusaurus/static/img/parts/*)
// ------------------------------------------------------------
function copyAssets() {
  let count = 0;
  const ASSET_PARTS_DIRS = ['communication', 'controller', 'interface', 'led', 'motor', 'sensors'];
  for (const sub of ASSET_PARTS_DIRS) {
    const src = path.join(ASSET_SRC_ROOT, 'images/parts', sub);
    const dst = path.join(ASSET_OUT_ROOT, 'parts', sub);
    if (!exists(src)) continue;
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
  // top-level parts files (lbs-40_product.jpg 등)
  const partsRoot = path.join(ASSET_SRC_ROOT, 'images/parts');
  if (exists(partsRoot)) {
    for (const e of fs.readdirSync(partsRoot, { withFileTypes: true })) {
      if (e.isFile()) {
        const dst = path.join(ASSET_OUT_ROOT, 'parts', e.name);
        if (!exists(dst)) {
          copyFile(path.join(partsRoot, e.name), dst);
          count++;
        }
      }
    }
  }
  // ln101_connect.jpg 같이 일부 페이지가 /img/parts/interface/ln101_connect.jpg 를 참조 — 이미 위에서 처리됨
  // dxl include 들이 /img/dxl/* 참조 — dxl 디렉터리는 이미 다른 작업에서 복사되었을 것
  return count;
}

// ------------------------------------------------------------
// parts index 생성 (parts.md 가 없으니 splash overview 파일을 사용)
//   en: source/docs/en/parts/all-parts.md (splash 형식)  → 본문 무시, 자체 카드 인덱스 작성
//   ko: source/docs/kr/parts/communication.md 같은 splash  → 동일
// 가장 안정적: 직접 카드 본문을 수동 작성.
// ------------------------------------------------------------
function buildPartsIndex() {
  const meta = {
    id: 'parts',
    title: 'Parts',
    sidebarLabel: 'Parts',
    sidebarPosition: 1,
    tags: ['parts'],
  };
  const enBody = `# Parts

ROBOTIS supports a wide range of compatible parts for your robotics projects.
This section covers controllers, interfaces, communication modules, sensors, motors, and display modules.

## Categories

- [Controller](/docs/parts/controller/all-controller) — ROBOTIS controllers (OpenRB, OpenCR, OpenCM, CM series).
- [Interface](/docs/parts/interface/all-interface) — DYNAMIXEL interfaces such as U2D2 and DYNAMIXEL Shield.
- [Communication](/docs/parts/communication/all-communication) — Bluetooth (BT-210/410), wireless (RC-100/200/300), and ZIG modules.
- [Sensor](/docs/parts/sensor/all-sensor) — IR, distance, touch, gyro, magnetic, and color sensors.
- [Motor](/docs/parts/motor/all-motor) — Geared motors and servo motors used in OLLO and DREAM kits.
- [Display](/docs/parts/display/lm-10) — LED display modules.
`;
  const koBody = `# Parts

ROBOTIS는 로보틱스 프로젝트를 위한 다양한 호환 부품을 제공합니다.
이 섹션에서는 컨트롤러, 인터페이스, 통신 모듈, 센서, 모터, 디스플레이 모듈을 다룹니다.

## 카테고리

- [컨트롤러](/docs/parts/controller/all-controller) — ROBOTIS 컨트롤러 (OpenRB, OpenCR, OpenCM, CM 시리즈).
- [인터페이스](/docs/parts/interface/all-interface) — U2D2, DYNAMIXEL Shield 등 다이나믹셀 인터페이스.
- [통신](/docs/parts/communication/all-communication) — 블루투스 (BT-210/410), 무선 컨트롤러 (RC-100/200/300), ZIG 모듈.
- [센서](/docs/parts/sensor/all-sensor) — 적외선, 거리, 터치, 자이로, 자기, 컬러 센서.
- [모터](/docs/parts/motor/all-motor) — OLLO/DREAM 키트용 감속 모터, 서보 모터.
- [디스플레이](/docs/parts/display/lm-10) — LED 디스플레이 모듈.
`;
  const newFm = {
    id: meta.id,
    title: meta.title,
    sidebar_label: meta.sidebarLabel,
    sidebar_position: meta.sidebarPosition,
    tags: meta.tags,
  };
  const enContent = buildFmYaml(newFm) + enBody;
  const koContent = buildFmYaml(newFm) + koBody;

  // 기존 placeholder index.md 제거
  const oldIndex = path.join(OUT_EN_ROOT, 'parts/index.md');
  if (exists(oldIndex)) fs.unlinkSync(oldIndex);
  const oldKo = path.join(OUT_KO_ROOT, 'parts/index.md');
  if (exists(oldKo)) fs.unlinkSync(oldKo);

  writeOut(path.join(OUT_EN_ROOT, 'parts/index.mdx'), enContent);
  writeOut(path.join(OUT_KO_ROOT, 'parts/index.mdx'), koContent);
}

// ------------------------------------------------------------
// 후처리: 변환되지 않은 parts 링크는 외부 강등
// ------------------------------------------------------------
function collectExistingPartsPaths() {
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
  function walkDirs(d, rel) {
    if (!exists(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const next = rel ? rel + '/' + e.name : e.name;
      const cat = path.join(d, e.name, '_category_.json');
      if (exists(cat)) paths.add(('/docs/' + next).replace(/\/+$/, ''));
      walkDirs(path.join(d, e.name), next);
    }
  }
  walkDirs(OUT_EN_ROOT, '');
  return paths;
}

function postProcessOrphanLinks() {
  const valid = collectExistingPartsPaths();
  const allFiles = [];
  function walk(d) {
    if (!exists(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && (e.name.endsWith('.mdx') || e.name.endsWith('.md'))) {
        if (full.includes(path.sep + 'parts' + path.sep)) {
          allFiles.push(full);
        }
      }
    }
  }
  walk(path.join(OUT_EN_ROOT, 'parts'));
  walk(path.join(OUT_KO_ROOT, 'parts'));

  let downgraded = 0;
  for (const file of allFiles) {
    let txt = readUtf8(file);
    txt = txt.replace(
      /\]\(\/docs\/parts\/([^)\s#]+?)(#[^)\s]*)?\)/g,
      (m, p, hash) => {
        const target = '/docs/parts/' + p.replace(/\/+$/, '');
        if (valid.has(target)) return m;
        downgraded++;
        return `](https://emanual.robotis.com/docs/en/parts/${p}/${hash || ''})`;
      },
    );
    txt = txt.replace(
      /^(\[[^\]]+\]):\s*\/docs\/parts\/([^\s#]+?)\/?(#[^\s]*)?\s*$/gm,
      (m, label, p, hash) => {
        const target = '/docs/parts/' + p.replace(/\/+$/, '');
        if (valid.has(target)) return m;
        downgraded++;
        return `${label}: https://emanual.robotis.com/docs/en/parts/${p}/${hash || ''}`;
      },
    );
    fs.writeFileSync(file, txt);
  }
  console.log(`postprocess: orphan parts links downgraded: ${downgraded}`);
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
    convertSinglePage(srcEnFull, srcKrFull, p.outRel, p.meta, p.productGroup);
    stats.pages++;
  }

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

  buildPartsIndex();

  stats.assets = copyAssets();

  postProcessOrphanLinks();

  console.log('Parts conversion complete.');
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v}`);
}

main();
