import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: false, outDir: 'dist', rollupOptions: { input: { wallet: 'index.html', onboarding: 'onboarding.html' } } }, 
});
