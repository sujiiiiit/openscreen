import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  // Plugins used by this build
  plugins: [
    react(),
    // Use the dts plugin to emit TypeScript declaration files
    dts({
      include: ['src/**/*'],
      outDir: 'dist',
      insertTypesEntry: true,
      compilerOptions: {
        declaration: true,
        emitDeclarationOnly: true
      }
    })
  ],
  // Path alias configuration
  resolve: {
  },
  // Build configuration
  build: {
    // Library mode configuration
    lib: {
      entry: path.resolve(__dirname, 'src/index.tsx'),
      name: 'react-timeline-editor',
      formats: ['es', 'umd', 'cjs'],
      fileName: (format) => `index.${format}.js`,
    },
    // Rollup bundling options
    rollupOptions: {
      // Mark dependencies that should not be bundled into the library
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        // Provide globals for the externalized dependencies in UMD builds
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'ReactJsxRuntime',
        },
      },
    },
  },
});
