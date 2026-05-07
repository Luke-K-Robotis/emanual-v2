#!/usr/bin/env node
/**
 * Edu (~34 페이지) + FAQ (~10 페이지) Jekyll Markdown → Docusaurus MDX 변환.
 *
 *   Edu (en + kr) :
 *     bioloid : beginner / comprehensive / stem / premium / gp
 *     dream   : dream / dream-a / dream-b / dream1-2..4 / dream2-1..5 / dream2-schoolset
 *     engineer: kit1 / kit2_introduction / kit2_quickstart / kit2_reference /
 *               kit2_advanced_course / pycm
 *     ollo    : bugkit / explorer / inventor (+ ko-only ollo-4)
 *     play    : play-300 / play-600 / play-700 (en만; ko 미러)
 *
 *   FAQ (en + kr) :
 *     faq / faq_dynamixel / faq_steam / faq_software / faq_platform / faq_parts /
 *     download_task_code / cm_510_530_fuse / op (en-only) / dxl-selection-guide
 *     ko-only: contents_guide / dxl_software_compatibility
 *
 *   Output:
 *     docusaurus/docs/edu/{bioloid,dream,engineer,ollo,play}/*.mdx + index.mdx
 *     docusaurus/docs/faq/*.mdx + index.mdx
 *     + ko mirror under i18n/ko/...
 *
 *   사용: node scripts/convert-edu-faq.js
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
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

// ------------------------------------------------------------
// Liquid include resolver
// ------------------------------------------------------------
function resolveInclude(includePath, ctx, depth = 0) {
  if (depth > 5) return `<!-- include depth limit: ${includePath} -->`;
  const candidates = [];
  candidates.push(path.join(SRC_INCLUDES, includePath));
  if (ctx && ctx.lang === 'kr' && /^en\//.test(includePath)) {
    candidates.push(path.join(SRC_INCLUDES, 'kr/' + includePath.slice(3)));
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
  txt = txt.replace(/\{%\s*include\s+([^\s%]+)\s*%\}/g, (_, p) => {
    const inc = resolveInclude(p, ctx, depth + 1);
    return inc === null ? `<!-- unresolved include: ${p} -->` : inc;
  });
  txt = evalLiquidConditionals(txt, ctx || {});
  return txt;
}

// ------------------------------------------------------------
// Liquid 조건문/변수 단순 평가기
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
  body = body.replace(/\/assets\/images\/edu\//g, '/img/edu/');
  body = body.replace(/\/assets\/images\/faq\//g, '/img/faq/');
  body = body.replace(/\/assets\/images\/parts\//g, '/img/parts/');
  body = body.replace(/\/assets\/images\/sw\//g, '/img/software/');
  body = body.replace(/\/assets\/images\/dxl\//g, '/img/dxl/');
  body = body.replace(/\/assets\/images\/platform\//g, '/img/platform/');
  body = body.replace(/\/assets\/images\/icon_warning\.png/g, '/img/icon_warning.png');
  body = body.replace(/\/assets\/images\/icon_unfold\.png/g, '/img/icon_unfold.png');
  body = body.replace(/\(\/assets\/images\//g, '(/img/');
  // /assets/foo.tsk 같은 직접 자산은 외부 강등
  body = body.replace(/\]\(\/assets\/([^)\s]+)\)/g, (_, p) => `](https://emanual.robotis.com/assets/${p})`);
  return body;
}

// 변환된 페이지 path 수집용
const globalConvertedPaths = new Set();

// 외부 강등 / 내부 변환
//   /docs/<lang>/edu/<rest>  → 내부 (postprocess가 미존재는 강등)
//   /docs/<lang>/faq/<rest>  → 내부
//   /docs/<lang>/parts/<rest> → /docs/parts/<rest>
//   기타 /docs/<lang>/* → 외부 강등
function rewriteInternalLinks(body) {
  // 누락 leading `/`
  body = body.replace(/\]\((docs\/(?:en|kr)\/[^)\s]+)\)/g, (_, p) => `](/${p})`);

  // 1) edu / faq 내부 링크 - locale prefix 제거
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/(edu|faq)\/([^)\s#]+?)\/?(#[^)\s]*)?\)/g,
    (_, lang, area, p, hash) => `](/docs/${area}/${p}${hash || ''})`,
  );
  body = body.replace(
    /^(\s*\[[^\]]+\]):\s*\/docs\/(en|kr)\/(edu|faq)\/([^\s#]+?)\/?(#[^\s]*)?\s*$/gm,
    (_, label, lang, area, p, hash) => `${label}: /docs/${area}/${p}${hash || ''}`,
  );

  // 2) edu / faq 인덱스 자체 (/docs/en/edu/, /docs/kr/edu/)
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/(edu|faq)\/?(#[^)\s]*)?\)/g,
    (_, lang, area, hash) => `](/docs/${area}${hash || ''})`,
  );
  body = body.replace(
    /^(\s*\[[^\]]+\]):\s*\/docs\/(en|kr)\/(edu|faq)\/?\s*$/gm,
    (_, label, lang, area) => `${label}: /docs/${area}`,
  );

  // 3) parts 영역 내부 링크 → /docs/parts/<rest>
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/parts\/([^)\s#]+?)\/?(#[^)\s]*)?\)/g,
    (_, lang, p, hash) => `](/docs/parts/${p}${hash || ''})`,
  );
  body = body.replace(
    /^(\s*\[[^\]]+\]):\s*\/docs\/(en|kr)\/parts\/([^\s#]+?)\/?(#[^\s]*)?\s*$/gm,
    (_, label, lang, p, hash) => `${label}: /docs/parts/${p}${hash || ''}`,
  );

  // 4) software / dxl 내부 링크 → /docs/<area>/<rest>
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/(software|dxl|platform)\/([^)\s#]+?)\/?(#[^)\s]*)?\)/g,
    (_, lang, area, p, hash) => `](/docs/${area}/${p}${hash || ''})`,
  );
  body = body.replace(
    /^(\s*\[[^\]]+\]):\s*\/docs\/(en|kr)\/(software|dxl|platform)\/([^\s#]+?)\/?(#[^\s]*)?\s*$/gm,
    (_, label, lang, area, p, hash) => `${label}: /docs/${area}/${p}${hash || ''}`,
  );

  // 5) 그 외 /docs/<lang>/<rest> → 외부 강등
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/([^)\s#]+?)\/?(#[^)\s]*)?\)/g,
    (_, lang, p, hash) => `](https://emanual.robotis.com/docs/${lang}/${p}/${hash || ''})`,
  );
  body = body.replace(
    /^(\s*\[[^\]]+\]):\s*\/docs\/(en|kr)\/(\S+?)\/?\s*$/gm,
    (_, label, lang, p) => `${label}: https://emanual.robotis.com/docs/${lang}/${p}/`,
  );

  // 6) bare anchor heading typo: `[Foo](slug-with-dashes)` → `[Foo](#slug-with-dashes)`
  body = body.replace(/\]\(([^)\s/#]+?)\)/g, (m, frag) => {
    if (/^https?:\/\//.test(frag)) return m;
    if (/^mailto:/.test(frag)) return m;
    if (frag.startsWith('/')) return m;
    if (frag === '') return m;
    if (frag.includes('.')) return m; // 이미지 / 도메인
    if (!/[-_]/.test(frag) && !/[ㄱ-힝]/.test(frag)) return m;
    return `](#${frag})`;
  });

  // 7) bare external www
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

  // Liquid 본문의 if/assign 평가
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

  // <br>/<hr>/<img> 정규화 (대소문자 무관)
  body = body.replace(/<br\s*\/?\s*>/gi, '<br />');
  body = body.replace(/<hr\s*\/?\s*>/gi, '<hr />');
  body = body.replace(/<img\b([^>]*?)(?<!\/)>/gi, '<img$1 />');

  // .popup / .button / .blank / .text-center 잔여
  body = body.replace(/\{:\s*\.popup\s*\}/g, '');
  body = body.replace(/\{:\s*\.button\s*\}/g, '');
  body = body.replace(/\{:\s*\.blank\s*\}/g, '');
  body = body.replace(/\{:\s*\.text-center\s*\}/g, '');
  body = body.replace(/\{:\s*\.align-center\s*\}/g, '');

  // self-link 헤딩 단순화
  body = cleanHeadings(body, ctx.title);

  // section
  body = body.replace(/<section[^>]*>/g, '');
  body = body.replace(/<\/section>/g, '');

  // div notice 블록
  body = transformDivNotices(body);

  // kramdown notice
  body = transformKramdownNotices(body);

  // 잔여 catchall kramdown attribute 제거
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

  // HTML inline style="prop:val;..." → JSX style={{prop: 'val', ...}} (MDX/React 요구)
  // (escape 이후에 수행하면, 이전에 본문의 {} 가 escape 되었으므로 충돌 없이 JSX expression 삽입 가능)
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
// 변환 대상
// ------------------------------------------------------------
const PAGES = [];

// FAQ (10 en + ko-only contents_guide / dxl_software_compatibility)
const FAQ = [
  { id: 'faq_dynamixel',     src: 'faq_dynamixel.md',     title: 'FAQ - DYNAMIXEL',                  pos: 10 },
  { id: 'faq_software',      src: 'faq_software.md',      title: 'FAQ - Software',                   pos: 20 },
  { id: 'faq_steam',         src: 'faq_steam.md',         title: 'FAQ - STEAM',                      pos: 30 },
  { id: 'faq_platform',      src: 'faq_platform.md',      title: 'FAQ - Platform',                   pos: 40 },
  { id: 'faq_parts',         src: 'faq_parts.md',         title: 'FAQ - Parts',                      pos: 50 },
  { id: 'faq_general',       src: 'faq.md',               title: 'FAQ - General',                    pos: 60 },
  { id: 'download_task_code',src: 'download_task_code.md',title: 'Download Task Code',               pos: 70 },
  { id: 'cm_510_530_fuse',   src: 'cm_510_530_fuse.md',   title: 'CM-510/530 Fuse Replacement',      pos: 80 },
  { id: 'op',                src: 'op.md',                title: 'DARWIN-OP FAQ',                    pos: 90 },
  { id: 'dxl-selection-guide', src: 'dxl-selection-guide.md', title: 'DYNAMIXEL Selection Guide',  pos: 100 },
];
for (const p of FAQ) {
  PAGES.push({
    srcEn: `faq/${p.src}`,
    srcKr: `faq/${p.src}`,
    outRel: `faq/${p.id}.mdx`,
    meta: { id: p.id, title: p.title, sidebarLabel: p.title, sidebarPosition: p.pos, tags: ['faq'] },
    productGroup: p.id,
  });
}
// ko-only FAQ pages
const FAQ_KO_ONLY = [
  { id: 'contents_guide',          src: 'contents_guide.md',          title: 'Contents Guide',                  pos: 5 },
  { id: 'dxl_software_compatibility', src: 'dxl_software_compatibility.md', title: 'DYNAMIXEL Software Compatibility', pos: 15 },
];

// Edu - bioloid (5)
const BIOLOID = [
  { id: 'beginner',      src: 'beginner.md',      title: 'BIOLOID Beginner',      pos: 10 },
  { id: 'comprehensive', src: 'comprehensive.md', title: 'BIOLOID Comprehensive', pos: 20 },
  { id: 'stem',          src: 'stem.md',          title: 'ROBOTIS STEM',          pos: 30 },
  { id: 'premium',       src: 'premium.md',       title: 'ROBOTIS PREMIUM',       pos: 40 },
  { id: 'gp',            src: 'gp.md',            title: 'ROBOTIS GP',            pos: 50 },
];
for (const p of BIOLOID) {
  PAGES.push({
    srcEn: `edu/bioloid/${p.src}`,
    srcKr: `edu/bioloid/${p.src}`,
    outRel: `edu/bioloid/${p.id}.mdx`,
    meta: { id: p.id, title: p.title, sidebarLabel: p.title, sidebarPosition: p.pos, tags: ['edu', 'bioloid'] },
    productGroup: 'bioloid',
  });
}

// Edu - dream (en files)
const DREAM = [
  { id: 'dream1-2',         src: 'dream1-2.md',         title: 'ROBOTIS DREAM Level 2',  pos: 20 },
  { id: 'dream1-3',         src: 'dream1-3.md',         title: 'ROBOTIS DREAM Level 3',  pos: 30 },
  { id: 'dream1-4',         src: 'dream1-4.md',         title: 'ROBOTIS DREAM Level 4',  pos: 40 },
  { id: 'dream-a',          src: 'dream-a.md',          title: 'ROBOTIS DREAM Set A',    pos: 50 },
  { id: 'dream-b',          src: 'dream-b.md',          title: 'ROBOTIS DREAM Set B',    pos: 60 },
  { id: 'dream2-1',         src: 'dream2-1.md',         title: 'ROBOTIS DREAM II Level 1', pos: 70 },
  { id: 'dream2-2',         src: 'dream2-2.md',         title: 'ROBOTIS DREAM II Level 2', pos: 80 },
  { id: 'dream2-3',         src: 'dream2-3.md',         title: 'ROBOTIS DREAM II Level 3', pos: 90 },
  { id: 'dream2-4',         src: 'dream2-4.md',         title: 'ROBOTIS DREAM II Level 4', pos: 100 },
  { id: 'dream2-5',         src: 'dream2-5.md',         title: 'ROBOTIS DREAM II Level 5', pos: 110 },
  { id: 'dream2-schoolset', src: 'dream2-schoolset.md', title: 'ROBOTIS DREAM II School Set', pos: 120 },
];
for (const p of DREAM) {
  PAGES.push({
    srcEn: `edu/dream/${p.src}`,
    srcKr: `edu/dream/${p.src}`,
    outRel: `edu/dream/${p.id}.mdx`,
    meta: { id: p.id, title: p.title, sidebarLabel: p.title, sidebarPosition: p.pos, tags: ['edu', 'dream'] },
    productGroup: 'dream',
  });
}
// ko-only dream
const DREAM_KO_ONLY = [
  { id: 'dream1-1', src: 'dream1-1.md', title: 'ROBOTIS DREAM Level 1', pos: 10 },
];

// Edu - engineer
const ENGINEER = [
  { id: 'kit1',                  src: 'kit1.md',                  title: 'ENGINEER Kit1',           pos: 10 },
  { id: 'kit2_introduction',     src: 'kit2_introduction.md',     title: 'ENGINEER Kit2 Introduction', pos: 20 },
  { id: 'kit2_quickstart',       src: 'kit2_quickstart.md',       title: 'ENGINEER Kit2 Quickstart',   pos: 30 },
  { id: 'kit2_reference',        src: 'kit2_reference.md',        title: 'ENGINEER Kit2 Reference',    pos: 40 },
  { id: 'kit2_advanced_course',  src: 'kit2_advanced_course.md',  title: 'ENGINEER Kit2 Advanced Course', pos: 50 },
  { id: 'pycm',                  src: 'pycm.md',                  title: 'CM-550 MicroPython API',     pos: 60 },
];
for (const p of ENGINEER) {
  PAGES.push({
    srcEn: `edu/engineer/${p.src}`,
    srcKr: `edu/engineer/${p.src}`,
    outRel: `edu/engineer/${p.id}.mdx`,
    meta: { id: p.id, title: p.title, sidebarLabel: p.title, sidebarPosition: p.pos, tags: ['edu', 'engineer'] },
    productGroup: 'engineer',
  });
}

// Edu - ollo
const OLLO = [
  { id: 'bugkit',   src: 'bugkit.md',   title: 'OLLO Bug Kit', pos: 10 },
  { id: 'explorer', src: 'explorer.md', title: 'OLLO Explorer', pos: 20 },
  { id: 'inventor', src: 'inventor.md', title: 'OLLO Inventor', pos: 30 },
];
for (const p of OLLO) {
  PAGES.push({
    srcEn: `edu/ollo/${p.src}`,
    srcKr: `edu/ollo/${p.src}`,
    outRel: `edu/ollo/${p.id}.mdx`,
    meta: { id: p.id, title: p.title, sidebarLabel: p.title, sidebarPosition: p.pos, tags: ['edu', 'ollo'] },
    productGroup: 'ollo',
  });
}
// ko-only ollo
const OLLO_KO_ONLY = [
  { id: 'ollo-4', src: 'ollo-4.md', title: 'OLLO Level 4', pos: 40 },
];

// Edu - play (en만)
const PLAY = [
  { id: 'play-300', src: 'play-300.md', title: 'ROBOTIS PLAY 300 DINOs',   pos: 10 },
  { id: 'play-600', src: 'play-600.md', title: 'ROBOTIS PLAY 600 PETs',    pos: 20 },
  { id: 'play-700', src: 'play-700.md', title: 'ROBOTIS PLAY 700 OLLOBOT', pos: 30 },
];
for (const p of PLAY) {
  PAGES.push({
    srcEn: `edu/play/${p.src}`,
    srcKr: `edu/play/${p.src}`, // 없으니 ko 미러로 처리됨
    outRel: `edu/play/${p.id}.mdx`,
    meta: { id: p.id, title: p.title, sidebarLabel: p.title, sidebarPosition: p.pos, tags: ['edu', 'play'] },
    productGroup: 'play',
  });
}

// ------------------------------------------------------------
// 카테고리 정의
// ------------------------------------------------------------
const CATEGORIES = [
  { dir: 'edu/bioloid',  label: 'BIOLOID',     koLabel: 'BIOLOID',         position: 10 },
  { dir: 'edu/dream',    label: 'DREAM',       koLabel: 'DREAM',           position: 20 },
  { dir: 'edu/engineer', label: 'ENGINEER',    koLabel: 'ENGINEER',        position: 30 },
  { dir: 'edu/ollo',     label: 'OLLO',        koLabel: 'OLLO',            position: 40 },
  { dir: 'edu/play',     label: 'PLAY',        koLabel: 'PLAY',            position: 50 },
];

// ------------------------------------------------------------
// 자산 복사
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

  walkCopy(path.join(ASSET_SRC_ROOT, 'images/edu'), path.join(ASSET_OUT_ROOT, 'edu'));
  walkCopy(path.join(ASSET_SRC_ROOT, 'images/faq'), path.join(ASSET_OUT_ROOT, 'faq'));

  return count;
}

// ------------------------------------------------------------
// FAQ index 생성
// ------------------------------------------------------------
function buildFaqIndex() {
  const meta = {
    id: 'faq',
    title: 'FAQ',
    sidebarLabel: 'FAQ',
    sidebarPosition: 1,
    slug: '/faq',
    tags: ['faq'],
  };
  const enBody = `# FAQ

Frequently Asked Questions for ROBOTIS products.

## Categories

- [DYNAMIXEL FAQ](/docs/faq/faq_dynamixel) — Common questions about DYNAMIXEL actuators, protocols, and accessories.
- [Software FAQ](/docs/faq/faq_software) — RoboPlus, DYNAMIXEL Wizard, DYNAMIXEL SDK and other software questions.
- [STEAM FAQ](/docs/faq/faq_steam) — Educational kit (STEAM) related questions.
- [Platform FAQ](/docs/faq/faq_platform) — TurtleBot and other platform related questions.
- [Parts FAQ](/docs/faq/faq_parts) — Controllers, sensors, motors, communication parts.
- [General FAQ](/docs/faq/faq_general) — Miscellaneous topics.
- [Download Task Code](/docs/faq/download_task_code) — How to download Task code to a controller.
- [CM-510/530 Fuse Replacement](/docs/faq/cm_510_530_fuse) — Replacing the fuse on CM-510 / CM-530.
- [DARWIN-OP FAQ](/docs/faq/op) — Frequently encountered DARWIN-OP issues.
- [DYNAMIXEL Selection Guide](/docs/faq/dxl-selection-guide) — Selecting the right DYNAMIXEL for your application.
`;
  const koBody = `# FAQ

ROBOTIS 제품 관련 자주 묻는 질문입니다.

## 카테고리

- [DYNAMIXEL FAQ](/docs/faq/faq_dynamixel) — DYNAMIXEL 액추에이터, 프로토콜, 액세서리 관련 질문.
- [소프트웨어 FAQ](/docs/faq/faq_software) — RoboPlus, DYNAMIXEL Wizard, DYNAMIXEL SDK 등.
- [STEAM FAQ](/docs/faq/faq_steam) — 교육용 키트 관련 질문.
- [플랫폼 FAQ](/docs/faq/faq_platform) — TurtleBot 등 플랫폼 관련 질문.
- [부품 FAQ](/docs/faq/faq_parts) — 컨트롤러, 센서, 모터, 통신 부품.
- [기타 질문](/docs/faq/faq_general) — 일반/기타 항목.
- [태스크 코드 다운로드](/docs/faq/download_task_code) — 컨트롤러에 Task 코드 다운로드 방법.
- [CM-510/530 퓨즈 교체](/docs/faq/cm_510_530_fuse) — CM-510 / CM-530 퓨즈 교체 안내.
- [DARWIN-OP FAQ](/docs/faq/op) — DARWIN-OP 자주 묻는 질문.
- [DYNAMIXEL 선정 가이드](/docs/faq/dxl-selection-guide) — 어플리케이션에 적합한 DYNAMIXEL 선정.
- [콘텐츠 가이드](/docs/faq/contents_guide) — eManual 사용 안내.
- [DYNAMIXEL 소프트웨어 호환성](/docs/faq/dxl_software_compatibility) — DYNAMIXEL과 소프트웨어 호환표.
`;
  const newFm = {
    id: meta.id,
    title: meta.title,
    sidebar_label: meta.sidebarLabel,
    sidebar_position: meta.sidebarPosition,
    slug: meta.slug,
    tags: meta.tags,
  };
  const enContent = buildFmYaml(newFm) + enBody;
  const koContent = buildFmYaml(newFm) + koBody;

  // 기존 placeholder 제거
  for (const old of [
    path.join(OUT_EN_ROOT, 'faq/index.md'),
    path.join(OUT_KO_ROOT, 'faq/index.md'),
  ]) { if (exists(old)) fs.unlinkSync(old); }

  writeOut(path.join(OUT_EN_ROOT, 'faq/index.mdx'), enContent);
  writeOut(path.join(OUT_KO_ROOT, 'faq/index.mdx'), koContent);
}

// ------------------------------------------------------------
// Edu index 생성
// ------------------------------------------------------------
function buildEduIndex() {
  const meta = {
    id: 'edu',
    title: 'Education',
    sidebarLabel: 'Education',
    sidebarPosition: 1,
    slug: '/edu',
    tags: ['edu'],
  };
  const enBody = `# Education

ROBOTIS educational platforms and kits.

## Categories

- [PLAY](/docs/edu/play/play-300) — Entry-level reconfigurable robot kits (PLAY 300/600/700).
- [OLLO](/docs/edu/ollo/bugkit) — OLLO kits for early learners (Bug Kit, Explorer, Inventor).
- [DREAM](/docs/edu/dream/dream1-2) — DREAM Level 2/3/4, Set A/B, and DREAM II Level 1-5 + School Set.
- [BIOLOID](/docs/edu/bioloid/beginner) — BIOLOID Beginner, Comprehensive, STEM, PREMIUM, GP.
- [ENGINEER](/docs/edu/engineer/kit1) — ENGINEER Kit 1 / Kit 2 with CM-550 MicroPython API.

:::warning

Several legacy kits (BIOLOID Beginner / Comprehensive, OLLO, DREAM I) have been discontinued.

:::
`;
  const koBody = `# 교육용 키트

ROBOTIS의 교육용 플랫폼 및 키트 안내입니다.

## 카테고리

- [PLAY](/docs/edu/play/play-300) — 입문용 조립 로봇 키트 (PLAY 300/600/700).
- [OLLO](/docs/edu/ollo/bugkit) — 초등 저학년용 OLLO 키트 (Bug Kit / Explorer / Inventor).
- [DREAM](/docs/edu/dream/dream1-2) — DREAM Level 2/3/4, Set A/B 및 DREAM II Level 1-5 + School Set.
- [BIOLOID](/docs/edu/bioloid/beginner) — BIOLOID Beginner / Comprehensive / STEM / PREMIUM / GP.
- [ENGINEER](/docs/edu/engineer/kit1) — ENGINEER Kit 1 / Kit 2 (CM-550 MicroPython API 포함).

:::warning

일부 레거시 키트 (BIOLOID Beginner / Comprehensive, OLLO, DREAM I)는 단종되었습니다.

:::
`;
  const newFm = {
    id: meta.id,
    title: meta.title,
    sidebar_label: meta.sidebarLabel,
    sidebar_position: meta.sidebarPosition,
    slug: meta.slug,
    tags: meta.tags,
  };
  const enContent = buildFmYaml(newFm) + enBody;
  const koContent = buildFmYaml(newFm) + koBody;

  for (const old of [
    path.join(OUT_EN_ROOT, 'edu/index.md'),
    path.join(OUT_KO_ROOT, 'edu/index.md'),
  ]) { if (exists(old)) fs.unlinkSync(old); }

  writeOut(path.join(OUT_EN_ROOT, 'edu/index.mdx'), enContent);
  writeOut(path.join(OUT_KO_ROOT, 'edu/index.mdx'), koContent);
}

// ------------------------------------------------------------
// ko-only 페이지 변환 (en 측엔 ko 본문 동일을 사용)
// ------------------------------------------------------------
function convertKoOnlyPage(area, srcRel, meta, productGroup) {
  const srcKrFull = path.join(SRC_KR, srcRel);
  if (!exists(srcKrFull)) return false;
  const krRaw = readUtf8(srcKrFull);
  const { fm: krFm, body: krBody } = splitFrontmatter(krRaw);
  const ctx = {
    title: meta.title,
    lang: 'kr',
    ref: krFm.ref || meta.id,
    product_group: productGroup || meta.id,
    vars: {},
  };
  const converted = convertBody(krBody, ctx);
  const newFm = {
    id: meta.id,
    title: meta.title,
    sidebar_label: meta.sidebarLabel || meta.title,
    sidebar_position: meta.sidebarPosition,
    tags: meta.tags,
  };
  const koContent = buildFmYaml(newFm) + converted.trimStart() + '\n';
  // Write to ko-only locale
  writeOut(path.join(OUT_KO_ROOT, `${area}/${meta.id}.mdx`), koContent);
  // For default locale (en), include a minimal stub with the original Korean body
  // so Docusaurus default locale routing also has the page.
  const stubFm = newFm;
  const stubBody = `:::info\n\nThis page is currently available in Korean only. The original Korean content is shown below.\n\n:::\n\n${converted.trimStart()}\n`;
  const enStub = buildFmYaml(stubFm) + stubBody;
  writeOut(path.join(OUT_EN_ROOT, `${area}/${meta.id}.mdx`), enStub);
  globalConvertedPaths.add(`/docs/${area}/${meta.id}`);
  return true;
}

// ------------------------------------------------------------
// 후처리: 변환되지 않은 edu/faq 링크는 외부 강등
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
  const valid = collectExistingPaths();
  const allFiles = [];
  function walk(d) {
    if (!exists(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && (e.name.endsWith('.mdx') || e.name.endsWith('.md'))) {
        if (full.includes(path.sep + 'edu' + path.sep) || full.includes(path.sep + 'faq' + path.sep)) {
          allFiles.push(full);
        }
      }
    }
  }
  walk(path.join(OUT_EN_ROOT, 'edu'));
  walk(path.join(OUT_EN_ROOT, 'faq'));
  walk(path.join(OUT_KO_ROOT, 'edu'));
  walk(path.join(OUT_KO_ROOT, 'faq'));

  // 모든 영역 (edu, faq, parts, software, dxl, platform) 의 미존재 링크는 외부 강등
  const AREAS = '(edu|faq|parts|software|dxl|platform)';
  const linkRe = new RegExp(`\\]\\(\\/docs\\/${AREAS}\\/([^)\\s#]+?)(#[^)\\s]*)?\\)`, 'g');
  const refRe = new RegExp(`^(\\[[^\\]]+\\]):\\s*\\/docs\\/${AREAS}\\/([^\\s#]+?)\\/?(#[^\\s]*)?\\s*$`, 'gm');

  // 잔존 /docs/en/<area>/ 패턴 (rewriteInternalLinks 누락분) 도 외부 강등 — 좌우 공백 허용
  const localeStrayRe = /\]\(\s*\/docs\/(?:en|kr)\/([^)\s#]+?)\/?(#[^)\s]*)?\s*\)/g;
  const localeStrayRefRe = /^(\[[^\]]+\]):\s*\/docs\/(?:en|kr)\/(\S+?)\/?(#[^\s]*)?\s*$/gm;

  let downgraded = 0;
  for (const file of allFiles) {
    let txt = readUtf8(file);

    // /docs/<area>/<rest> 링크 검증 + 미존재 외부 강등
    txt = txt.replace(linkRe, (m, area, p, hash) => {
      const target = `/docs/${area}/` + p.replace(/\/+$/, '');
      if (valid.has(target)) return m;
      downgraded++;
      return `](https://emanual.robotis.com/docs/en/${area}/${p}/${hash || ''})`;
    });
    txt = txt.replace(refRe, (m, label, area, p, hash) => {
      const target = `/docs/${area}/` + p.replace(/\/+$/, '');
      if (valid.has(target)) return m;
      downgraded++;
      return `${label}: https://emanual.robotis.com/docs/en/${area}/${p}/${hash || ''}`;
    });

    // 잔존 /docs/<lang>/... → 외부 강등
    txt = txt.replace(localeStrayRe, (m, p, hash) => {
      downgraded++;
      return `](https://emanual.robotis.com/docs/en/${p}/${hash || ''})`;
    });
    txt = txt.replace(localeStrayRefRe, (m, label, p, hash) => {
      downgraded++;
      return `${label}: https://emanual.robotis.com/docs/en/${p}/${hash || ''}`;
    });

    // /docs/edu/dream 처럼 카테고리(generated-index) 페이지를 직접 가리키는 링크는
    // Docusaurus가 /docs/category/<label> 형태로 라우팅하므로 직접 링크는 외부 강등.
    // 단, 그 디렉터리에 실제 mdx 파일(=valid에 등록)이 있으면 OK.
    const categoryDirs = new Set();
    for (const c of CATEGORIES) {
      categoryDirs.add(`/docs/${c.dir}`);
    }
    txt = txt.replace(
      /\]\((\/docs\/[a-z0-9_\-/]+?)(#[^)\s]*)?\)/gi,
      (m, base, hash) => {
        if (categoryDirs.has(base)) {
          downgraded++;
          return `](https://emanual.robotis.com${base.replace('/docs/', '/docs/en/')}/${hash || ''})`;
        }
        return m;
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
  const stats = { pages: 0, missing: 0, koOnly: 0, categories: 0, assets: 0 };

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

  // ko-only pages
  for (const p of FAQ_KO_ONLY) {
    if (convertKoOnlyPage('faq', `faq/${p.src}`,
      { id: p.id, title: p.title, sidebarLabel: p.title, sidebarPosition: p.pos, tags: ['faq'] },
      p.id)) stats.koOnly++;
  }
  for (const p of DREAM_KO_ONLY) {
    if (convertKoOnlyPage('edu/dream', `edu/dream/${p.src}`,
      { id: p.id, title: p.title, sidebarLabel: p.title, sidebarPosition: p.pos, tags: ['edu', 'dream'] },
      'dream')) stats.koOnly++;
  }
  for (const p of OLLO_KO_ONLY) {
    if (convertKoOnlyPage('edu/ollo', `edu/ollo/${p.src}`,
      { id: p.id, title: p.title, sidebarLabel: p.title, sidebarPosition: p.pos, tags: ['edu', 'ollo'] },
      'ollo')) stats.koOnly++;
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

  buildFaqIndex();
  buildEduIndex();

  stats.assets = copyAssets();

  postProcessOrphanLinks();

  console.log('Edu/FAQ conversion complete.');
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v}`);
}

main();
