// Daily updater for the Wix Feature Request Tracker.
// Reads data.json, re-checks every request's Wix Help Center page for its current
// status label, looks for new request articles, and writes data.json back.
// Runs on Node 20+ with no dependencies.
import { readFile, writeFile } from "node:fs/promises";

const FILE = new URL("../data.json", import.meta.url);
const ARTICLE = "https://support.wix.com/en/article/";
const SITEMAPS = ["https://support.wix.com/sitemap.xml", "https://support.wix.com/en/sitemap.xml"];
const CONCURRENCY = 4, DELAY_MS = 400, MAX_NEW = 200;
const UA = "WixFeatureRequestTracker/1.0 (public status tracker; daily check)";
const today = new Date().toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ALIAS = {"studio editor":"Wix Studio","wix studio":"Wix Studio","developer":"Developers","wix headless":"Developers","wix mobile apps":"Mobile apps","wix chat":"Chat & messaging","wix smart chat":"Chat & messaging","wix messaging":"Chat & messaging","wix inbox":"Chat & messaging","wix invoices":"Invoices & Quotes","wix price quotes":"Invoices & Quotes","wix invoices & price quotes":"Invoices & Quotes","wix audio":"Wix Music","sales tax":"Payments & tax","wix pricing plans":"Pricing Plans","pricing plans":"Pricing Plans","wix harmony editor feature":"Wix Harmony","wix harmony editor":"Wix Harmony","wix hotels by hotelrunner":"Wix Hotels","wix pos go":"Wix POS","wix pos register":"Wix POS","wix mobile pos":"Wix POS","wix stores pos":"Wix POS","wix bookings pos":"Wix POS","email marketing":"Marketing","google ads with wix":"Marketing","facebook ads":"Marketing","wix apps":"Third-party apps","wix app":"Wix app","wix automations":"Automations","wix event":"Wix Events","bookings":"Wix Bookings","wix online programs":"Online Programs","online programs":"Online Programs","site members":"Site Members"};

function productFor(title) {
  const m = /^(.*?)\s+(?:Feature\s+)?Request:/i.exec(title);
  if (!m) return "Other";
  const raw = m[1].trim();
  return ALIAS[raw.toLowerCase()] || raw;
}
const text = html => html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;|&rsquo;/g, "’").replace(/&quot;/g, '"').replace(/\s+/g, " ");

// Returns "v" (collecting votes), "r" (released), "p" (planned) or null (couldn't tell).
function statusOf(html) {
  const t = text(html).toLowerCase();
  if (!t.includes("request")) return null;
  if (/collecting votes/.test(t)) return "v";
  if (/(excited|pleased|happy|thrilled) to announce|feature request\s*\|\s*(released|launched)|\blaunched (in|on) /.test(t)) return "r";
  if (/feature request\s*\|\s*(planned|in development|coming soon)/.test(t)) return "p";
  return null;
}
const titleOf = html => ((/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || "").replace(/\s*\|\s*Help Center.*$/i, "").trim();

async function get(url) {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: r.ok ? await r.text() : "" };
  } catch (e) { return { status: 0, body: "" }; }
}
async function pool(list, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < list.length) { const idx = i++; out[idx] = await fn(list[idx]); await sleep(DELAY_MS); }
  }));
  return out;
}

// Best-effort discovery of request articles that aren't tracked yet.
async function discover(known) {
  const found = new Set(), seen = new Set(), queue = [...SITEMAPS];
  while (queue.length && seen.size < 60) {
    const url = queue.shift(); if (seen.has(url)) continue; seen.add(url);
    const { body } = await get(url); if (!body) continue;
    for (const [, loc] of body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      if (/\.xml(\?|$)/.test(loc)) { queue.push(loc); continue; }
      const m = /support\.wix\.com\/en\/article\/([a-z0-9-]+)/.exec(loc);
      if (m && /request/.test(m[1]) && !known.has(m[1])) found.add(m[1]);
    }
  }
  return [...found].slice(0, MAX_NEW);
}

const data = JSON.parse(await readFile(FILE, "utf8"));
data.items ||= {}; data.changes ||= [];
const slugs = Object.keys(data.items);
let checked = 0, unreadable = 0;
const changes = [];

await pool(slugs, async slug => {
  const { status, body } = await get(ARTICLE + slug);
  if (status !== 200) { unreadable++; return; }
  const s = statusOf(body); if (!s) { unreadable++; return; }
  checked++;
  const item = data.items[slug];
  if (item[0] !== s) { changes.push({ id: slug, t: item[2], from: item[0], to: s, at: today }); item[0] = s; item[4] = today; }
});

const fresh = await discover(new Set(slugs));
await pool(fresh, async slug => {
  const { status, body } = await get(ARTICLE + slug);
  if (status !== 200) return;
  const s = statusOf(body); if (!s) return;
  const full = titleOf(body);
  if (!/request/i.test(full)) return;
  data.items[slug] = [s, productFor(full), full.replace(/^.*?Request:\s*/i, "").trim(), "", today];
  changes.push({ id: slug, t: data.items[slug][2], from: null, to: s, at: today });
  checked++;
});

data.checkedAt = new Date().toISOString();
data.found = checked; data.queries = slugs.length + fresh.length; data.unreadable = unreadable;
data.changes = [...changes, ...data.changes.filter(c => !changes.some(n => n.id === c.id))].slice(0, 60);
await writeFile(FILE, JSON.stringify(data, null, 1) + "\n");
console.log(`Checked ${checked} pages, ${unreadable} unreadable, ${fresh.length} new candidates, ${changes.length} changes.`);
