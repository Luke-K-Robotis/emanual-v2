#!/usr/bin/env node
/**
 * Platform / Humanoid (ROBOTIS OP3 / OP2 / OP / Thormang3)
 * 변환 스크립트.
 *
 * 입력:
 *   - source/docs/{en,kr}/platform/op3/*.md         (en 9 페이지, kr introduction 만)
 *   - source/docs/{en,kr}/platform/op2/*.md         (en 2 페이지, kr getting_started 만)
 *   - source/docs/{en,kr}/platform/op/*.md          (en 5 페이지, kr getting_started 만)
 *   - source/docs/{en,kr}/platform/thormang3/*.md   (en 7 페이지, kr introduction 만)
 *   - source/_includes/{en,kr}/platform/op3/*_rev2.md
 *
 * 출력:
 *   - docusaurus/docs/platform/<series>/<ref>.mdx
 *   - docusaurus/i18n/ko/.../current/platform/<series>/<ref>.mdx
 *   - docusaurus/docs/_partials/platform/<series>/<frag>.mdx
 *   - docusaurus/i18n/ko/.../current/_partials/platform/<series>/<frag>.mdx
 *
 * 특이사항:
 *   - OP3 의 9 페이지는 모두 `tabs: "Revision"` + tab_title1 (2025~) / tab_title2 (~2023)
 *     <section data-id="..."> 패턴을 사용한다. 메인 본문 = 2025 revision.
 *     `_rev2` partial = 2023 이전 revision 본문.
 *   - 일부 페이지는 cross-series include 사용:
 *       - {% include en/faq/charging_battery.md %}    (OP3 introduction, OP2 getting_started)
 *       - {% include en/dxl/fcc_class_a.md %}         (OP2 getting_started, OP references)
 *       - {% include en/dxl/p/dxl_p_notice.md %}      (Thormang3 quick_start, ros_packages)
 *     이들은 humanoid 시리즈 partial 디렉터리에 inline 변환본을 한 번 만들어 import.
 *
 * 사용법: node scripts/convert-humanoids.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

// ----- 유틸 -----
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function writeOut(p, c) { ensureDir(path.dirname(p)); fs.writeFileSync(p, c); }
function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

function pascalCaseSegments(s) {
  let r = s.split(/[_\-\/.]+/).filter(Boolean)
    .map(x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()).join('');
  if (/^\d/.test(r)) r = 'P' + r;
  return r;
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

function buildFmYaml(fm) {
  const lines = ['---'];
  if (fm.id) lines.push(`id: ${fm.id}`);
  if (fm.title) lines.push(`title: ${JSON.stringify(fm.title)}`);
  if (fm.sidebar_label) lines.push(`sidebar_label: ${JSON.stringify(fm.sidebar_label)}`);
  if (fm.sidebar_position !== undefined) lines.push(`sidebar_position: ${fm.sidebar_position}`);
  if (fm.tags && fm.tags.length) lines.push(`tags: [${fm.tags.join(', ')}]`);
  lines.push('---');
  return lines.join('\n') + '\n\n';
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

function evalOutput(expr, ctx) {
  const pipes = expr.split('|').map(s => s.trim());
  let base = pipes[0];
  let val;
  let m;
  if ((m = base.match(/^page\.(\w+)$/))) {
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
    // unknown tag — skip
    i++;
  }
  return out;
}

// ----- Kramdown / MDX 변환 -----
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
        if (inner === '') {
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

const KNOWN_HUMANOID_SERIES = ['op3', 'op2', 'op', 'thormang3'];

function makeKramdownToMdx(seriesKey) {
  return function kramdownToMdx(src) {
    src = src.replace(/\{::options[^}]*\/\}/g, '');
    src = src.replace(/^\s*\*\s*\n\s*\{:toc\}\s*$/gm, '');
    src = src.replace(/\{:toc\}/g, '');
    src = src.replace(/\{:\s*\.text-center\}/g, '');
    src = src.replace(/\{:\s*\.blank\}/g, '');
    src = src.replace(/\{:\s*\.popup\}/g, '');
    src = src.replace(/\{:\s*width="[^"]*"\s*\}/g, '');
    src = src.replace(/\{:\s*style="[^"]*"\s*\}/g, '');

    src = src.replace(/<style>[\s\S]*?<\/style>/g, '');
    src = src.replace(/<div\s+style="counter-reset:[^"]*"\s*><\/div>/g, '');

    // Notice (admonitionConvert MUST run before the generic {:...} stripper below).
    src = admonitionConvert(src, /^\s*\{:\s*\.notice--danger\}\s*$/, 'danger');
    src = admonitionConvert(src, /^\s*\{:\s*\.notice--warning\}\s*$/, 'warning');
    src = admonitionConvert(src, /^\s*\{:\s*\.notice--info\}\s*$/, 'info');
    src = admonitionConvert(src, /^\s*\{:\s*\.notice--success\}\s*$/, 'tip');
    src = admonitionConvert(src, /^\s*\{:\s*\.notice\}\s*$/, 'note');

    // catch-all kramdown attribute remover
    src = src.replace(/\{:\s*[^}]*\}/g, '');

    // div notices
    src = src.replace(/<div\s+class="notice--success">([\s\S]*?)<\/div>/g, (_, b) => `\n:::tip\n\n${b.trim()}\n\n:::\n`);
    src = src.replace(/<div\s+class="notice--warning">([\s\S]*?)<\/div>/g, (_, b) => `\n:::warning\n\n${b.trim()}\n\n:::\n`);
    src = src.replace(/<div\s+class="notice--info">([\s\S]*?)<\/div>/g, (_, b) => `\n:::info\n\n${b.trim()}\n\n:::\n`);
    src = src.replace(/<div\s+class="notice--danger">([\s\S]*?)<\/div>/g, (_, b) => `\n:::danger\n\n${b.trim()}\n\n:::\n`);
    src = src.replace(/<div\s+class="notice">([\s\S]*?)<\/div>/g, (_, b) => `\n:::note\n\n${b.trim()}\n\n:::\n`);

    // 이미지 경로
    src = src.replace(/\/assets\/images\/platform\//g, '/img/platform/');
    src = src.replace(/\/assets\/images\//g, '/img/');
    // 기타 /assets/docs/... → 외부 URL
    src = src.replace(
      /\]\(\/assets\/([^)\s]+)\)/g,
      (_, p) => `](https://emanual.robotis.com/assets/${p})`
    );
    src = src.replace(
      /^(\[[^\]]+\]):\s*\/assets\/(\S+)$/gm,
      (_, label, p) => `${label}: https://emanual.robotis.com/assets/${p}`
    );

    // Series ref slug normalization (hyphen → underscore where matching)
    function normalizeSlug(p, knownRefs) {
      const segs = p.split('/');
      const candidate = segs[0].replace(/-/g, '_');
      if (knownRefs && knownRefs.has(candidate)) {
        segs[0] = candidate;
      }
      return segs.join('/');
    }

    const SERIES_REFS = {
      op3: new Set(['introduction','quick_start','getting_started','robotis_ros_packages','tutorials','advanced_tutorials','simulation','hardware','recovery']),
      op2: new Set(['getting_started','ros_packages']),
      op: new Set(['getting_started','development','simulation','maintenance','references']),
      thormang3: new Set(['introduction','quick_start','getting_started','thormang3_ros_packages','thormang3_operation','gazebo_simulation','references']),
    };

    // 자체 시리즈 내부 링크 유지
    const seriesRefs = SERIES_REFS[seriesKey] || new Set();
    function rewriteSeriesLink(p, hash, knownRefs) {
      const norm = normalizeSlug(p, knownRefs);
      const firstSeg = norm.split('/')[0];
      if (knownRefs.has(firstSeg)) {
        return `/docs/platform/${seriesKey}/${norm}${hash || ''}`;
      }
      return null;
    }
    const internalSeriesPathRe = new RegExp(
      `\\]\\(\\/docs\\/(en|kr)\\/platform\\/${seriesKey}\\/([^)#\\s]+?)\\/?(#[^)\\s]*)?\\)`,
      'g'
    );
    src = src.replace(internalSeriesPathRe, (m, lang, p, hash) => {
      const r = rewriteSeriesLink(p, hash, seriesRefs);
      if (r) return `](${r})`;
      return `](https://emanual.robotis.com/docs/${lang}/platform/${seriesKey}/${p}/${hash || ''})`;
    });

    const internalSeriesRefRe = new RegExp(
      `^(\\[[^\\]]+\\]):\\s*\\/docs\\/(en|kr)\\/platform\\/${seriesKey}\\/([^\\s#]+?)\\/?(#[^\\s]*)?\\s*$`,
      'gm'
    );
    src = src.replace(internalSeriesRefRe, (m, label, lang, p, hash) => {
      const r = rewriteSeriesLink(p, hash, seriesRefs);
      if (r) return `${label}: ${r}`;
      return `${label}: https://emanual.robotis.com/docs/${lang}/platform/${seriesKey}/${p}/${hash || ''}`;
    });

    // 다른 humanoid 시리즈 간 링크 유지
    for (const s of KNOWN_HUMANOID_SERIES) {
      if (s === seriesKey) continue;
      const otherRefs = SERIES_REFS[s] || new Set();
      const re1 = new RegExp(`\\]\\(\\/docs\\/(en|kr)\\/platform\\/${s}\\/([^)#\\s]+?)\\/?(#[^)\\s]*)?\\)`, 'g');
      src = src.replace(re1, (m, lang, p, hash) => {
        const norm = normalizeSlug(p, otherRefs);
        const firstSeg = norm.split('/')[0];
        if (otherRefs.has(firstSeg)) return `](/docs/platform/${s}/${norm}${hash || ''})`;
        return `](https://emanual.robotis.com/docs/${lang}/platform/${s}/${p}/${hash || ''})`;
      });
      const re2 = new RegExp(`^(\\[[^\\]]+\\]):\\s*\\/docs\\/(en|kr)\\/platform\\/${s}\\/([^\\s#]+?)\\/?(#[^\\s]*)?\\s*$`, 'gm');
      src = src.replace(re2, (m, label, lang, p, hash) => {
        const norm = normalizeSlug(p, otherRefs);
        const firstSeg = norm.split('/')[0];
        if (otherRefs.has(firstSeg)) return `${label}: /docs/platform/${s}/${norm}${hash || ''}`;
        return `${label}: https://emanual.robotis.com/docs/${lang}/platform/${s}/${p}/${hash || ''}`;
      });
    }

    // 다른 변환 안 된 영역 → 외부 URL 강등
    const seriesGroup = KNOWN_HUMANOID_SERIES.join('|');
    const downgradeRe1 = new RegExp(
      `\\]\\(\\/docs\\/(en|kr)\\/(?!platform\\/(?:${seriesGroup})\\/)([^)#\\s]+)(#[^)\\s]*)?\\)`,
      'g'
    );
    src = src.replace(downgradeRe1, (_, lang, p, hash) => `](https://emanual.robotis.com/docs/${lang}/${p}${hash || ''})`);
    const downgradeRe2 = new RegExp(
      `^(\\[[^\\]]+\\]):\\s*\\/docs\\/(en|kr)\\/(?!platform\\/(?:${seriesGroup})\\/)([^\\s#]+)(#[^\\s]*)?\\s*$`,
      'gm'
    );
    src = src.replace(downgradeRe2, (_, label, lang, p, hash) => `${label}: https://emanual.robotis.com/docs/${lang}/${p}${hash || ''}`);

    // 누락된 /docs/ 접두사 또는 /doc/ 오타 처리:
    //   /en/platform/op/development/         → /docs/platform/op/development (현 시리즈 내부) 또는 외부 URL
    //   en/platform/op/getting_started/      → 외부 URL (앞에 슬래시 없음 → 절대 경로 아님)
    //   /en/dxl/mx/mx-28/                    → 외부 URL
    //   /doc/en/popup/...                    → 외부 URL
    function rewriteSlashlessOrTypoLink(lang, p, hash) {
      // 자체 시리즈 매치?
      const series = KNOWN_HUMANOID_SERIES.find(s => p.startsWith(`platform/${s}/`) || p === `platform/${s}`);
      if (series) {
        const tail = p.replace(new RegExp(`^platform\\/${series}\\/?`), '');
        const refs = SERIES_REFS[series] || new Set();
        if (tail === '' || refs.has(tail.split('/')[0].replace(/-/g, '_'))) {
          const norm = normalizeSlug(tail, refs);
          return `/docs/platform/${series}${norm ? '/' + norm : ''}${hash || ''}`;
        }
      }
      return `https://emanual.robotis.com/docs/${lang}/${p.replace(/\/$/, '')}${hash || ''}`;
    }

    // inline 링크: ](/en/...) or ](/kr/...)  (without /docs)
    src = src.replace(
      /\]\(\/(en|kr)\/([^)#\s]+?)\/?(#[^)\s]*)?\)/g,
      (_, lang, p, hash) => `](${rewriteSlashlessOrTypoLink(lang, p, hash)})`
    );
    // reference defs: [foo]: /en/...
    src = src.replace(
      /^(\[[^\]]+\]):\s*\/(en|kr)\/([^\s#]+?)\/?(#[^\s]*)?\s*$/gm,
      (_, label, lang, p, hash) => `${label}: ${rewriteSlashlessOrTypoLink(lang, p, hash)}`
    );

    // /doc/en/... or /doc/kr/...  (typo for /docs/)
    src = src.replace(
      /\]\(\/doc\/(en|kr)\/([^)#\s]+?)(#[^)\s]*)?\)/g,
      (_, lang, p, hash) => `](https://emanual.robotis.com/docs/${lang}/${p.replace(/\/$/, '')}${hash || ''})`
    );
    src = src.replace(
      /^(\[[^\]]+\]):\s*\/doc\/(en|kr)\/([^\s#]+?)(#[^\s]*)?\s*$/gm,
      (_, label, lang, p, hash) => `${label}: https://emanual.robotis.com/docs/${lang}/${p.replace(/\/$/, '')}${hash || ''}`
    );

    // 상대 (선두 / 없음) en/platform/.../...  -> 외부 URL
    src = src.replace(
      /^(\[[^\]]+\]):\s*(en|kr)\/([^\s#]+?)\/?(#[^\s]*)?\s*$/gm,
      (_, label, lang, p, hash) => `${label}: https://emanual.robotis.com/docs/${lang}/${p}${hash || ''}`
    );
    src = src.replace(
      /\]\((en|kr)\/([^)#\s]+?)\/?(#[^)\s]*)?\)/g,
      (_, lang, p, hash) => `](https://emanual.robotis.com/docs/${lang}/${p}${hash || ''})`
    );

    // 정적 자산 reference 정의 → inline anchor
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
      /\[([^\]\[]+)\]\((\/img\/[^)\s]+\.(?:jpg|jpeg|png|gif|svg|pdf|webp))\)/g,
      (m, label, url) => `<a href="${url}" target="_blank">${label}</a>`
    );

    // typo: `[Foo](slug)` (bare anchor without `#`) → `[Foo](#slug)`
    src = src.replace(
      /\]\(([a-z][a-z0-9-]+)\]?\)/g,
      (m, anchor) => {
        if (/[\/\.:]/.test(anchor)) return m;
        return `](#${anchor})`;
      }
    );

    // HTML comments 제거
    src = src.replace(/<!--[\s\S]*?-->/g, '');

    // <br>, <hr>, <img> self-closing
    src = src.replace(/<br\s*>/g, '<br />');
    src = src.replace(/<hr\s*>/g, '<hr />');
    src = src.replace(/<img([^>]*[^\/])>/g, '<img$1 />');

    // <sup>*</sup> escape
    src = src.replace(/<sup>([^<]*)<\/sup>/g, (m, inner) => {
      const escaped = inner.replace(/\*/g, '&#42;');
      return `<sup>${escaped}</sup>`;
    });
    src = src.replace(/<sub>([^<]*)<\/sub>/g, (m, inner) => {
      const escaped = inner.replace(/\*/g, '&#42;');
      return `<sub>${escaped}</sub>`;
    });

    // strip JSX-incompatible style attrs on common tags
    src = src.replace(/(<(?:img|a|span|div|p|td|tr|tbody|table|li|ul|ol|h\d|hr|br|iframe)[^>]*?)\s+style="[^"]*"([^>]*>)/gi, '$1$2');

    // Escape stray angle brackets that are not valid JSX/HTML tags
    {
      const lines = src.split('\n');
      let inFence = false;
      for (let li = 0; li < lines.length; li++) {
        if (/^```/.test(lines[li])) { inFence = !inFence; continue; }
        if (inFence) continue;
        // <**...**> → &lt;**...**&gt;
        lines[li] = lines[li].replace(/<(\*\*[^<>]+\*\*)>/g, '&lt;$1&gt;');
        // std::vector<JointData>* → std::vector&lt;JointData&gt;*
        lines[li] = lines[li].replace(
          /([A-Za-z_][\w:]*)<([A-Z][A-Za-z0-9_]*)>/g,
          '$1&lt;$2&gt;'
        );
      }
      src = lines.join('\n');
    }

    // MDX brace escaping
    src = escapeMdxBraces(src);

    // 헤딩 anchor 정리
    src = src.replace(
      /^(#{1,6})((?:\s*<a name="[^"]+"><\/a>)+)(.*)$/gm,
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

    return src;
  };
}

// ----- Cross-series shared partials (inline helpers) -----
// These were originally in source/_includes outside the humanoid series.
// We materialize them as series-local partials to keep imports simple.
const SHARED_PARTIALS = {
  // {% include en/faq/charging_battery.md %}
  'charging_battery': {
    en: `The following video provides instructions on how to charge a battery using the LBC-010.

<iframe width="560" height="315" src="https://www.youtube.com/embed/V1l9lB1ny_4?start=58" frameborder="0" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
`,
    kr: `The following video provides instructions on how to charge a battery using the LBC-010.

<iframe width="560" height="315" src="https://www.youtube.com/embed/V1l9lB1ny_4?start=58" frameborder="0" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
`,
  },
  // {% include en/dxl/fcc_class_a.md %}
  'fcc_class_a': {
    en: `:::note

**Note**: This equipment has been tested and found to comply with the limits for a Class A digital device, pursuant to part 15 of the FCC Rules. These limits are designed to provide reasonable protection against harmful interference when the equipment is operated in a commercial environment. This equipment generates, uses, and can radiate radio frequency energy and, if not installed and used in accordance with the instruction manual, may cause harmful interference to radio communications. Operation of this equipment in a residential area is likely to cause harmful interference in which case the user will be required to correct the interference at his own expense.

:::

:::warning

**WARNING**
Any changes or modifications not expressly approved by the manufacturer could void the user's authority to operate the equipment.

:::
`,
    kr: `:::note

**Note**: This equipment has been tested and found to comply with the limits for a Class A digital device, pursuant to part 15 of the FCC Rules. These limits are designed to provide reasonable protection against harmful interference when the equipment is operated in a commercial environment. This equipment generates, uses, and can radiate radio frequency energy and, if not installed and used in accordance with the instruction manual, may cause harmful interference to radio communications. Operation of this equipment in a residential area is likely to cause harmful interference in which case the user will be required to correct the interference at his own expense.

:::

:::warning

**WARNING**
Any changes or modifications not expressly approved by the manufacturer could void the user's authority to operate the equipment.

:::
`,
  },
  // {% include en/dxl/p/dxl_p_notice.md %}
  'dxl_p_notice': {
    en: `:::note

**NOTE**: DYNAMIXEL PRO+ is renamed as DYNAMIXEL-P.
- Revised Date: Jan 2th, 2020.
- Revised Model Name: See the following table.

  | Previous        | New             |
  |:----------------|:----------------|
  | H54P-200-S500-R | PH54-200-S500-R |
  | H54P-100-S500-R | PH54-100-S500-R |
  | H42P-020-S300-R | PH42-020-S300-R |
  | M54P-060-S250-R | PM54-060-S250-R |
  | M54P-040-S250-R | PM54-040-S250-R |
  | M42P-010-S260-R | PM42-010-S260-R |

:::
`,
    kr: `:::note

**NOTE**: DYNAMIXEL PRO+ is renamed as DYNAMIXEL-P.
- Revised Date: Jan 2th, 2020.
- Revised Model Name: See the following table.

  | Previous        | New             |
  |:----------------|:----------------|
  | H54P-200-S500-R | PH54-200-S500-R |
  | H54P-100-S500-R | PH54-100-S500-R |
  | H42P-020-S300-R | PH42-020-S300-R |
  | M54P-060-S250-R | PM54-060-S250-R |
  | M54P-040-S250-R | PM54-040-S250-R |
  | M42P-010-S260-R | PM42-010-S260-R |

:::
`,
  },
};

// Map cross-series include path to a (key, optional content provider).
function classifyCrossSeriesInclude(spec) {
  const norm = spec.replace(/^\/+/, '');
  // en/faq/charging_battery.md  | kr/faq/charging_battery.md
  if (/^(en|kr)\/faq\/charging_battery\.md$/.test(norm)) {
    return { key: 'charging_battery' };
  }
  if (/^(en|kr)\/dxl\/fcc_class_a\.md$/.test(norm)) {
    return { key: 'fcc_class_a' };
  }
  if (/^(en|kr)\/dxl\/p\/dxl_p_notice\.md$/.test(norm)) {
    return { key: 'dxl_p_notice' };
  }
  return null;
}

// ----- 페이지 변환 -----
function convertPageFromRaw(raw, ref, lang, pageTitle, pagePosition, seriesKey, productGroup) {
  const { fm, body } = splitFrontmatter(raw);
  const ctx = {
    ref: fm.ref || ref,
    product_group: fm.product_group || productGroup,
    lang,
    tab_title1: fm.tab_title1 || '',
    tab_title2: fm.tab_title2 || '',
    tab_title3: fm.tab_title3 || '',
    tab_title4: fm.tab_title4 || '',
    tab_title5: fm.tab_title5 || '',
    tab_title6: fm.tab_title6 || '',
    vars: {},
  };

  const tabTitles = {};
  for (let i = 1; i <= 6; i++) {
    if (fm[`tab_title${i}`]) tabTitles[i] = fm[`tab_title${i}`];
  }

  const importsMap = new Map();

  function partialKeyForLocal(includeSpec) {
    const norm = includeSpec.replace(/^\/+/, '');
    const m = norm.match(new RegExp(`^(?:en|kr)\\/platform\\/${seriesKey}\\/(.+)\\.md$`));
    if (!m) return null;
    return m[1].replace(/[\/\-]/g, '_');
  }

  function handleInclude(spec) {
    // 1) 시리즈 내부 partial
    const localKey = partialKeyForLocal(spec);
    if (localKey) {
      const varName = pascalCaseSegments(localKey);
      importsMap.set(localKey, varName);
      PARTIAL_QUEUE.push({ key: localKey, spec, lang, seriesKey, kind: 'local' });
      return `\n<${varName} />\n`;
    }
    // 2) cross-series shared (FCC / charging_battery / dxl_p_notice)
    const cross = classifyCrossSeriesInclude(spec);
    if (cross && SHARED_PARTIALS[cross.key]) {
      const varName = pascalCaseSegments(cross.key);
      importsMap.set(cross.key, varName);
      PARTIAL_QUEUE.push({ key: cross.key, spec, lang, seriesKey, kind: 'shared' });
      return `\n<${varName} />\n`;
    }
    // 3) unknown — leave a TODO comment
    return `\n{/* TODO unhandled include: ${spec} */}\n`;
  }

  const tokens = tokenize(body);
  let rendered = render(tokens, ctx, handleInclude);

  // <section data-id="..."> → <Tabs>/<TabItem>
  const sectionLiteralRe = /<section\s+data-id=(?:"|')([^"']+)(?:"|')[^>]*>\s*([\s\S]*?)\s*<\/section>/g;
  const matches = [];
  let mm;
  while ((mm = sectionLiteralRe.exec(rendered)) !== null) {
    matches.push({ start: mm.index, end: mm.index + mm[0].length, label: mm[1], inner: mm[2] });
  }
  let hasTabs = false;
  if (matches.length > 0) {
    const groups = [];
    let cur = [matches[0]];
    for (let i = 1; i < matches.length; i++) {
      const prev = matches[i - 1];
      const sep = rendered.slice(prev.end, matches[i].start);
      if (/^\s*$/.test(sep)) cur.push(matches[i]);
      else { groups.push(cur); cur = [matches[i]]; }
    }
    groups.push(cur);

    let result = '';
    let cursor = 0;
    for (const g of groups) {
      result += rendered.slice(cursor, g[0].start);
      hasTabs = true;
      const merged = new Map();
      for (const sec of g) {
        let label = sec.label.trim();
        const m2 = label.match(/page\.tab_title(\d+)/);
        if (m2) label = tabTitles[parseInt(m2[1], 10)] || `Tab${m2[1]}`;
        const value = label.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'tab';
        if (!merged.has(value)) merged.set(value, { label, parts: [] });
        merged.get(value).parts.push(sec.inner.trim());
      }
      let tabs = `\n<Tabs groupId="op3-revision" queryString>\n`;
      for (const [value, item] of merged) {
        tabs += `<TabItem value="${value}" label="${item.label}">\n\n${item.parts.join('\n\n')}\n\n</TabItem>\n`;
      }
      tabs += `</Tabs>\n`;
      result += tabs;
      cursor = g[g.length - 1].end;
    }
    result += rendered.slice(cursor);
    rendered = result;
  }

  // Kramdown → MDX
  const kramdownToMdx = makeKramdownToMdx(seriesKey);
  rendered = kramdownToMdx(rendered);

  // Frontmatter
  const titleFromFm = pageTitle || fm.title || (fm.sidebar && fm.sidebar.title);
  const newFm = {
    id: ref,
    title: titleFromFm || ref,
    sidebar_label: undefined,
    sidebar_position: pagePosition !== undefined ? pagePosition : (fm.page_number ? parseInt(fm.page_number, 10) : undefined),
    tags: [productGroup],
  };
  if (Number.isNaN(newFm.sidebar_position)) newFm.sidebar_position = undefined;

  const fmStr = buildFmYaml(newFm);

  const importLines = [];
  if (hasTabs) {
    importLines.push("import Tabs from '@theme/Tabs';");
    importLines.push("import TabItem from '@theme/TabItem';");
  }
  for (const [key, varName] of importsMap) {
    importLines.push(`import ${varName} from '@site/docs/_partials/platform/${seriesKey}/${key}.mdx';`);
  }
  const importsBlock = importLines.length ? importLines.join('\n') + '\n\n' : '';

  return fmStr + importsBlock + rendered.trim() + '\n';
}

// ----- Partial 처리 -----
const PARTIAL_QUEUE = [];
const PARTIAL_DONE = new Set();

function convertPartial(spec, lang, seriesKey, kind) {
  if (kind === 'shared') {
    const cross = classifyCrossSeriesInclude(spec);
    if (cross && SHARED_PARTIALS[cross.key]) {
      const content = SHARED_PARTIALS[cross.key][lang] || SHARED_PARTIALS[cross.key].en;
      return content;
    }
    return null;
  }
  // local partial
  const norm = spec.replace(/^\/+/, '');
  const localized = norm.replace(/^(en|kr)\//, lang + '/');
  let full = path.join(REPO, 'source', '_includes', localized);
  let raw = readSafe(full);
  if (raw === null) {
    if (lang === 'kr') {
      const fallback = path.join(REPO, 'source', '_includes', norm.replace(/^kr\//, 'en/'));
      raw = readSafe(fallback);
    }
    if (raw === null) return null;
  }
  const ctx = {
    ref: seriesKey,
    product_group: seriesKey,
    lang,
    vars: {},
  };
  const nestedImports = new Map();
  function nestedInclude(s) {
    const sNorm = s.replace(/^\/+/, '');
    const m = sNorm.match(new RegExp(`^(?:en|kr)\\/platform\\/${seriesKey}\\/(.+)\\.md$`));
    if (m) {
      const key = m[1].replace(/[\/\-]/g, '_');
      const varName = pascalCaseSegments(key);
      nestedImports.set(key, varName);
      PARTIAL_QUEUE.push({ key, spec: s, lang, seriesKey, kind: 'local' });
      return `\n<${varName} />\n`;
    }
    const cross = classifyCrossSeriesInclude(s);
    if (cross && SHARED_PARTIALS[cross.key]) {
      const varName = pascalCaseSegments(cross.key);
      nestedImports.set(cross.key, varName);
      PARTIAL_QUEUE.push({ key: cross.key, spec: s, lang, seriesKey, kind: 'shared' });
      return `\n<${varName} />\n`;
    }
    return `\n{/* nested include: ${s} */}\n`;
  }
  const tokens = tokenize(raw);
  let rendered = render(tokens, ctx, nestedInclude);
  const kramdownToMdx = makeKramdownToMdx(seriesKey);
  rendered = kramdownToMdx(rendered);
  let importsBlock = '';
  if (nestedImports.size > 0) {
    const importLines = [];
    for (const [key, varName] of nestedImports) {
      importLines.push(`import ${varName} from '@site/docs/_partials/platform/${seriesKey}/${key}.mdx';`);
    }
    importsBlock = importLines.join('\n') + '\n\n';
  }
  return importsBlock + rendered.trim() + '\n';
}

// ----- 시리즈 정의 -----
const SERIES = {
  op3: {
    label: 'ROBOTIS OP3',
    productGroup: 'op3',
    sourceDir: 'op3',
    categoryPosition: 8,
    pages: [
      { src: 'introduction.md',          ref: 'introduction',          title: 'Introduction',          position: 1 },
      { src: 'quick_start.md',           ref: 'quick_start',           title: 'Quick Start',           position: 2 },
      { src: 'getting_started.md',       ref: 'getting_started',       title: 'Getting Started',       position: 3 },
      { src: 'robotis_ros_packages.md',  ref: 'robotis_ros_packages',  title: 'ROBOTIS ROS Packages',  position: 4 },
      { src: 'tutorials.md',             ref: 'tutorials',             title: 'Tutorials',             position: 5 },
      { src: 'advanced_tutorials.md',    ref: 'advanced_tutorials',    title: 'Advanced Tutorials',    position: 6 },
      { src: 'simulation.md',            ref: 'simulation',            title: 'Simulation',            position: 7 },
      { src: 'hardware.md',              ref: 'hardware',              title: 'Hardware',              position: 8 },
      { src: 'recovery.md',              ref: 'recovery',              title: 'Recovery',              position: 9 },
    ],
    koOverrides: {
      'introduction': 'introduction.md',
    },
  },
  op2: {
    label: 'ROBOTIS OP2',
    productGroup: 'op2',
    sourceDir: 'op2',
    categoryPosition: 9,
    pages: [
      { src: 'getting_started.md', ref: 'getting_started', title: 'Getting Started',         position: 1 },
      { src: 'ros_packages.md',    ref: 'ros_packages',    title: 'ROBOTIS-OP2 ROS Packages', position: 2 },
    ],
    koOverrides: {
      'getting_started': 'getting_started.md',
    },
  },
  op: {
    label: 'ROBOTIS OP',
    productGroup: 'op',
    sourceDir: 'op',
    categoryPosition: 10,
    pages: [
      { src: 'getting_started.md', ref: 'getting_started', title: 'Introduction',  position: 1 },
      { src: 'development.md',     ref: 'development',     title: 'Development',   position: 2 },
      { src: 'simulation.md',      ref: 'simulation',      title: 'Simulation',    position: 3 },
      { src: 'maintenance.md',     ref: 'maintenance',     title: 'Maintenance',   position: 4 },
      { src: 'references.md',      ref: 'references',      title: 'References',    position: 5 },
    ],
    koOverrides: {
      'getting_started': 'getting_started.md',
    },
  },
  thormang3: {
    label: 'ROBOTIS THORMANG3',
    productGroup: 'thormang3',
    sourceDir: 'thormang3',
    categoryPosition: 11,
    pages: [
      { src: 'Introduction.md',           ref: 'introduction',           title: 'Introduction',           position: 1 },
      { src: 'quick_start.md',            ref: 'quick_start',            title: 'Quick Start',            position: 2 },
      { src: 'getting_started.md',        ref: 'getting_started',        title: 'Getting Started',        position: 3 },
      { src: 'thormang3_ros_packages.md', ref: 'thormang3_ros_packages', title: 'THORMANG3 ROS Packages', position: 4 },
      { src: 'thormang3_operation.md',    ref: 'thormang3_operation',    title: 'THORMANG3 Operation',    position: 5 },
      { src: 'gazebo_simulation.md',      ref: 'gazebo_simulation',      title: 'Gazebo Simulation',      position: 6 },
      { src: 'references.md',             ref: 'references',             title: 'References',             position: 7 },
    ],
    koOverrides: {
      'introduction': 'introduction.md',
    },
  },
};

// ----- 실행 -----
function runSeries(seriesKey, stats) {
  const series = SERIES[seriesKey];
  const SRC_EN_ROOT = path.join(REPO, 'source', 'docs', 'en', 'platform', series.sourceDir);
  const SRC_KR_ROOT = path.join(REPO, 'source', 'docs', 'kr', 'platform', series.sourceDir);
  const OUT_DOC_EN = path.join(REPO, 'docusaurus', 'docs', 'platform', seriesKey);
  const OUT_DOC_KO = path.join(REPO, 'docusaurus', 'i18n', 'ko', 'docusaurus-plugin-content-docs', 'current', 'platform', seriesKey);
  const OUT_PART_EN = path.join(REPO, 'docusaurus', 'docs', '_partials', 'platform', seriesKey);
  const OUT_PART_KO = path.join(REPO, 'docusaurus', 'i18n', 'ko', 'docusaurus-plugin-content-docs', 'current', '_partials', 'platform', seriesKey);

  ensureDir(OUT_DOC_EN);
  ensureDir(OUT_DOC_KO);
  ensureDir(OUT_PART_EN);
  ensureDir(OUT_PART_KO);

  // _category_.json
  writeOut(
    path.join(OUT_DOC_EN, '_category_.json'),
    JSON.stringify({ label: series.label, position: series.categoryPosition, link: { type: 'generated-index' } }, null, 2) + '\n'
  );
  writeOut(
    path.join(OUT_DOC_KO, '_category_.json'),
    JSON.stringify({ label: series.label, position: series.categoryPosition, link: { type: 'generated-index' } }, null, 2) + '\n'
  );

  for (const page of series.pages) {
    const enSrc = path.join(SRC_EN_ROOT, page.src);
    const enRaw = readSafe(enSrc);
    if (enRaw !== null) {
      try {
        const out = convertPageFromRaw(enRaw, page.ref, 'en', page.title, page.position, seriesKey, series.productGroup);
        writeOut(path.join(OUT_DOC_EN, `${page.ref}.mdx`), out);
        stats.en++;
      } catch (e) { stats.errors.push(`${seriesKey}/en/${page.ref}: ${e.message}`); }
    } else {
      stats.errors.push(`${seriesKey}/en/${page.ref}: source missing (${enSrc})`);
    }

    let koRaw = null;
    const koOverride = series.koOverrides[page.ref];
    if (koOverride) {
      koRaw = readSafe(path.join(SRC_KR_ROOT, koOverride));
    }
    if (koRaw === null && enRaw !== null) {
      koRaw = enRaw;
    }
    if (koRaw !== null) {
      try {
        let out = convertPageFromRaw(koRaw, page.ref, 'kr', page.title, page.position, seriesKey, series.productGroup);
        if (!koOverride) {
          const match = out.match(/^(---\n[\s\S]*?\n---\n\n(?:import [^\n]+\n)*\n?)/);
          if (match) {
            const head = match[1];
            const rest = out.slice(head.length);
            out = head + ':::info\n\n한국어 번역은 준비 중입니다. 영문 콘텐츠를 그대로 표시합니다.\n\n:::\n\n' + rest;
          } else {
            out = out.replace(/^---\n([\s\S]*?)\n---\n\n/, (m) => {
              return m + ':::info\n\n한국어 번역은 준비 중입니다. 영문 콘텐츠를 그대로 표시합니다.\n\n:::\n\n';
            });
          }
        }
        writeOut(path.join(OUT_DOC_KO, `${page.ref}.mdx`), out);
        stats.ko++;
      } catch (e) { stats.errors.push(`${seriesKey}/ko/${page.ref}: ${e.message}`); }
    }
  }

  // partial flush
  while (PARTIAL_QUEUE.length > 0) {
    const q = PARTIAL_QUEUE.shift();
    const sig = `${q.lang}|${q.seriesKey}|${q.key}`;
    if (PARTIAL_DONE.has(sig)) continue;
    PARTIAL_DONE.add(sig);
    try {
      const content = convertPartial(q.spec, q.lang, q.seriesKey, q.kind);
      const dir = q.lang === 'en'
        ? path.join(REPO, 'docusaurus', 'docs', '_partials', 'platform', q.seriesKey)
        : path.join(REPO, 'docusaurus', 'i18n', 'ko', 'docusaurus-plugin-content-docs', 'current', '_partials', 'platform', q.seriesKey);
      if (content === null) {
        stats.errors.push(`partial ${q.lang}/${q.seriesKey}/${q.key}: source missing`);
        const stub = `{/* TODO: missing source for ${q.spec} */}\n`;
        writeOut(path.join(dir, `${q.key}.mdx`), stub);
        if (q.lang === 'en') stats.partials_en++; else stats.partials_ko++;
        continue;
      }
      writeOut(path.join(dir, `${q.key}.mdx`), content);
      if (q.lang === 'en') stats.partials_en++; else stats.partials_ko++;
    } catch (e) { stats.errors.push(`partial ${q.lang}/${q.seriesKey}/${q.key}: ${e.message}`); }
  }
}

function run() {
  const stats = { en: 0, ko: 0, partials_en: 0, partials_ko: 0, errors: [] };

  for (const seriesKey of ['op3', 'op2', 'op', 'thormang3']) {
    runSeries(seriesKey, stats);
  }

  console.log('Done.', JSON.stringify(stats, null, 2));
  if (stats.errors.length > 0) {
    console.log('\nErrors:');
    stats.errors.forEach(e => console.log('  -', e));
  }
}

run();
