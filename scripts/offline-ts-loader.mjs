/** Local Catalina fallback: pure-JS TypeScript transpilation, NOT a type check.
 * Uses the existing sponsor TypeScript dependency. Does not modify source or global tools.
 * Run: node --loader ./scripts/offline-ts-loader.mjs <entry.ts|entry.mts>
 */
import ts from '../apps/sponsor/node_modules/typescript/lib/typescript.js';
import { readFile, access } from 'node:fs/promises';
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if (!specifier.startsWith('.') || !context.parentURL) throw error;
    for (const suffix of ['.ts', '.mts']) {
      const url = new URL(specifier + suffix, context.parentURL);
      try { await access(url); return { url: url.href, shortCircuit: true }; } catch {}
    }
    throw error;
  }
}
export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !/\.(?:ts|mts)$/.test(url)) return nextLoad(url, context);
  const source = await readFile(new URL(url), 'utf8');
  const output = ts.transpileModule(source, { fileName: new URL(url).pathname,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, isolatedModules: true } });
  return { format: 'module', source: output.outputText, shortCircuit: true };
}
