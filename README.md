# doomscroll

A personal feed of videos, blog posts, Bluesky posts and papers from a hand-picked list of people and engineering blogs, sorted by time. It is a static site on GitHub Pages; a scheduled GitHub Action fetches every source, merges the result with what was already stored, and redeploys.

It has three modes:

- **Feed** (`#feed`): everything with a date, newest first. Filter by type (Videos, Posts, Bluesky, Library) and by person or blog. Search matches every word against the title, text and author name; "Search by meaning" uses a local embedding model instead.
- **Random** (`#random`): one full-screen item at a time, chosen by picking a random author first and then a random item, so channels with 900 videos don't crowd out Lamport's papers. Filter: Anything / Watch / Read. Space or → for another.
- **Next** (`#next`): one recommendation at a time, with a line saying why it was picked. Keys: `o` open, `l` more like this, `s` / → skip, `x` not for me. The "In the mood for…" box steers recommendations with free text.

## Layout

```
scripts/
  people.mjs     people (YouTube, Bluesky, blog feeds, library) and engineering blogs
  concepts.mjs   Wikipedia seed concepts and a hand-written list of classic papers
  build.mjs      fetch, merge, embed; writes site/data/
site/            everything GitHub Pages serves, no build step
  index.html, style.css
  app.js         routing, feed, random mode, next mode
  render.js      DOM helpers, cards, YouTube click-to-play
  recommend.js   recommender and in-browser query embedding
  history.js     localStorage: per-item interaction history and UI prefs
  data/items.json      generated: { meta, items }
  data/embeddings.bin  generated: int8 vectors, 384 per row
.github/workflows/update.yml   every 3 h: build data, commit it, deploy Pages
```

## Data

`site/data/items.json` has `meta` (generation time, author list with `group`: people, blogs or library) and `items`. One item:

| field | meaning |
| --- | --- |
| `id` | `yt:<videoId>`, `blog:<url>`, `bsky:<at-uri>`, `lamport:<anchor>`, `iq:<slug>`, `wiki:<title>`, `classic:<url>` |
| `kind` | `video`, `post`, `note` (Bluesky), `paper`, `article` (IQ), `concept` (Wikipedia) |
| `author` | id from `meta.authors` |
| `title`, `text`, `url` | text is plain, at most about 600 characters |
| `date` | ISO string, or `null` for undated library items |
| `approx` | the date came from YouTube's "3 years ago" text, so it is only accurate to the month |
| `video`, `short` | YouTube id; shorts are left out of Random and Next |
| `img`, `link` | Bluesky image and link-card |
| `year`, `cite`, `notes` | papers |
| `e` | row in `embeddings.bin`, absent for Bluesky posts |

Items with no `date` (Lamport's papers, IQ articles, Wikipedia concepts, classics, Discord engineering posts that have dropped out of its RSS) form the library: they do not appear in the time-sorted feed, but do appear in the Library filter, in search, in Random and in Next.

### How build.mjs works

1. Loads the previous `items.json` and `embeddings.bin`. Old items are never dropped, so the feed accumulates history even though RSS feeds only return the latest 10 to 20 entries.
2. Fetches every source in parallel. A failing source logs a warning and keeps its old items.
   - YouTube: channel RSS (latest 15, exact dates). Once a week, or when `FORCE_ARCHIVE=1`, `yt-dlp --flat-playlist --extractor-args youtubetab:approximate_date` lists each channel's whole `/videos` tab with approximate dates. An exact RSS date always wins over an approximate one.
   - Blogs: RSS or Atom via `fast-xml-parser`. Discord's RSS has no categories, so only posts linked from `discord.com/category/engineering` are kept (`onlyCategory`).
   - Bluesky: `public.api.bsky.app` `getAuthorFeed` without replies or reposts. No auth needed.
   - Lamport: parses `lamport.azurewebsites.net/pubs/pubs.html` (one `<LI><A NAME=…>` per paper; links to the PDF when one exists).
   - Inigo Quilez: the article index at `iquilezles.org/articles/`, plus the first paragraph of each article (fetched once).
   - Wikipedia: REST summary for each seed concept, plus two `morelike:` related pages per seed. Requests are spaced 250 ms apart with backoff on 429, because Wikipedia rate-limits hard. Seeds already present are skipped on later runs.
3. Embeds new non-Bluesky items with `Xenova/all-MiniLM-L6-v2` (q8, 384 dims) through `@huggingface/transformers` in Node, normalises, quantises to int8 and writes them in item order.

Env flags: `SKIP_ARCHIVE=1` skips yt-dlp, `FORCE_ARCHIVE=1` runs it regardless of age.

## Recommendations

No server and no API key. The vectors are computed at build time; the browser only loads them (about 1.5 KB per 4 items).

- Every interaction is stored in `localStorage` under `doomscroll:history:v1` as `{ [itemId]: { open, like, skip, nope, shown, t } }`. Clicking a link or playing a video anywhere in the site counts as `open`.
- Positive anchors are items with `like × 2 + open`, negative anchors are `nope × 1.5 + skip × 0.25`, both halved every 30 days.
- With fewer than four positive anchors, seed interests fill in: M/M/1 queue, Kolmogorov complexity, Raft, the Lehmer RNG and Martin Fowler's latest posts (`SEED_TITLES` in `recommend.js`).
- A candidate's score is its best cosine similarity to any positive anchor, minus a penalty if it is close to a negative anchor, minus a small penalty if the same author was shown in the last three picks. The pick is sampled from the top 8 with a softmax; 15% of the time it is a random item from ranks 40 to 600 instead, labelled "Something different".
- Opened, liked and rejected items never come back; skipped and shown items come back after 5 days.
- "In the mood for…" and "Search by meaning" load the same MiniLM model in the browser from jsDelivr (`@huggingface/transformers@4.3.1`, about 25 MB, cached by the browser) and embed the query on the fly.

## Running locally

```
npm ci
pip install yt-dlp          # optional, for the YouTube back catalogue
node scripts/build.mjs      # SKIP_ARCHIVE=1 for a faster run
npm run serve               # http://localhost:8080
```

The first full build takes several minutes, mostly Wikipedia rate limits and yt-dlp.

## Adding a source

- A person: add an entry to `people` in `scripts/people.mjs` with any of `youtube: { channelId }`, `bluesky` (handle), `feeds` (RSS/Atom URLs), `links`. Find a channel id with `curl -sL https://www.youtube.com/@handle | grep -o '"externalId":"UC[^"]*"'`.
- An engineering blog: add to `blogs` with `feeds`.
- A concept: add a Wikipedia title to `seedConcepts`; a paper or essay: add to `classics`.
- A new library scraper: write a `fetchX` in `build.mjs` that returns items with `date: null` and push it onto `tasks` in `main()`.

## Known gaps and ideas

- X/Twitter has no free public API, so it is not used. Bluesky covers most of the people here; LaurieWired and Inigo Quilez post on both.
- Martin Fowler's feed only has recent entries; his older articles and bliki are not scraped yet (`martinfowler.com/tags/` would be the place to start).
- Martin Kleppmann's papers (`martin.kleppmann.com/papers/`) and Ray Myers' older talks could be added as library scrapers.
- yt-dlp may be blocked on GitHub's runners at times; the archive then just isn't refreshed, and RSS keeps new videos coming.
- History is per browser. Export/import of `localStorage` (or a GitHub Gist sync) would make it portable.
- A small generative model in the browser (WebLLM with a 0.5B to 1.5B model) could write a one-line reason for each recommendation from the user's history. The current "why" line is the nearest anchor.
