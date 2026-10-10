import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./tests',testMatch:'admin-password.spec.mjs',timeout:60_000,workers:1,reporter:'list',
  use:{baseURL:'http://127.0.0.1:5181',headless:true,locale:'ru-RU'},
  webServer:{command:'npm run dev -- --host 127.0.0.1 --port 5181 --strictPort',url:'http://127.0.0.1:5181',reuseExistingServer:false,
    env:{VITE_NATIVE_AR_ENABLED:'1',VITE_PRESERVATION_V2_ENABLED:'1',VITE_NATIVE_AR_PILOT:'1',VITE_NATIVE_AR_BROADCAST:'0',VITE_NATIVE_SOL_MAINNET:'0',VITE_QA_TOOLS:'0',VITE_PUBLISH_MODE:'solana',VITE_SOLANA_NETWORK:'devnet'}},
});
