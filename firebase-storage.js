// firebase-storage.js — localStorage-backed shim of the v9 modular Storage API.
// Files are read as base64 data URLs and stored at localStorage["fb:storage:<path>"].
// Hard 5 MB per-file limit (matches the original Storage rules).
// localStorage is itself ~5–10 MB total in most browsers, so heavy image use
// will exhaust the quota — we surface a clear error when that happens.

const PREFIX = 'fb:storage:';
const MAX_FILE_BYTES = 5 * 1024 * 1024;

class StorageReference {
  constructor(path) {
    this.fullPath = path;
    this.name = path.split('/').pop();
    this.bucket = 'localStorage';
  }
}

export function getStorage(_app) {
  return { __isStorage: true };
}

export function ref(_storage, path) {
  return new StorageReference(path);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

export async function uploadBytes(storageRef, fileOrBlob, _metadata) {
  const size = fileOrBlob && fileOrBlob.size != null ? fileOrBlob.size : 0;
  if (size > MAX_FILE_BYTES) {
    throw new Error(`storage/file-too-large: file is ${(size / 1024 / 1024).toFixed(1)} MB, max is 5 MB`);
  }
  const dataUrl = await fileToDataUrl(fileOrBlob);
  try {
    localStorage.setItem(PREFIX + storageRef.fullPath, dataUrl);
  } catch (e) {
    if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message))) {
      throw new Error('storage/quota-exceeded: localStorage is full. Delete old uploads or clear site data.');
    }
    throw e;
  }
  return {
    ref: storageRef,
    metadata: { fullPath: storageRef.fullPath, name: storageRef.name, size, contentType: fileOrBlob.type || 'application/octet-stream' },
  };
}

export async function getDownloadURL(storageRef) {
  const url = localStorage.getItem(PREFIX + storageRef.fullPath);
  if (url == null) {
    const err = new Error('storage/object-not-found'); err.code = 'storage/object-not-found'; throw err;
  }
  return url;
}

export async function deleteObject(storageRef) {
  localStorage.removeItem(PREFIX + storageRef.fullPath);
}

export function uploadString(storageRef, value, _format) {
  // Best-effort: persist as-is.
  try {
    localStorage.setItem(PREFIX + storageRef.fullPath, value);
  } catch (e) {
    throw new Error('storage/quota-exceeded');
  }
  return Promise.resolve({ ref: storageRef, metadata: { fullPath: storageRef.fullPath } });
}
