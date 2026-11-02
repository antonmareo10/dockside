#!/usr/bin/env node
// Checks that every named import from the Forge packages used in src/ is really
// exported by the installed version. Exports are read from the packages' .d.ts files
// (following `export * from`), because @forge/bridge cannot load outside Atlassian.
// Webpack only warns about missing named imports, so the bundle check alone would miss them.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pkgs = ['@forge/react', '@forge/bridge', '@forge/api', '@forge/kvs', '@forge/resolver'];

function dtsExports(file, seen = new Set()) {
  const out = new Set();
  if (seen.has(file) || !fs.existsSync(file)) return out;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  const resolve = (spec) => {
    const base = path.resolve(dir, spec);
    for (const c of [`${base}.d.ts`, path.join(base, 'index.d.ts')]) if (fs.existsSync(c)) return c;
    return null;
  };
  for (const m of src.matchAll(/export\s+\*\s+from\s+['"](\.[^'"]+)['"]/g)) { const f = resolve(m[1]); if (f) for (const n of dtsExports(f, seen)) out.add(n); }
  for (const m of src.matchAll(/export\s+\*\s+as\s+(\w+)\s+from/g)) out.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:const|let|var|function|class|enum|type|interface|abstract\s+class)\s+(\w+)/g)) out.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) for (const part of m[1].split(',')) { const p = part.trim().replace(/^type\s+/, ''); if (!p) continue; const as = p.split(/\s+as\s+/); out.add((as[1] || as[0]).trim()); }
  if (/export\s+default\b/.test(src)) out.add('default');
  return out;
}

const exportsOf = {};
for (const pkg of pkgs) {
  const pj = path.join(root, 'node_modules', pkg, 'package.json');
  const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
  const types = meta.types || meta.typings || 'out/index.d.ts';
  exportsOf[pkg] = dtsExports(path.join(path.dirname(pj), types));
}

const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|jsx)$/.test(e.name)) files.push(p); } })(path.join(root, 'src'));
let bad = 0;
let checked = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+'([^']+)'/g)) {
    const [, clause, pkg] = m;
    if (!pkgs.includes(pkg)) continue;
    const ex = exportsOf[pkg];
    const named = (clause.match(/\{([\s\S]*)\}/) || [, ''])[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    const hasDefault = /^[A-Za-z_$][\w$]*\s*(,|$)/.test(clause.trim());
    if (hasDefault) { checked++; if (!ex.has('default')) { console.log(`${path.relative(root, f)}: ${pkg} has no default export`); bad++; } }
    for (const n of named) { checked++; if (!ex.has(n)) { console.log(`${path.relative(root, f)}: ${pkg} does not export ${n}`); bad++; } }
  }
}
console.log(bad ? `${bad} missing import(s)` : `All ${checked} imports from Forge packages exist (${files.length} files).`);
process.exit(bad ? 1 : 0);
