#!/usr/bin/env node
/**
 * docusaurus/static/img/ 의 모든 JPG/JPEG → WebP q=85 일괄 변환.
 *   - 변환 후 원본 JPG 삭제
 *
 * 사용법:
 *   node scripts/jpg-to-webp.js
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

async function convertOne(jpgPath) {
  const webpPath = jpgPath.replace(/\.(jpg|jpeg)$/i, '.webp');
  const before = fs.statSync(jpgPath).size;
  // 같은 stem.webp 가 이미 존재 (PNG에서 변환된 경우)? 충돌 방지
  if (fs.existsSync(webpPath) && webpPath !== jpgPath) {
    // 동일 basename을 가진 WebP가 이미 있음 → 스킵 (수동 처리 필요)
    return { ok: false, before, error: 'webp target already exists (basename collision)' };
  }
  try {
    await sharp(jpgPath).webp({ quality: QUALITY }).toFile(webpPath);
    const after = fs.statSync(webpPath).size;
    fs.unlinkSync(jpgPath);
    return { ok: true, before, after };
  } catch (e) {
    return { ok: false, before, error: e.message };
  }
}

async function main() {
  const jpgs = [...walk(STATIC_IMG)].filter((f) => /\.(jpg|jpeg)$/i.test(f));
  console.log(`JPG/JPEG files: ${jpgs.length}`);
  const totalBefore = jpgs.reduce((s, f) => s + fs.statSync(f).size, 0);
  console.log(`total size: ${(totalBefore / 1024 / 1024).toFixed(1)} MB`);
  console.log(`converting to WebP q=${QUALITY}...`);

  let converted = 0;
  let failed = 0;
  let totalAfter = 0;
  const errors = [];

  for (let i = 0; i < jpgs.length; i++) {
    const r = await convertOne(jpgs[i]);
    if (r.ok) {
      converted++;
      totalAfter += r.after;
    } else {
      failed++;
      errors.push({ file: jpgs[i], error: r.error });
    }
    if ((i + 1) % 500 === 0) {
      process.stdout.write(`  ${i + 1}/${jpgs.length}\n`);
    }
  }

  console.log('---');
  console.log(`converted: ${converted}`);
  console.log(`failed:    ${failed}`);
  console.log(`total before: ${(totalBefore / 1024 / 1024).toFixed(1)} MB`);
  console.log(`total after:  ${(totalAfter / 1024 / 1024).toFixed(1)} MB`);
  console.log(`saved: ${((totalBefore - totalAfter) / 1024 / 1024).toFixed(1)} MB (${(((totalBefore - totalAfter) / totalBefore) * 100).toFixed(1)}%)`);
  if (errors.length) {
    console.log(`\nfirst 10 errors:`);
    for (const e of errors.slice(0, 10)) console.log(`  - ${e.file}: ${e.error}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
