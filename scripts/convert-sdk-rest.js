#!/usr/bin/env node
/**
 * DYNAMIXEL SDK 나머지 페이지 (sample_code 외) 변환 스크립트.
 *
 * 변환 대상:
 *   1. api_reference (42 페이지) — c, cpp, csharp, java, labview, matlab, python (각 6 = porthandler / packethandler / groupbulkread / groupbulkwrite / groupsyncread / groupsyncwrite)
 *   2. library_setup (7 페이지) — c, cpp, csharp, java, labview, matlab, python
 *      각 페이지는 Linux/Windows/Mac 탭 구조 (`{% include %}` 로 파셜 evaluate)
 *   3. tutorial (6 leaf + 3 인덱스) — basic/bulk/sync read_write
 *   4. dynamixel_sdk 직속 페이지 — overview / quick_start_guide / quick_start_video / download / device_setup / faq / library_setup.md / *_tutorial.md (인덱스)
 *   5. dynamixel_sdk 루트 인덱스 (index.mdx)
 *
 * 출력:
 *   docusaurus/docs/software/dynamixel/dynamixel_sdk/<...>.mdx (en)
 *   docusaurus/i18n/ko/docusaurus-plugin-content-docs/current/software/dynamixel/dynamixel_sdk/<...>.mdx (ko mirror)
 *   _category_.json (en/ko) — api_reference / library_setup / tutorial 등 디렉터리에
 *   docusaurus/static/img/software/dynamixel/dynamixel_sdk/... 자산 복사
 *
 *   kr 원본은 overview.md만 존재 (다른 페이지는 모두 en만) → 모든 ko 페이지는 en mirror + 한국어 번역 준비 중 안내
 *
 * 사용법: node scripts/convert-sdk-rest.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SRC_EN = path.join(REPO, 'source/docs/en/software/dynamixel/dynamixel_sdk');
const SRC_KR = path.join(REPO, 'source/docs/kr/software/dynamixel/dynamixel_sdk');
const SRC_INCLUDES = path.join(REPO, 'source/_includes');
const OUT_EN = path.join(REPO, 'docusaurus/docs/software/dynamixel/dynamixel_sdk');
const OUT_KO = path.join(
  REPO,
  'docusaurus/i18n/ko/docusaurus-plugin-content-docs/current/software/dynamixel/dynamixel_sdk',
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
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

// ------------------------------------------------------------
// 언어별 메타
// ------------------------------------------------------------
const LANGUAGES = {
  c: { label: 'C', koLabel: 'C', position: 1 },
  cpp: { label: 'C++', koLabel: 'C++', position: 2 },
  python: { label: 'Python', koLabel: 'Python', position: 3 },
  java: { label: 'Java', koLabel: 'Java', position: 4 },
  csharp: { label: 'C#', koLabel: 'C#', position: 5 },
  matlab: { label: 'MATLAB', koLabel: 'MATLAB', position: 6 },
  labview: { label: 'LabVIEW', koLabel: 'LabVIEW', position: 7 },
};

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
  labview: 'text',
  bash: 'bash',
  shell: 'bash',
  sh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
};

// ------------------------------------------------------------
// Frontmatter
// ------------------------------------------------------------
function splitFrontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
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
  if (fm.tags && fm.tags.length) lines.push(`tags: [${fm.tags.join(', ')}]`);
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

// ------------------------------------------------------------
// 공통 본문 변환 (kramdown / scaffolding 헤딩 / 자기 self-link / fence / 이미지 / 링크 / MDX escape)
// ------------------------------------------------------------
function convertBody(body, ctx) {
  // 0) 미해결 include 가 남아있으면 평가 시도
  body = body.replace(/\{%\s*include\s+([^\s%]+)\s*%\}/g, (_, p) => {
    const inc = resolveInclude(p);
    return inc === null ? `<!-- unresolved include: ${p} -->` : inc;
  });

  // 0b) Liquid capture / markdownify → admonition
  body = transformLiquidCapture(body);

  // 1) 제거할 jekyll 잔여물
  body = body.replace(/<style>[\s\S]*?<\/style>/g, '');
  body = body.replace(/<div\s+style="counter-reset:[^"]*"\s*><\/div>/g, '');
  body = body.replace(/<!--\[dummy[\s\S]*?<!\[end[^>]*-->/g, '');
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  body = body.replace(/^\s*\{::options[^}]*\}\s*$/gm, '');
  body = body.replace(/^\s*\{:toc\}\s*$/gm, '');

  // 1b) main-header 블록 제거 (제목은 frontmatter 의 title이 담당)
  body = body.replace(/<div\s+class="main-header"\s*>[\s\S]*?<\/div>/g, '');

  // 1c) <br> 간결화 — MDX는 self-closing `<br/>` 만 허용. 연속 다수는 단일 줄바꿈으로.
  body = body.replace(/(?:<br\s*\/?\s*>\s*){2,}/g, '\n');
  // 단독 <br> 도 self-closing 으로 변환 (MDX requirement)
  body = body.replace(/<br\s*>/g, '<br/>');

  // 2) 자기 self-link 헤딩: `### [Foo](#foo)` → `### Foo`
  body = body.replace(
    /^(#{1,6})\s+\[([^\]]+)\]\(#[^)]*\)\s*$/gm,
    (_, hashes, txt) => `${hashes} ${txt.trim()}`,
  );
  // bold + self-link: `### **[Foo](#foo)**` → `### Foo`
  body = body.replace(
    /^(#{1,6})\s+\*\*\[([^\]]+)\]\(#[^)]*\)\*\*\s*$/gm,
    (_, hashes, txt) => `${hashes} ${txt.trim()}`,
  );

  // 3) kramdown notice block
  body = transformKramdownNotices(body);

  // 4) leading scaffolding 헤딩 제거 (h1/h2/h3 만)
  if (ctx && ctx.title) {
    const lines = body.split('\n');
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') i++;
    while (i < lines.length) {
      const line = lines[i];
      if (/^#{1,3}\s+\S/.test(line)) {
        const text = line.replace(/^#{1,3}\s+/, '').trim();
        const titleNorm = ctx.title.toLowerCase().replace(/\s+/g, ' ').trim();
        const textNorm = text.toLowerCase().replace(/\s+/g, ' ').trim();
        // title과 동일/유사하면 제거
        let isOurTitle = textNorm === titleNorm;
        // <C++> / <Python> 같은 angle suffix 비교
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

  // 5) 코드 fence 정규화
  body = normalizeFences(body);

  // 6) 이미지 경로 재작성: /assets/images/sw/sdk/dynamixel_sdk/<rest> → /img/software/dynamixel/dynamixel_sdk/<rest>
  body = body.replace(/\/assets\/images\/sw\/sdk\/dynamixel_sdk\//g, '/img/software/dynamixel/dynamixel_sdk/');
  // 그 외 /assets/images/parts/... 류 → /img/parts/...
  body = body.replace(/\/assets\/images\/parts\//g, '/img/parts/');
  body = body.replace(/\/assets\/images\/icon_unfold\.png/g, '/img/icon_unfold.png');
  // 기타 /assets/... 가 등장하면 외부 강등 (백업)
  body = body.replace(/\]\(\/assets\/([^)\s]+)\)/g, (_, p) => `](https://emanual.robotis.com/assets/${p})`);

  // 7) 내부 링크 재작성
  // dynamixel_sdk 내 페이지는 /docs/software/dynamixel/dynamixel_sdk/<...> 형태로
  // sample_code 는 lang/<example> 분리
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/software\/dynamixel\/dynamixel_sdk\/sample_code\/(c|cpp|python|java|csharp|labview|matlab)_([a-z0-9_]+?)\/?(#[^)\s]*)?\)/gi,
    (_, lang, slang, name, hash) =>
      `](/docs/software/dynamixel/dynamixel_sdk/sample_code/${slang.toLowerCase()}/${name}${hash || ''})`,
  );
  // library_setup 의 lang 페이지: /docs/.../library_setup/<lang>/(#hash) 그대로 유지
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/software\/dynamixel\/dynamixel_sdk\/library_setup\/(c|cpp|python|java|csharp|labview|matlab)\/?(#[^)\s]*)?\)/gi,
    (_, lang, slang, hash) =>
      `](/docs/software/dynamixel/dynamixel_sdk/library_setup/${slang.toLowerCase()}${hash || ''})`,
  );
  // tutorial leaf URL 변환:
  //   /docs/en/.../basic_read_write_tutorial/basic_read_write_tutorial_cpp/ → /docs/.../basic_read_write_tutorial/cpp
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/software\/dynamixel\/dynamixel_sdk\/(basic|bulk|sync)_read_write_tutorial\/\2_read_write_tutorial_(cpp|python)\/?(#[^)\s]*)?\)/gi,
    (_, lang, kind, ll, hash) =>
      `](/docs/software/dynamixel/dynamixel_sdk/${kind}_read_write_tutorial/${ll}${hash || ''})`,
  );
  // dynamixel_sdk 내부 (변환되는 페이지) — 일단 모두 /docs/software/dynamixel/dynamixel_sdk/<rest> 로
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/software\/dynamixel\/dynamixel_sdk\/([^)\s#]+?)\/?(#[^)\s]*)?\)/g,
    (_, lang, p, hash) => `](/docs/software/dynamixel/dynamixel_sdk/${p}${hash || ''})`,
  );
  // 그 외 /docs/<lang>/... → 외부 emanual로 강등 (link target & 일반)
  body = body.replace(
    /\]\(\/docs\/(en|kr)\/([^)\s#]+?)\/?(#[^)\s]*)?\)/g,
    (_, lang, p, hash) => `](https://emanual.robotis.com/docs/${lang}/${p}/${hash || ''})`,
  );

  // 8) reference-style link definitions: `[Foo]: /docs/en/dxl/...` → 외부 emanual 강등
  body = body.replace(
    /^(\[[^\]]+\]):\s*\/docs\/(en|kr)\/(\S+?)\/?\s*$/gm,
    (_, label, lang, p) => `${label}: https://emanual.robotis.com/docs/${lang}/${p}/`,
  );

  // 8) MDX safe escape (코드블록 외부의 stray angle brackets 처리)
  body = mdxEscapeOutsideFences(body);

  // 9) 빈 줄 정리
  body = collapseBlankLines(body);

  return body;
}

// kramdown notice 블록 변환
//   원본: 라인 끝에 `{: .notice}` / `{: .notice--info}` / `{: .notice--warning}` / `{: .notice--success}` / `{: .notice--danger}`
//   해당 라인 직전 paragraph(연속 비어있지 않은 라인)를 admonition으로 감싼다.
//   단순화: 그 paragraph 만 감싼다.
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
    const variant = m[1] || 'info'; // .notice 단독 → info
    let admType = 'note';
    if (variant === 'info') admType = 'info';
    else if (variant === 'warning') admType = 'warning';
    else if (variant === 'success') admType = 'tip';
    else if (variant === 'danger') admType = 'danger';
    else if (variant === 'primary') admType = 'note';

    // 직전 paragraph 찾기
    // out 의 끝에서 빈 줄까지 거꾸로 — 그 사이 라인이 paragraph
    let j = out.length - 1;
    // 빈 줄 후행 무시
    while (j >= 0 && out[j].trim() === '') j--;
    let start = j;
    while (start - 1 >= 0 && out[start - 1].trim() !== '') start--;
    if (start < 0) start = 0;
    const paragraph = out.splice(start, j - start + 1);
    // trailing 빈 줄 다시 추가
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

// fence 정규화
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
      if (/```\s*$/.test(line)) {
        const idx = line.lastIndexOf('```');
        const codePart = line.slice(0, idx).trimEnd();
        if (fenceIndent && codePart.startsWith(fenceIndent)) {
          out.push(codePart.slice(fenceIndent.length));
        } else if (codePart) {
          out.push(codePart);
        }
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
        // <단어> 또는 <단어 ...> 또는 </단어>
        const m = line.slice(i).match(/^<\/?([A-Za-z][A-Za-z0-9._\-]*)([^>]*)>/);
        if (m) {
          const tag = m[1].toLowerCase();
          const safeTags = new Set([
            'br', 'hr', 'img', 'a', 'b', 'i', 'em', 'strong', 'span', 'div',
            'p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'sub', 'sup', 'code', 'pre',
            'tabs', 'tabitem', 'details', 'summary', 'iframe', 'kbd', 'section',
          ]);
          if (!safeTags.has(tag)) {
            out += '&lt;' + m[0].slice(1, -1) + '&gt;';
            i += m[0].length;
            continue;
          }
          // safe 태그면 그대로 유지
          out += m[0];
          i += m[0].length;
          continue;
        }
        // <…>가 매치되지 않으면 ≪일반 부등호≫ — entity escape (MDX 안전성)
        // 그러나 `< 값` 같은 부등호는 그대로 두어야 자연스러움 → 보수적으로 ' < 숫자/단어' 등은 escape
        // 여기서는 일단 그대로 두되 `<` 다음 공백이 있으면 그대로
        out += ch;
        i++;
        continue;
      }
      // `{}` 처리 — MDX에서 `{}` 는 expression 으로 해석되지만, 우리 본문에는 코드 외부의 `{}` 는 거의 없음.
      // capture 패턴 (Liquid `{% capture %}` `{% endcapture %}`) 만 처리
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
// ko mirror (en + 한국어 번역 준비 중 안내)
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
  if (opts.key) data.key = opts.key;
  writeOut(path.join(dir, '_category_.json'), JSON.stringify(data, null, 2) + '\n');
}

// ------------------------------------------------------------
// Liquid include resolver (재귀)
// ------------------------------------------------------------
//   `{% include en/software/dynamixel_sdk/library_setup/c_linux.md %}`
//   → source/_includes/en/software/dynamixel_sdk/library_setup/c_linux.md
function resolveInclude(includePath, depth = 0) {
  if (depth > 5) return `<!-- include depth limit: ${includePath} -->`;
  const full = path.join(SRC_INCLUDES, includePath);
  if (!fs.existsSync(full)) return null;
  let txt = fs.readFileSync(full, 'utf8');
  // 재귀 평가
  txt = txt.replace(/\{%\s*include\s+([^\s%]+)\s*%\}/g, (_, p) => {
    const inc = resolveInclude(p, depth + 1);
    return inc === null ? `<!-- unresolved include: ${p} -->` : inc;
  });
  return txt;
}

// ------------------------------------------------------------
// Liquid capture / endcapture / markdownify 처리
// ------------------------------------------------------------
//   {% capture notice_01 %}
//   **WARNING**: ...
//   {% endcapture %}
//   <div class="notice--warning">{{ notice_01 | markdownify }}</div>
//
//   → :::warning  / 본문 / :::
function transformLiquidCapture(src) {
  // 모든 capture 블록을 이름:본문 맵으로 수집
  const captures = {};
  src = src.replace(
    /\{%\s*capture\s+(\w+)\s*%\}([\s\S]*?)\{%\s*endcapture\s*%\}/g,
    (_, name, content) => {
      captures[name] = content.trim();
      return ''; // 자리 제거
    },
  );
  // <div class="notice--xxx">{{ name | markdownify }}</div> 또는 markdownify 단독
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
  // 남은 markdownify 출력 (capture 없이 단독): {{ var | markdownify }} → 잔여 (해당 capture 가 위에서 인라인됨)
  src = src.replace(/\{\{\s*\w+\s*\|\s*markdownify\s*\}\}/g, '');
  return src;
}

// ------------------------------------------------------------
// library_setup 페이지 변환
// ------------------------------------------------------------
//   각 페이지 본문은 1~3개의 `<section data-id="{{ page.tab_titleN }}">` 블록.
//   각 블록은 `{% include en/software/dynamixel_sdk/library_setup/<file>.md %}` 1줄.
//   탭 라벨은 frontmatter 의 tab_title1/2/3.
function convertLibrarySetupPage(srcPath, lang) {
  const raw = fs.readFileSync(srcPath, 'utf8');
  const { fm, body } = splitFrontmatter(raw);

  const tabTitles = [];
  for (const k of ['tab_title1', 'tab_title2', 'tab_title3']) {
    if (fm[k]) tabTitles.push(fm[k]);
  }

  // section 블록 추출
  const sections = [];
  const reSec = /<section\s+data-id="\{\{\s*page\.(tab_title\d)\s*\}\}"[^>]*>([\s\S]*?)<\/section>/g;
  let mm;
  while ((mm = reSec.exec(body)) !== null) {
    const tabKey = mm[1]; // tab_title1
    const inner = mm[2];
    const label = fm[tabKey] || 'OS';
    sections.push({ label, content: inner });
  }

  // 각 section 의 include 평가 (있으면)
  for (const s of sections) {
    s.content = s.content.replace(/\{%\s*include\s+([^\s%]+)\s*%\}/g, (_, p) => {
      const inc = resolveInclude(p);
      if (inc === null) {
        return `<!-- unresolved include: ${p} -->`;
      }
      return inc;
    });
  }

  const langMeta = LANGUAGES[lang];
  const title = `Library Setup (${langMeta.label})`;
  // id 는 파일 stem(`c.mdx` → `c`) 과 동일하게 — URL 슬러그가 `library_setup/c` 가 되도록.
  const id = lang;

  // 본문: Tabs/TabItem 으로 감싸기
  let tabsBody = '';
  if (sections.length === 0) {
    // section 이 없으면 그냥 body
    tabsBody = body;
  } else if (sections.length === 1) {
    // 단일 section (예: labview는 windows 만)
    tabsBody = sections[0].content;
  } else {
    const groupId = 'library-setup-os';
    const items = sections.map((s, idx) => {
      const value = s.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      return { value, label: s.label, content: s.content, default: idx === 0 };
    });
    tabsBody += `<Tabs groupId="${groupId}" queryString>\n`;
    items.forEach((it) => {
      tabsBody += `<TabItem value="${it.value}" label="${it.label}"${it.default ? ' default' : ''}>\n\n`;
      tabsBody += it.content.trim() + '\n\n';
      tabsBody += `</TabItem>\n`;
    });
    tabsBody += `</Tabs>\n`;
  }

  // 본문 변환
  const ctx = { title, lang };
  let converted = convertBody(tabsBody, ctx);

  // Tabs/TabItem import 헤더 추가 (사용 시)
  let imports = '';
  if (sections.length > 1) {
    imports = `import Tabs from '@theme/Tabs';\nimport TabItem from '@theme/TabItem';\n\n`;
  }

  const newFm = {
    id,
    title,
    sidebar_label: langMeta.label,
    sidebar_position: langMeta.position,
    tags: ['dynamixel_sdk', 'library_setup', lang],
  };

  return {
    id,
    title,
    outFilename: `${lang}.mdx`,
    content: buildFmYaml(newFm) + imports + converted.trimStart() + '\n',
  };
}

// ------------------------------------------------------------
// api_reference 페이지 변환
// ------------------------------------------------------------
function convertApiReferencePage(srcPath, lang, filename) {
  const raw = fs.readFileSync(srcPath, 'utf8');
  const { fm, body } = splitFrontmatter(raw);

  const langMeta = LANGUAGES[lang];
  // filename: cpp_porthandler.md → ref name: porthandler
  const stem = filename.replace(/\.md$/, '');
  const refKind = stem.replace(/^[a-z]+_/, ''); // porthandler/packethandler/groupbulkread/...
  const kindLabels = {
    porthandler: 'PortHandler',
    packethandler: 'PacketHandler',
    groupbulkread: 'GroupBulkRead',
    groupbulkwrite: 'GroupBulkWrite',
    groupsyncread: 'GroupSyncRead',
    groupsyncwrite: 'GroupSyncWrite',
  };
  const kindLabel = kindLabels[refKind] || refKind;
  const title = `${langMeta.label} ${kindLabel}`;
  const id = stem;

  const positions = {
    porthandler: 1,
    packethandler: 2,
    groupbulkread: 3,
    groupbulkwrite: 4,
    groupsyncread: 5,
    groupsyncwrite: 6,
  };
  const sidebarPos = positions[refKind] || 99;

  const ctx = { title, lang };
  let converted = convertBody(body, ctx);

  const newFm = {
    id,
    title,
    sidebar_label: kindLabel,
    sidebar_position: sidebarPos,
    tags: ['dynamixel_sdk', 'api_reference', lang],
  };

  return {
    id,
    title,
    outFilename: `${stem}.mdx`,
    content: buildFmYaml(newFm) + converted.trimStart() + '\n',
  };
}

// ------------------------------------------------------------
// tutorial leaf 페이지 (basic/bulk/sync read_write tutorial; cpp/python)
// ------------------------------------------------------------
//   본문에 `<section data-id="{{ page.tab_titleN }}">` 블록이 군데군데 끼어있다.
//   같은 헤딩 아래 여러 탭 별로 다른 본문이 있는 형태.
//   단순화 정책: section 블록을 보존하되 각 section을 인라인 admonition/details 같은 단순 위젯으로
//   변환하면 의미가 깨지므로, **page 전체를 OS 탭으로 나누지 않고**:
//   각 section 블록을 <Tabs> 내부 단일 TabItem 으로 감싸지 않고 그냥 인라인 펼치기로 둔다.
//
//   단순화: 각 section 블록을 `<Tabs>` 미니 탭 그룹으로 묶는다 (인접한 sections 만 그룹).
//   하지만 이는 복잡하므로 더 단순한 대안:
//     `<section data-id="X">...content...</section>` →
//        `**X 환경:**\n\n...content...\n`  (섹션 라벨을 강조 텍스트로 prefix)
//   읽기는 가능하지만 시각적 탭은 사라짐.
//
//   더 나은 단순화: 인접한 같은 셋업의 section 그룹을 Tabs로 감싸기.
//   여기서는 `<section data-id="{{ page.tab_title1 }}">` (Linux) 와 `<section data-id="{{ page.tab_title2 }}">` (Windows) 가
//   바로 인접해 있으면 그 둘을 Tabs로 묶는다.
function convertTutorialLeafPage(srcPath, kind, lang) {
  const raw = fs.readFileSync(srcPath, 'utf8');
  const { fm, body: rawBody } = splitFrontmatter(raw);

  const langMeta = LANGUAGES[lang];
  const kindTitles = {
    basic_read_write: 'Basic Read/Write Tutorial',
    bulk_read_write: 'Bulk Read/Write Tutorial',
    sync_read_write: 'Sync Read/Write Tutorial',
  };
  const kindTitle = kindTitles[kind];
  const title = `${kindTitle} (${langMeta.label})`;
  // id 는 파일 stem(`cpp.mdx` → `cpp`) 과 동일하게 — URL 슬러그가 `<kind>_tutorial/cpp` 가 되도록.
  const id = lang;

  // 1) `<section data-id="{{ page.tab_titleN }}">` 패턴을 '##__SECTION_START_N__\n' / '##__SECTION_END__\n' 마커로 변환
  let body = rawBody;
  body = body.replace(
    /<section\s+data-id="\{\{\s*page\.(tab_title\d)\s*\}\}"[^>]*>/g,
    (_, key) => `\n@@SECTION_START:${key}@@\n`,
  );
  body = body.replace(/<\/section>/g, `\n@@SECTION_END@@\n`);

  // 2) 본문을 라인 단위로 순회하며 인접한 섹션을 Tabs 그룹으로 묶는다.
  //    같은 시작 위치(연속된 섹션 그룹)는 하나의 Tabs로.
  const lines = body.split('\n');
  const out = [];
  let i = 0;
  let usedTabs = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line.match(/^@@SECTION_START:(tab_title\d)@@$/)) {
      // 섹션 그룹 시작 — 인접 섹션 모두 수집
      const sections = [];
      while (i < lines.length) {
        const sm = lines[i].match(/^@@SECTION_START:(tab_title\d)@@$/);
        if (!sm) break;
        const tabKey = sm[1];
        const label = fm[tabKey] || 'OS';
        i++;
        const buf = [];
        while (i < lines.length && lines[i] !== '@@SECTION_END@@') {
          buf.push(lines[i]);
          i++;
        }
        // 종료 마커 skip
        if (i < lines.length) i++;
        // 다음 줄이 빈 줄이면 skip하지 말고 다음 섹션 시작인지 확인
        // 빈 줄들 skip
        while (i < lines.length && lines[i].trim() === '') {
          // peek next
          if (i + 1 < lines.length && lines[i + 1].match(/^@@SECTION_START:tab_title\d@@$/)) {
            i++;
            continue;
          }
          break;
        }
        sections.push({ label, content: buf.join('\n').trim() });
      }
      // emit as Tabs
      if (sections.length === 1) {
        // 단일 섹션이면 라벨만 prefix
        out.push('');
        out.push(sections[0].content);
        out.push('');
      } else {
        usedTabs = true;
        const groupId = 'tutorial-os';
        out.push('<Tabs groupId="' + groupId + '" queryString>');
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

  let assembled = out.join('\n');

  // 3) capture / endcapture / markdownify 잔여 정리 (단순)
  assembled = assembled.replace(/\{%\s*capture\s+\w+\s*%\}/g, '');
  assembled = assembled.replace(/\{%\s*endcapture\s*%\}/g, '');
  assembled = assembled.replace(/\{\{\s*\w+\s*\|\s*markdownify\s*\}\}/g, '');

  const ctx = { title, lang };
  let converted = convertBody(assembled, ctx);

  let imports = '';
  if (usedTabs) {
    imports = `import Tabs from '@theme/Tabs';\nimport TabItem from '@theme/TabItem';\n\n`;
  }

  const newFm = {
    id,
    title,
    sidebar_label: langMeta.label,
    sidebar_position: langMeta.position,
    tags: ['dynamixel_sdk', 'tutorial', kind, lang],
  };

  return {
    id,
    title,
    outFilename: `${lang}.mdx`,
    content: buildFmYaml(newFm) + imports + converted.trimStart() + '\n',
  };
}

// ------------------------------------------------------------
// tutorial 인덱스 페이지 (basic/bulk/sync read_write tutorial.md)
// ------------------------------------------------------------
function convertTutorialIndexPage(srcPath, kind) {
  const raw = fs.readFileSync(srcPath, 'utf8');
  const { fm, body: rawBody } = splitFrontmatter(raw);

  const kindTitles = {
    basic_read_write: 'Basic Read/Write Tutorial',
    bulk_read_write: 'Bulk Read/Write Tutorial',
    sync_read_write: 'Sync Read/Write Tutorial',
  };
  const title = kindTitles[kind];
  const id = `${kind}_tutorial`;

  // 인덱스 페이지의 leaf 링크에서 #hash 제거 (heading 이 페이지 title 이라 anchor 없음)
  let body = rawBody.replace(
    /\(\/docs\/(en|kr)\/software\/dynamixel\/dynamixel_sdk\/(basic|bulk|sync)_read_write_tutorial\/(\w+)\/?#[^)]*\)/g,
    (_, lang, k, p) => `(/docs/software/dynamixel/dynamixel_sdk/${k}_read_write_tutorial/${p})`,
  );

  const ctx = { title };
  let converted = convertBody(body, ctx);

  const positions = {
    basic_read_write: 5,
    sync_read_write: 6,
    bulk_read_write: 7,
  };

  const newFm = {
    id,
    title,
    sidebar_label: title,
    sidebar_position: positions[kind] || 50,
    tags: ['dynamixel_sdk', 'tutorial'],
  };

  return {
    id,
    title,
    outFilename: 'index.mdx',
    content: buildFmYaml(newFm) + converted.trimStart() + '\n',
  };
}

// ------------------------------------------------------------
// 직속 페이지 (overview / quick_start_guide / quick_start_video / download / device_setup / faq / library_setup.md)
// ------------------------------------------------------------
function convertDirectPage(srcPath, kind) {
  const raw = fs.readFileSync(srcPath, 'utf8');
  const { fm, body } = splitFrontmatter(raw);

  const meta = {
    overview: { title: 'Overview', position: 1 },
    quick_start_guide: { title: 'Quick Start Guide', position: 2 },
    download: { title: 'Download SDK', position: 3 },
    device_setup: { title: 'Device Setup', position: 4 },
    library_setup: { title: 'Library Setup', position: 10 },
    quick_start_video: { title: 'Quick Start Video', position: 50 },
    faq: { title: 'FAQ', position: 90 },
  };
  const m = meta[kind];
  const title = m.title;
  const id = kind;

  // capture / markdownify 처리 (device_setup.md에 있음)
  let preBody = body;
  preBody = preBody.replace(/\{%\s*capture\s+(\w+)\s*%\}([\s\S]*?)\{%\s*endcapture\s*%\}/g, (_, name, content) => {
    return content.trim();
  });
  preBody = preBody.replace(/<div class="notice--success">\{\{\s*\w+\s*\|\s*markdownify\s*\}\}<\/div>/g, '');

  const ctx = { title };
  let converted = convertBody(preBody, ctx);

  const newFm = {
    id,
    title,
    sidebar_label: title,
    sidebar_position: m.position,
    tags: ['dynamixel_sdk'],
  };

  return {
    id,
    title,
    outFilename: `${kind}.mdx`,
    content: buildFmYaml(newFm) + converted.trimStart() + '\n',
  };
}

// ------------------------------------------------------------
// 후처리: 내부 dynamixel_sdk 링크 중 변환된 출력에 없는 것을 외부 emanual 로 강등
// ------------------------------------------------------------
function collectExistingSdkPaths() {
  // OUT_EN 의 모든 .mdx 파일 → URL 슬러그
  const paths = new Set();
  function walk(d, rel) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const next = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(full, next);
      else if (e.isFile() && e.name.endsWith('.mdx')) {
        const stem = e.name.replace(/\.mdx$/, '');
        // id 가 frontmatter에 있으면 그것이 슬러그. 단순화: 파일 stem 기반.
        // 파일 stem 이 'index' 면 디렉터리 path = url
        const url = stem === 'index'
          ? rel.replace(/\\/g, '/')
          : (rel ? rel.replace(/\\/g, '/') + '/' : '') + stem;
        // frontmatter id 도 추출
        const txt = fs.readFileSync(full, 'utf8');
        const idMatch = txt.match(/^---[\s\S]*?\nid:\s*([\w-]+)/m);
        const id = idMatch ? idMatch[1] : stem;
        // Docusaurus 는 id를 마지막 path 세그먼트로 사용
        const dir = rel ? rel.replace(/\\/g, '/') : '';
        const idUrl = stem === 'index' ? dir : (dir ? dir + '/' : '') + id;
        paths.add('/docs/software/dynamixel/dynamixel_sdk/' + url);
        paths.add('/docs/software/dynamixel/dynamixel_sdk/' + idUrl);
      }
    }
  }
  walk(OUT_EN, '');
  // generated-index 디렉터리도 valid
  function walkDirs(d, rel) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const next = rel ? rel + '/' + e.name : e.name;
      // _category_.json 가 있는 디렉터리는 generated-index URL
      const cat = path.join(d, e.name, '_category_.json');
      if (fs.existsSync(cat)) {
        paths.add('/docs/software/dynamixel/dynamixel_sdk/' + next.replace(/\\/g, '/'));
      }
      walkDirs(path.join(d, e.name), next);
    }
  }
  walkDirs(OUT_EN, '');
  return paths;
}

function postProcessOrphanLinks() {
  const valid = collectExistingSdkPaths();
  const allFiles = [];
  function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.mdx')) allFiles.push(full);
    }
  }
  walk(OUT_EN);
  walk(OUT_KO);

  let downgraded = 0;
  for (const file of allFiles) {
    let txt = fs.readFileSync(file, 'utf8');
    txt = txt.replace(
      /\]\(\/docs\/software\/dynamixel\/dynamixel_sdk\/([^)\s#]+?)(#[^)\s]*)?\)/g,
      (m, p, hash) => {
        const target = '/docs/software/dynamixel/dynamixel_sdk/' + p.replace(/\/+$/, '');
        if (valid.has(target)) return m;
        downgraded++;
        return `](https://emanual.robotis.com/docs/en/software/dynamixel/dynamixel_sdk/${p}/${hash || ''})`;
      },
    );
    fs.writeFileSync(file, txt);
  }
  console.log(`postprocess: orphan links downgraded: ${downgraded}`);
}

// ------------------------------------------------------------
// 자산 복사
// ------------------------------------------------------------
function copyAssets() {
  const SRC = path.join(ASSET_SRC_ROOT, 'images/sw/sdk/dynamixel_sdk');
  const DST = path.join(ASSET_OUT_ROOT, 'software/dynamixel/dynamixel_sdk');
  let count = 0;
  if (!fs.existsSync(SRC)) return 0;
  function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const next = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(full, next);
      else if (e.isFile()) {
        copyFile(full, path.join(DST, next));
        count++;
      }
    }
  }
  walk(SRC, '');

  // device_setup 페이지가 사용하는 /assets/images/parts/interface/u2d2_01.jpg
  const u2d2 = path.join(ASSET_SRC_ROOT, 'images/parts/interface/u2d2_01.jpg');
  if (fs.existsSync(u2d2)) {
    copyFile(u2d2, path.join(ASSET_OUT_ROOT, 'parts/interface/u2d2_01.jpg'));
    count++;
  }
  // icon_unfold.png — 튜토리얼 details summary 안에서 쓰임
  const iconUnfold = path.join(ASSET_SRC_ROOT, 'images/icon_unfold.png');
  if (fs.existsSync(iconUnfold)) {
    copyFile(iconUnfold, path.join(ASSET_OUT_ROOT, 'icon_unfold.png'));
    count++;
  }
  return count;
}

// ------------------------------------------------------------
// 메인
// ------------------------------------------------------------
function main() {
  ensureDir(OUT_EN);
  ensureDir(OUT_KO);

  const stats = { library_setup: 0, api_reference: 0, tutorial: 0, direct: 0, index: 0 };

  // ---- library_setup ----
  const LS_SRC = path.join(SRC_EN, 'library_setup');
  const LS_OUT_EN = path.join(OUT_EN, 'library_setup');
  const LS_OUT_KO = path.join(OUT_KO, 'library_setup');
  ensureDir(LS_OUT_EN);
  ensureDir(LS_OUT_KO);
  writeCategoryJson(LS_OUT_EN, 'Library Setup', 10);
  writeCategoryJson(LS_OUT_KO, '라이브러리 설치', 10);

  const lsFiles = fs
    .readdirSync(LS_SRC)
    .filter((f) => f.startsWith('library_setup_') && f.endsWith('.md'));
  for (const f of lsFiles) {
    const lang = f.replace(/^library_setup_/, '').replace(/\.md$/, '');
    if (!(lang in LANGUAGES)) continue;
    const result = convertLibrarySetupPage(path.join(LS_SRC, f), lang);
    writeOut(path.join(LS_OUT_EN, result.outFilename), result.content);
    writeOut(path.join(LS_OUT_KO, result.outFilename), buildKoMirror(result.content));
    stats.library_setup++;
  }
  // (library_setup 의 lang 도큐먼트는 카테고리가 아니라 doc 이라 키 필요 없음)

  // ---- api_reference ----
  const AR_SRC = path.join(SRC_EN, 'api_reference');
  const AR_OUT_EN = path.join(OUT_EN, 'api_reference');
  const AR_OUT_KO = path.join(OUT_KO, 'api_reference');
  ensureDir(AR_OUT_EN);
  ensureDir(AR_OUT_KO);
  writeCategoryJson(AR_OUT_EN, 'API Reference', 80);
  writeCategoryJson(AR_OUT_KO, 'API 참조', 80);

  const arLangs = fs
    .readdirSync(AR_SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const lang of arLangs) {
    if (!(lang in LANGUAGES)) continue;
    const langSrc = path.join(AR_SRC, lang);
    const langOutEn = path.join(AR_OUT_EN, lang);
    const langOutKo = path.join(AR_OUT_KO, lang);
    ensureDir(langOutEn);
    ensureDir(langOutKo);
    writeCategoryJson(langOutEn, LANGUAGES[lang].label, LANGUAGES[lang].position, {
      key: `api_reference_${lang}`,
    });
    writeCategoryJson(langOutKo, LANGUAGES[lang].koLabel, LANGUAGES[lang].position, {
      key: `api_reference_${lang}`,
    });
    const files = fs.readdirSync(langSrc).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      const result = convertApiReferencePage(path.join(langSrc, f), lang, f);
      writeOut(path.join(langOutEn, result.outFilename), result.content);
      writeOut(path.join(langOutKo, result.outFilename), buildKoMirror(result.content));
      stats.api_reference++;
    }
  }

  // ---- tutorial ----
  const tutKinds = ['basic_read_write', 'bulk_read_write', 'sync_read_write'];
  const tutorialLangs = ['cpp', 'python'];
  for (const kind of tutKinds) {
    const tutDirSrc = path.join(SRC_EN, `${kind}_tutorial`);
    const tutDirOutEn = path.join(OUT_EN, `${kind}_tutorial`);
    const tutDirOutKo = path.join(OUT_KO, `${kind}_tutorial`);
    ensureDir(tutDirOutEn);
    ensureDir(tutDirOutKo);

    // 인덱스 페이지 (basic_read_write_tutorial.md → index.mdx)
    const indexSrc = path.join(SRC_EN, `${kind}_tutorial.md`);
    if (fs.existsSync(indexSrc)) {
      const idxResult = convertTutorialIndexPage(indexSrc, kind);
      writeOut(path.join(tutDirOutEn, idxResult.outFilename), idxResult.content);
      writeOut(path.join(tutDirOutKo, idxResult.outFilename), buildKoMirror(idxResult.content));
      stats.index++;
    }

    // 카테고리 (인덱스 doc 가 카테고리 link 가 되도록)
    const positions = { basic_read_write: 5, sync_read_write: 6, bulk_read_write: 7 };
    const titles = {
      basic_read_write: 'Basic Read/Write Tutorial',
      sync_read_write: 'Sync Read/Write Tutorial',
      bulk_read_write: 'Bulk Read/Write Tutorial',
    };
    const koTitles = {
      basic_read_write: 'Basic Read/Write 튜토리얼',
      sync_read_write: 'Sync Read/Write 튜토리얼',
      bulk_read_write: 'Bulk Read/Write 튜토리얼',
    };
    writeCategoryJson(tutDirOutEn, titles[kind], positions[kind], {
      linkType: 'doc',
      linkId: `${kind}_tutorial`,
    });
    writeCategoryJson(tutDirOutKo, koTitles[kind], positions[kind], {
      linkType: 'doc',
      linkId: `${kind}_tutorial`,
    });

    // leaf 페이지 (cpp/python)
    for (const lang of tutorialLangs) {
      const leafSrc = path.join(SRC_EN, `${kind}_tutorial`, `${kind}_tutorial_${lang}.md`);
      if (!fs.existsSync(leafSrc)) continue;
      const result = convertTutorialLeafPage(leafSrc, kind, lang);
      writeOut(path.join(tutDirOutEn, result.outFilename), result.content);
      writeOut(path.join(tutDirOutKo, result.outFilename), buildKoMirror(result.content));
      stats.tutorial++;
    }
  }

  // ---- 직속 페이지 ----
  const directKinds = [
    'overview',
    'quick_start_guide',
    'download',
    'device_setup',
    'library_setup',
    'quick_start_video',
    'faq',
  ];
  for (const kind of directKinds) {
    const src = path.join(SRC_EN, `${kind}.md`);
    if (!fs.existsSync(src)) continue;
    const result = convertDirectPage(src, kind);
    writeOut(path.join(OUT_EN, result.outFilename), result.content);
    writeOut(path.join(OUT_KO, result.outFilename), buildKoMirror(result.content));
    stats.direct++;
  }

  // ---- 루트 인덱스 (dynamixel_sdk/index.mdx) ----
  const indexFm = {
    id: 'dynamixel_sdk',
    title: 'DYNAMIXEL SDK',
    sidebar_label: 'DYNAMIXEL SDK',
    sidebar_position: 1,
    tags: ['dynamixel_sdk'],
  };
  const indexBody = `
The **DYNAMIXEL SDK** provides a set of functions for creating and processing DYNAMIXEL Protocol packets to manage DYNAMIXEL servos. The SDK provides libraries for a wide variety of programming languages including Java, C, C++, and Python.

## Sections

- [Overview](/docs/software/dynamixel/dynamixel_sdk/overview)
- [Quick Start Guide](/docs/software/dynamixel/dynamixel_sdk/quick_start_guide)
- [Download SDK](/docs/software/dynamixel/dynamixel_sdk/download)
- [Device Setup](/docs/software/dynamixel/dynamixel_sdk/device_setup)
- [Library Setup](/docs/software/dynamixel/dynamixel_sdk/library_setup)
- [Basic Read/Write Tutorial](/docs/software/dynamixel/dynamixel_sdk/basic_read_write_tutorial)
- [Sync Read/Write Tutorial](/docs/software/dynamixel/dynamixel_sdk/sync_read_write_tutorial)
- [Bulk Read/Write Tutorial](/docs/software/dynamixel/dynamixel_sdk/bulk_read_write_tutorial)
- API Reference (see sidebar)
- Sample Code (see sidebar)
- [Quick Start Video](/docs/software/dynamixel/dynamixel_sdk/quick_start_video)
- [FAQ](/docs/software/dynamixel/dynamixel_sdk/faq)

## Resources

- [DYNAMIXEL SDK GitHub repository](https://github.com/ROBOTIS-GIT/DynamixelSDK)
- [DYNAMIXEL SDK Releases](https://github.com/ROBOTIS-GIT/DynamixelSDK/releases)
- [ROBOTIS Community Forum](https://forum.robotis.com)
`;
  const enIndex = buildFmYaml(indexFm) + indexBody.trimStart() + '\n';
  writeOut(path.join(OUT_EN, 'index.mdx'), enIndex);
  // ko: kr 원본 overview.md 가 한국어 안내를 갖고 있지만, 우리는 단순히 mirror 처리
  writeOut(path.join(OUT_KO, 'index.mdx'), buildKoMirror(enIndex));
  stats.index++;

  // ---- 후처리: 내부 SDK 링크 중 변환되지 않은 페이지를 외부 emanual로 강등 ----
  postProcessOrphanLinks();

  // ---- 자산 복사 ----
  const assetCount = copyAssets();

  console.log('SDK rest conversion complete.');
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v}`);
  console.log(`  assets copied: ${assetCount}`);
  console.log(`  total: ${Object.values(stats).reduce((a, b) => a + b, 0)} pages × 2 (en/ko)`);
}

main();
