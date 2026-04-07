// firebase-app.js — no-op shim. The app calls initializeApp(config) and passes
// the returned handle around. Nothing in the rest of the shim layer needs the
// real config (no real Firebase services are involved), so we just return a
// marker object.

export function initializeApp(config) {
  return { __isFirebaseApp: true, options: config || {} };
}

export function getApp() {
  return { __isFirebaseApp: true, options: {} };
}

export function getApps() {
  return [getApp()];
}
