/// <reference types="vitest/config" />
import type { Plugin } from 'vite'

/**
 * Experiment 2: Does glob-based filtering work too?
 * Try filtering with a pattern that only matches alpha.
 */
export function filterPluginGlob(): Plugin {
  return {
    name: 'vitest:filter-experiment-glob',

    configureVitest({ vitest }: any) {
      console.log('\n=== FILTER PLUGIN GLOB: configureVitest called ===')
      console.log('Original config.include:', JSON.stringify(vitest.config.include))

      // Use a glob that only matches alpha
      vitest.config.include = ['**/alpha.test.ts']

      console.log('Mutated config.include to:', JSON.stringify(vitest.config.include))
      console.log('=== END FILTER PLUGIN ===\n')
    }
  }
}
