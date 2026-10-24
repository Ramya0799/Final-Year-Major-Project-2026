// Node 25+ has its own localStorage/sessionStorage globals. Without a storage file,
// Node's localStorage has no methods, and it hides the jsdom versions the browser tests need.
// Point both back at jsdom. Node-environment tests have no `jsdom` global and are unaffected.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;

if (dom) {
  for (const key of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, enumerable: true, get: () => dom.window[key] });
  }
}
