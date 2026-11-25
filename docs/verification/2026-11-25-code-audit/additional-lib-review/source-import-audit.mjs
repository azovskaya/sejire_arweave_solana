/** Read-only source import inventory. This does not run, bundle, or test the app. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(output, '../../../..');
const require = createRequire(path.join(root, 'apps/web/package.json'));
const ts = require('typescript');
const rel = value => path.relative(root, value).replaceAll(path.sep, '/');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const aliases = {
  '@sejire/app': 'apps/web/src/App.tsx',
  '@sejire/publish': 'apps/web/src/components/PublishSeedModal.tsx',
  '@sejire/preservation-context': 'apps/web/src/lib/preservationContext.legacy.ts',
  '@sejire/payment-panels': 'apps/web/src/components/paymentPanels.native.ts',
};
const isCode = file => /\.(?:[cm]?[jt]sx?)$/.test(file);
const inventory = [];
function walk(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) walk(file);
    else if (/\.tsx?$/.test(file) && !/(?:selftest|\.test\.|\.spec\.|\.e2e\.|\.fixture\.|\.d\.ts$)/.test(file)) inventory.push(rel(file));
  }
}
walk(path.join(root, 'apps/web/src/lib'));
inventory.sort();

function resolveLocal(from, specifier) {
  const clean = specifier.split(/[?#]/, 1)[0];
  if (aliases[clean]) return path.join(root, aliases[clean]);
  if (!clean.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), clean);
  const choices = [base, ...['.ts', '.tsx', '.mts', '.js', '.mjs', '.json'].map(ext => base + ext),
    ...['index.ts', 'index.tsx', 'index.mts', 'index.js'].map(name => path.join(base, name))];
  if (/\.[cm]?js$/.test(base)) choices.push(base.replace(/\.[cm]?js$/, '.ts'));
  return choices.find(file => fs.existsSync(file) && fs.statSync(file).isFile()) ?? undefined;
}
function imports(file, source) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const result = [];
  function add(node, specifier, kind) {
    const resolved = resolveLocal(file, specifier);
    result.push({ specifier, kind, line: parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      ...(resolved ? { target: rel(resolved) } : { external: resolved === null, unresolved: resolved === undefined }) });
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const namedOnly = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name &&
        clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(item => item.isTypeOnly);
      add(node, node.moduleSpecifier.text, clause?.isTypeOnly || namedOnly ? 'type-only' : 'static');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const allType = node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every(item => item.isTypeOnly);
      add(node, node.moduleSpecifier.text, node.isTypeOnly || allType ? 'type-only' : 're-export');
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) add(node, node.arguments[0].text, 'dynamic-literal');
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return result;
}
const queue = ['apps/web/src/main.tsx'];
const modules = new Map();
for (let index = 0; index < queue.length; index++) {
  const name = queue[index];
  if (modules.has(name)) continue;
  const file = path.join(root, name), bytes = fs.readFileSync(file);
  const edges = isCode(file) ? imports(file, bytes.toString('utf8')) : [];
  modules.set(name, { path: name, sha256: sha(bytes), bytes: bytes.length, edges });
  for (const edge of edges) if (edge.kind !== 'type-only' && edge.target && !modules.has(edge.target)) queue.push(edge.target);
}
const lib = inventory.map(name => {
  const bytes = fs.readFileSync(path.join(root, name));
  return { path: name, sha256: sha(bytes), lines: bytes.toString('utf8').split('\n').length - (bytes.at(-1) === 10 ? 1 : 0),
    sourceImportReachable: modules.has(name) };
});
const record = {
  schema: 'sejire/source-import-reachability/v1', generatedAt: new Date().toISOString(),
  snapshotCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  method: 'TypeScript AST local-source import graph from funded main.tsx aliases; type-only edges retained but not traversed.',
  caveat: 'Conservative source graph only. It does not fold environment branches, remove unused exports, model all dynamic expressions, or prove emitted JS membership. Current local independent dist is intentionally not consulted.',
  aliasEvidence: 'apps/web/vite.config.ts; scripts/build-arns-promo.sh; VITE_DECENTRALIZED_MODE=false; VITE_NATIVE_AR_ENABLED=1',
  aliases, entrypoint: 'apps/web/src/main.tsx', libraryFileCount: lib.length,
  sourceImportReachableLibraryCount: lib.filter(item => item.sourceImportReachable).length,
  localModuleCountIncludingAssets: modules.size, libraryFiles: lib,
  modules: [...modules.values()].sort((a, b) => a.path.localeCompare(b.path)),
};
fs.writeFileSync(path.join(output, 'source-import-reachability.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ libraryFiles: lib.length, sourceImportReachable: record.sourceImportReachableLibraryCount,
  localModules: modules.size, unresolvedLocalImports: record.modules.flatMap(module => module.edges.filter(edge => edge.unresolved).map(edge => ({ from: module.path, ...edge }))) }));
