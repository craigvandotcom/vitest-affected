/// <reference types="vitest/config" />
import type { Plugin } from 'vite'
import path from 'node:path'

/**
 * Experiment: Can a configureVitest plugin filter tests by mutating config.include?
 *
 * We set config.include to ONLY alpha.test.ts.
 * If beta.test.ts still runs, the plugin approach CANNOT filter tests.
 * If only alpha.test.ts runs, the plugin approach WORKS.
 */
export function filterPlugin(): Plugin {
  return {
    name: 'vitest:filter-experiment',

    configureVitest({ vitest, project }: any) {
      const alphaPath = path.resolve(__dirname, 'alpha.test.ts')

      console.log('\n=== FILTER PLUGIN: configureVitest called ===')
      console.log('Original config.include:', JSON.stringify(vitest.config.include))

      // EXPERIMENT 1: Try mutating config.include to only alpha
      vitest.config.include = [alphaPath]

      console.log('Mutated config.include to:', JSON.stringify(vitest.config.include))
      console.log('=== END FILTER PLUGIN ===\n')
    }
  }
}
