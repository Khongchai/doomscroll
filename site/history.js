const KEY = "doomscroll:history:v1";

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
}

const state = load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
}

export function record(id, action) {
  const entry = (state[id] ??= {});
  entry[action] = (entry[action] ?? 0) + 1;
  entry.t = Date.now();
  save();
}

export function entryFor(id) {
  return state[id];
}

export function allEntries() {
  return Object.entries(state);
}

export function exportHistory() {
  return JSON.stringify(state);
}

export function readPref(name, fallback) {
  try {
    return JSON.parse(localStorage.getItem(`doomscroll:pref:${name}`)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writePref(name, value) {
  try {
    localStorage.setItem(`doomscroll:pref:${name}`, JSON.stringify(value));
  } catch {}
}
