// Ambient module declaration for Vite's `?raw` import suffix, used by
// tests/t.test.ts (`import raw from '../src/w.txt?raw'`). oxc-resolver +
// Vite handle this at build/dev time; TypeScript needs an explicit ambient
// declaration since tsconfig.test.json type-checks everything under test/,
// including fixture sources, and has no `vite/client` types reference.
declare module '*?raw' {
  const content: string;
  export default content;
}
