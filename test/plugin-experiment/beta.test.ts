import { test, expect } from 'vitest'

test('beta test - SHOULD BE FILTERED OUT', () => {
  console.log('>>> BETA TEST EXECUTED <<<')
  expect(2 + 2).toBe(4)
})
