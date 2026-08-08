import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Relative base so the build works unmodified on GitHub Pages (project sites,
  // any subpath), Netlify, Vercel, or Cloudflare Pages without extra config.
  base: './',
  plugins: [react()],
})
