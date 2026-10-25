// IndexedDB persistence of document state.
//
// Layout: DB "weft", store "states", one record per *session* keyed "<docId>/<clientId>", holding
// that session's full encoded state. Each tab only ever overwrites its own record, so two tabs
// can never clobber each other's edits. On open we read every record for the doc, merge them
// into the new replica, write the merged state under our key and delete the records we merged,
// all inside ONE readwrite transaction (wasm calls are synchronous, so this is safe), which keeps
// the store compact without ever dropping an edit.

const DB_NAME = 'weft';
const STORE = 'states';

interface StateRecord {
  key: string;
  docId: string;
  state: Uint8Array;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null); // private mode etc.: run without persistence
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

const keyFor = (docId: string, clientId: string) => `${docId}/${clientId}`;
// doc ids are [A-Za-z0-9_-], so "/" cleanly separates and "0" (after "/") bounds the range.
const rangeFor = (docId: string) => IDBKeyRange.bound(`${docId}/`, `${docId}0`, false, true);

export class DocStorage {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstDirty = 0;
  private closed = false;

  private constructor(
    private readonly db: IDBDatabase | null,
    private readonly key: string,
    private readonly docId: string,
    private readonly encode: () => Uint8Array,
  ) {}

  /**
   * Load all persisted states for `docId`, let `build` construct the replica from them
   * (synchronously), then persist the merged result under this session's key.
   */
  static async open<T>(
    docId: string,
    clientId: string,
    build: (states: Uint8Array[]) => { value: T; encode: () => Uint8Array },
  ): Promise<{ value: T; storage: DocStorage }> {
    const db = await openDb();
    const key = keyFor(docId, clientId);
    if (!db) {
      const { value, encode } = build([]);
      return { value, storage: new DocStorage(null, key, docId, encode) };
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const states: Uint8Array[] = [];
      const keys: IDBValidKey[] = [];
      let result: { value: T; storage: DocStorage } | null = null;
      const cur = store.openCursor(rangeFor(docId));
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) {
          const rec = c.value as StateRecord;
          if (rec.state instanceof Uint8Array && rec.state.length) states.push(rec.state);
          keys.push(c.primaryKey);
          c.continue();
          return;
        }
        try {
          const { value, encode } = build(states);
          for (const k of keys) store.delete(k);
          if (states.length) {
            store.put({ key, docId, state: encode(), savedAt: Date.now() } satisfies StateRecord);
          }
          result = { value, storage: new DocStorage(db, key, docId, encode) };
        } catch (e) {
          tx.abort();
          reject(e);
        }
      };
      tx.oncomplete = () => (result ? resolve(result) : reject(new Error('IndexedDB load failed')));
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB load failed'));
    });
  }

  /** Debounced save: 400 ms after the last edit, but at most 2 s after the first unsaved one. */
  schedule(): void {
    if (!this.db || this.closed) return;
    const now = Date.now();
    if (!this.timer) this.firstDirty = now;
    else clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(400, this.firstDirty + 2000 - now));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  /** Save now (if anything is pending or `force`). Safe to call from `pagehide`. */
  flush(force = false): void {
    if (!this.db || this.closed) return;
    if (!this.timer && !force) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      const tx = this.db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({
        key: this.key,
        docId: this.docId,
        state: this.encode(),
        savedAt: Date.now(),
      } satisfies StateRecord);
    } catch (e) {
      console.warn('[weft] save failed', e);
    }
  }

  close(): void {
    this.flush();
    this.closed = true;
  }
}
