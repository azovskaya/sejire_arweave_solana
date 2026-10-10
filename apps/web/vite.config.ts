import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import react from "@vitejs/plugin-react";

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
  plugins: [react(), nodePolyfills({ globals: { Buffer: true, global: true, process: true } }), spaFallback404()],
  resolve: {
    // Prefer browser build; node entry breaks Vite CJS default interop (.init).
    alias: [{ find: "@sejire/payment-panels", replacement: resolve(__dirname, process.env.VITE_NATIVE_AR_ENABLED === "1" ? "src/components/paymentPanels.native.ts" : "src/components/paymentPanels.legacy.ts") }, { find: /^arweave$/, replacement: resolve(__dirname, "node_modules/arweave/web/index.js") }],
  },
  optimizeDeps: {
    // Dev-only fixture discovery must finish before the first browser imports its software signer.
    // Does not add test entrypoints to the production Rollup build.
    entries: ["index.html", "tests/*fixture.ts"],
    include: ["arweave/web/index.js", "node-forge", "@scure/bip39", "@noble/hashes", "@noble/curves/ed25519", "@solana/web3.js", "bs58", "buffer"],
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
