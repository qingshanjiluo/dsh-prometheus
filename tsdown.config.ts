import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'client/index': 'client/index.tsx',
  },
  format: 'esm',
  dts: true,
  clean: true,
});
