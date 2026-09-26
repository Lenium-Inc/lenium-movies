/**
 * Minimal Web Storage + event-target stub for the repo's `node` vitest
 * environment.
 *
 * The suites that exercise `localSession` and `lists` need a real
 * `localStorage` and a real `dispatchEvent`, because the code under test
 * writes during a `useState` initialiser and notifies subscribers on every
 * write. Pulling in jsdom for that would be a heavy dependency for a handful of
 * calls, so this covers exactly the surface those modules touch:
 *
 *   - `localStorage`: getItem / setItem / removeItem / clear
 *   - `CustomEvent`, `dispatchEvent`, `addEventListener`, `removeEventListener`
 *
 * Importing this module has a deliberate side effect: it installs the globals.
 * It must be the *first* import in a test file, because ES modules evaluate
 * their dependencies in import order, and the modules under test read
 * `typeof window` at module scope.
 *
 * `clearStorage()` resets only the storage contents and leaves the global
 * installed, so it is safe to call from `beforeEach`.
 */

const store = new Map<string, string>();
const listeners = new Set<(event: { type: string; detail?: unknown }) => void>();

class StubCustomEvent {
  readonly detail: unknown;
  constructor(readonly type: string, init?: { detail?: unknown }) {
    this.detail = init?.detail;
  }
}

export const stubStorage = {
  getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
  clear: () => store.clear(),
};

const win = {
  localStorage: stubStorage,
  CustomEvent: StubCustomEvent,
  dispatchEvent: (event: { type: string; detail?: unknown }) => {
    listeners.forEach(fn => fn(event));
    return true;
  },
  addEventListener: (_type: string, fn: (event: { type: string; detail?: unknown }) => void) => {
    listeners.add(fn);
  },
  removeEventListener: (
    _type: string,
    fn: (event: { type: string; detail?: unknown }) => void
  ) => {
    listeners.delete(fn);
  },
};

(globalThis as unknown as { window: unknown }).window = win;
// `migrateLegacyKeys` and `wipeLocalData` reach for bare `localStorage`
// rather than `window.localStorage`, so both spellings have to exist.
(globalThis as unknown as { localStorage: unknown }).localStorage = stubStorage;

export function clearStorage(): void {
  store.clear();
}
