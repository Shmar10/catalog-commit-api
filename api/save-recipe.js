// Vercel Serverless Function to upsert custom-recipes.json in your GitHub Pages repo.
//
// ✅ Supports single { recipe } or bulk { recipes: [...] } payloads
// ✅ Upserts by id (or slug(name) if id missing)
// ✅ Optional CORS allowlist via ALLOWED_ORIGIN
//
// ── Required Environment Variables (Vercel → Project → Settings → Environment Variables) ──
//   ADMIN_PASSWORD  - password you'll type in admin.html
//   GH_TOKEN        - GitHub fine-grained token (Contents: Read/Write) for the Pages repo
//   GH_OWNER        - your GitHub username or org
//   GH_REPO         - your Pages repo name (hosting index.html)
//   GH_BRANCH       - main (or your default)
//   GH_FILE         - custom-recipes.json
//   ALLOWED_ORIGIN  - (optional) e.g. https://<username>.github.io/<repo>
//
// ── POST bodies supported ──
// { password: "…", recipe: { name, base[], profile[], sweetness, ingredients[[amt,item]], method, glass, garnish, tags[] } }
// { password: "…", recipes: [ {…}, {…} ] }

export default async function handler(req, res) {
  // --- CORS (allow OPTIONS preflight) ---
  const origin = req.headers.origin || "";
  const allowed = process.env.ALLOWED_ORIGIN || ""; // leave blank to allow all origins
  res.setHeader("Access-Control-Allow-Origin", allowed || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method-not-allowed" });
  }
  if (allowed && origin && origin !== allowed) {
    return res.status(403).json({ error: "forbidden-origin" });
  }

  try {
    const { password, recipe, recipes } = req.body || {};
    if (!password || password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "unauthorized" });
    }

    // Normalize input(s)
    let incoming = [];
    if (Array.isArray(recipes)) incoming = recipes;
    else if (recipe) incoming = [recipe];
    if (!incoming.length) return res.status(400).json({ error: "no-recipes" });

    // GitHub config
    const owner  = process.env.GH_OWNER;
    const repo   = process.env.GH_REPO;
    const path   = process.env.GH_FILE   || "custom-recipes.json";
    const branch = process.env.GH_BRANCH || "main";
    const token  = process.env.GH_TOKEN;

    if (!owner || !repo || !token) {
      return res.status(500).json({ error: "missing-github-config" });
    }

    const headers = {
      "Authorization": `token ${token}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json"
    };

    // --- Read existing file from GitHub ---
    const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
    let sha = null, list = [];
    const getRes = await fetch(getUrl, { headers });
    if (getRes.status === 200) {
      const body = await getRes.json();
      sha = body.sha;
      const content = Buffer.from(body.content || "", "base64").toString("utf-8");
      try {
        const parsed = JSON.parse(content);
        list = Array.isArray(parsed) ? parsed : [];
      } catch {
        list = [];
      }
    } else if (getRes.status !== 404) {
      return res.status(500).json({ error: "github-read-failed", detail: await getRes.text() });
    }
    // if 404 -> file doesn’t exist yet; we’ll create it below

    // --- Helpers ---
    const slug = (s) => String(s || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

    const normalize = (r) => {
      // Accept both single string or array for profile; ensure arrays
      const profileArr =
        Array.isArray(r.profile) ? r.profile
        : (r.profile ? [r.profile] : []);

      // Ingredients: accept [["2 oz","Gin"], ...] or [{amount,item}, ...]
      const ingredientsArr = Array.isArray(r.ingredients) ? r.ingredients.map(p => {
        if (Array.isArray(p)) return [p[0] || "", p[1] || ""];
        if (p && typeof p === "object") return [p.amount || "", p.item || ""];
        return ["", String(p || "")];
      }) : [];

      return {
        id: r.id || slug(r.name),
        name: r.name,
        base: (r.base || []).map(b => String(b).toLowerCase()),
        profile: profileArr,
        sweetness: r.sweetness || "balanced",
        ingredients: ingredientsArr,
        method: r.method || "",
        glass: r.glass || "",
        garnish: r.garnish || "",
        tags: Array.isArray(r.tags) ? r.tags : (r.tags ? [r.tags] : [])
      };
    };

    // --- Upsert incoming recipes ---
    let upserted = 0;
    const upsertIds = [];
    for (const raw of incoming) {
      if (!raw || !raw.name) continue; // skip invalid
      const n = normalize(raw);
      const findId = (x) => (x.id || slug(x.name || ""));
      const idx = list.findIndex(x => findId(x) === n.id);
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...n }; // merge/overwrite
      } else {
        list.push(n);
      }
      upserted++;
      upsertIds.push(n.id);
    }

    // Sort for readability by name
    list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    // --- Commit back to GitHub ---
    const newContent = Buffer.from(JSON.stringify(list, null, 2), "utf-8").toString("base64");
    const putUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
    const message = upserted === 1
      ? `Upsert recipe: ${incoming[0]?.name || "1 item"}`
      : `Upsert ${upserted} recipes`;

    const putBody = { message, content: newContent, branch, ...(sha ? { sha } : {}) };
    const putRes = await fetch(putUrl, { method: "PUT", headers, body: JSON.stringify(putBody) });
    if (putRes.status < 200 || putRes.status >= 300) {
      return res.status(500).json({ error: "github-write-failed", detail: await putRes.text() });
    }

    return res.status(200).json({ ok: true, count: upserted, ids: upsertIds });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server-error" });
  }
}
