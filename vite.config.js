import { defineConfig } from 'vite';
import { resolve } from 'path';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        { src: 'manifest.json', dest: '' }
      ]
    })
  ],
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, '/index.html'),
        scrape: resolve(__dirname, 'src/scripts/scrape.js'),
        background: resolve(__dirname, 'src/scripts/background.js'),
        zipper: resolve(__dirname, 'src/scripts/zipper.js')
      },
      output: {
        entryFileNames: 'src/scripts/[name].js',
        chunkFileNames: 'src/scripts/[name].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    },
    outDir: 'dist',
    emptyOutDir: true,
  }
});