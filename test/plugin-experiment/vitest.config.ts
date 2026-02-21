import { defineConfig } from 'vitest/config'
import { filterPlugin } from './filter-plugin.js'

export default defineConfig({
  plugins: [filterPlugin()],
  test: {
    include: ['**/*.test.ts'],
    root: import.meta.dirname,
  }
})
