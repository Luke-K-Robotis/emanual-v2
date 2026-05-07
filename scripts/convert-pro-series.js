#!/usr/bin/env node
/**
 * Pro 시리즈 변환 스크립트.
 *
 * 입력:
 *   - source/docs/{en,kr}/dxl/pro/*.md (18 페이지 × 2)
 *   - source/docs/{en,kr}/dxl/pro_{h,l,m}.md (인덱스 3 × 2)
 *   - source/_includes/{en,kr}/dxl/<frag>.md           (Pro fragment)
 *   - source/_includes/{en,kr}/dxl/p/<frag>.md         (Pro_a fragment)
 *
 * 출력:
 *   - docusaurus/docs/dxl/pro/<ref>.mdx                          (en)
 *   - docusaurus/i18n/ko/.../current/dxl/pro/<ref>.mdx           (ko)
 *   - docusaurus/docs/_partials/dxl/pro/<frag>.mdx               (en)
 *   - docusaurus/i18n/ko/.../current/_partials/dxl/pro/<frag>.mdx (ko)
 *
 * convert-x-series.js 와 동일한 Liquid evaluator + kramdown 변환을 사용한다.
 * 차이:
 *   - PROFILES 가 dxl_pro / dxl_pro_a
 *   - partial 출력 디렉터리 _partials/dxl/pro/
 *   - specifications_pro / specifications_proa 는 yaml data 를 inline 파싱하여 채움
 *   - include path 'en/dxl/p/<frag>.md' 도 partial key 로 처리 (key prefix 'p_')
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require(path.join(__dirname, '..', 'docusaurus', 'node_modules', 'js-yaml'));

const REPO = path.resolve(__dirname, '..');
const SRC = (lang) => path.join(REPO, 'source', 'docs', lang, 'dxl', 'pro');
const OUT_DOC_EN = path.join(REPO, 'docusaurus', 'docs', 'dxl', 'pro');
const OUT_DOC_KO = path.join(REPO, 'docusaurus', 'i18n', 'ko', 'docusaurus-plugin-content-docs', 'current', 'dxl', 'pro');
const OUT_PART_EN = path.join(REPO, 'docusaurus', 'docs', '_partials', 'dxl', 'pro');
const OUT_PART_KO = path.join(REPO, 'docusaurus', 'i18n', 'ko', 'docusaurus-plugin-content-docs', 'current', '_partials', 'dxl', 'pro');

// product_group 매핑
const PROFILES = {
  'h42-20-s300-r':  { product_group: 'dxl_pro' },
  'h54-100-s500-r': { product_group: 'dxl_pro' },
  'h54-200-s500-r': { product_group: 'dxl_pro' },
  'l42-10-s300-r':  { product_group: 'dxl_pro' },
  'l54-30-s400-r':  { product_group: 'dxl_pro' },
  'l54-30-s500-r':  { product_group: 'dxl_pro' },
  'l54-50-s290-r':  { product_group: 'dxl_pro' },
  'l54-50-s500-r':  { product_group: 'dxl_pro' },
  'm42-10-s260-r':  { product_group: 'dxl_pro' },
  'm54-40-s250-r':  { product_group: 'dxl_pro' },
  'm54-60-s250-r':  { product_group: 'dxl_pro' },
  'h42-20-s300-ra':  { product_group: 'dxl_pro_a' },
  'h54-100-s500-ra': { product_group: 'dxl_pro_a' },
  'h54-200-s500-ra': { product_group: 'dxl_pro_a' },
  'm42-10-s260-ra':  { product_group: 'dxl_pro_a' },
  'm54-40-s250-ra':  { product_group: 'dxl_pro_a' },
  'm54-60-s250-ra':  { product_group: 'dxl_pro_a' },
  'pro':             { product_group: 'dxl_pro' },
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
const PRO_DATA  = loadSpecData('dxl_pro_info.yml');
const PROA_DATA = loadSpecData('dxl_proa_info.yml');

// ----- Liquid parser (X 스크립트와 동일) -----
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
  // site.data.xxx[page.ref].field != 'N/A' 패턴
  if ((m = cond.match(/^site\.data\.(\w+)\[page\.ref\]\.(\w+)\s*(==|!=)\s*['"]([^'"]*)['"]$/))) {
    const data = m[1] === 'dxl_pro_info' ? PRO_DATA : (m[1] === 'dxl_proa_info' ? PROA_DATA : null);
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
    const data = m[1] === 'dxl_pro_info' ? PRO_DATA : (m[1] === 'dxl_proa_info' ? PROA_DATA : null);
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

// ----- Kramdown → MDX (X 스크립트와 동일) -----
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

  // ref 정의: [Label]: /img/...  → 본문 [Label] 사용처를 외부 anchor 로 변환
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
    /\[([^\]]+)\]\((\/img\/[^)\s]+\.(?:jpg|jpeg|png|gif|svg|pdf|webp))\)/g,
    (m, label, url) => {
      // 이미지를 라벨로 쓰는 image-as-link `[![](...)](...)` 패턴은 변환하면 깨짐 → 유지
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

// dxl_pro vs dxl_pro_a 에서 분기 결과가 다른 fragment 키 (suffix '_proa' 부여)
// - control_table.md: torque_enable 분기 (562 vs 512)
// - control_table_torque_enable.md: torque_enable / present_position / homing_offset 분기
// - warning.md: target_file 분기 (dxl_pro_info vs dxl_proa_info)
// - control_table_id.md: 동일 (else 가지) → suffix 불필요
// - 기타 _pro / p/_*.md fragment는 product_group 분기 없음
const PROA_BRANCHES = new Set([
  'control_table',
  'control_table_torque_enable',
  'warning',
]);

const PARTIAL_QUEUE = [];
const PARTIAL_DONE = new Set();

/**
 * include path → partial key
 *   en/dxl/control_table.md      → control_table
 *   en/dxl/control_table_id.md   → control_table_id
 *   en/dxl/p/control_table_X.md  → p_control_table_X
 *   en/dxl/specifications_pro.md → specifications_pro
 */
