import { defineConfig } from 'vite';
import { extensions, classicEmberSupport, ember } from '@embroider/vite';
import { babel } from '@rollup/plugin-babel';

export default defineConfig({
  plugins: [
    classicEmberSupport(),
    ember(),
    babel({
      babelHelpers: 'runtime',
      extensions,
    }),
  ],
  optimizeDeps: {
    // alasql and buffer are CJS; pre-bundle them so Vite serves them as ESM
    include: ['alasql', 'buffer'],
  },
  resolve: {
    alias: {
      // Redirect bare 'buffer' imports to the browser polyfill package
      buffer: 'buffer/',
    },
  },
});
