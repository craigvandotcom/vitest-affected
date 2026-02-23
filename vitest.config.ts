import { defineConfig } from 'vitest/config';
import { vitestAffected } from './dist/index.js';

export default defineConfig({
  plugins: [vitestAffected({ verbose: true })],
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixtures/**'],
  },
});
