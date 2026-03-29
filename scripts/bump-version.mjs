#!/usr/bin/env node
/**
 * Atomically bump version across all packages in the monorepo.
 * Usage: node scripts/bump-version.mjs <patch|minor|major>
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const bumpType = process.argv[2] || 'patch';
if (!['patch', 'minor', 'major'].includes(bumpType)) {
  console.error('Usage: node scripts/bump-version.mjs <patch|minor|major>');
  process.exit(1);
}

// Read current version from root shared package
const sharedPkg = JSON.parse(readFileSync('packages/shared/package.json', 'utf-8'));
const current = sharedPkg.version;
const [major, minor, patch] = current.split('.').map(Number);

const newVersion =
  bumpType === 'major' ? `${major + 1}.0.0` :
  bumpType === 'minor' ? `${major}.${minor + 1}.0` :
  `${major}.${minor}.${patch + 1}`;

console.log(`Bumping ${current} → ${newVersion} (${bumpType})\n`);

// Update all packages
const pkgDirs = readdirSync('packages').filter(d =>
  existsSync(join('packages', d, 'package.json'))
);

let updated = 0;
for (const dir of pkgDirs) {
  const pkgPath = join('packages', dir, 'package.json');
  const raw = readFileSync(pkgPath, 'utf-8');
  // Replace all occurrences of the old version (own version + internal dep versions)
  const newRaw = raw.replaceAll(current, newVersion);
  if (newRaw !== raw) {
    writeFileSync(pkgPath, newRaw);
    updated++;
    console.log(`  ✓ packages/${dir}/package.json`);
  }
}

// Also update root package.json if it has a version
const rootPkgPath = 'package.json';
if (existsSync(rootPkgPath)) {
  const raw = readFileSync(rootPkgPath, 'utf-8');
  const newRaw = raw.replaceAll(current, newVersion);
  if (newRaw !== raw) {
    writeFileSync(rootPkgPath, newRaw);
    updated++;
    console.log(`  ✓ package.json (root)`);
  }
}

console.log(`\n${updated} files updated to ${newVersion}`);
console.log(`\nNext steps:`);
console.log(`  git add -A && git commit -m "chore: bump version to ${newVersion}"`);
console.log(`  git tag v${newVersion}`);
console.log(`  git push origin main --tags`);
