// firebase-auth.js — localStorage-backed shim of the v9 modular Auth API.
// Email/password accounts. Passwords stored as SHA-256 hex hashes (NOT secure
// against an attacker with disk access — this is a local-only demo).
// Google sign-in is faked (synthetic user, no OAuth).

const USERS_KEY = 'fb:auth:users';
const CURRENT_KEY = 'fb:auth:currentUid';

function loadUsers() {
  try { return JSON.parse(localStorage.getItem(USERS_KEY) || '[]'); } catch { return []; }
}
function saveUsers(users) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}
async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function genUid() {
  const a = new Uint8Array(14);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makeUserPublic(record) {
  if (!record) return null;
  return {
    uid: record.uid,
    email: record.email,
    displayName: record.displayName || null,
    photoURL: record.photoURL || null,
    emailVerified: !!record.emailVerified,
    providerData: record.providerData || [],
  };
}

class AuthInstance {
  constructor() {
    this.currentUser = null;
    this._listeners = new Set();
    this._loadCurrent();
  }
  _loadCurrent() {
    const uid = localStorage.getItem(CURRENT_KEY);
    if (!uid) { this.currentUser = null; return; }
    const rec = loadUsers().find((u) => u.uid === uid);
    this.currentUser = makeUserPublic(rec);
  }
  _setCurrent(uid) {
    if (uid) localStorage.setItem(CURRENT_KEY, uid);
    else localStorage.removeItem(CURRENT_KEY);
    this._loadCurrent();
    for (const cb of this._listeners) {
      try { cb(this.currentUser); } catch (e) { console.error(e); }
    }
  }
}

let _instance = null;
export function getAuth(_app) {
  if (!_instance) _instance = new AuthInstance();
  return _instance;
}

export function onAuthStateChanged(auth, cb) {
  auth._listeners.add(cb);
  // Fire immediately with current state (matches real Firebase behavior on subscribe)
  Promise.resolve().then(() => cb(auth.currentUser));
  return () => auth._listeners.delete(cb);
}

export async function createUserWithEmailAndPassword(auth, email, password) {
  email = (email || '').trim().toLowerCase();
  if (!email || !password) throw new Error('auth/invalid-email');
  const users = loadUsers();
  if (users.some((u) => u.email === email)) {
    const err = new Error('auth/email-already-in-use'); err.code = 'auth/email-already-in-use'; throw err;
  }
  const uid = genUid();
  const passwordHash = await sha256Hex(password);
  const rec = { uid, email, passwordHash, displayName: null, photoURL: null, emailVerified: false, providerData: [{ providerId: 'password' }] };
  users.push(rec);
  saveUsers(users);
  auth._setCurrent(uid);
  return { user: makeUserPublic(rec) };
}

export async function signInWithEmailAndPassword(auth, email, password) {
  email = (email || '').trim().toLowerCase();
  const users = loadUsers();
  const rec = users.find((u) => u.email === email);
  if (!rec) { const err = new Error('auth/user-not-found'); err.code = 'auth/user-not-found'; throw err; }
  const passwordHash = await sha256Hex(password);
  if (rec.passwordHash !== passwordHash) {
    const err = new Error('auth/wrong-password'); err.code = 'auth/wrong-password'; throw err;
  }
  auth._setCurrent(rec.uid);
  return { user: makeUserPublic(rec) };
}

export async function signOut(auth) {
  auth._setCurrent(null);
}

export async function sendPasswordResetEmail(_auth, email, _opts) {
  // No real email infrastructure in a localStorage build, so do the reset
  // inline: look the account up, prompt for a new password, save its hash.
  email = (email || '').trim().toLowerCase();
  const users = loadUsers();
  const rec = users.find((u) => u.email === email);
  if (!rec) {
    const err = new Error('auth/user-not-found'); err.code = 'auth/user-not-found'; throw err;
  }
  const next = window.prompt(
    `[Local password reset]\n\nThis build has no email server, so we'll reset your password right here.\n\nEnter a new password for ${email}:`
  );
  if (next == null) {
    const err = new Error('auth/cancelled'); err.code = 'auth/cancelled'; throw err;
  }
  if (next.length < 6) {
    const err = new Error('auth/weak-password'); err.code = 'auth/weak-password'; throw err;
  }
  rec.passwordHash = await sha256Hex(next);
  saveUsers(users);
}

export async function sendEmailVerification(user, _opts) {
  // Mark verified immediately so any "verify your email" gating doesn't block use.
  const users = loadUsers();
  const rec = users.find((u) => u.uid === user.uid);
  if (rec) { rec.emailVerified = true; saveUsers(users); }
  if (_instance) _instance._loadCurrent();
  console.warn('[auth shim] sendEmailVerification: marking', user.email, 'as verified locally.');
}

export async function deleteUser(user) {
  const users = loadUsers().filter((u) => u.uid !== user.uid);
  saveUsers(users);
  if (_instance && _instance.currentUser && _instance.currentUser.uid === user.uid) {
    _instance._setCurrent(null);
  }
}

export class GoogleAuthProvider {
  constructor() {
    this.providerId = 'google.com';
    this._customParameters = {};
    this._scopes = [];
  }
  setCustomParameters(params) { this._customParameters = { ...(params || {}) }; return this; }
  addScope(scope) { this._scopes.push(scope); return this; }
  static credential() { return null; }
  static PROVIDER_ID = 'google.com';
}

export async function signInWithPopup(auth, _provider) {
  // Fake Google sign-in: synthesize (or reuse) a synthetic Google user.
  const users = loadUsers();
  let rec = users.find((u) => u.email === 'demo.google@example.com');
  if (!rec) {
    rec = {
      uid: genUid(),
      email: 'demo.google@example.com',
      passwordHash: '', // not used for OAuth users
      displayName: 'Demo Google User',
      photoURL: null,
      emailVerified: true,
      providerData: [{ providerId: 'google.com' }],
    };
    users.push(rec);
    saveUsers(users);
  }
  auth._setCurrent(rec.uid);
  return { user: makeUserPublic(rec) };
}
