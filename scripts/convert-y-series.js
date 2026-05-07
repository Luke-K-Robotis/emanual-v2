#!/usr/bin/env node
/**
 * Y 시리즈 변환 스크립트.
 *
 * 입력:
 *   - source/docs/{en,kr}/dxl/y/*.md (12 모델 + y.md 인덱스)
 *   - source/_includes/{en,kr}/dxl/<frag>.md          (공유 fragment)
 *   - source/_includes/{en,kr}/dxl/y/<frag>.md        (Y 전용 fragment)
 *
 * 출력:
 *   - docusaurus/docs/dxl/y/<ref>.mdx                          (en)
 *   - docusaurus/i18n/ko/.../current/dxl/y/<ref>.mdx           (ko)
 *   - docusaurus/docs/_partials/dxl/y/<frag>.mdx               (en)
 *   - docusaurus/i18n/ko/.../current/_partials/dxl/y/<frag>.mdx (ko)
 *
 * Y는 4개 product_group 변형 (dxl_y_m / dxl_y_b / dxl_y_r / dxl_y_a).
 * fragment 중 product_group 분기가 있는 것은 key 에 product_group 접미사 부여.
 *
 * 사용법: node scripts/convert-y-series.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require(path.join(__dirname, '..', 'docusaurus', 'node_modules', 'js-yaml'));

const REPO = path.resolve(__dirname, '..');
const SRC = (lang) => path.join(REPO, 'source', 'docs', lang, 'dxl', 'y');
const OUT_DOC_EN = path.join(REPO, 'docusaurus', 'docs', 'dxl', 'y');
const OUT_DOC_KO = path.join(REPO, 'docusaurus', 'i18n', 'ko', 'docusaurus-plugin-content-docs', 'current', 'dxl', 'y');
const OUT_PART_EN = path.join(REPO, 'docusaurus', 'docs', '_partials', 'dxl', 'y');
const OUT_PART_KO = path.join(REPO, 'docusaurus', 'i18n', 'ko', 'docusaurus-plugin-content-docs', 'current', '_partials', 'dxl', 'y');

const PROFILES = {
  'ym070-210-m001-rh': { product_group: 'dxl_y_m' },
  'ym080-230-m001-rh': { product_group: 'dxl_y_m' },
  'ym070-210-b001-rh': { product_group: 'dxl_y_b' },
  'ym080-230-b001-rh': { product_group: 'dxl_y_b' },
  'ym070-210-r051-rh': { product_group: 'dxl_y_r' },
  'ym070-210-r099-rh': { product_group: 'dxl_y_r' },
  'ym080-230-r051-rh': { product_group: 'dxl_y_r' },
  'ym080-230-r099-rh': { product_group: 'dxl_y_r' },
  'ym070-210-a051-rh': { product_group: 'dxl_y_a' },
  'ym070-210-a099-rh': { product_group: 'dxl_y_a' },
  'ym080-230-a051-rh': { product_group: 'dxl_y_a' },
  'ym080-230-a099-rh': { product_group: 'dxl_y_a' },
};

// ---- spec data ----
function loadSpecData(filename) {
  const p = path.join(REPO, 'source', '_data', filename);
  if (!fs.existsSync(p)) return {};
  try {
    const doc = yaml.load(fs.readFileSync(p, 'utf8'));
    return doc || {};
  } catch (e) {
    console.warn(`yaml load failed: ${filename}: ${e.message}`);
    return {};
  }
}
const Y_DATA = loadSpecData('dxl_y_info.yml');

// product_group 분기가 있는 Y fragment.
// 같은 분기 결과를 만드는 product_group을 그룹화하여 partial 키에 접미사 부여.
//   control_table_512_torque_enable.md: dxl_y_m vs (others)  -> _m / _other
//   y_warning.md: (dxl_y_r or dxl_y_a) vs (others)            -> _ra / _mb
const PG_BRANCH_FRAGMENTS = {
  // key (partial key without suffix) -> function(product_group) -> suffix string
  'y_control_table_512_torque_enable': (pg) => pg === 'dxl_y_m' ? '_m' : '_other',
  'y_y_warning': (pg) => (pg === 'dxl_y_r' || pg === 'dxl_y_a') ? '_ra' : '_mb',
};

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
  if ((m = cond.match(/^site\.data\.(\w+)\[page\.ref\]\.(\w+)\s*(==|!=)\s*['"]([^'"]*)['"]$/))) {
    const data = m[1] === 'dxl_y_info' ? Y_DATA : null;
    if (!data || !data[ctx.ref]) return m[3] === '!=';
    const v = data[ctx.ref][m[2]];
    return m[3] === '==' ? v === m[4] : v !== m[4];
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
  if ((m = base.match(/^site\.data\.(\w+)\[page\.ref\]\.(\w+)$/))) {
    const data = m[1] === 'dxl_y_info' ? Y_DATA : null;
    if (data && data[ctx.ref]) val = data[ctx.ref][m[2]];
  } else if ((m = base.match(/^page\.(\w+)$/))) {
    val = ctx[m[1]];
  } else if (ctx.vars && Object.prototype.hasOwnProperty.call(ctx.vars, base)) {
    val = ctx.vars[base];
  }
  if (val === undefined) return `{{ ${expr} }}`;
  return String(val);
}

function render(tokens, ctx, includeHandler) {
  let out = '';
  let i = 0;
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
      ctx.vars[name] = render(sub, ctx, includeHandler);
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
      if (chosen) out += render(chosen.tokens, ctx, includeHandler);
      continue;
    }
    if (/^include\s+/.test(tag)) {
      const m = tag.match(/^include\s+(\S+)/);
      if (m && includeHandler) out += includeHandler(m[1].replace(/^\//, ''));
      i++; continue;
    }
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
  if (/^\d/.test(r)) r = 'X' + r;
  return r;
}
function importVarFor(partialKey) {
  return pascalCaseSegments(partialKey);
}

// ----- Kramdown → MDX -----
function escapeMdxBraces(src) {
  const lines = src.split('\n');
  let inFence = false;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const out = [];
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === '`') {
        const end = line.indexOf('`', i + 1);
        if (end === -1) { out.push(line.slice(i)); i = line.length; }
        else { out.push(line.slice(i, end + 1)); i = end + 1; }
        continue;
      }
      if (ch === '{') {
        if (line.slice(i, i + 3) === '{/*') {
          const end = line.indexOf('*/}', i + 3);
          if (end === -1) { out.push(line.slice(i)); i = line.length; }
          else { out.push(line.slice(i, end + 3)); i = end + 3; }
          continue;
        }
        const close = line.indexOf('}', i + 1);
        if (close === -1) {
          out.push('&#123;');
          i++;
          continue;
        }
        const inner = line.slice(i + 1, close).trim();
        if (/^[A-Za-z_$][\w$]*$/.test(inner) || inner === '') {
          out.push(line.slice(i, close + 1));
        } else {
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

// `<`가 알파벳, `/`, `!`, `?` 가 아닌 문자 뒤에 오면 JSX 태그 시작으로 오인됨.
// 본문에 `<= 0`, `<5`, `< text` 같은 수식 / 비교 연산자 → `&lt;` 로 escape.
// 코드 블록(```), 인라인 코드(`), 그리고 식별 가능한 HTML 태그는 보호.
function escapeAngleBrackets(src) {
  const lines = src.split('\n');
  let inFence = false;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (/^```/.test(line)) { inFence = !inFence; continue; }
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
        const next = line[i + 1] || '';
        // 알파벳/슬래시/!/?로 시작 → JSX/HTML 태그로 보고 보존
        if (/[A-Za-z/!?]/.test(next)) { out += ch; i++; continue; }
        // 그 외 (=, 숫자, 공백 등) → escape
        out += '&lt;';
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

function admonitionConvert(src, marker, kind) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (marker.test(lines[i])) {
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

  src = admonitionConvert(src, /^\s*\{:\s*\.notice--danger\}\s*$/, 'danger');
  src = admonitionConvert(src, /^\s*\{:\s*\.notice--warning\}\s*$/, 'warning');
  src = admonitionConvert(src, /^\s*\{:\s*\.notice--info\}\s*$/, 'info');
  src = admonitionConvert(src, /^\s*\{:\s*\.notice--success\}\s*$/, 'tip');
  src = admonitionConvert(src, /^\s*\{:\s*\.notice\}\s*$/, 'note');

  src = src.replace(/<div\s+class="notice--warning">([\s\S]*?)<\/div>/g, (_, b) => `\n:::warning\n\n${b.trim()}\n\n:::\n`);
  src = src.replace(/<div\s+class="notice--info">([\s\S]*?)<\/div>/g, (_, b) => `\n:::info\n\n${b.trim()}\n\n:::\n`);
  src = src.replace(/<div\s+class="notice--danger">([\s\S]*?)<\/div>/g, (_, b) => `\n:::danger\n\n${b.trim()}\n\n:::\n`);
  src = src.replace(/<div\s+class="notice--success">([\s\S]*?)<\/div>/g, (_, b) => `\n:::tip\n\n${b.trim()}\n\n:::\n`);
  src = src.replace(/<div\s+class="notice">([\s\S]*?)<\/div>/g, (_, b) => `\n:::note\n\n${b.trim()}\n\n:::\n`);

  src = src.replace(/\/assets\/images\/dxl\//g, '/img/dxl/');
  src = src.replace(/\/assets\/images\//g, '/img/');

  src = src.replace(
    /\]\(\/docs\/(en|kr)\/([^)#\s]+)(#[^)\s]*)?\)/g,
    (_, lang, p, hash) => `](https://emanual.robotis.com/docs/${lang}/${p}${hash || ''})`
  );
  src = src.replace(
    /^(\[[^\]]+\]):\s*\/docs\/(en|kr)\/([^\s#]+)(#[^\s]*)?$/gm,
    (_, label, lang, p, hash) => `${label}: https://emanual.robotis.com/docs/${lang}/${p}${hash || ''}`
  );

  {
    const refs = new Map();
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

  src = src.replace(
    /\[([^\]]+)\]\((\/img\/[^)\s]+\.(?:jpg|jpeg|png|gif|svg|pdf|webp))\)/gi,
    (m, label, url) => {
      if (label.startsWith('!')) return m;
      return `<a href="${url}" target="_blank">${label}</a>`;
    }
  );

  src = src.replace(
    /\]\(([a-z][a-z0-9-]+(?:-?\d+)?)\)/g,
    (m, anchor) => {
      if (/[\/\.:]/.test(anchor)) return m;
      return `](#${anchor})`;
    }
  );

  src = src.replace(/<!--[\s\S]*?-->/g, '');
  src = src.replace(/<br\s*>/g, '<br />');
  src = src.replace(/<hr\s*>/g, '<hr />');
  src = src.replace(/<img([^>]*[^\/])>/g, '<img$1 />');

  // 원본 typo 보정: `<sup>X<sup>` (닫는 태그 누락) → `<sup>X</sup>`
  src = src.replace(/<sup>([^<]*?)<sup>/g, '<sup>$1</sup>');
  src = src.replace(/<sub>([^<]*?)<sub>/g, '<sub>$1</sub>');

  // MDX는 raw HTML <table> 내 markdown 처리에 약하다 — multi-line <td>...</td> 안 줄바꿈을
  // 한 줄로 합쳐서 paragraph 분기를 방지.
  src = src.replace(/<td\b([^>]*)>([\s\S]*?)<\/td>/g, (m, attrs, body) => {
    const collapsed = body.replace(/\s*\n\s*/g, ' ').trim();
    return `<td${attrs}>${collapsed}</td>`;
  });

  // MDX는 `<` 이후 첫 글자가 알파벳/`/`/`!`/`?` 가 아니면 JSX 시작 으로 오인.
  // 수식 표기 `<= 0`, `< 100` 등 → `&lt;` 로 escape (코드 블록 외부에서만).
  src = escapeAngleBrackets(src);

  src = escapeMdxBraces(src);

  src = src.replace(
    /^(#{1,6})((?:\s*<a name="[^"]+"(?:><\/a>|>))+)(.*)$/gm,
    (m, h, anchors, rest) => `${h}${rest}`
  );
  src = src.replace(
    /^(#{1,6})\s*\*\*\[([^\]]+?)\]\(#[^)]+\)\*\*\s*$/gm,
    '$1 $2'
  );
  src = src.replace(
    /^(#{1,6})\s*\[([^\]]+?)\]\(#[^)]+\)\s*$/gm,
    '$1 $2'
  );
  src = src.replace(
    /^(#{1,6})\s*\*\*([^*]+)\*\*\s*$/gm,
    '$1 $2'
  );
  src = src.replace(
    /^(#{1,6})\s*(\*\*\[[^\]]+\]\(#[^)]+\)\*\*(?:[,\s]+\*\*\[[^\]]+\]\(#[^)]+\)\*\*)+)\s*$/gm,
    (m, h, links) => {
      const cleaned = links.replace(/\*\*\[([^\]]+?)\]\(#[^)]+\)\*\*/g, '$1');
      return `${h} ${cleaned}`;
    }
  );

  return src;
}

function buildFmYaml(fm) {
  const lines = ['---'];
  if (fm.id) lines.push(`id: ${fm.id}`);
  if (fm.title) lines.push(`title: ${JSON.stringify(fm.title)}`);
  if (fm.sidebar_label) lines.push(`sidebar_label: ${JSON.stringify(fm.sidebar_label)}`);
  if (fm.tags && fm.tags.length) lines.push(`tags: [${fm.tags.join(', ')}]`);
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

const PARTIAL_QUEUE = [];
const PARTIAL_DONE = new Set();

/**
 * include path → partial key (without product_group suffix)
 *   en/dxl/control_table.md      → control_table
 *   en/dxl/y/<frag>.md           → y_<frag>
 */
function partialKeyBaseFor(includeSpec) {
  const norm = includeSpec.replace(/^\/+/, '');
  let m = norm.match(/^(?:en|kr)\/dxl\/(.+)\.md$/);
  if (!m) return null;
  let tail = m[1];
  if (tail.startsWith('y/')) return 'y_' + tail.slice(2).replace(/[\/\-]/g, '_');
  return tail.replace(/[\/\-]/g, '_');
}

function partialKeyFor(includeSpec, productGroup) {
  const base = partialKeyBaseFor(includeSpec);
  if (!base) return null;
  if (PG_BRANCH_FRAGMENTS[base]) {
    const suffix = PG_BRANCH_FRAGMENTS[base](productGroup);
    return base + suffix;
  }
  return base;
}

function convertPage(srcPath, ref, lang) {
  const raw = readSafe(srcPath);
  if (raw === null) return null;
  const { fm, body } = splitFrontmatter(raw);
  const profile = PROFILES[ref] || {};
  const ctx = {
    ref: fm.ref || ref,
    product_group: fm.product_group || profile.product_group || 'dxl_y_m',
    lang,
    vars: {},
  };

  const importsMap = new Map();

  function handleInclude(spec) {
    // 사양 표는 ref 별 데이터 차이로 partial 공유 불가 → 인라인 렌더
    if (/specifications_y\.md$/.test(spec)) {
      const inlined = inlineRender(spec, lang, ctx);
      return inlined === null ? `\n{/* include: ${spec} (missing) */}\n` : ('\n' + inlined.trim() + '\n');
    }
    let key = partialKeyFor(spec, ctx.product_group);
    if (!key) return `\n{/* include: ${spec} */}\n`;
    const varName = importVarFor(key);
    importsMap.set(key, varName);
    PARTIAL_QUEUE.push({ key, spec, lang, refForCtx: ctx.ref, productGroupForCtx: ctx.product_group });
    return `\n<${varName} />\n`;
  }

  const tokens = tokenize(body);
  let rendered = render(tokens, ctx, handleInclude);
  rendered = kramdownToMdx(rendered);

  const sidebarTitle = (fm.sidebar && fm.sidebar.title) || fm.title;
  const newFm = {
    id: ref,
    title: sidebarTitle || ref.toUpperCase(),
    sidebar_label: sidebarTitle || undefined,
    tags: fm.product_group ? [fm.product_group] : (profile.product_group ? [profile.product_group] : []),
  };
  const fmStr = buildFmYaml(newFm);
  const importLines = [];
  for (const [key, varName] of importsMap) {
    importLines.push(`import ${varName} from '@site/docs/_partials/dxl/y/${key}.mdx';`);
  }
  const importsBlock = importLines.length ? importLines.join('\n') + '\n\n' : '';

  return fmStr + importsBlock + rendered.trim() + '\n';
}

function inlineRender(spec, lang, ctx) {
  const norm = spec.replace(/^\/+/, '');
  const localized = norm.replace(/^(en|kr)\//, lang + '/');
  const full = path.join(REPO, 'source', '_includes', localized);
  let raw = readSafe(full);
  if (raw === null) {
    if (lang === 'kr') {
      const fallback = path.join(REPO, 'source', '_includes', norm.replace(/^kr\//, 'en/'));
      raw = readSafe(fallback);
    }
    if (raw === null) return null;
  }
  const subCtx = { ref: ctx.ref, product_group: ctx.product_group, lang, vars: {} };
  function nestedInclude(s) { return `\n{/* nested include: ${s} */}\n`; }
  const tokens = tokenize(raw);
  let rendered = render(tokens, subCtx, nestedInclude);
  rendered = kramdownToMdx(rendered);
  return rendered;
}

function convertPartial(spec, lang, refForCtx, productGroupForCtx) {
  const norm = spec.replace(/^\/+/, '');
  const localized = norm.replace(/^(en|kr)\//, lang + '/');
  const full = path.join(REPO, 'source', '_includes', localized);
  let raw = readSafe(full);
  if (raw === null) {
    if (lang === 'kr') {
      const fallback = path.join(REPO, 'source', '_includes', norm.replace(/^kr\//, 'en/'));
      raw = readSafe(fallback);
    }
    if (raw === null) return null;
  }
  const ctx = {
    ref: refForCtx || 'ym070-210-m001-rh',
    product_group: productGroupForCtx || 'dxl_y_m',
    lang,
    vars: {},
  };
  function nestedInclude(s) {
    return `\n{/* nested include: ${s} */}\n`;
  }
  const tokens = tokenize(raw);
  let rendered = render(tokens, ctx, nestedInclude);
  rendered = kramdownToMdx(rendered);
  return rendered.trim() + '\n';
}

// ----- 인덱스 (y.md → y/index.mdx) -----
function convertIndexPage(srcPath, lang) {
  const raw = readSafe(srcPath);
  if (raw === null) return null;
  const { fm, body } = splitFrontmatter(raw);
  const ctx = {
    ref: fm.ref || 'dxl_y',
    product_group: fm.product_group || 'dxl_y',
    lang,
    vars: {},
  };

  const importsMap = new Map();
  function handleInclude(spec) {
    let key = partialKeyFor(spec, ctx.product_group);
    if (!key) return `\n{/* include: ${spec} */}\n`;
    const varName = importVarFor(key);
    importsMap.set(key, varName);
    PARTIAL_QUEUE.push({ key, spec, lang, refForCtx: ctx.ref, productGroupForCtx: ctx.product_group });
    return `\n<${varName} />\n`;
  }

  const tokens = tokenize(body);
  let rendered = render(tokens, ctx, handleInclude);
  rendered = kramdownToMdx(rendered);

  const sidebarTitle = (fm.sidebar && fm.sidebar.title) || fm.title;
  const newFm = {
    id: 'index',
    title: sidebarTitle || 'DYNAMIXEL-Y',
    sidebar_label: sidebarTitle || undefined,
    tags: ['dxl_y'],
  };
  const fmStr = buildFmYaml(newFm);

  const importLines = [];
  for (const [key, varName] of importsMap) {
    importLines.push(`import ${varName} from '@site/docs/_partials/dxl/y/${key}.mdx';`);
  }
  const importsBlock = importLines.length ? importLines.join('\n') + '\n\n' : '';
  return fmStr + importsBlock + rendered.trim() + '\n';
}

function run() {
  ensureDir(OUT_DOC_EN);
  ensureDir(OUT_DOC_KO);
  ensureDir(OUT_PART_EN);
  ensureDir(OUT_PART_KO);

  // _category_.json — Y는 최신 라인업이라 navigation 첫 머리 (position 0)
  writeOut(
    path.join(OUT_DOC_EN, '_category_.json'),
    JSON.stringify({ label: 'Y Series', position: 0, link: { type: 'doc', id: 'dxl/y/index' } }, null, 2) + '\n'
  );
  writeOut(
    path.join(OUT_DOC_KO, '_category_.json'),
    JSON.stringify({ label: 'Y Series', position: 0, link: { type: 'doc', id: 'dxl/y/index' } }, null, 2) + '\n'
  );

  const stats = { en: 0, ko: 0, partials_en: 0, partials_ko: 0, errors: [] };

  // 본문 (12 모델)
  for (const ref of Object.keys(PROFILES)) {
    const filename = `${ref}.md`;
    const enSrc = path.join(SRC('en'), filename);
    const koSrc = path.join(SRC('kr'), filename);
    const outName = `${ref}.mdx`;
    if (fs.existsSync(enSrc)) {
      try {
        const out = convertPage(enSrc, ref, 'en');
        if (out) { writeOut(path.join(OUT_DOC_EN, outName), out); stats.en++; }
      } catch (e) { stats.errors.push(`en/${ref}: ${e.message}`); }
    }
    if (fs.existsSync(koSrc)) {
      try {
        const out = convertPage(koSrc, ref, 'kr');
        if (out) { writeOut(path.join(OUT_DOC_KO, outName), out); stats.ko++; }
      } catch (e) { stats.errors.push(`ko/${ref}: ${e.message}`); }
    }
  }

  // 인덱스: y.md → y/index.mdx
  {
    const enSrc = path.join(SRC('en'), 'y.md');
    const koSrc = path.join(SRC('kr'), 'y.md');
    if (fs.existsSync(enSrc)) {
      try {
        const out = convertIndexPage(enSrc, 'en');
        if (out) { writeOut(path.join(OUT_DOC_EN, 'index.mdx'), out); stats.en++; }
      } catch (e) { stats.errors.push(`en/index: ${e.message}`); }
    }
    if (fs.existsSync(koSrc)) {
      try {
        const out = convertIndexPage(koSrc, 'kr');
        if (out) { writeOut(path.join(OUT_DOC_KO, 'index.mdx'), out); stats.ko++; }
      } catch (e) { stats.errors.push(`ko/index: ${e.message}`); }
    }
  }

  // partial flush
  for (const q of PARTIAL_QUEUE) {
    const sig = `${q.lang}|${q.key}`;
    if (PARTIAL_DONE.has(sig)) continue;
    PARTIAL_DONE.add(sig);
    try {
      const content = convertPartial(q.spec, q.lang, q.refForCtx, q.productGroupForCtx);
      if (content === null) continue;
      const dir = q.lang === 'en' ? OUT_PART_EN : OUT_PART_KO;
      writeOut(path.join(dir, `${q.key}.mdx`), content);
      if (q.lang === 'en') stats.partials_en++; else stats.partials_ko++;
    } catch (e) { stats.errors.push(`partial ${q.lang}/${q.key}: ${e.message}`); }
  }

  console.log('Done.', stats);
}

run();