function partialKeyFor(includeSpec) {
  const norm = includeSpec.replace(/^\/+/, '');
  let m = norm.match(/^(?:en|kr)\/dxl\/(.+)\.md$/);
  if (!m) return null;
  let tail = m[1];
  if (tail.startsWith('p/')) return 'p_' + tail.slice(2).replace(/[\/\-]/g, '_');
  return tail.replace(/[\/\-]/g, '_');
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

  const importsMap = new Map();

  function handleInclude(spec) {
    // 사양 표 (specifications_pro / p/specifications_proa / p/specifications_p) 는
    // ref 별 데이터 차이로 partial 공유 불가 → 페이지에 인라인 렌더
    if (/specifications_pro\.md$/.test(spec) ||
        /specifications_proa\.md$/.test(spec) ||
        /specifications_p\.md$/.test(spec)) {
      const inlined = inlineRender(spec, lang, ctx);
      return inlined === null ? `\n{/* include: ${spec} (missing) */}\n` : ('\n' + inlined.trim() + '\n');
    }
    let key = partialKeyFor(spec);
    if (!key) return `\n{/* include: ${spec} */}\n`;
    // product_group 별로 분기 결과가 다른 fragment 는 dxl_pro_a 에서 별도 partial 로 분리
    if (ctx.product_group === 'dxl_pro_a' && PROA_BRANCHES.has(key)) {
      key = key + '_proa';
    }
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
    importLines.push(`import ${varName} from '@site/docs/_partials/dxl/pro/${key}.mdx';`);
  }
  const importsBlock = importLines.length ? importLines.join('\n') + '\n\n' : '';

  return fmStr + importsBlock + rendered.trim() + '\n';
}

/**
 * include 의 raw 내용을 호출 페이지 컨텍스트(ctx)로 렌더한다 (partial 화 없이 인라인).
 * 사양 표처럼 ref 별 데이터가 다른 fragment 에 사용.
 */
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
  // 새 ctx (vars 분리) 로 렌더하되 ref/product_group/lang 은 호출 페이지 것을 사용
  const subCtx = { ref: ctx.ref, product_group: ctx.product_group, lang, vars: {} };
  function nestedInclude(s) { return `\n{/* nested include: ${s} */}\n`; }
  const tokens = tokenize(raw);
  let rendered = render(tokens, subCtx, nestedInclude);
  rendered = kramdownToMdx(rendered);
  return rendered;
}

