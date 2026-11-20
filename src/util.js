import { createHash, randomUUID } from 'node:crypto';

export const nowIso = () => new Date().toISOString();

export function addDays(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function shortId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Stable JSON stringification with sorted object keys. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function parseJson(text, fallback = null) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function uniqueStrings(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((x) => String(x).trim()).filter(Boolean))];
}

export function isSubset(subset, superset) {
  return subset.every((item) => superset.includes(item));
}

export function missingFrom(subset, superset) {
  return subset.filter((item) => !superset.includes(item));
}

export function groupCount(rows, key) {
  const out = {};
  for (const row of rows) out[row[key]] = (out[row[key]] ?? 0) + 1;
  return out;
}
