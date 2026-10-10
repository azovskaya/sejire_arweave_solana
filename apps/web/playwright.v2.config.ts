import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests',testMatch:'preservation-v2.spec.mjs',timeout:60_000,workers:1,reporter:'list',
  use:{baseURL:'http://127.0.0.1:5177',headless:true},
  webServer:{command:'npm run dev -- --host 127.0.0.1 --port 5177 --strictPort',url:'http://127.0.0.1:5177',reuseExistingServer:false,
    env:{VITE_NATIVE_AR_ENABLED:'1',VITE_PRESERVATION_V2_ENABLED:'1',VITE_PRESERVATION_V2_TEST:'1',VITE_NATIVE_AR_PILOT:'1',VITE_NATIVE_AR_BROADCAST:'0',VITE_NATIVE_SOL_MAINNET:'0',VITE_PUBLISH_MODE:'solana',VITE_SOLANA_NETWORK:'devnet'}},
});
