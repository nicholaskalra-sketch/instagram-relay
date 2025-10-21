// api/ogrelay.js
// Instagram OG relay with CORS. Tries (1) oEmbed, (2) direct HTML, (3) r.jina.ai mirror,
// (4) ddinstagram mirror, (5) ddinstagram via r.jina.ai.
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
  const target = normalizeIgUrl(raw);

  try {
    // 1) oEmbed
    const fromOEmbed = await tryOEmbed(target);
    if (fromOEmbed) return res.status(200).json({ ...fromOEmbed, source: "oembed" });

    // 2) Direct HTML
    let html = await fetchHtml(target);
    let parsed = extractOgAndText(html);
    if (hasUseful(parsed)) {
      return res.status(200).json({ ok: true, ...parsed, source: "html" });
    }

    // 3) r.jina.ai mirror (http, https)
    const hostAndPath = target.replace(/^https?:\/\//i, "");
    const mirrors = [
      `https://r.jina.ai/http://${hostAndPath}`,
      `https://r.jina.ai/https://${hostAndPath}`,
    ];
    for (const m of mirrors) {
      html = await fetchHtml(m);
      parsed = extractOgAndText(html);
      if (hasUseful(parsed)) {
        return res.status(200).json({ ok: true, ...parsed, source: "mirror" });
      }
    }

    // 4) ddinstagram mirror (construct from original /p/ or /reel/ path)
    const ddUrl = toDdInstagram(target);          // e.g., https://ddinstagram.com/p/abc123/
    if (ddUrl) {
      html = await fetchHtml(ddUrl);
      parsed = extractOgAndText(html);
      if (hasUseful(parsed)) {
        return res.status(200).json({ ok: true, ...parsed, source: "ddinstagram" });
      }
    }

    // 5) ddinstagram via r.jina.ai (http/https)
    if (ddUrl) {
      const ddHostPath = ddUrl.replace(/^https?:\/\//i, "");
      const ddMirrors = [
        `https://r.jina.ai/http://${ddHostPath}`,
        `https://r.jina.ai/https://${ddHostPath}`,
      ];
      for (const m of ddMirrors) {
        html = await fetchHtml(m);
        parsed = extractOgAndText(html);
        if (hasUseful(parsed)) {
          return res.status(200).json({ ok: true, ...parsed, source: "dd-mirror" });
        }
      }
    }

    // Nothing useful anywhere
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
  https = https.replace(/<|>/g, "");
  try {
    const url = new URL(https);
    // Ensure trailing slash for /p/ or /reel/ paths (helps some mirrors)
    if ((/\/p\/[^/]+$/.test(url.pathname) || /\/reel\/[^/]+$/.test(url.pathname)) && !url.pathname.endsWith("/")) {
      url.pathname += "/";
      https = url.toString();
    }
  } catch {}
  return https;
}

function toDdInstagram(igUrl) {
  try {
    const u = new URL(igUrl);
    // Map instagram.com → ddinstagram.com (keep path/query)
    return `https://ddinstagram.com${u.pathname}${u.search || ""}`;
  } catch {
    return null;
  }
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
  });
  if (!res.ok) {
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

  const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const noStyles  = noScripts.replace(/<style[\s\S]*?<\/style>/gi, " ");
  const textOnly  = noStyles.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const text      = textOnly.slice(0, 4000);

  return { ogTitle, ogDesc, ogImage, text };
}

function hasUseful(parsed) {
  if (!parsed) return false;
  if (parsed.ogTitle || parsed.ogDesc) return true;
  if (parsed.text && parsed.text !== "Instagram") return true;
  return false;
}
