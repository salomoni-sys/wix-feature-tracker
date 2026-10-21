// Daily updater for the Wix Feature Request Tracker. Node 20+, no dependencies.
// 1. Re-checks every tracked request's Help Center page for its status label.
// 2. Mondays and manual runs: walks Help Center category pages and adds any request
//    listed under "Feature Requests" that isn't tracked yet.
// 3. Reads Wix's Planned ahead and New releases pages for roadmap items and releases.
// 4. Health check: if most pages can't be read (for example after a Help Center
//    redesign), it keeps the last good data and fails the run so GitHub emails you.
import { readFile, writeFile } from "node:fs/promises";

const FILE = new URL("../data.json", import.meta.url);
const HC = "https://support.wix.com";
const ARTICLE = HC + "/en/article/";
const PLANNED_PAGE = "https://www.wix.com/updates?view=planned";
const RELEASES_PAGE = "https://www.wix.com/updates";
const CONCURRENCY = 4, DELAY_MS = 300, TIMEOUT_MS = 15000;
const CRAWL_MAX_PAGES = 2500, CRAWL_BUDGET_MS = 12 * 60 * 1000;
const UA = "WixFeatureRequestTracker/2.0 (public status tracker; daily check)";
const FULL = process.env.FULL_SCAN === "1" || new Date().getUTCDay() === 1;
const today = new Date().toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ALIAS = {"studio editor":"Wix Studio","wix studio":"Wix Studio","developer":"Developers","wix headless":"Developers","wix mobile apps":"Mobile apps","wix chat":"Chat & messaging","wix smart chat":"Chat & messaging","wix messaging":"Chat & messaging","wix inbox":"Chat & messaging","wix invoices":"Invoices & Quotes","wix price quotes":"Invoices & Quotes","wix invoices & price quotes":"Invoices & Quotes","wix audio":"Wix Music","sales tax":"Payments & tax","wix payments":"Payments & tax","wix pricing plans":"Pricing Plans","pricing plans":"Pricing Plans","wix harmony editor feature":"Wix Harmony","wix harmony editor":"Wix Harmony","wix hotels by hotelrunner":"Wix Hotels","wix pos go":"Wix POS","wix pos register":"Wix POS","wix mobile pos":"Wix POS","wix stores pos":"Wix POS","wix bookings pos":"Wix POS","email marketing":"Marketing","google ads with wix":"Marketing","facebook ads":"Marketing","wix apps":"Third-party apps","wix app":"Wix app","wix automations":"Automations","wix event":"Wix Events","bookings":"Wix Bookings","wix online programs":"Online Programs","online programs":"Online Programs","site members":"Site Members"};
// Tags on Wix's Releases & Updates pages, in order of preference, mapped to tracker products.
const TAGS = [["Wix Harmony","Wix Harmony"],["Bookings","Wix Bookings"],["Services","Wix Bookings"],["eCommerce","Wix Stores"],["Events","Wix Events"],["Restaurants","Wix Restaurants"],["Wix Restaurants","Wix Restaurants"],["Forms","Wix Forms"],["Blog","Wix Blog"],["Online programs","Online Programs"],["Pricing plans","Pricing Plans"],["Payments","Payments & tax"],["Multilingual","Wix Multilingual"],["CMS","CMS"],["Analytics","Analytics"],["SEO","Marketing"],["Marketing","Marketing"],["Dev Tools","Developers"],["Wix Blocks","Wix Blocks"],["Studio Workspace","Wix Studio"],["Studio Editor","Wix Studio"],["Wix Studio","Wix Studio"],["Wix Editor","Wix Editor"],["Wix App","Wix app"],["AI Tools","AI tools"]];

