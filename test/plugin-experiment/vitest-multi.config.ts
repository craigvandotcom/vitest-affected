import { defineConfig } from 'vitest/config'
import { filterPluginMulti } from './filter-plugin-multi.js'

export default defineConfig({
  plugins: [filterPluginMulti()],
  test: {
    include: ['**/*.test.ts'],
    root: import.meta.dirname,
  }
})
