// Private entry — the replay-harness surface, NOT part of the public API.
//
// Emitted to dist/internal.js and DELIBERATELY absent from package.json's
// exports map (which stays exactly `["."]`), so this is not an importable
// public subpath and not documented. It exists solely so the replay tooling
// (tools/replay/*, test/replay*.test.ts) can import the two symbols it needs
// from the BUILT artifact — the same reason evolution.ts imports from dist
// rather than src — without those symbols being forced onto the public
// dist/index.js surface (see va-hygiene-20260706-deferred-wlm.9).
export { mergeRuntimeEdges } from './runtime-merge.js';
export type { ReverseMap } from './graph/types.js';
