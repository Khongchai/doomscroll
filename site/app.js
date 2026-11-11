import { h, card, spotlight, relativeAge } from "./render.js";
import { record, readPref, writePref } from "./history.js";
import { createRecommender } from "./recommend.js";

const PAGE = 30;
const LIBRARY_KINDS = new Set(["paper", "article", "concept"]);
const READ_KINDS = new Set(["post", "paper", "article", "concept"]);

const FEED_KINDS = [
  { id: "all", label: "All", test: (i) => !!i.date },
  { id: "video", label: "Videos", test: (i) => i.kind === "video" && !!i.date },
  { id: "post", label: "Posts", test: (i) => i.kind === "post" && !!i.date },
  { id: "note", label: "Bluesky", test: (i) => i.kind === "note" },
  { id: "library", label: "Library", test: (i) => LIBRARY_KINDS.has(i.kind) || !i.date },
];

const RANDOM_KINDS = [
  { id: "any", label: "Anything", test: (i) => i.kind !== "note" && !i.short },
  { id: "watch", label: "Watch", test: (i) => i.kind === "video" && !i.short },
  { id: "read", label: "Read", test: (i) => READ_KINDS.has(i.kind) },
];

const $ = (id) => document.getElementById(id);

async function loadData() {
  const [data, bin] = await Promise.all([
    fetch("data/items.json").then((r) => r.json()),
    fetch("data/embeddings.bin").then((r) => (r.ok ? r.arrayBuffer() : new ArrayBuffer(0))),
  ]);
  return { ...data, vectors: new Int8Array(bin) };
}

function chipGroup(container, options, selected, onChange, { multi = false } = {}) {
  const buttons = options.map((o) =>
    h("button", {
      class: "chip",
      type: "button",
      "aria-pressed": String(multi ? selected.has(o.id) : selected === o.id),
      onclick: () => onChange(o.id),
    }, o.label),
  );
  container.replaceChildren(...buttons);
  return {
    update(sel) {
      options.forEach((o, i) => buttons[i].setAttribute("aria-pressed", String(multi ? sel.has(o.id) : sel === o.id)));
    },
  };
}

function setupFeed(data, authors, recommender) {
  const list = $("feed-list");
  const status = $("feed-status");
  const search = $("search");
  let kind = readPref("feedKind", "all");
  const picked = new Set(readPref("feedAuthors", []));
  let query = "";
  let semantic = false;
  let results = [];
  let shown = 0;
  let searchToken = 0;

  const haystack = new Map();
  const textFor = (item) => {
    let s = haystack.get(item);
    if (!s) {
      s = `${item.title} ${item.text} ${item.cite ?? ""} ${authors.get(item.author)?.name ?? ""} ${item.link?.title ?? ""}`.toLowerCase();
      haystack.set(item, s);
    }
    return s;
  };

  const kindChips = chipGroup($("kinds"), [...FEED_KINDS, { id: "semantic", label: "Search by meaning" }], kind, (id) => {
    if (id === "semantic") {
      semantic = !semantic;
      $("kinds").lastChild.setAttribute("aria-pressed", String(semantic));
      refresh();
      return;
    }
    kind = id;
    writePref("feedKind", kind);
    kindChips.update(kind);
    $("kinds").lastChild.setAttribute("aria-pressed", String(semantic));
    refresh();
  });

  const groups = [
    { id: "people", label: "People" },
    { id: "blogs", label: "Engineering blogs" },
    { id: "library", label: "Library" },
  ];
  const groupChips = [];
  const togglePick = (id) => {
    picked.has(id) ? picked.delete(id) : picked.add(id);
    writePref("feedAuthors", [...picked]);
    groupChips.forEach((c) => c.update(picked));
    refresh();
  };
  const sections = groups.map((g) => {
    const row = h("div", { class: "chips" });
    const options = data.meta.authors
      .filter((a) => (a.group ?? "people") === g.id)
      .map((a) => ({ id: a.id, label: a.name }));
    groupChips.push(chipGroup(row, options, picked, togglePick, { multi: true }));
    if (g.id === "people") return row;
    const hasPicked = options.some((o) => picked.has(o.id));
    return h("details", { open: hasPicked }, h("summary", {}, `${g.label} (${options.length}) ▾`), row);
  });
  $("authors").replaceChildren(...sections);

  function keywordResults() {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const kindTest = FEED_KINDS.find((k) => k.id === kind)?.test ?? FEED_KINDS[0].test;
    const pool = data.items.filter((i) => (!picked.size || picked.has(i.author)));
    if (!tokens.length) {
      const out = pool.filter(kindTest);
      if (kind === "library") out.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title));
      return out;
    }
    const matchKind = kind === "all" ? () => true : kindTest;
    return pool.filter((i) => matchKind(i) && tokens.every((t) => textFor(i).includes(t)));
  }

  async function refresh() {
    query = search.value.trim();
    const token = ++searchToken;
    if (semantic && query) {
      status.textContent = "Searching by meaning…";
      try {
        const hits = await recommender.search(query, 80, (msg) => (status.textContent = msg));
        if (token !== searchToken) return;
        results = hits.map((x) => x.item).filter((i) => !picked.size || picked.has(i.author));
      } catch (error) {
        status.textContent = `Could not load the model: ${error.message}`;
        return;
      }
    } else {
      results = keywordResults();
    }
    shown = 0;
    list.replaceChildren();
    renderMore();
    const updated = data.meta.generatedAt ? ` · updated ${relativeAge(data.meta.generatedAt)}` : "";
    status.textContent = `${results.length.toLocaleString()} items${updated}`;
    if (!results.length) list.append(h("li", { class: "empty" }, "Nothing matches."));
  }

  function renderMore() {
    const slice = results.slice(shown, shown + PAGE);
    list.append(...slice.map((i) => card(i, authors.get(i.author))));
    shown += slice.length;
  }

  let debounce;
  search.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, semantic ? 400 : 120);
  });

  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && shown < results.length) renderMore();
  }, { rootMargin: "800px" }).observe($("sentinel"));

  refresh();
}

