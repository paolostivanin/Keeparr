#!/usr/bin/env node
// Bumps a release version in every place that carries it.
//
//   node scripts/bump-version.mjs server <X.Y.Z>
//   node scripts/bump-version.mjs android <X.Y.Z> [versionCode]
//
// `server` covers the web app, API, image and MCP server (tag `vX.Y.Z`).
// `android` covers the native app (tag `android-vX.Y.Z`); versionCode defaults to the current value + 1.
// The script only edits files. Review the diff, commit, then run the tag command it prints.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = (relative) => join(root, relative);

function usage(message) {
  if (message) console.error(`${message}\n`);
  console.error('Usage: node scripts/bump-version.mjs server <X.Y.Z>');
  console.error('       node scripts/bump-version.mjs android <X.Y.Z> [versionCode]');
  process.exit(1);
}

// Replaces exactly one match so a stale pattern fails loudly instead of silently skipping a file.
function replaceOnce(relative, pattern, replacement) {
  const file = path(relative);
  const source = readFileSync(file, 'utf8');
  const matches = source.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`));
  if (matches?.length !== 1) {
    throw new Error(`${relative}: expected exactly one match for ${pattern}, found ${matches?.length ?? 0}`);
  }
  writeFileSync(file, source.replace(pattern, replacement));
}

function bumpJson(relative, edit) {
  const file = path(relative);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  edit(data);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function bumpServer(version) {
  bumpJson('package.json', (pkg) => { pkg.version = version; });
  bumpJson('package-lock.json', (lock) => {
    lock.version = version;
    lock.packages[''].version = version;
  });
  replaceOnce('mcp/server.mjs', /(name: 'keeparr-mcp', version: ')[^']+(')/, `$1${version}$2`);
  const [major, minor] = version.split('.');
  replaceOnce(
    'README.md',
    /(Release tags are also published as )`[^`]+`, `[^`]+` and `[^`]+`/,
    `$1\`${version}\`, \`${major}.${minor}\` and \`${major}\``,
  );
  console.log(`Server/web ${version}. After committing:\n  git tag -a v${version} -m "Keeparr v${version}" && git push origin v${version}`);
}

function bumpAndroid(version, requestedCode) {
  const gradle = 'android-native/app/build.gradle.kts';
  const current = Number(readFileSync(path(gradle), 'utf8').match(/versionCode = (\d+)/)?.[1]);
  if (!Number.isInteger(current)) throw new Error(`${gradle}: versionCode not found`);
  const code = requestedCode ?? current + 1;
  if (code <= current) usage(`versionCode must be greater than the current ${current}`);

  replaceOnce(gradle, /versionCode = \d+/, `versionCode = ${code}`);
  replaceOnce(gradle, /versionName = "[^"]+"/, `versionName = "${version}"`);
  replaceOnce(
    'android-native/app/src/test/java/dev/keeparr/android/ReleaseConfigurationTest.kt',
    /assertEquals\("[^"]+", info\.versionName\)/,
    `assertEquals("${version}", info.versionName)`,
  );
  const contractTest = 'android-native/app/src/test/java/dev/keeparr/android/data/NativeContractTest.kt';
  replaceOnce(contractTest, /assertEquals\("[^"]+", BuildConfig\.VERSION_NAME\)/, `assertEquals("${version}", BuildConfig.VERSION_NAME)`);
  replaceOnce(contractTest, /assertEquals\(\d+, BuildConfig\.VERSION_CODE\)/, `assertEquals(${code}, BuildConfig.VERSION_CODE)`);
  console.log(
    `Android ${version} (versionCode ${code}). After committing:\n` +
    `  git tag -a android-v${version} -m "Keeparr Android ${version}" && git push origin android-v${version}\n` +
    'Create its GitHub release with --latest=false: the server update check reads releases/latest.',
  );
}

const [target, version, code] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) usage('Version must look like X.Y.Z');
if (code !== undefined && !/^\d+$/.test(code)) usage('versionCode must be a positive integer');

if (target === 'server') bumpServer(version);
else if (target === 'android') bumpAndroid(version, code === undefined ? undefined : Number(code));
else usage('Target must be "server" or "android"');
