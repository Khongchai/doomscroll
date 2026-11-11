import { record } from "./history.js";

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const KIND_LABEL = {
  video: "Video",
  post: "Post",
  note: "Bluesky",
  paper: "Paper",
  article: "Article",
  concept: "Concept",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function when(item) {
  if (!item.date) return item.year ? String(item.year) : "";
  const d = new Date(item.date);
  if (item.approx) return `~${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const mins = (Date.now() - d.getTime()) / 60000;
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  if (mins < 60 * 24 * 7) return `${Math.round(mins / 1440)}d`;
  if (d.getFullYear() === new Date().getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function relativeAge(iso) {
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (mins < 60) return `${Math.round(mins)} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

function player(item) {
  const el = h(
    "div",
    { class: "player", role: "button", tabindex: "0", "aria-label": `Play ${item.title}` },
    h("img", { src: `https://i.ytimg.com/vi/${item.video}/hqdefault.jpg`, alt: "", loading: "lazy" }),
  );
  const play = () => {
    if (el.classList.contains("playing")) return;
    el.classList.add("playing");
    el.replaceChildren(
      h("iframe", {
        src: `https://www.youtube-nocookie.com/embed/${item.video}?autoplay=1&rel=0`,
        allow: "autoplay; encrypted-media; picture-in-picture; fullscreen",
        allowfullscreen: true,
        title: item.title,
      }),
    );
    record(item.id, "open");
  };
  el.addEventListener("click", play);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") play();
  });
  return el;
}

function openLink(item, label, cls) {
  return h(
    "a",
    { href: item.url, target: "_blank", rel: "noopener", class: cls, onclick: () => record(item.id, "open") },
    label,
  );
}

function metaLine(item, author) {
  return h(
    "div",
    { class: "meta" },
    h("span", { class: "kind" }, KIND_LABEL[item.kind] ?? item.kind),
    h("span", { class: "who" }, author?.name ?? item.author),
    item.cite && item.kind === "paper" && item.author === "classics" ? h("span", {}, item.cite) : null,
    h("span", {}, when(item)),
  );
}

export function card(item, author) {
  const isNote = item.kind === "note";
  return h(
    "li",
    { class: `card ${item.kind}`, "data-id": item.id },
    metaLine(item, author),
    isNote ? null : h("h3", {}, openLink(item, item.title || item.url)),
    item.text ? h("p", { class: isNote ? "" : "clamp" }, item.text) : null,
    isNote && item.link?.url ? openLink({ ...item, url: item.link.url }, item.link.title || item.link.url, "linkcard") : null,
    item.video ? player(item) : item.img ? h("img", { class: "thumb", src: item.img, alt: "", loading: "lazy" }) : null,
    isNote ? h("div", { class: "meta" }, openLink(item, "View on Bluesky")) : null,
  );
}

export function spotlight(item, author, why) {
  return h(
    "article",
    { class: "spot-inner" },
    metaLine(item, author),
    h("h2", {}, openLink(item, item.title || item.text.slice(0, 120))),
    item.text && item.title ? h("p", {}, item.text.length > 420 ? item.text.slice(0, 419) + "…" : item.text) : null,
    why ? h("div", { class: "why" }, ...why) : null,
    item.video ? player(item) : item.img ? h("img", { class: "thumb", src: item.img, alt: "" }) : null,
  );
}
