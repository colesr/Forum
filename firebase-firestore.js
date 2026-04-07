// firebase-firestore.js — localStorage-backed shim of the v9 modular Firestore API.
// Persists every document at localStorage["fb:doc:<full/path>"] as JSON.
// Maintains per-collection indexes at localStorage["fb:idx:<collection/path>"].
// Implements: collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
// query, where, orderBy, limit, onSnapshot, serverTimestamp, Timestamp, arrayUnion,
// arrayRemove, deleteField, increment, getFirestore. Plus a tiny event bus and a
// document-trigger registry that the cloud-functions shim hooks into.

const DOC_PREFIX = 'fb:doc:';
const IDX_PREFIX = 'fb:idx:';

// ---------- Timestamp ----------
export class Timestamp {
  constructor(seconds, nanoseconds = 0) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
    this._seconds = seconds; // legacy compat field used by some code paths
  }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  toDate() { return new Date(this.toMillis()); }
  valueOf() { return this.toMillis(); }
  static now() { return Timestamp.fromMillis(Date.now()); }
  static fromMillis(m) { return new Timestamp(Math.floor(m / 1000), (m % 1000) * 1e6); }
  static fromDate(d) { return Timestamp.fromMillis(d.getTime()); }
  toJSON() { return { __t: 'ts', m: this.toMillis() }; }
}

function hydrateValue(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(hydrateValue);
  if (typeof v === 'object') {
    if (v.__t === 'ts' && typeof v.m === 'number') return Timestamp.fromMillis(v.m);
    const out = {};
    for (const k of Object.keys(v)) out[k] = hydrateValue(v[k]);
    return out;
  }
  return v;
}

function dehydrateValue(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Timestamp) return { __t: 'ts', m: v.toMillis() };
  if (v instanceof Date) return { __t: 'ts', m: v.getTime() };
  if (Array.isArray(v)) return v.map(dehydrateValue);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = dehydrateValue(v[k]);
    return out;
  }
  return v;
}

// ---------- Sentinels (FieldValue equivalents) ----------
const SENTINEL = Symbol.for('fbShimSentinel');
export function serverTimestamp() { return { [SENTINEL]: 'serverTimestamp' }; }
export function arrayUnion(...values) { return { [SENTINEL]: 'arrayUnion', values }; }
export function arrayRemove(...values) { return { [SENTINEL]: 'arrayRemove', values }; }
export function deleteField() { return { [SENTINEL]: 'deleteField' }; }
export function increment(n) { return { [SENTINEL]: 'increment', value: n }; }

function isSentinel(v) { return v && typeof v === 'object' && v[SENTINEL]; }

// Apply sentinels against an existing document body. Used by setDoc and updateDoc.
// Returns a NEW object (does not mutate the input). For setDoc({merge:true}) the
// caller passes the existing doc; for plain setDoc, an empty object.
function applyWrites(existing, patch, mode /* 'set' | 'merge' | 'update' */) {
  const result = mode === 'merge' || mode === 'update' ? { ...(existing || {}) } : {};

  // For 'update', dotted field paths could be supported but the existing app
  // never uses them, so we treat keys literally.
  for (const key of Object.keys(patch)) {
    const v = patch[key];
    if (isSentinel(v)) {
      const op = v[SENTINEL];
      if (op === 'serverTimestamp') {
        result[key] = Timestamp.now();
      } else if (op === 'deleteField') {
        delete result[key];
      } else if (op === 'arrayUnion') {
        const arr = Array.isArray(result[key]) ? [...result[key]] : [];
        for (const x of v.values) {
          // Use deep-equal for objects, identity for primitives
          const exists = arr.some((item) => deepEqual(item, x));
          if (!exists) arr.push(x);
        }
        result[key] = arr;
      } else if (op === 'arrayRemove') {
        const arr = Array.isArray(result[key]) ? [...result[key]] : [];
        result[key] = arr.filter((item) => !v.values.some((x) => deepEqual(item, x)));
      } else if (op === 'increment') {
        const cur = typeof result[key] === 'number' ? result[key] : 0;
        result[key] = cur + v.value;
      }
    } else if (mode === 'merge' && v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Timestamp) && !(v instanceof Date)) {
      // Deep merge for plain objects under merge mode
      const cur = result[key] && typeof result[key] === 'object' && !Array.isArray(result[key]) ? result[key] : {};
      result[key] = applyWrites(cur, v, 'merge');
    } else {
      result[key] = v;
    }
  }
  return result;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

