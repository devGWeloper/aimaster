import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// AutoQual 운영 UI — 빌드 결과물(dist/)은 FastAPI(ui/server.py)가 그대로 서빙한다.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:8765', changeOrigin: true } } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1500 },
})
