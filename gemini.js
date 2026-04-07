// gemini.js — minimal browser REST client for the Google Generative Language API.
// Reads the user's API key from localStorage["geminiApiKey"]. Triggers a settings
// modal (api-key-modal.js) if missing.

import { ensureApiKey } from './api-key-modal.js';

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

export async function callGemini(prompt, opts = {}) {
  const key = await ensureApiKey();
  if (!key) throw new Error('Gemini API key not provided');
  const model = opts.model || MODEL;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
  };
  if (opts.systemInstruction) {
    body.systemInstruction = { parts: [{ text: opts.systemInstruction }] };
  }
  if (opts.generationConfig) body.generationConfig = opts.generationConfig;

  const res = await fetch(ENDPOINT(model, key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${text}`);
  }
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return text;
}

// Strip markdown code fences (```json ... ```) and parse JSON.
export function parseJsonLoose(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(s); } catch {}
  // try to find the first {...} block
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
