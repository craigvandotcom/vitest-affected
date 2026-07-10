// Control test: imports src/x.ts, the sibling file with no relationship to
// w.txt or t.test.ts. Proves the selector's specificity — changing x.ts must
// select ONLY this test, never t.test.ts.
import { x } from '../src/x';
import { test, expect } from 'vitest';

test('u imports the sibling x.ts', () => {
  expect(x).toBe(1);
});
