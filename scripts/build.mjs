import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { XMLParser } from "fast-xml-parser";
import { people, blogs, extraAuthors } from "./people.mjs";
import { seedConcepts, classics } from "./concepts.mjs";

const execFileAsync = promisify(execFile);
const DATA_DIR = new URL("../site/data/", import.meta.url);
const ITEMS_PATH = new URL("items.json", DATA_DIR);
const EMB_PATH = new URL("embeddings.bin", DATA_DIR);
const DIM = 384;
const USER_AGENT = "doomscroll-feed/1.0 (personal feed reader)";
const ARCHIVE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const TEXT_LIMIT = 600;

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });

async function fetchText(url, { attempts = 5, timeoutMs = 20000 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status === 503) {
        const wait = Number(res.headers.get("retry-after")) || 5 * (i + 1);
        lastError = new Error(`${res.status} ${url}`);
        await new Promise((r) => setTimeout(r, Math.min(wait, 60) * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.text();
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastError;
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

const wikiQueue = { last: 0 };

async function fetchWikiJson(url) {
  const gap = 250;
  const now = Date.now();
  const at = Math.max(now, wikiQueue.last + gap);
  wikiQueue.last = at;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
  return fetchJson(url);
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function plain(html, limit = TEXT_LIMIT) {
  if (html == null) return "";
  const raw = typeof html === "object" ? (html["#text"] ?? "") : String(html);
  const text = decodeEntities(
    raw
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? text.slice(0, limit - 1).trimEnd() + "…" : text;
}

function textOf(node) {
  if (node == null) return "";
  if (typeof node === "object") return String(node["#text"] ?? "");
  return String(node);
}

function isoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function videoItem({ videoId, author, title, text, date, approx, short }) {
  return {
    id: `yt:${videoId}`,
    kind: "video",
    author,
    title,
    text: text ?? "",
    url: short ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`,
    date,
    approx: approx || undefined,
    video: videoId,
    short: short || undefined,
  };
}

async function fetchYoutubeRss(person) {
  const body = await fetchText(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${person.youtube.channelId}`,
  );
  const feed = xml.parse(body).feed;
  return asArray(feed.entry).map((e) => {
    const link = asArray(e.link).map((l) => l["@href"]).find(Boolean) ?? "";
    return videoItem({
      videoId: textOf(e["yt:videoId"]),
      author: person.id,
      title: plain(e.title, 300),
      text: plain(e["media:group"]?.["media:description"]),
      date: isoDate(e.published),
      short: link.includes("/shorts/"),
    });
  });
}

async function fetchYoutubeArchive(person) {
  const { stdout } = await execFileAsync(
    "yt-dlp",
    [
      "--flat-playlist",
      "-J",
      "--extractor-args",
      "youtubetab:approximate_date",
      `https://www.youtube.com/channel/${person.youtube.channelId}/videos`,
    ],
    { maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60 * 1000 },
  );
  return asArray(JSON.parse(stdout).entries)
    .filter((e) => e?.id && e.title && !/^\[(private|deleted)/i.test(e.title))
    .map((e) =>
      videoItem({
        videoId: e.id,
        author: person.id,
        title: e.title,
        text: e.description ?? "",
        date: e.timestamp ? new Date(e.timestamp * 1000).toISOString() : null,
        approx: true,
      }),
    );
}

function mediaThumb(it) {
  return it["media:thumbnail"]?.["@url"] ?? asArray(it["media:content"]).find((m) => m?.["@medium"] === "image")?.["@url"];
}

async function fetchBlogFeed(person, url) {
  const doc = xml.parse(await fetchText(url));
  if (doc.rss) {
    return asArray(doc.rss.channel.item).map((it) => {
      const link = textOf(it.link) || textOf(it.guid);
      return {
        id: `blog:${link}`,
        kind: "post",
        author: person.id,
        title: plain(it.title, 300),
        text: plain(it.description ?? it["content:encoded"]),
        url: link,
        date: isoDate(textOf(it.pubDate) || textOf(it["dc:date"])),
        img: mediaThumb(it),
      };
    });
  }
  return asArray(doc.feed?.entry).map((it) => {
    const links = asArray(it.link);
    const link =
      links.find((l) => !l["@rel"] || l["@rel"] === "alternate")?.["@href"] ?? textOf(it.id);
    return {
      id: `blog:${link}`,
      kind: "post",
      author: person.id,
      title: plain(it.title, 300),
      text: plain(it.summary ?? it.content),
      url: link,
      date: isoDate(textOf(it.published) || textOf(it.updated)),
    };
  });
}

async function categoryLinks(pageUrl) {
  const html = await fetchText(pageUrl);
  const origin = new URL(pageUrl).origin;
  return [...html.matchAll(/<a[^>]*aria-label="([^"]+)"[^>]*href="(\/blog\/[^"]+)"/g)].map(([, title, href]) => ({
    url: origin + href,
    title: decodeEntities(title),
  }));
}

async function fetchFilteredBlog(person, url) {
  const [items, links] = await Promise.all([fetchBlogFeed(person, url), categoryLinks(person.onlyCategory)]);
  const allowed = new Map(links.map((l) => [l.url, l]));
  const dated = items.filter((i) => allowed.has(i.url));
  const seen = new Set(dated.map((i) => i.url));
  const undated = [...allowed.values()]
    .filter((l) => !seen.has(l.url) && !/patch notes/i.test(l.title))
    .map((l) => ({ id: `blog:${l.url}`, kind: "post", author: person.id, title: l.title, text: "", url: l.url, date: null }));
  return [...dated, ...undated];
}

function blueskyEmbed(embed) {
  if (!embed) return {};
  const type = embed.$type ?? "";
  if (type.startsWith("app.bsky.embed.images")) {
    return { img: embed.images?.[0]?.thumb };
  }
  if (type.startsWith("app.bsky.embed.external")) {
    const ext = embed.external ?? {};
    return { img: ext.thumb, link: { url: ext.uri, title: plain(ext.title, 200) } };
  }
  if (type.startsWith("app.bsky.embed.video")) {
    return { img: embed.thumbnail };
  }
  if (type.startsWith("app.bsky.embed.recordWithMedia")) {
    return blueskyEmbed(embed.media);
  }
  return {};
}

async function fetchBluesky(person) {
  const data = await fetchJson(
    `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(person.bluesky)}&limit=100&filter=posts_no_replies`,
  );
  return data.feed
    .filter((f) => !f.reason)
    .map(({ post }) => {
      const rkey = post.uri.split("/").pop();
      const text = plain(post.record?.text ?? "", 1000);
      const extra = blueskyEmbed(post.embed);
      return {
        id: `bsky:${post.uri}`,
        kind: "note",
        author: person.id,
        title: "",
        text,
        url: `https://bsky.app/profile/${post.author.handle}/post/${rkey}`,
        date: isoDate(post.record?.createdAt ?? post.indexedAt),
        img: extra.img,
        link: extra.link,
      };
    })
    .filter((it) => it.text || it.img || it.link);
}

async function fetchLamportPubs() {
  const base = "https://lamport.azurewebsites.net/pubs/";
  const res = await fetch(`${base}pubs.html`, { headers: { "user-agent": USER_AGENT } });
  const html = new TextDecoder("latin1").decode(await res.arrayBuffer());
  const parts = html.split(/<LI>\s*<A\s+NAME\s*=\s*"/i).slice(1);
  return parts
    .map((part) => {
      const anchor = part.slice(0, part.indexOf('"'));
      const title = plain(part.match(/<B>([\s\S]*?)<\/B>/i)?.[1] ?? "", 300);
      if (!anchor || !title) return null;
      const citeEnd = part.search(/<A\s+HREF|<HR>/i);
      const cite = plain(part.slice(part.indexOf("</B>") + 4, citeEnd > 0 ? citeEnd : 400), 300);
      const year = cite.match(/\b(19[5-9]\d|20[0-4]\d)\b/)?.[1];
      const pdf = part.match(/<A\s+HREF\s*=\s*"([^"]+\.pdf)"\s*>\s*PDF/i)?.[1];
      const afterHr = part.split(/<HR>/i).slice(-1)[0];
      return {
        id: `lamport:${anchor}`,
        kind: "paper",
        author: "lamport",
        title,
        text: plain(afterHr),
        cite,
        url: pdf ? new URL(pdf, base).href : `${base}pubs.html#${anchor}`,
        notes: `${base}pubs.html#${anchor}`,
        year: year ? Number(year) : undefined,
        date: null,
      };
    })
    .filter(Boolean);
}

async function fetchIqArticles(previous) {
  const base = "https://iquilezles.org/articles/";
  const html = await fetchText(base);
  const links = [...html.matchAll(/<a[^>]*href="?([a-z0-9_\-]+)"?[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(([, slug, label]) => ({ slug, title: plain(label, 200) }))
    .filter((l) => l.title && !/^(https?|mailto)/.test(l.slug));
  const unique = [...new Map(links.map((l) => [l.slug, l])).values()];
  return mapLimit(unique, 4, async ({ slug, title }) => {
    const id = `iq:${slug}`;
    const old = previous.get(id);
    if (old?.text) return { ...old, title };
    let text = "";
    try {
      const page = await fetchText(`${base}${slug}/`);
      const body = page.split(/<div[^>]*id="?content"?[^>]*>/i)[1] ?? page;
      text = plain(body.replace(/<div id="?header[\s\S]*?<\/div>\s*<\/div>/i, ""));
    } catch {}
    return { id, kind: "article", author: "iq", title, text, url: `${base}${slug}/`, date: null };
  });
}

async function wikiSummary(title) {
  const s = await fetchWikiJson(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`,
  );
  if (s.type === "disambiguation" || !s.extract) return null;
  return {
    id: `wiki:${s.titles?.canonical ?? s.title}`,
    kind: "concept",
    author: "wikipedia",
    title: s.title,
    text: plain(s.extract),
    url: s.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    img: s.thumbnail?.source,
    date: null,
  };
}

async function wikiRelated(title, limit) {
  const data = await fetchWikiJson(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${limit}&srsearch=${encodeURIComponent(`morelike:${title}`)}`,
  );
  return (data.query?.search ?? []).map((r) => r.title);
}

async function fetchConcepts(previous) {
  const known = new Set([...previous.values()].filter((i) => i.kind === "concept" && !i.related).map((i) => i.seed));
  const seeds = seedConcepts.filter((t) => !known.has(t));
  const related = (
    await mapLimit(seeds, 2, async (t) => {
      try {
        return (await wikiRelated(t, 2)).map((r) => ({ title: r, seed: t, related: true }));
      } catch {
        return [];
      }
    })
  ).flat();
  const wanted = [...seeds.map((t) => ({ title: t, seed: t })), ...related];
  const results = await mapLimit(wanted, 2, async (w) => {
    try {
      const item = await wikiSummary(w.title);
      return item && { ...item, seed: w.seed, related: w.related || undefined };
    } catch (error) {
      console.warn(`wiki ${w.title}: ${error.message}`);
      return null;
    }
  });
  return results.filter(Boolean);
}

function classicItems() {
  return classics.map((c) => ({
    id: `classic:${c.url}`,
    kind: "paper",
    author: "classics",
    title: c.title,
    text: c.text,
    cite: c.by,
    url: c.url,
    year: c.year,
    date: null,
  }));
}

async function loadPrevious() {
  if (!existsSync(ITEMS_PATH)) return { items: new Map(), vectors: new Map(), meta: {} };
  const data = JSON.parse(await readFile(ITEMS_PATH, "utf8"));
  const bin = existsSync(EMB_PATH) ? new Int8Array((await readFile(EMB_PATH)).buffer.slice(0)) : null;
  const items = new Map();
  const vectors = new Map();
  for (const item of data.items) {
    const { e, ...rest } = item;
    items.set(item.id, rest);
    if (bin && e != null && e >= 0 && (e + 1) * DIM <= bin.length) {
      vectors.set(item.id, bin.slice(e * DIM, (e + 1) * DIM));
    }
  }
  return { items, vectors, meta: data.meta ?? {} };
}

function mergeItem(old, fresh) {
  if (!old) return fresh;
  const merged = { ...old, ...Object.fromEntries(Object.entries(fresh).filter(([, v]) => v != null && v !== "")) };
  if (old.date && !old.approx && fresh.approx) {
    merged.date = old.date;
    delete merged.approx;
  }
  if (fresh.approx === undefined && fresh.date) delete merged.approx;
  if (old.text && !fresh.text) merged.text = old.text;
  return merged;
}

function embedText(item) {
  return `${item.title}. ${item.text}`.slice(0, 700);
}

async function embedAll(items, vectors) {
  const wanted = items.filter((i) => i.kind !== "note" && !vectors.has(i.id));
  if (!wanted.length) return;
  console.log(`embedding ${wanted.length} new items`);
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = new URL("../.cache/models", import.meta.url).pathname;
  const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
  const batchSize = 32;
  for (let i = 0; i < wanted.length; i += batchSize) {
    const batch = wanted.slice(i, i + batchSize);
    const out = await extractor(batch.map(embedText), { pooling: "mean", normalize: true });
    const data = out.data;
    batch.forEach((item, j) => {
      const row = new Int8Array(DIM);
      for (let d = 0; d < DIM; d++) row[d] = Math.max(-127, Math.min(127, Math.round(data[j * DIM + d] * 127)));
      vectors.set(item.id, row);
    });
    if ((i / batchSize) % 10 === 0) console.log(`  ${Math.min(i + batchSize, wanted.length)}/${wanted.length}`);
  }
}

async function hasYtDlp() {
  try {
    await execFileAsync("yt-dlp", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function run(label, task) {
  try {
    const items = await task();
    console.log(`${label}: ${items.length}`);
    return items;
  } catch (error) {
    console.warn(`${label} failed: ${error.message}`);
    return [];
  }
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const previous = await loadPrevious();
  const archiveAge = Date.now() - new Date(previous.meta.archiveAt ?? 0).getTime();
  const doArchive =
    process.env.SKIP_ARCHIVE !== "1" &&
    (process.env.FORCE_ARCHIVE === "1" || archiveAge > ARCHIVE_MAX_AGE_MS) &&
    (await hasYtDlp());

  const tasks = [];
  for (const person of people) {
    if (person.youtube) {
      tasks.push(run(`${person.id} youtube rss`, () => fetchYoutubeRss(person)));
      if (doArchive) tasks.push(run(`${person.id} youtube archive`, () => fetchYoutubeArchive(person)));
    }
    for (const url of person.feeds ?? []) tasks.push(run(`${person.id} feed`, () => fetchBlogFeed(person, url)));
    if (person.bluesky) tasks.push(run(`${person.id} bluesky`, () => fetchBluesky(person)));
  }
  for (const blog of blogs) {
    for (const url of blog.feeds) {
      tasks.push(
        run(`${blog.id} feed`, () => (blog.onlyCategory ? fetchFilteredBlog(blog, url) : fetchBlogFeed(blog, url))),
      );
    }
  }
  tasks.push(run("lamport pubs", fetchLamportPubs));
  tasks.push(run("iq articles", () => fetchIqArticles(previous.items)));
  tasks.push(run("wikipedia concepts", () => fetchConcepts(previous.items)));
  tasks.push(run("classics", async () => classicItems()));

  const results = await Promise.all(tasks);
  const archiveSucceeded = doArchive && results.some((r) => r.some((i) => i.approx));

  const merged = new Map(previous.items);
  for (const item of results.flat()) {
    if (!item?.id || !item.url) continue;
    merged.set(item.id, mergeItem(merged.get(item.id), item));
  }

  const items = [...merged.values()].sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return a.id.localeCompare(b.id);
  });

  await embedAll(items, previous.vectors);

  const rows = [];
  const out = items.map((item) => {
    const vec = previous.vectors.get(item.id);
    if (!vec) return item;
    rows.push(vec);
    return { ...item, e: rows.length - 1 };
  });
  const bin = new Int8Array(rows.length * DIM);
  rows.forEach((r, i) => bin.set(r, i * DIM));

  const meta = {
    generatedAt: new Date().toISOString(),
    archiveAt: archiveSucceeded ? new Date().toISOString() : previous.meta.archiveAt,
    dim: DIM,
    model: "Xenova/all-MiniLM-L6-v2",
    authors: [
      ...people.map(({ id, name, links, bluesky, youtube }) => ({
        id,
        name,
        links: [
          ...(links ?? []),
          ...(youtube ? [`https://www.youtube.com/channel/${youtube.channelId}`] : []),
          ...(bluesky ? [`https://bsky.app/profile/${bluesky}`] : []),
        ],
      })),
      ...blogs.map(({ id, name, feeds }) => ({ id, name, group: "blogs", links: [new URL(feeds[0]).origin] })),
      ...extraAuthors.map((a) => ({ ...a, group: "library" })),
    ],
  };

  const previousJson = existsSync(ITEMS_PATH) ? JSON.parse(await readFile(ITEMS_PATH, "utf8")) : null;
  const unchanged =
    previousJson &&
    JSON.stringify(previousJson.items) === JSON.stringify(out) &&
    JSON.stringify(previousJson.meta.authors) === JSON.stringify(meta.authors) &&
    previousJson.meta.archiveAt === meta.archiveAt;
  if (unchanged) {
    console.log(`no changes (${out.length} items)`);
    return;
  }
  await writeFile(ITEMS_PATH, JSON.stringify({ meta, items: out }));
  await writeFile(EMB_PATH, Buffer.from(bin.buffer));
  const counts = out.reduce((acc, i) => ((acc[i.kind] = (acc[i.kind] ?? 0) + 1), acc), {});
  console.log(`wrote ${out.length} items, ${rows.length} vectors`, counts);
}

await main();
