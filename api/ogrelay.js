// api/ogrelay.js
// Instagram OG relay with CORS. Tries (1) oEmbed, (2) direct HTML, (3) read-only mirror.
// Returns: { ok, ogTitle, ogDesc, ogImage, text, source }

export default async function handler(req, res) {
  // ---- CORS ----
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  // ---- Validate input ----
  const raw = (req.query.url || "").toString().trim();
  if (!/^https?:\/\//i.test(raw) || !/instagram\.com\//i.test(raw)) {
    return res.status(400).json({ error: "Provide a valid Instagram post URL." });
  }
  // normalize to https + ensure trailing slash for /p/ or /reel/ links
  const target = normalizeIgUrl(raw);

  try {
    // 1) oEmbed (fast when it works)
    const fromOEmbed = await tryOEmbed(target);
    if (fromOEmbed) return res.status(200).json({ ...fromOEmbed, source: "oembed" });

    // 2) Direct HTML (may hit login wall; try anyway)
    const html = await fetchHtml(target);
    let parsed = extractOgAndText(html);
    if (hasUseful(parsed)) {
      return res.status(200).json({ ok: true, ...parsed, source: "html" });
    }

    // 3) Mirror fallback via r.jina.ai (http and https variants)
    const hostAndPath = target.replace(/^https?:\/\//i, "");
    const mirrors = [
      `https://r.jina.ai/http://${hostAndPath}`,
      `https://r.jina.ai/https://${hostAndPath}`,
    ];
    for (const m of mirrors) {
      const mh = await fetchHtml(m);
      parsed = extractOgAndText(mh);
      if (hasUseful(parsed)) {
        return res.status(200).json({ ok: true, ...parsed, source: "mirror" });
      }
    }

    // Nothing useful anywhere → likely private/blocked/removed
    return res.status(200).json({
      ok: true,
      ogTitle: "",
      ogDesc: "",
      ogImage: "",
      text: "Instagram",
      source: "empty"
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Relay error" });
  }
}

// ---------- helpers ----------

function normalizeIgUrl(u) {
  let https = u.replace(/^http:\/\//i, "https://");
  // strip angle brackets or accidental encoding
  https = https.replace(/<|>/g, "");
  // common pattern: ensure trailing slash for /p/ and /reel/ (helps some mirrors)
  try {
    const url = new URL(https);
    if ((/\/p\/[^/]+$/.test(url.pathname) || /\/reel\/[^/]+$/.test(url.pathname)) && !url.pathname.endsWith("/")) {
      url.pathname += "/";
      https = url.toString();
    }
  } catch (_) {}
  return https;
}

async function tryOEmbed(postUrl) {
  try {
    const oembed = await fetch(
      "https://www.instagram.com/oembed/?omitscript=true&url=" + encodeURIComponent(postUrl),
      { method: "GET", headers: { "User-Agent": "VercelRelay/1.0" } }
    );
    if (!oembed.ok) return null;
    const j = await oembed.json();
    const title  = (j.title || "").toString();
    const author = (j.author_name || "").toString();
    const thumb  = (j.thumbnail_url || "").toString();
    if (title) {
      return {
        ok: true,
        ogTitle: title,
        ogDesc: author ? `By ${author} — Instagram` : "",
        ogImage: thumb,
        text: [title, author ? `By ${author} — Instagram` : ""].filter(Boolean).join(" | ")
      };
    }
    return null;
  } catch { return null; }
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.8",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    // Vercel functions use global fetch; default timeout is fine for MVP
  });
  if (!res.ok) {
    // Return minimal HTML so downstream continues
    return "<html><head><title>Instagram</title></head><body>Instagram</body></html>";
  }
  return await res.text();
}

function extractOgAndText(html = "") {
  const getMeta = (key) => {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i");
    const m1 = html.match(re1);
    if (m1?.[1]) return m1[1].trim();
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["'][^>]*>`, "i");
    const m2 = html.match(re2);
    return m2?.[1]?.trim() || "";
  };

  const ogTitle = getMeta("og:title");
  const ogDesc  = getMeta("og:description");
  const ogImage = getMeta("og:image");

  // visible text fallback
  const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const noStyles  = noScripts.replace(/<style[\s\S]*?<\/style>/gi, " ");
  const textOnly  = noStyles.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const text      = textOnly.slice(0, 4000);

  return { ogTitle, ogDesc, ogImage, text };
}

function hasUseful(parsed) {
  if (!parsed) return false;
  if (parsed.ogTitle || parsed.ogDesc || (parsed.text && parsed.text !== "Instagram")) return true;
  return false;
}
