import { copyFileSync, existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import react from "@vitejs/plugin-react";
import { webProfile, webDefines } from "../../scripts/web-profile.mjs";

const independent = webProfile(process.env.VITE_DECENTRALIZED_MODE) === 'decentralized-direct-arweave';

/** Serve only the published recovery kit during development, without exposing
 * its source directory or letting a missing decoder fall through to the SPA. */
function recoveryKitDev(): Plugin {
  const files = new Map([
    ['recover.mjs', 'text/javascript; charset=utf-8'],
    ['README.md', 'text/markdown; charset=utf-8'],
    ['FORMAT.md', 'text/markdown; charset=utf-8'],
    ['envelope-v1.schema.json', 'application/json; charset=utf-8'],
    ['english.txt', 'text/plain; charset=utf-8'],
    ['LICENSES.txt', 'text/plain; charset=utf-8'],
    ['public-vectors.json', 'application/json; charset=utf-8'],
    ['recovery.html', 'text/html; charset=utf-8'],
  ]);
  return {
    name: 'recovery-kit-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = request.url?.split('?', 1)[0];
        if (!pathname?.startsWith('/recovery/')) return next();
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.statusCode = 405;
          response.setHeader('Allow', 'GET, HEAD');
          response.end('Method not allowed');
          return;
        }
        const name = pathname.slice('/recovery/'.length), mime = files.get(name);
        if (!mime) { response.statusCode = 404; response.end('Recovery file not found'); return; }
        try {
          const path = resolve(__dirname, '../../tools/recovery', name), info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink()) throw Error('invalid_recovery_file');
          const body = request.method === 'HEAD' ? undefined : await readFile(path);
          response.setHeader('Content-Type', mime);
          response.setHeader('Content-Length', body?.length ?? info.size);
          response.end(body);
        } catch {
          response.statusCode = 404;
          response.end('Recovery file unavailable');
        }
      });
    },
  };
}

/** ArNS path manifests treat 404.html as SPA fallback (trailing-slash / deep links). */
function spaFallback404(): Plugin {
  return {
    name: "spa-fallback-404",
    closeBundle() {
      const index = resolve(__dirname, "dist/index.html");
      const fallback = resolve(__dirname, "dist/404.html");
      const faviconSvg = resolve(__dirname, "dist/favicon.svg");
      const faviconIco = resolve(__dirname, "dist/favicon.ico");
      if (existsSync(index)) copyFileSync(index, fallback);
      // Browsers still request /favicon.ico; keep a bytes-on-path so ArNS is not "Not found".
      if (existsSync(faviconSvg) && !existsSync(faviconIco)) copyFileSync(faviconSvg, faviconIco);
    },
  };
}

export default defineConfig({
  base: "./",
  define: webDefines(process.env.VITE_DECENTRALIZED_MODE),
  plugins: [react(), nodePolyfills({ globals: { Buffer: true, global: true, process: true } }),
    ...(independent ? [recoveryKitDev()] : []), spaFallback404()],
  resolve: {
    // Prefer browser build; node entry breaks Vite CJS default interop (.init).
    alias: [
      { find: '@sejire/app', replacement: resolve(__dirname, independent ? 'src/App.independent.tsx' : 'src/App.tsx') },
      { find: '@sejire/publish', replacement: resolve(__dirname, independent ? 'src/components/PublishSeedModal.independent.tsx' : 'src/components/PublishSeedModal.tsx') },
      { find: '@sejire/preservation-context', replacement: resolve(__dirname, independent ? 'src/lib/preservationContext.independent.ts' : 'src/lib/preservationContext.legacy.ts') },
      { find: "@sejire/payment-panels", replacement: resolve(__dirname, process.env.VITE_NATIVE_AR_ENABLED === "1" ? "src/components/paymentPanels.native.ts" : "src/components/paymentPanels.legacy.ts") },
      { find: /^arweave$/, replacement: resolve(__dirname, "node_modules/arweave/web/index.js") },
    ],
  },
  optimizeDeps: {
    // Dev-only fixture discovery must finish before the first browser imports its software signer.
    // Does not add test entrypoints to the production Rollup build.
    entries: ["index.html", "tests/*fixture.ts"],
    include: ["arweave/web/index.js", "node-forge", "@scure/bip39", "@noble/hashes", "buffer", "vite-plugin-node-polyfills/shims/buffer",
      ...(independent ? [] : ["@noble/curves/ed25519", "@solana/web3.js", "bs58"])],
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/],
      transformMixedEsModules: true,
    },
    chunkSizeWarningLimit: 1200,
    modulePreload: {
      resolveDependencies: (_filename, deps) =>
        deps.filter((d) => !d.includes("pdf-vendor") && !d.includes("thirteenLineage")),
    },
    rollupOptions: {
      output: {
        // Avoid circular async chunk with app entry (Safari: Importing a module script failed).
        manualChunks(id) {
          if (id.includes("node_modules/jspdf")) {
            return "pdf-vendor";
          }
          // Keep Arweave/forge off the UI entry and never lazy-import them:
          // a lazy wallet chunk that imports back from index.html's entry
          // fails on ArNS with "Failed to fetch dynamically imported module".
          if (id.includes("node_modules/arweave") || id.includes("node_modules/node-forge")) {
            return "wallet";
          }
        },
      },
    },
  },
});
