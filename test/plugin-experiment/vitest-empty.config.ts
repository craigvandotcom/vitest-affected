import { defineConfig } from 'vitest/config'
import { filterPluginEmpty } from './filter-plugin-empty.js'

export default defineConfig({
  plugins: [filterPluginEmpty()],
  test: {
    include: ['**/*.test.ts'],
    root: import.meta.dirname,
  }
})
