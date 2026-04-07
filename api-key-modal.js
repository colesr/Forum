// api-key-modal.js — minimal settings UI for the Gemini API key.
// Stores the key in localStorage["geminiApiKey"]. ensureApiKey() returns the
// key if present, otherwise opens a modal that resolves with the key the user
// pastes (or null if they cancel).

const KEY_NAME = 'geminiApiKey';

export function getApiKey() {
  return localStorage.getItem(KEY_NAME) || '';
}
export function setApiKey(key) {
  if (key) localStorage.setItem(KEY_NAME, key.trim());
  else localStorage.removeItem(KEY_NAME);
}

let _modalOpenPromise = null;

export function ensureApiKey() {
  const existing = getApiKey();
  if (existing) return Promise.resolve(existing);
  return openApiKeyModal();
}

export function openApiKeyModal() {
  if (_modalOpenPromise) return _modalOpenPromise;
  _modalOpenPromise = new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.6);
      display:flex;align-items:center;justify-content:center;
      font-family:system-ui,-apple-system,sans-serif;
    `;
    overlay.innerHTML = `
      <div style="background:#fff;color:#111;max-width:480px;width:90%;border-radius:12px;
                  padding:24px;box-shadow:0 20px 60px rgba(0,0,0,0.4);">
        <h2 style="margin:0 0 8px;font-size:20px;">Gemini API Key Required</h2>
        <p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#444;">
          This standalone build calls the Google Gemini API directly from your browser
          for AI features. Paste a Gemini API key below — it stays on your device in
          <code>localStorage</code> and is never sent anywhere except <code>generativelanguage.googleapis.com</code>.
        </p>
        <p style="margin:0 0 12px;font-size:13px;color:#666;">
          Get a key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">aistudio.google.com/app/apikey</a>.
        </p>
        <input type="password" id="__shim_gemini_key" placeholder="AIza..."
               style="width:100%;padding:10px;border:1px solid #ccc;border-radius:6px;
                      font-size:14px;font-family:inherit;box-sizing:border-box;" />
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button id="__shim_gemini_cancel" style="padding:8px 16px;border:1px solid #ccc;
                  background:#fff;border-radius:6px;cursor:pointer;font-size:14px;">Cancel</button>
          <button id="__shim_gemini_save" style="padding:8px 16px;border:none;
                  background:#3b82f6;color:#fff;border-radius:6px;cursor:pointer;font-size:14px;">Save key</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#__shim_gemini_key');
    input.focus();
    const finish = (val) => {
      document.body.removeChild(overlay);
      _modalOpenPromise = null;
      resolve(val);
    };
    overlay.querySelector('#__shim_gemini_save').addEventListener('click', () => {
      const v = input.value.trim();
      if (!v) { input.style.borderColor = '#ef4444'; return; }
      setApiKey(v);
      finish(v);
    });
    overlay.querySelector('#__shim_gemini_cancel').addEventListener('click', () => finish(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') overlay.querySelector('#__shim_gemini_save').click();
      if (e.key === 'Escape') overlay.querySelector('#__shim_gemini_cancel').click();
    });
  });
  return _modalOpenPromise;
}

// Expose a global so the host page can add a "Settings" button that opens the modal.
if (typeof window !== 'undefined') {
  window.__openGeminiKeyModal = openApiKeyModal;
  window.__getGeminiKey = getApiKey;
  window.__setGeminiKey = setApiKey;
}
