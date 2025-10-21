// api/ogrelay.js
// Minimal Instagram OG relay with CORS. Returns og fields + small text.
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const url = (req.query.url || "").toString().trim();
  if (!/^https?:\/\//i.test(url) || !/instagram\.com\//i.test(url)) {
    return res.status(400).json({ error: "Provide a valid Instagram URL." });
  }

  try {
    const target = url.replace(/^http:\/\//i, "https://");

    // Try oEmbed first (often works server-side)
    try {
      const oembed = await fetch(
        "https://www.instagram.com/oembed/?omitscript=true&url=" + encodeURIComponent(target),
        { method: "GET", headers: { "User-Agent": "VercelRelay/1.0" } }
      );
      if (oembed.ok) {
        const j = await oembed.json();
        const title = (j.title || "").toString();
        const author = (j.author_name || "").toString();
        const thumb = (j.thumbnail_url || "").toString();
        const text = [title, `By ${author} — Instagram`].filter(Boolean).join(" | ");
        if (title) {
          return res.status(200).json({
            ok: true, ogTitle: title, ogDesc: `By ${author} — Instagram`,
            ogImage: thumb, text, source: "oembed"
          });
        }
      }
    } catch { /* fall through */ }

    // Fallback: fetch HTML and extract OG tags
    const igRes = await fetch(target, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!igRes.ok) {
      return res.status(igRes.status).json({ error: `Fetch failed: ${igRes.status} ${igRes.statusText}` });
    }

    const html = await igRes.text();
    const getMeta = (key) => {
      const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i");
      const m1 = html.match(re1); if (m1?.[1]) return m1[1].trim();
      const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["'][^>]*>`, "i");
      const m2 = html.match(re2); return m2?.[1]?.trim() || "";
    };

    const ogTitle = getMeta("og:title");
    const ogDesc  = getMeta("og:description");
    const ogImage = getMeta("og:image");

    const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
    const noStyles  = noScripts.replace(/<style[\s\S]*?<\/style>/gi, " ");
    const textOnly  = noStyles.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const text      = textOnly.slice(0, 4000);

    return res.status(200).json({ ok: true, ogTitle, ogDesc, ogImage, text, source: "html" });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Relay error" });
  }
}
