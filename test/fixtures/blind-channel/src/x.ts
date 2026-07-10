// Sibling source file with NO edge to w.txt or to tests/t.test.ts. Imported
// only by tests/u.test.ts — the control edge used to prove that changing this
// file does NOT select tests/t.test.ts (the raw-import test).
export const x = 1;
