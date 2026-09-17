import { defineConfig } from 'vite';

// base:'./' 使 dist 产物可放在任意子路径下用任意静态服务器运行
export default defineConfig({
  base: './',
  server: { port: 8080 },
  preview: { port: 8080 },
  build: { outDir: 'dist' },
});
