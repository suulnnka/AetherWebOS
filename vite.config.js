import { defineConfig } from 'vite';

// base:'./' 使 dist 产物可放在任意子路径下用任意静态服务器运行
export default defineConfig({
  base: './',
  server: { port: 8080 },
  preview: { port: 8080 },
  /* 象棋引擎(ai-worker.js)走独立 Worker chunk:
   * - format:'es' 是因为 index.js 里用 new Worker(url, { type: 'module' })
   * - 固定文件名便于 tools/check-size.mjs 定位并卡 35KB gzip 预算 */
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app-chess3d-worker-[hash].js',
        chunkFileNames: 'assets/app-chess3d-worker-[hash].js',
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        /* 共享内核独立成 chunk:应用只依赖内核,不依赖主包,
         * 改单个应用的代码不会级联改名其它应用(浏览器缓存友好)。
         * 归入 core 的三类模块:
         * 1. js/core 下的内核模块
         * 2. 各应用的清单文件(装配表(主包)与各应用都要用,放 core
         *    才能避免应用 chunk 反向引用主包)
         * 3. system/session.js(被设置应用引用,同理归入稳定区)
         * 注意:应用只能 import js/core 与自身目录,否则会重新引入级联 */
        manualChunks(id) {
          if (/[\\/]js[\\/]core[\\/]/.test(id)) return 'core';
          if (/[\\/]apps[\\/]\w+[\\/]manifest\.js/.test(id)) return 'core';
          if (/[\\/]system[\\/]session\.js/.test(id)) return 'core';
          if (id.includes('preload-helper')) return 'core';   // Vite 动态 import 辅助函数
        },
        // 每个应用拆为独立 chunk(首开窗口时按需加载),
        // 以应用目录命名便于辨识:assets/app-<id>-[hash].js
        chunkFileNames(chunk) {
          const m = chunk.facadeModuleId?.match(/[\\/]apps[\\/](\w+)[\\/]index\.js$/);
          return m ? `assets/app-${m[1]}-[hash].js` : 'assets/[name]-[hash].js';
        },
        // 应用 CSS 随各自 chunk 拆分,同样以应用命名
        assetFileNames(info) {
          const m = (info.originalFileNames?.[0] ?? info.originalFileName ?? '')
            .match(/[\\/]apps[\\/](\w+)[\\/]/);
          return m ? `assets/app-${m[1]}-[hash][extname]` : 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
