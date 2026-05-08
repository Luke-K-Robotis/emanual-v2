#!/usr/bin/env node
/**
 * docusaurus/static/img/ 의 모든 PNG → WebP q=85 (alpha 보존) 일괄 변환.
 *   - 변환 후 원본 PNG 삭제
 *   - 측정: 총 PNG 크기, 변환 후 WebP 크기, 절약률
 *
 * 사용법:
 *   node scripts/png-to-webp.js
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const STATIC_IMG = path.join(REPO_ROOT, 'docusaurus', 'static', 'img');
const sharp = require(path.join(REPO_ROOT, 'docusaurus', 'node_modules', 'sharp'));

const QUALITY = 85;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

async function convertOne(pngPath) {
  const webpPath = pngPath.replace(/\.png$/i, '.webp');
  const before = fs.statSync(pngPath).size;
  try {
    await sharp(pngPath)
      .webp({ quality: QUALITY, alphaQuality: 100 })
      .toFile(webpPath);
    const after = fs.statSync(webpPath).size;
    fs.unlinkSync(pngPath);
    return { ok: true, before, after };
  } catch (e) {
    return { ok: false, before, error: e.message };
  }
}

async function main() {
  const pngs = [...walk(STATIC_IMG)].filter((f) => f.toLowerCase().endsWith('.png'));
  console.log(`PNG files: ${pngs.length}`);

  const totalBefore = pngs.reduce((s, f) => s + fs.statSync(f).size, 0);
  console.log(`PNG total size: ${(totalBefore / 1024 / 1024).toFixed(1)} MB`);
  console.log(`converting to WebP q=${QUALITY}...`);

  let converted = 0;
  let failed = 0;
  let totalAfter = 0;
  const errors = [];

  for (let i = 0; i < pngs.length; i++) {
    const r = await convertOne(pngs[i]);
    if (r.ok) {
      converted++;
      totalAfter += r.after;
    } else {
      failed++;
      errors.push({ file: pngs[i], error: r.error });
    }
    if ((i + 1) % 500 === 0) {
      process.stdout.write(`  ${i + 1}/${pngs.length} (converted ${converted}, failed ${failed})\n`);
    }
  }

  console.log('---');
  console.log(`converted: ${converted}`);
  console.log(`failed:    ${failed}`);
  console.log(`total before: ${(totalBefore / 1024 / 1024).toFixed(1)} MB`);
  console.log(`total after:  ${(totalAfter / 1024 / 1024).toFixed(1)} MB`);
  console.log(`saved: ${((totalBefore - totalAfter) / 1024 / 1024).toFixed(1)} MB (${(((totalBefore - totalAfter) / totalBefore) * 100).toFixed(1)}%)`);
  if (errors.length) {
    console.log(`\nfirst 5 errors:`);
    for (const e of errors.slice(0, 5)) console.log(`  - ${e.file}: ${e.error}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
