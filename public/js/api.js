const state = {
  meta: null,
  cache: new Map(),
};

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: { code: 'E_BAD_RESPONSE', message: text } };
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `HTTP ${res.status}`);
    err.code = data?.error?.code;
    err.extra = data?.error?.extra;
    err.status = res.status;
    throw err;
  }
  return data;
}

export const get = (path) => api(path);
export const post = (path, body = {}) => api(path, { method: 'POST', body });

export async function meta() {
  if (!state.meta) state.meta = await get('/api/meta');
  return state.meta;
}

export function setCache(key, value) {
  state.cache.set(key, value);
}
export function getCache(key) {
  return state.cache.get(key);
}
export function invalidate() {
  state.cache.clear();
}

export function purposeLabel(key) {
  return state.meta?.purposes.find((p) => p.key === key)?.label ?? key;
}
export function purposeShort(key) {
  return state.meta?.purposes.find((p) => p.key === key)?.short ?? key;
}
export function scopeInfo(key) {
  return state.meta?.scopes.find((s) => s.key === key);
}
export function scopeLabel(key) {
  return scopeInfo(key)?.label ?? key;
}
export function fieldLabel(field) {
  const map = {
    contact: '联系方式',
    device_id: '设备标识',
    lat: '纬度',
    lng: '经度',
    city: '城市',
    behavior: '行为事件',
    voice: '语音记录',
  };
  return map[field] ?? field;
}
