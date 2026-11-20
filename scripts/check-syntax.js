// Static syntax sweep over the code that ships.
//
// WHY this exists, and why it is not ESLint:
//
// The repo has no devDependencies and no lockfile entries to spare, and the
// checks that matter most are the cheapest ones: a typo'd brace, a stray `}`,
// a half-finished edit or a `catch` without a body all leave a file that only
// fails when that code path is first executed — which, for the player, the
// Range handler or the service worker, may be on somebody's phone. `node
// --check` parses a file without running it and catches exactly that class of
// breakage in under a second per file.
//
// It does NOT catch an undeclared identifier or an unused variable; that needs
// a real parser with scope tracking (`no-undef`/`no-unused-vars` in ESLint).
// Adding ESLint here was deliberately not done: it is an npm install plus a
// package-lock change, and a package.json that disagrees with the lockfile makes
// every `npm ci` in CI fail. This script is the no-network, no-dependency half
// of that finding, and it runs in CI on every push.
//
// Files are parsed as ESM (package.json says "type": "module"), so `import`,
// top-level `await` and the browser modules under public/ all check the same way
// they get loaded.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `.pathname`: pathname is percent-encoded, so a checkout in
// a directory with a space or a non-ASCII character ("/home/me/my repo") turned
// into a path `node --check` could not open. This is also why the script no
// longer depends on the caller's working directory.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// test/ is not swept on purpose: it is 40 files of fixture-heavy code, and a
// syntax error there fails the test job within seconds anyway with a far better
// message (the file and the line Node choked on).
const ROOTS = ['src', 'public', 'scripts'];

function jsFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      jsFiles(full, out);
    } else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = ROOTS.flatMap((rel) => jsFiles(path.join(ROOT, rel))).sort();
if (!files.length) {
  console.error('check-syntax: no files found — the src/, public/ and scripts/ directories are missing next to this script');
  process.exit(1);
}

const failures = [];
for (const file of files) {
  // --check parses and exits; it never evaluates a module, so nothing here can
  // open a database, bind a port or spawn yt-dlp.
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    failures.push({ file: path.relative(ROOT, file), detail: `${res.stderr || res.stdout || ''}`.trim() });
  }
}

if (failures.length) {
  // The parser's own message already names the line and the token; stripping the
  // `node:internal` stack frames leaves exactly the part worth reading.
  for (const { file, detail } of failures) {
    console.error(`\n✗ ${file}\n${detail.split('\n').slice(0, 6).join('\n')}`);
  }
  console.error(`\ncheck-syntax: ${failures.length} of ${files.length} files do not parse.`);
  process.exit(1);
}

console.log(`check-syntax: ${files.length} files parse cleanly (src/, public/, scripts/).`);