function setupRandom(data, authors) {
  let kind = readPref("randomKind", "any");
  const recent = [];
  const chips = chipGroup($("random-kinds"), RANDOM_KINDS, kind, (id) => {
    kind = id;
    writePref("randomKind", kind);
    chips.update(kind);
    show();
  });

  function pick() {
    const test = RANDOM_KINDS.find((k) => k.id === kind).test;
    const byAuthor = new Map();
    for (const item of data.items) {
      if (!test(item) || recent.includes(item.id)) continue;
      if (!byAuthor.has(item.author)) byAuthor.set(item.author, []);
      byAuthor.get(item.author).push(item);
    }
    const groups = [...byAuthor.values()];
    if (!groups.length) return null;
    const group = groups[Math.floor(Math.random() * groups.length)];
    return group[Math.floor(Math.random() * group.length)];
  }

  function show() {
    const item = pick();
    const target = $("random-card");
    if (!item) {
      target.replaceChildren(h("p", { class: "empty" }, "Nothing to show."));
      return;
    }
    recent.push(item.id);
    if (recent.length > 50) recent.shift();
    target.replaceChildren(spotlight(item, authors.get(item.author)));
  }

  $("random-next").addEventListener("click", show);
  return {
    enter() {
      if (!$("random-card").childElementCount) show();
    },
    key(e) {
      if (e.key === " " || e.key === "ArrowRight") {
        e.preventDefault();
        show();
      }
    },
  };
}

function setupNext(data, authors, recommender) {
  let current = null;
  const target = $("next-card");
  const moodInput = $("mood");
  const moodStatus = $("mood-status");

  function whyLine(choice) {
    if (choice.explore) return ["Something different from your usual picks."];
    const a = choice.because;
    if (!a) return null;
    if (a.mood) return ["Matches what you are in the mood for: ", h("b", {}, a.mood)];
    const title = a.item.title || a.item.text.slice(0, 80);
    if (a.seed) return ["Close to a starting interest: ", h("b", {}, title)];
    return ["Because you liked ", h("b", {}, title)];
  }

  function show() {
    current = recommender.next();
    if (!current) {
      target.replaceChildren(h("p", { class: "empty" }, "You have seen everything. Come back after the next refresh."));
      return;
    }
    record(current.item.id, "shown");
    target.replaceChildren(spotlight(current.item, authors.get(current.item.author), whyLine(current)));
  }

  function act(action) {
    if (!current) return;
    if (action === "open") {
      record(current.item.id, "open");
      window.open(current.item.url, "_blank", "noopener");
      return;
    }
    record(current.item.id, action);
    show();
  }

  $("next-open").addEventListener("click", () => act("open"));
  $("next-like").addEventListener("click", () => act("like"));
  $("next-skip").addEventListener("click", () => act("skip"));
  $("next-nope").addEventListener("click", () => act("nope"));

  $("mood-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = moodInput.value.trim();
    try {
      await recommender.setMood(text, (msg) => (moodStatus.textContent = msg));
      moodStatus.textContent = text ? `Steering towards “${text}”. Clear the box to stop.` : "";
      show();
    } catch (error) {
      moodStatus.textContent = `Could not load the model: ${error.message}`;
    }
  });

  return {
    enter() {
      if (!target.childElementCount) show();
    },
    key(e) {
      const keys = { o: "open", l: "like", s: "skip", ArrowRight: "skip", x: "nope" };
      if (keys[e.key]) {
        e.preventDefault();
        act(keys[e.key]);
      }
    },
  };
}

async function main() {
  let data;
  try {
    data = await loadData();
  } catch (error) {
    document.body.append(h("p", { class: "empty" }, `Could not load the feed data: ${error.message}`));
    return;
  }
  const authors = new Map(data.meta.authors.map((a) => [a.id, a]));
  const recommender = createRecommender({ items: data.items, vectors: data.vectors, dim: data.meta.dim });

  setupFeed(data, authors, recommender);
  const modes = { random: setupRandom(data, authors), next: setupNext(data, authors, recommender) };
  const views = { feed: $("feed-view"), random: $("random-view"), next: $("next-view") };
  let route = "feed";

  function go() {
    route = location.hash.slice(1) in views ? location.hash.slice(1) : "feed";
    for (const [name, el] of Object.entries(views)) el.hidden = name !== route;
    document.querySelectorAll("[data-route]").forEach((a) => {
      if (a.dataset.route === route) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    modes[route]?.enter();
  }

  window.addEventListener("hashchange", go);
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    modes[route]?.key(e);
  });
  go();
}

main();
