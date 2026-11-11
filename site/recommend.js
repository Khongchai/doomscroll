import { allEntries, entryFor } from "./history.js";

const DAY = 24 * 3600 * 1000;
const HALF_LIFE = 30 * DAY;
const RESHOW_AFTER = 5 * DAY;
const EXPLORE_RATE = 0.15;
const MAX_ANCHORS = 60;
const SEED_TITLES = new Set([
  "M/M/1 queue",
  "Kolmogorov complexity",
  "Raft (algorithm)",
  "Lehmer random number generator",
  "In Search of an Understandable Consensus Algorithm (Raft)",
]);
const SEED_AUTHORS = new Set(["fowler"]);
const MODEL = "Xenova/all-MiniLM-L6-v2";
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";

export function createRecommender({ items, vectors, dim }) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const candidates = items.filter((i) => i.e != null && i.kind !== "note" && !i.short);
  const scale = 127 * 127;
  let mood = null;
  const recent = [];

  const rowOf = (item) => vectors.subarray(item.e * dim, (item.e + 1) * dim);

  function dot(a, b) {
    let s = 0;
    for (let i = 0; i < dim; i++) s += a[i] * b[i];
    return s / scale;
  }

  function seedAnchors() {
    const seeds = items.filter((i) => i.e != null && SEED_TITLES.has(i.title));
    const fowler = items.filter((i) => i.e != null && SEED_AUTHORS.has(i.author)).slice(0, 2);
    return [...seeds, ...fowler].map((item) => ({ item, vec: rowOf(item), w: 1, seed: true }));
  }

  function anchors() {
    const now = Date.now();
    const positive = [];
    const negative = [];
    for (const [id, h] of allEntries()) {
      const item = byId.get(id);
      if (!item || item.e == null) continue;
      const decay = 0.5 ** ((now - (h.t ?? now)) / HALF_LIFE);
      const pos = ((h.like ?? 0) * 2 + (h.open ?? 0)) * decay;
      const neg = ((h.nope ?? 0) * 1.5 + (h.skip ?? 0) * 0.25) * decay;
      if (pos > neg) positive.push({ item, vec: rowOf(item), w: pos - neg });
      else if (neg > 0) negative.push({ item, vec: rowOf(item), w: neg });
    }
    positive.sort((a, b) => b.w - a.w);
    const pos = positive.slice(0, MAX_ANCHORS);
    if (pos.length < 4) pos.push(...seedAnchors());
    if (mood) pos.push({ vec: mood.vec, w: 4, mood: mood.text });
    return { pos, neg: negative.slice(0, MAX_ANCHORS) };
  }

  function excluded(item, now) {
    const h = entryFor(item.id);
    if (!h) return false;
    if (h.open || h.like || h.nope) return true;
    return (h.shown || h.skip) && now - h.t < RESHOW_AFTER;
  }

  function scoreAll() {
    const now = Date.now();
    const { pos, neg } = anchors();
    const lastAuthors = new Set(recent.slice(-3).map((i) => i.author));
    const scored = [];
    for (const item of candidates) {
      if (excluded(item, now) || recent.includes(item)) continue;
      const v = rowOf(item);
      let best = -1;
      let because = null;
      for (const a of pos) {
        const weight = a.mood ? 1.25 : 0.8 + 0.2 * Math.min(a.w, 3) / 3;
        const s = dot(v, a.vec) * weight;
        if (s > best) {
          best = s;
          because = a;
        }
      }
      let penalty = 0;
      for (const n of neg) penalty = Math.max(penalty, dot(v, n.vec) - 0.35);
      let score = best - Math.max(0, penalty) * 0.8;
      if (lastAuthors.has(item.author)) score -= 0.08;
      scored.push({ item, score, because });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  function pickWeighted(list, temperature) {
    const top = list[0].score;
    const weights = list.map((s) => Math.exp((s.score - top) / temperature));
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < list.length; i++) {
      r -= weights[i];
      if (r <= 0) return list[i];
    }
    return list[0];
  }

  function next() {
    const scored = scoreAll();
    if (!scored.length) return null;
    let choice;
    if (Math.random() < EXPLORE_RATE) {
      const pool = scored.slice(40, 600);
      choice = pool.length ? { ...pool[Math.floor(Math.random() * pool.length)], explore: true } : scored[0];
    } else {
      choice = pickWeighted(scored.slice(0, 8), 0.03);
    }
    recent.push(choice.item);
    if (recent.length > 30) recent.shift();
    return choice;
  }

  let extractorPromise = null;

  async function embedQuery(text, onStatus) {
    extractorPromise ??= (async () => {
      onStatus?.("Loading the local model (about 25 MB, cached after the first time)…");
      const { pipeline } = await import(TRANSFORMERS_URL);
      return pipeline("feature-extraction", MODEL, { dtype: "q8" });
    })();
    const extractor = await extractorPromise;
    const out = await extractor([text], { pooling: "mean", normalize: true });
    const vec = new Int8Array(dim);
    for (let i = 0; i < dim; i++) vec[i] = Math.max(-127, Math.min(127, Math.round(out.data[i] * 127)));
    return vec;
  }

  async function setMood(text, onStatus) {
    if (!text) {
      mood = null;
      return;
    }
    mood = { text, vec: await embedQuery(text, onStatus) };
  }

  async function search(text, limit = 50, onStatus) {
    const q = await embedQuery(text, onStatus);
    return candidates
      .map((item) => ({ item, score: dot(rowOf(item), q) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  return { next, setMood, search, get mood() { return mood?.text ?? null; } };
}
