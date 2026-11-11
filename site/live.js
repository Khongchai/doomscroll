const BSKY_FEED = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed";

function blueskyHandle(author) {
  if (author.bluesky) return author.bluesky;
  const link = (author.links ?? []).find((l) => l.startsWith("https://bsky.app/profile/"));
  return link ? link.slice("https://bsky.app/profile/".length) : null;
}

function embedParts(embed) {
  if (!embed) return {};
  const type = embed.$type ?? "";
  if (type.startsWith("app.bsky.embed.images")) return { img: embed.images?.[0]?.thumb };
  if (type.startsWith("app.bsky.embed.external")) {
    const ext = embed.external ?? {};
    return { img: ext.thumb, link: { url: ext.uri, title: ext.title } };
  }
  if (type.startsWith("app.bsky.embed.video")) return { img: embed.thumbnail };
  if (type.startsWith("app.bsky.embed.recordWithMedia")) return embedParts(embed.media);
  return {};
}

function toItem(authorId, post) {
  const text = (post.record?.text ?? "").trim();
  const extra = embedParts(post.embed);
  return {
    id: `bsky:${post.uri}`,
    kind: "note",
    author: authorId,
    title: "",
    text,
    url: `https://bsky.app/profile/${post.author.handle}/post/${post.uri.split("/").pop()}`,
    date: new Date(post.record?.createdAt ?? post.indexedAt).toISOString(),
    img: extra.img,
    link: extra.link,
  };
}

async function fetchAuthor(author, handle) {
  const url = `${BSKY_FEED}?actor=${encodeURIComponent(handle)}&limit=30&filter=posts_no_replies`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return [];
  const data = await res.json();
  return data.feed
    .filter((f) => !f.reason)
    .map((f) => toItem(author.id, f.post))
    .filter((i) => i.text || i.img || i.link);
}

export async function fetchLiveBluesky(authors) {
  const jobs = authors
    .map((a) => [a, blueskyHandle(a)])
    .filter(([, handle]) => handle)
    .map(([a, handle]) => fetchAuthor(a, handle).catch(() => []));
  return (await Promise.all(jobs)).flat();
}

export function mergeLive(items, fresh) {
  const known = new Set(items.map((i) => i.id));
  const added = fresh.filter((i) => !known.has(i.id));
  if (!added.length) return 0;
  items.push(...added);
  items.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });
  return added.length;
}
