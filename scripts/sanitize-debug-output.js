'use strict';

/*
 * Rewrites existing dumps under debug-output/ in place with the same
 * redaction the dump script now applies. Dumps taken before redaction
 * existed carry account identity, location and network data; this strips
 * them while leaving the device shadow properties intact.
 *
 * Usage: npm run sanitize:debug
 */

const fs = require('fs/promises');
const path = require('path');
const { redact } = require('./redact');

const ROOT = path.join(__dirname, '..', 'debug-output');

async function walkDir(dir) {
  const files = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkDir(full)));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const files = await walkDir(ROOT);
  if (!files.length) {
    console.log('No dumps found under debug-output/');
    return;
  }

  let changed = 0;
  for (const file of files) {
    const before = await fs.readFile(file, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(before);
    } catch (error) {
      console.log(`skipped (not valid JSON): ${path.relative(ROOT, file)}`);
      continue;
    }
    const after = `${JSON.stringify(redact(parsed), null, 2)}\n`;
    if (after !== before) {
      await fs.writeFile(file, after);
      changed++;
      console.log(`redacted: ${path.relative(ROOT, file)}`);
    }
  }
  console.log(`\n${changed} of ${files.length} file(s) rewritten.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
