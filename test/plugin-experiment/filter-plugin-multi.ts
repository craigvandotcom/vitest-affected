/// <reference types="vitest/config" />
import type { Plugin } from 'vite'
import path from 'node:path'

/**
 * Experiment 3: Set include to an array of absolute paths.
 * This is exactly what vitest-affected would do:
 * - BFS finds affected test files as absolute paths
 * - Plugin sets config.include = [...affectedTestPaths]
 *
 * Also test: what happens with onFilterWatchedSpecification for watch mode?
 */
export function filterPluginMulti(): Plugin {
  return {
    name: 'vitest:filter-experiment-multi',

    configureVitest({ vitest }: any) {
      const alphaPath = path.resolve(import.meta.dirname, 'alpha.test.ts')

      console.log('\n=== FILTER PLUGIN MULTI ===')
      console.log('Setting config.include to single absolute path array')

      // This is the exact pattern vitest-affected would use
      vitest.config.include = [alphaPath]

      console.log('config.include =', JSON.stringify(vitest.config.include))

      // Also register watch mode filter (for completeness)
      if (typeof vitest.onFilterWatchedSpecification === 'function') {
        console.log('onFilterWatchedSpecification IS available')
        vitest.onFilterWatchedSpecification((spec: any) => {
          const shouldRun = spec.moduleId === alphaPath
          console.log(`Watch filter: ${spec.moduleId} -> ${shouldRun}`)
          return shouldRun
        })
      } else {
        console.log('onFilterWatchedSpecification NOT available')
      }

      console.log('=== END MULTI ===\n')
    }
  }
}