// ---------- Storage primitives ----------
function readDoc(path) {
  const raw = localStorage.getItem(DOC_PREFIX + path);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function writeDocRaw(path, data) {
  localStorage.setItem(DOC_PREFIX + path, JSON.stringify(data));
}
function deleteDocRaw(path) {
  localStorage.removeItem(DOC_PREFIX + path);
}
function readIndex(collectionPath) {
  const raw = localStorage.getItem(IDX_PREFIX + collectionPath);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}
function writeIndex(collectionPath, ids) {
  localStorage.setItem(IDX_PREFIX + collectionPath, JSON.stringify(ids));
}
function indexAdd(collectionPath, id) {
  const ids = readIndex(collectionPath);
  if (!ids.includes(id)) {
    ids.push(id);
    writeIndex(collectionPath, ids);
  }
}
function indexRemove(collectionPath, id) {
  const ids = readIndex(collectionPath).filter((x) => x !== id);
  writeIndex(collectionPath, ids);
}

// Generate Firestore-style 20-char auto IDs
const AUTO_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function autoId() {
  let s = '';
  const buf = new Uint8Array(20);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 20; i++) s += AUTO_ID_CHARS[buf[i] % AUTO_ID_CHARS.length];
  return s;
}

// ---------- Refs ----------
class CollectionReference {
  constructor(path, parent = null) {
    this.path = path;
    this.id = path.split('/').pop();
    this.parent = parent;
    this.type = 'collection';
    this._isCollection = true;
  }
}
class DocumentReference {
  constructor(path) {
    this.path = path;
    const segs = path.split('/');
    this.id = segs[segs.length - 1];
    this.parent = new CollectionReference(segs.slice(0, -1).join('/'), null);
    this.type = 'document';
    this._isDoc = true;
  }
}

export function getFirestore(_app) {
  // The db handle is just a marker. All real state lives in localStorage.
  return { __isDb: true };
}

// collection(db, path) OR collection(db, 'parent', parentId, 'sub', ...)
// Also supports collection(docRef, 'sub') for sub-collection access from a doc ref.
export function collection(dbOrRef, ...segments) {
  let basePath = '';
  if (dbOrRef && dbOrRef._isDoc) basePath = dbOrRef.path + '/';
  // Allow first segment to itself contain slashes
  const flat = segments.join('/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  return new CollectionReference(basePath + flat);
}

// doc(db, path) OR doc(db, 'col', id, 'sub', id2, ...) OR doc(collectionRef[, id])
export function doc(dbOrRef, ...segments) {
  if (dbOrRef && dbOrRef._isCollection) {
    const id = segments[0] || autoId();
    return new DocumentReference(dbOrRef.path + '/' + id);
  }
  if (dbOrRef && dbOrRef._isDoc) {
    return new DocumentReference(dbOrRef.path + '/' + segments.join('/'));
  }
  // db handle path: doc(db, 'col', id, ...)
  const flat = segments.join('/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  return new DocumentReference(flat);
}

// ---------- Snapshots ----------
class DocumentSnapshot {
  constructor(ref, raw) {
    this.ref = ref;
    this.id = ref.id;
    this._raw = raw;
  }
  exists() { return this._raw != null; }
  data() { return this._raw == null ? undefined : hydrateValue(this._raw); }
  get(field) {
    const d = this.data();
    if (!d) return undefined;
    return field.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), d);
  }
}
class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.empty = docs.length === 0;
    this.size = docs.length;
  }
  forEach(cb) { this.docs.forEach(cb); }
}

// ---------- Reads ----------
export async function getDoc(ref) {
  const raw = readDoc(ref.path);
  return new DocumentSnapshot(ref, raw);
}

