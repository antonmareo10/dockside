#!/usr/bin/env node
// Offline checks that do not need `forge login`:
//   1. Full manifest validation with @forge/manifest (the package the Forge CLI uses for lint and deploy).
//   2. The client-side linters from @forge/lint (scopes used in code vs manifest, handlers, UI Kit files).
// `forge lint` itself requires a session, so this runs the same validators directly.
// It is a pre-check; `forge lint` and `forge deploy` stay the final word.

const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
process.chdir(root);

const manifestPkg = require(require.resolve('@forge/manifest', { paths: [root] }));
const lintPath = require.resolve('@forge/lint', { paths: [path.join(root, 'node_modules/@forge/cli')] });
const lintPkg = require(lintPath);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(entry.name)) out.push(p);
  }
  return out;
}

(async () => {
  let failed = false;
  const result = await manifestPkg.validate(false, path.join(root, 'manifest.yml'));
  const errors = result.errors ?? [];
  console.log(`Manifest validation (@forge/manifest): ${result.success ? 'passed' : 'FAILED'}`);
  for (const e of errors) {
    console.log(`  [${e.level ?? 'error'}] ${e.message}${e.line ? ` (line ${e.line})` : ''}`);
    if ((e.level ?? 'error') === 'error') failed = true;
  }
  if (!result.success) failed = true;

  const manifest = result.manifestObject?.typedContent ?? result.manifestObject?.yamlContent;
  if (manifest) {
    const files = walk(path.join(root, 'src'));
    const statsigStub = new Proxy({}, { get: (_t, prop) => (prop === 'getDeprecatedRuntimes' ? async () => [] : async () => false) });
    const lines = [];
    const logger = { info: (m) => lines.push(String(m)) };
    const lintResults = await lintPkg.lint(files, manifest, 'development', logger, statsigStub, { linter: { mode: 'client-side' } });
    const count = lintPkg.problemCount(lintResults);
    lintPkg.reportLintResults(logger, lintResults, true);
    console.log(`Client-side lint (@forge/lint): ${count.errors} errors, ${count.warnings} warnings, on ${files.length} files`);
    for (const l of lines) if (l.trim()) console.log(`  ${l}`);
    if (count.errors > 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Validation could not run:', e?.stack ?? e);
  process.exit(2);
});
