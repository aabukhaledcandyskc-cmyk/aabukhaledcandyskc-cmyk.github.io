// Upsert by unique key. Pure function so it is shared by every storage backend.
export function mergeRecords(existing, incoming) {
  const map = new Map(existing.map((r) => [r.key, r]));
  let added = 0, updated = 0;
  for (const rec of incoming) {
    if (map.has(rec.key)) updated++; else added++;
    map.set(rec.key, rec);
  }
  return { records: [...map.values()], added, updated };
}

// Browser storage (IndexedDB). Same interface a Supabase backend will implement later.
const DB = 'nexus';
const STORES = ['sales', 'payments', 'imports', 'repSettings', 'targets', 'meta'];
const KEYLESS = new Set(['imports']);

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 3);
    req.onupgradeneeded = () => {
      for (const s of STORES) {
        if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, KEYLESS.has(s) ? { autoIncrement: true } : { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
const get = (store) => new Promise((res, rej) => { const r = store.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const browserStore = {
  async loadAll(name) { const db = await open(); return get(db.transaction(name).objectStore(name)); },
  async upsert(name, incoming) {
    const db = await open();
    const existing = await get(db.transaction(name).objectStore(name));
    const merged = mergeRecords(existing, incoming);
    const tx = db.transaction(name, 'readwrite');
    const st = tx.objectStore(name);
    for (const r of incoming) st.put(r);
    await done(tx);
    return { added: merged.added, updated: merged.updated };
  },
  async put(name, rec) { const db = await open(); const tx = db.transaction(name, 'readwrite'); tx.objectStore(name).put(rec); await done(tx); },
  async remove(name, key) { const db = await open(); const tx = db.transaction(name, 'readwrite'); tx.objectStore(name).delete(key); await done(tx); },
  async log(entry) { const db = await open(); const tx = db.transaction('imports', 'readwrite'); tx.objectStore('imports').add(entry); await done(tx); },
  async lastImports() { const db = await open(); return (await get(db.transaction('imports').objectStore('imports'))).slice(-5).reverse(); },
  async clear() { const db = await open(); const names = ['sales', 'payments', 'imports']; const tx = db.transaction(names, 'readwrite'); names.forEach((s) => tx.objectStore(s).clear()); await done(tx); },
};