const productFor = title => {
  const m = /^(.*?)\s+(?:Feature\s+)?Request:/i.exec(title);
  if (!m) return "Other";
  const raw = m[1].trim();
  return ALIAS[raw.toLowerCase()] || raw;
};
const decode = s => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;|&rsquo;/g, "’").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = html => decode(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const lines = html => decode(html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
  .replace(/<h2[^>]*>/gi, "\n@@H2 ").replace(/<\/(h1|h2|h3|p|div|li|span|a|button)>|<br\s*\/?>/gi, "\n")
  .replace(/<a[^>]+href="([^"]+)"[^>]*>/gi, "\n@@LINK $1\n").replace(/<[^>]+>/g, ""))
  .split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);

// Returns "v" (collecting votes), "r" (released), "p" (planned) or null (couldn't tell).
function statusOf(html) {
  const t = text(html).toLowerCase();
  if (!t.includes("request")) return null;
  if (/collecting votes|vote for this feature/.test(t)) return "v";
  if (/(excited|pleased|happy|thrilled) to announce|feature request\s*\|\s*(released|launched)|\blaunched (in|on) /.test(t)) return "r";
  if (/feature request\s*\|\s*(planned|in development|coming soon)/.test(t)) return "p";
  return null;
}

async function get(url) {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en" }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: r.status, body: r.ok ? await r.text() : "" };
  } catch (e) { return { status: 0, body: "" }; }
}
async function pool(list, fn, deadline = Infinity) {
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < list.length && Date.now() < deadline) { const idx = i++; await fn(list[idx], idx); await sleep(DELAY_MS); }
  }));
}

const data = JSON.parse(await readFile(FILE, "utf8"));
data.items ||= {}; data.changes ||= [];
const changes = [];
const log = (...a) => console.log(...a);

// ---- 1. Discover new requests from category pages (Mondays and manual runs) ----
let discovered = 0, crawled = 0;
if (FULL) {
  const deadline = Date.now() + CRAWL_BUDGET_MS;
  const seen = new Set(), queue = [HC + "/en"], found = new Map();
  while (queue.length && seen.size < CRAWL_MAX_PAGES && Date.now() < deadline) {
    const batch = queue.splice(0, CONCURRENCY * 4).filter(u => !seen.has(u));
    batch.forEach(u => seen.add(u));
    await pool(batch, async url => {
      const { body } = await get(url); if (!body) return; crawled++;
      const h1 = text((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body) || [])[1] || "").trim();
      for (const [, href, inner] of body.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const abs = href.startsWith("/") ? HC + href : href;
        const art = /^https:\/\/support\.wix\.com\/en\/article\/([a-z0-9-]+)\/?$/.exec(abs);
        if (art) {
          const title = text(inner).trim();
          if (/\bRequest:/i.test(title) && !data.items[art[1]] && !found.has(art[1])) found.set(art[1], { title, cat: h1 });
          continue;
        }
        const cat = /^https:\/\/support\.wix\.com\/en\/([a-z0-9-]+)\/?$/.exec(abs);
        if (cat && !seen.has(abs) && !queue.includes(abs)) queue.push(abs);
      }
    }, deadline);
  }
  for (const [slug, f] of found) {
    data.items[slug] = ["?", productFor(f.title), f.title.replace(/^.*?Request:\s*/i, "").trim(), f.cat, today];
  }
  discovered = found.size;
  log(`Discovery: crawled ${crawled} Help Center pages, found ${discovered} untracked requests.`);
}

// ---- 2. Re-check every tracked request ----
const slugs = Object.keys(data.items);
let checked = 0, unreadable = 0, skipped = 0;
await pool(slugs, async slug => {
  const item = data.items[slug];
  if (item[6] === "rel") { skipped++; return; }
  const { status, body } = await get(ARTICLE + slug);
  const s = status === 200 ? statusOf(body) : null;
  if (!s) {
    if (item[0] === "?") { delete data.items[slug]; discovered--; return; }   // couldn't confirm a new one: drop it
    if (!/request/.test(slug)) { skipped++; return; }                          // release article, not a request page
    unreadable++; return;
  }
  checked++;
  if (item[0] === "?") { item[0] = s; changes.push({ id: slug, t: item[2], from: null, to: s, at: today }); return; }
  if (item[0] !== s) { changes.push({ id: slug, t: item[2], from: item[0], to: s, at: today }); item[0] = s; item[4] = today; }
});
log(`Status check: ${checked} read, ${unreadable} unreadable, ${skipped} skipped.`);

