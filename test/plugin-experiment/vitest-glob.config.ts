import { defineConfig } from 'vitest/config'
import { filterPluginGlob } from './filter-plugin-glob.js'

export default defineConfig({
  plugins: [filterPluginGlob()],
  test: {
    include: ['**/*.test.ts'],
    root: import.meta.dirname,
  }
})
