#!/usr/bin/env node
/**
 * PNG 이미지를 JPEG / WebP 로 변환했을 때의 용량 변화 추정.
 *
 *   샘플링 정책:
 *     - 모든 PNG 파일에서 size 분포에 따라 균등 샘플 200개 선택
 *       (크기별 bucket: <50KB, 50~200KB, 200~500KB, 500KB+)
 *     - 각 샘플을 sharp 로 in-memory 변환 후 byte length 측정
 *     - 형식: JPEG (quality 80, 85), WebP (lossless, quality 80, 85)
 *
 *   사용법:
 *     node scripts/measure-png-compression.js
 *
 *   출력:
 *     형식별 평균 압축률, 추정 전체 용량.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const STATIC_IMG = path.join(REPO_ROOT, 'docusaurus', 'static', 'img');
// sharp는 docusaurus/node_modules에 설치됨
const sharp = require(path.join(REPO_ROOT, 'docusaurus', 'node_modules', 'sharp'));

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function pickSample(allFiles, n = 200) {
  // 크기 4 buckets
  const buckets = {
    s: [],   // <50KB
    m: [],   // 50~200KB
    l: [],   // 200~500KB
    xl: [],  // 500KB+
  };
  for (const f of allFiles) {
    const size = fs.statSync(f).size;
    if (size < 50 * 1024) buckets.s.push({ f, size });
    else if (size < 200 * 1024) buckets.m.push({ f, size });
    else if (size < 500 * 1024) buckets.l.push({ f, size });
    else buckets.xl.push({ f, size });
  }
  const perBucket = Math.floor(n / 4);
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  const picked = [];
  for (const [k, bucket] of Object.entries(buckets)) {
    shuffle(bucket);
    picked.push(...bucket.slice(0, perBucket).map((x) => ({ ...x, bucket: k })));
  }
  return picked;
}

async function measureSample(filepath) {
  const buffer = fs.readFileSync(filepath);
  const result = { png: buffer.length };
  try {
    const img = sharp(buffer);
    // alpha 채널 검사
    const meta = await img.metadata();
    result.hasAlpha = !!meta.hasAlpha;
    result.width = meta.width;
    result.height = meta.height;
    // JPEG q=80 (no alpha — JPEG는 투명도 미지원)
    result.jpeg80 = (await img.clone().jpeg({ quality: 80, mozjpeg: true }).toBuffer()).length;
    // JPEG q=85
    result.jpeg85 = (await img.clone().jpeg({ quality: 85, mozjpeg: true }).toBuffer()).length;
    // WebP lossless
    result.webpLossless = (await img.clone().webp({ lossless: true }).toBuffer()).length;
    // WebP q=80
    result.webp80 = (await img.clone().webp({ quality: 80 }).toBuffer()).length;
    // WebP q=85
    result.webp85 = (await img.clone().webp({ quality: 85 }).toBuffer()).length;
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

async function main() {
  console.log('collecting PNG files...');
  const allPng = [...walk(STATIC_IMG)].filter((f) => f.toLowerCase().endsWith('.png'));
  console.log(`total PNG: ${allPng.length}`);

  const totalSize = allPng.reduce((s, f) => s + fs.statSync(f).size, 0);
  console.log(`total PNG size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);

  const samples = pickSample(allPng, 200);
  console.log(`samples: ${samples.length}`);

  // sample 측정
  const stats = { samples: 0, alpha: 0, errors: 0 };
  const sums = {
    png: 0,
    jpeg80: 0,
    jpeg85: 0,
    webpLossless: 0,
    webp80: 0,
    webp85: 0,
  };

  let i = 0;
  for (const s of samples) {
    i++;
    if (i % 50 === 0) process.stdout.write(`  measured ${i}/${samples.length}\n`);
    const r = await measureSample(s.f);
    if (r.error) {
      stats.errors++;
      continue;
    }
    stats.samples++;
    if (r.hasAlpha) stats.alpha++;
    sums.png += r.png;
    sums.jpeg80 += r.jpeg80;
    sums.jpeg85 += r.jpeg85;
    sums.webpLossless += r.webpLossless;
    sums.webp80 += r.webp80;
    sums.webp85 += r.webp85;
  }

  console.log('---');
  console.log(`samples measured: ${stats.samples}/${samples.length} (errors: ${stats.errors})`);
  console.log(`with alpha channel: ${stats.alpha} (${((stats.alpha / stats.samples) * 100).toFixed(1)}%)`);
  console.log('');
  console.log('average per-file ratio (sample):');
  for (const k of ['jpeg80', 'jpeg85', 'webpLossless', 'webp80', 'webp85']) {
    const ratio = sums[k] / sums.png;
    console.log(`  ${k.padEnd(14)}: ${(ratio * 100).toFixed(1)}% of PNG`);
  }
  console.log('');
  console.log(`extrapolated to all ${allPng.length} PNGs (total ${(totalSize / 1024 / 1024).toFixed(1)} MB):`);
  for (const k of ['jpeg80', 'jpeg85', 'webpLossless', 'webp80', 'webp85']) {
    const ratio = sums[k] / sums.png;
    const estMB = (totalSize / 1024 / 1024) * ratio;
    const savedMB = (totalSize / 1024 / 1024) - estMB;
    console.log(`  ${k.padEnd(14)}: ~${estMB.toFixed(0)} MB  (saved ${savedMB.toFixed(0)} MB)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
