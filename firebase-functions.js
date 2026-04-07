// firebase-functions.js — shim for the Functions client SDK.
// httpsCallable(functions, name) returns an async function which dispatches to
// the in-browser cloud-function port table from cloud-functions.js. The result
// is wrapped in `{ data }` to match the real SDK's return shape.

import { dispatch } from './cloud-functions.js';
import { getAuth } from './firebase-auth.js';

export function getFunctions(_app) {
  return { __isFunctions: true };
}

export function httpsCallable(_functions, name) {
  return async (data) => {
    const auth = getAuth();
    const ctx = {
      auth: auth.currentUser ? { uid: auth.currentUser.uid, token: { email: auth.currentUser.email } } : null,
    };
    const fn = dispatch[name];
    if (!fn) {
      throw Object.assign(new Error(`Cloud function "${name}" is not implemented in the localStorage shim`), { code: 'functions/unimplemented' });
    }
    const result = await fn(data || {}, ctx);
    return { data: result };
  };
}

// Optional: allow importing connectFunctionsEmulator harmlessly if any code path uses it.
export function connectFunctionsEmulator() {}
