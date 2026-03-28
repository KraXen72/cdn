import { defineConfig } from 'vite';

export default defineConfig({
  // Build to dist/ — served at /pdf-to-graphviz/dist/ on GitHub Pages
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // pdfjs-dist is large; externalise it or let it bundle inline
    },
  },
  // Base path for GitHub Pages: /pdf-to-graphviz/dist/
  base: './',
  optimizeDeps: {
    include: ['pdfjs-dist'],
  },
});
