/// <reference types="vitest/config" />
import type { Plugin } from 'vite'

/**
 * Experiment 4: What happens if we set include to empty array?
 * (Edge case: no files changed, no tests affected)
 */
export function filterPluginEmpty(): Plugin {
  return {
    name: 'vitest:filter-experiment-empty',

    configureVitest({ vitest }: any) {
      console.log('\n=== FILTER PLUGIN EMPTY ===')
      vitest.config.include = []
      console.log('Set config.include to empty array')
      console.log('=== END EMPTY ===\n')
    }
  }
}