export async function getDocs(refOrQuery) {
  let coll, constraints = [];
  if (refOrQuery && refOrQuery._isCollection) {
    coll = refOrQuery;
  } else if (refOrQuery && refOrQuery.__type === 'query') {
    coll = refOrQuery._collection;
    constraints = refOrQuery._constraints;
  } else {
    throw new Error('getDocs: expected CollectionReference or Query');
  }
  const ids = readIndex(coll.path);
  let docs = ids.map((id) => {
    const path = coll.path + '/' + id;
    const raw = readDoc(path);
    if (raw == null) return null;
    return new DocumentSnapshot(new DocumentReference(path), raw);
  }).filter(Boolean);

  // Apply where
  for (const c of constraints) {
    if (c.kind === 'where') docs = docs.filter((d) => evalWhere(d.data(), c));
  }
  // Apply orderBy (multi-key)
  const orderBys = constraints.filter((c) => c.kind === 'orderBy');
  if (orderBys.length) {
    docs.sort((a, b) => {
      for (const ob of orderBys) {
        const av = getFieldValue(a.data(), ob.field);
        const bv = getFieldValue(b.data(), ob.field);
        const cmp = compareValues(av, bv);
        if (cmp !== 0) return ob.direction === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  }
  // Apply limit
  const lim = constraints.find((c) => c.kind === 'limit');
  if (lim) docs = docs.slice(0, lim.count);

  return new QuerySnapshot(docs);
}

function getFieldValue(data, field) {
  if (!data) return undefined;
  return field.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), data);
}

function compareValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  // Timestamps support valueOf -> millis
  const av = typeof a === 'object' && a.toMillis ? a.toMillis() : a;
  const bv = typeof b === 'object' && b.toMillis ? b.toMillis() : b;
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  if (typeof av === 'string' && typeof bv === 'string') return av < bv ? -1 : av > bv ? 1 : 0;
  // fall back to JSON
  const sa = JSON.stringify(av), sb = JSON.stringify(bv);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function evalWhere(data, c) {
  const v = getFieldValue(data, c.field);
  const target = c.value;
  switch (c.op) {
    case '==': return deepEqual(v, target);
    case '!=': return !deepEqual(v, target);
    case '>': return compareValues(v, target) > 0;
    case '>=': return compareValues(v, target) >= 0;
    case '<': return compareValues(v, target) < 0;
    case '<=': return compareValues(v, target) <= 0;
    case 'array-contains':
      return Array.isArray(v) && v.some((x) => deepEqual(x, target));
    case 'array-contains-any':
      return Array.isArray(v) && Array.isArray(target) && v.some((x) => target.some((t) => deepEqual(x, t)));
    case 'in':
      return Array.isArray(target) && target.some((t) => deepEqual(v, t));
    case 'not-in':
      return Array.isArray(target) && !target.some((t) => deepEqual(v, t));
    default:
      return false;
  }
}

// ---------- Query builder ----------
export function query(collectionRef, ...constraints) {
  return {
    __type: 'query',
    _collection: collectionRef,
    _constraints: constraints,
  };
}
export function where(field, op, value) {
  return { kind: 'where', field, op, value };
}
export function orderBy(field, direction = 'asc') {
  return { kind: 'orderBy', field, direction };
}
export function limit(count) {
  return { kind: 'limit', count };
}

// ---------- Writes ----------
export async function setDoc(ref, data, options = {}) {
  const merge = !!options.merge;
  const existing = readDoc(ref.path);
  const next = applyWrites(merge ? existing : null, data, merge ? 'merge' : 'set');
  const dehydrated = dehydrateValue(next);
  writeDocRaw(ref.path, dehydrated);
  // Add to collection index
  const collPath = ref.path.split('/').slice(0, -1).join('/');
  const wasNew = existing == null;
  indexAdd(collPath, ref.id);
  emit(collPath, wasNew ? 'create' : 'update', ref, next);
  return undefined;
}

export async function updateDoc(ref, data) {
  const existing = readDoc(ref.path);
  if (existing == null) {
    // Real Firestore throws "No document to update". The app code generally
    // updates docs it just read, but be permissive: throw to surface bugs.
    throw new Error('updateDoc: document does not exist at ' + ref.path);
  }
  const next = applyWrites(existing, data, 'update');
  const dehydrated = dehydrateValue(next);
  writeDocRaw(ref.path, dehydrated);
  const collPath = ref.path.split('/').slice(0, -1).join('/');
  emit(collPath, 'update', ref, next);
  return undefined;
}

export async function addDoc(collRef, data) {
  const id = autoId();
  const ref = new DocumentReference(collRef.path + '/' + id);
  const next = applyWrites(null, data, 'set');
  const dehydrated = dehydrateValue(next);
  writeDocRaw(ref.path, dehydrated);
  indexAdd(collRef.path, id);
  emit(collRef.path, 'create', ref, next);
  return ref;
}

export async function deleteDoc(ref) {
  const existing = readDoc(ref.path);
  deleteDocRaw(ref.path);
  const collPath = ref.path.split('/').slice(0, -1).join('/');
  indexRemove(collPath, ref.id);
  if (existing != null) emit(collPath, 'delete', ref, hydrateValue(existing));
  return undefined;
}

// ---------- Event bus + onSnapshot + document triggers ----------
const collectionListeners = new Map(); // collPath -> Set<listener>
const docListeners = new Map(); // docPath -> Set<listener>
const docTriggers = []; // [{pattern: 'threads/{threadId}', regex, fn}]

function emit(collPath, kind, ref, data) {
  // Notify collection listeners
  const setC = collectionListeners.get(collPath);
  if (setC) {
    for (const fn of setC) {
      try { fn(); } catch (e) { console.error('snapshot listener error', e); }
    }
  }
  // Notify single-doc listeners
  const setD = docListeners.get(ref.path);
  if (setD) {
    for (const fn of setD) {
      try { fn(); } catch (e) { console.error('doc listener error', e); }
    }
  }
  // Fire document triggers (only on create — that's all the cloud functions use)
  if (kind === 'create') {
    for (const trig of docTriggers) {
      const m = ref.path.match(trig.regex);
      if (m) {
        const params = {};
        trig.paramNames.forEach((name, i) => { params[name] = m[i + 1]; });
        // fire async, do not await
        Promise.resolve().then(() => trig.fn({ params, data: hydrateValue(data), ref })).catch((e) => {
          console.error('document trigger error for', trig.pattern, e);
        });
      }
    }
  }
}

export function onSnapshot(refOrQuery, cb, errCb) {
  // Determine target
  let coll, isDoc = false, docPath = null;
  if (refOrQuery && refOrQuery._isDoc) {
    isDoc = true;
    docPath = refOrQuery.path;
  } else if (refOrQuery && refOrQuery._isCollection) {
    coll = refOrQuery;
  } else if (refOrQuery && refOrQuery.__type === 'query') {
    coll = refOrQuery._collection;
  } else {
    throw new Error('onSnapshot: invalid argument');
  }

  const fire = async () => {
    try {
      if (isDoc) {
        const snap = await getDoc(refOrQuery);
        cb(snap);
      } else {
        const snap = await getDocs(refOrQuery);
        cb(snap);
      }
    } catch (e) {
      if (errCb) errCb(e); else console.error('onSnapshot fire error', e);
    }
  };

  // Register
  if (isDoc) {
    if (!docListeners.has(docPath)) docListeners.set(docPath, new Set());
    docListeners.get(docPath).add(fire);
  } else {
    if (!collectionListeners.has(coll.path)) collectionListeners.set(coll.path, new Set());
    collectionListeners.get(coll.path).add(fire);
  }

  // Initial fire (async, but synchronous-ish)
  fire();

  // Unsubscribe
  return () => {
    if (isDoc) {
      docListeners.get(docPath)?.delete(fire);
    } else {
      collectionListeners.get(coll.path)?.delete(fire);
    }
  };
}

// ---------- Document trigger registry (used by cloud-functions shim) ----------
// Pattern syntax: 'threads/{threadId}' or 'conversations/{convId}/messages/{msgId}'
export function registerDocumentTrigger(pattern, fn) {
  const paramNames = [];
  const regexStr = '^' + pattern.replace(/\{([^}]+)\}/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  }) + '$';
  docTriggers.push({ pattern, regex: new RegExp(regexStr), paramNames, fn });
}

// ---------- Misc ----------
// The app imports `limit as fsLimit` from this module. The `as` rename is at
// the import site so we just need to export `limit`. Already done above.

// Some app code uses `deleteField` from this module — already exported above.

// Provide a default db handle for any code that imports it.
export const db = { __isDb: true };