// ---- 3. Health check ----
const attempted = checked + unreadable;
if (attempted > 20 && checked / attempted < 0.5) {
  console.error(`Only ${checked} of ${attempted} request pages could be read. The Help Center may have changed. Keeping the last good data.`);
  process.exit(1);
}

// ---- 4. Planned ahead and New releases pages ----
function pickProduct(tags, title) {
  const hay = " " + tags.join(" | ") + " | " + title + " ";
  for (const [tag, prod] of TAGS) if (hay.toLowerCase().includes(tag.toLowerCase())) return prod;
  return null;
}
{
  const { body } = await get(PLANNED_PAGE);
  const L = body ? lines(body) : [], planned = [];
  for (let i = 0; i < L.length; i++) {
    const eta = /^ETA:\s*(Q[1-4])\s*-?\s*(\d{4})$/i.exec(L[i]); if (!eta) continue;
    let j = i + 1; while (j < L.length && !L[j].startsWith("@@H2 ")) j++;
    if (j >= L.length || j - i > 6) continue;
    const t = L[j].slice(5).trim(); const tags = [];
    for (let k = j + 1; k < Math.min(L.length, j + 12) && tags.length < 8; k++) if (L[k].length < 30 && !L[k].startsWith("@@")) tags.push(L[k]);
    if (t && !planned.some(p => p.t === t)) planned.push({ t, eta: `${eta[1].toUpperCase()} ${eta[2]}`, p: pickProduct(tags, t) || "Roadmap" });
  }
  if (planned.length >= 3) {
    const before = new Set((data.planned || []).map(p => p.t));
    if (data.planned) planned.filter(p => !before.has(p.t)).forEach(p => changes.push({ id: "", t: p.t, from: null, to: "p", at: today }));
    data.planned = planned;
  }
  log(`Planned ahead: ${planned.length} items read${planned.length < 3 ? " (too few, kept previous)" : ""}.`);
}
{
  const { body } = await get(RELEASES_PAGE);
  const L = body ? lines(body) : []; let date = null, title = null, tags = [], added = 0;
  const MONTH = /^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})$/;
  for (const l of L) {
    const d = MONTH.exec(l);
    if (d) { date = new Date(`${d[1]} ${d[2]}, ${d[3]} UTC`).toISOString().slice(0, 10); title = null; tags = []; continue; }
    if (l.startsWith("@@H2 ")) { title = l.slice(5).trim(); tags = []; continue; }
    if (title && !l.startsWith("@@") && l.length < 30) tags.push(l);
    const link = /^@@LINK (https:\/\/support\.wix\.com\/en\/article\/([a-z0-9-]+))/.exec(l);
    if (link && date && title) {
      const slug = link[2];
      if (!data.items[slug]) {
        data.items[slug] = ["r", pickProduct(tags, title) || "Releases", title, "", date, "Announced on Wix’s New releases page.", "rel"];
        changes.push({ id: slug, t: title, from: null, to: "r", at: today }); added++;
      }
      title = null;
    }
  }
  log(`New releases: ${added} new items added.`);
}

data.checkedAt = new Date().toISOString();
data.found = checked; data.queries = attempted; data.unreadable = unreadable; data.crawled = crawled;
data.changes = [...changes, ...data.changes.filter(c => !changes.some(n => n.id && n.id === c.id))].slice(0, 60);
await writeFile(FILE, JSON.stringify(data, null, 1) + "\n");
log(`Done: ${changes.length} changes, ${Math.max(0, discovered)} new requests.`);
