// Static production bundle evidence only. No wallet, network payment or deployment.
import { createRequire } from 'node:module';
import { resolve, relative } from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '..'), web = resolve(root, 'apps/web');
const requireWeb = createRequire(resolve(web, 'package.json'));
const { build } = await import(pathToFileURL(requireWeb.resolve('vite')));
const audit = JSON.parse(await readFile(resolve(root, 'docs/verification/2026-09-30-web-production-audit.json'), 'utf8'));
const modules = new Set(), rendered = new Set();
Object.assign(process.env, { VITE_PUBLISH_MODE: 'solana', VITE_SOLANA_NETWORK: 'devnet', VITE_QA_TOOLS: '0' });
await build({ root: web, configFile: resolve(web, 'vite.config.ts'), logLevel: 'warn', build: { write: false },
  plugins: [{ name: 'sejire-security-module-evidence',
    moduleParsed(info) { modules.add(info.id); },
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) if (item.type === 'chunk') {
        for (const [id, meta] of Object.entries(item.modules)) { modules.add(id); if ((meta.renderedLength ?? 0) > 0) rendered.add(id); }
      }
    } }] });
const clean = id => relative(root, id.replace(/^\0/, '').split('?')[0]);
const entries = {};
for (const [pkg, finding] of Object.entries(audit.vulnerabilities)) {
  const ids = [...modules].filter(id => finding.nodes.some(node => id.includes(`/apps/web/${node}/`)));
  const sources = [];
  for (const id of ids) {
    if (id.startsWith('\0') || id.includes('?')) continue;
    try {
      const source = await readFile(id, 'utf8');
      const matches = source.split('\n').map((line, i) => ({ line: i + 1, code: line.trim().slice(0, 220) }))
        .filter(row => /toBigIntLE|ecdh|WebSocketServer|createServer|stream-json|uuid\.v[356]|\bv[356]\(/i.test(row.code));
      if (matches.length) sources.push({ file: clean(id), matches: matches.slice(0, 12) });
    } catch { /* Virtual module or browser stub; recorded by module path above. */ }
  }
  entries[pkg] = { severityAtBaseline: finding.severity, advisory: finding.via, dependencyNodes: finding.nodes,
    includedModules: ids.map(clean).sort(), renderedModules: ids.filter(id => rendered.has(id)).map(clean).sort(), sourceMatches: sources,
    conclusion: ids.length ? 'BUNDLE_PRESENCE_NOT_PROOF_OF_EXPLOIT_REACHABILITY' : 'NOT_IN_THIS_BROWSER_BUILD_NOT_A_GLOBAL_SAFETY_CLAIM' };
}
const result = { date: '2026-09-30', sha: process.env.GITHUB_SHA ?? 'local', target: 'production-format devnet browser bundle',
  method: 'Vite module graph + rendered chunk modules, existing SDK/cryptography unchanged; no dynamic exploit proof', entries };
const out = resolve(root, '.cache/a2-1'); await mkdir(out, { recursive: true });
await writeFile(resolve(out, 'browser-dependency-reachability.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ sha: result.sha, packages: Object.fromEntries(Object.entries(entries).map(([pkg, e]) => [pkg,
  { included: e.includedModules.length, rendered: e.renderedModules.length, verdict: e.conclusion }])) }, null, 2));