function convertPartial(spec, lang, refForCtx, productGroupForCtx) {
  const norm = spec.replace(/^\/+/, '');
  // include 의 lang 부분을 호출자 lang으로 교체
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
    ref: refForCtx || 'h42-20-s300-r',
    product_group: productGroupForCtx || 'dxl_pro',
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

// ----- 인덱스 페이지 (pro_h, pro_l, pro_m) -----
function convertIndexPage(srcPath, lang) {
  const raw = readSafe(srcPath);
  if (raw === null) return null;
  const { fm, body } = splitFrontmatter(raw);
  const ctx = {
    ref: fm.ref || 'pro',
    product_group: fm.product_group || 'dxl_pro',
    lang,
    vars: {},
  };
  function handleInclude(spec) { return ''; }
  const tokens = tokenize(body);
  let rendered = render(tokens, ctx, handleInclude);
  rendered = kramdownToMdx(rendered);

  const sidebarTitle = (fm.sidebar && fm.sidebar.title) || fm.title;
  const newFm = {
    // id 는 파일명과 매칭 (URL slug 안정성). ref 는 sidebar_label 등에 영향 X
    id: path.basename(srcPath, '.md'),
    title: sidebarTitle || (fm.ref || 'Pro Series'),
    sidebar_label: sidebarTitle || undefined,
    tags: fm.product_group ? [fm.product_group] : [],
  };
  const fmStr = buildFmYaml(newFm);
  return fmStr + rendered.trim() + '\n';
}

function run() {
  ensureDir(OUT_DOC_EN);
  ensureDir(OUT_DOC_KO);
  ensureDir(OUT_PART_EN);
  ensureDir(OUT_PART_KO);

  // _category_.json
  writeOut(
    path.join(OUT_DOC_EN, '_category_.json'),
    JSON.stringify({ label: 'Pro Series', position: 6, link: { type: 'generated-index' } }, null, 2) + '\n'
  );
  writeOut(
    path.join(OUT_DOC_KO, '_category_.json'),
    JSON.stringify({ label: 'Pro Series', position: 6, link: { type: 'generated-index' } }, null, 2) + '\n'
  );

  const stats = { en: 0, ko: 0, partials_en: 0, partials_ko: 0, errors: [] };

  // 본문 (pro.md 포함, ref 별로 매핑)
  for (const ref of Object.keys(PROFILES)) {
    const filename = ref === 'pro' ? 'pro.md' : `${ref}.md`;
    const enSrc = path.join(SRC('en'), filename);
    const koSrc = path.join(SRC('kr'), filename);
    const outName = ref === 'pro' ? 'index.mdx' : `${ref}.mdx`;
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

  // 인덱스 페이지: pro_h, pro_l, pro_m → dxl/pro_{h,l,m}.mdx (원본 permalink 와 매칭)
  const OUT_DXL_EN = path.join(REPO, 'docusaurus', 'docs', 'dxl');
  const OUT_DXL_KO = path.join(REPO, 'docusaurus', 'i18n', 'ko', 'docusaurus-plugin-content-docs', 'current', 'dxl');
  for (const idx of ['pro_h', 'pro_l', 'pro_m']) {
    const enSrc = path.join(REPO, 'source', 'docs', 'en', 'dxl', `${idx}.md`);
    const koSrc = path.join(REPO, 'source', 'docs', 'kr', 'dxl', `${idx}.md`);
    if (fs.existsSync(enSrc)) {
      try {
        const out = convertIndexPage(enSrc, 'en');
        if (out) { writeOut(path.join(OUT_DXL_EN, `${idx}.mdx`), out); stats.en++; }
      } catch (e) { stats.errors.push(`en/${idx}: ${e.message}`); }
    }
    if (fs.existsSync(koSrc)) {
      try {
        const out = convertIndexPage(koSrc, 'kr');
        if (out) { writeOut(path.join(OUT_DXL_KO, `${idx}.mdx`), out); stats.ko++; }
      } catch (e) { stats.errors.push(`ko/${idx}: ${e.message}`); }
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
