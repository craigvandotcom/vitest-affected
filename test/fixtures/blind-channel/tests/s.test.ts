// The alwaysRunTests subject: entirely unrelated to w.txt, x.ts, t.test.ts,
// and u.test.ts. Selected only via the alwaysRunTests option, never via BFS.
import { test, expect } from 'vitest';

test('s is unrelated to every other fixture edge', () => {
  expect(1).toBe(1);
});
