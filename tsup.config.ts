import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/internal.ts', 'src/explain-cli.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
});
