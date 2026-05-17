import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

const isDev = process.env.NODE_ENV === 'development';

// Shared configuration
const sharedConfig = {
  input: 'src/index.ts',
  plugins: [
    nodeResolve(),
    commonjs(),
    typescript({
      tsconfig: './tsconfig.build.json',
      sourceMap: isDev,
      inlineSources: isDev,
    }),
  ],
};

// Development build configuration
const devConfig = [
  // ES module build
  {
    ...sharedConfig,
    output: {
      file: 'dist/index.esm.js',
      format: 'es',
      sourcemap: true,
    },
    plugins: [
      ...sharedConfig.plugins,
      typescript({
        tsconfig: './tsconfig.build.json',
        declaration: false, // Disable declaration output from Rollup; use tsc separately
        sourceMap: true,
        inlineSources: true,
      }),
    ],
    watch: {
      include: 'src/**',
    },
  },
  // CommonJS build
  {
    ...sharedConfig,
    output: {
      file: 'dist/index.cjs.js',
      format: 'cjs',
      sourcemap: true,
    },
    watch: {
      include: 'src/**',
    },
  },
];

// Production build configuration
const prodConfig = [
  // ES module build
  {
    ...sharedConfig,
    output: {
      file: 'dist/index.esm.js',
      format: 'es',
      sourcemap: true,
    },
    plugins: [
      ...sharedConfig.plugins,
      typescript({
        tsconfig: './tsconfig.build.json',
        declaration: false, // Disable declaration output from Rollup; use tsc separately
        sourceMap: false,
      }),
      terser({
        compress: {
          drop_console: true,
        },
      }),
    ],
  },
  // CommonJS build
  {
    ...sharedConfig,
    output: {
      file: 'dist/index.cjs.js',
      format: 'cjs',
      sourcemap: true,
    },
    plugins: [
      ...sharedConfig.plugins,
      terser({
        compress: {
          drop_console: true,
        },
      }),
    ],
  },
  // UMD build
  {
    ...sharedConfig,
    output: {
      file: 'dist/index.umd.js',
      format: 'umd',
      name: 'TimelineEngine',
      sourcemap: true,
    },
    plugins: [
      ...sharedConfig.plugins,
      terser({
        compress: {
          drop_console: true,
        },
      }),
    ],
  },
  // Minified UMD build
  {
    ...sharedConfig,
    output: {
      file: 'dist/index.umd.min.js',
      format: 'umd',
      name: 'TimelineEngine',
      sourcemap: true,
    },
    plugins: [
      ...sharedConfig.plugins,
      terser({
        compress: {
          drop_console: true,
        },
      }),
    ],
  },
];

export default isDev ? devConfig : prodConfig;