// The Silver Bullet subject: imports src/w.txt via a raw-suffixed specifier
// only — no other edge into the dependency graph. Selecting this test when
// w.txt changes proves the blind channel (a Vite `?raw` import the static
// oxc-parser walk cannot resolve to a real module) is closed by the runtime
// reporter + query-suffix handling.
import raw from '../src/w.txt?raw';
import { test, expect } from 'vitest';

test('t reads w.txt via a raw import', () => {
  expect(raw.length).toBeGreaterThan(0);
});
