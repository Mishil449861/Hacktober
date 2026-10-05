import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/uploads': 'http://localhost:8787',
    },
    // Only the web app's sources matter; don't watch the Python env, server data or demo assets.
    watch: { ignored: ['**/.venv/**', '**/data/**', '**/data-eval/**', '**/demo/**', '**/tests/**'] },
  },
})
