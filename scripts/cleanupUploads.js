#!/usr/bin/env node
/**
 * Cleanup old uploaded PDF files.
 * Usage: node scripts/cleanupUploads.js [--days=2]
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const argDays = process.argv.find(a => a.startsWith('--days='));
const days = argDays ? Number(argDays.split('=')[1]) : 2; // default 2 days
if (isNaN(days) || days <= 0) {
  console.error('Invalid days value.');
  process.exit(1);
}

const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
let removed = 0;
let kept = 0;

if (!fs.existsSync(uploadDir)) {
  console.log('Upload directory not found:', uploadDir);
  process.exit(0);
}

for (const file of fs.readdirSync(uploadDir)) {
  const full = path.join(uploadDir, file);
  try {
    const stat = fs.statSync(full);
    if (stat.isFile()) {
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed++;
      } else {
        kept++;
      }
    }
  } catch (e) {
    console.warn('Skip file error', file, e.message);
  }
}

console.log(`Cleanup done. Removed: ${removed}, Kept: ${kept}, Days threshold: ${days}`);