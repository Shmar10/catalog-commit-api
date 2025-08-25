// Vercel Serverless Function to upsert custom-recipes.json in your GitHub Pages repo.
//
// Required Environment Variables (set in Vercel):
//   ADMIN_PASSWORD  - password you'll type in admin.html
//   GH_TOKEN        - GitHub fine-grained token (Contents: Read/Write) for the Pages repo
//   GH_OWNER        - your GitHub username or org
//   GH_REPO         - your Pages repo name (hosting index.html)
//   GH_BRANCH       - main (or your default)
//   GH_FILE         - custom-recipes.json
//
// POST body:
// { password: "...", recipe: { name, base[], profile[], sweetness, ingredients[[amt,item]], method, glass, garnish, tags[] } }

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method-not-allowed" });

  try {
    const { password, recipe } = req.body || {};
    if (!password || password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "unauthorized" });
    }
    if (!recipe || !recipe.name) return res.status(400).json({ error: "bad-recipe" });

    const slug = slugify(recipe.name);
    const normalized = {
      id: slug,
      name: recipe.name,
      base: (recipe.base || []).map(b => String(b).toLowerCase()),
      profile: Array.isArray(recipe.profile) ? recipe.profile : (recipe.profile ? [recipe.profile] : []),
      sweetness: recipe.sweetness || "balanced",
      ingredients: (recipe.ingredients || []).map(p => Array.isArray(p) ? p : [p.amount||"", p.item||""]),
      method: recipe.method || "",
      glass: recipe.glass || "",
      garnish: recipe.garnish || "",
      tags: (recipe.tags || [])
    };

    const owner = process.env.GH_OWNER;
    const repo = process.env.GH_REPO;
    const path = process.env.GH_FILE || "custom-recipes.json";
    const branch = process.env.GH_BRANCH || "main";
    const token = process.env.GH_TOKEN;

    if (!owner || !repo || !token) return res.status(500).json({ error: "missing-github-config" });

    const headers = {
      "Authorization": `token ${token}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json"
    };

    // Get existing file
    const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
    let sha = null, list = [];
    let getRes = await fetch(getUrl, { headers });
    if (getRes.status === 200) {
      const body = await getRes.json();
      sha = body.sha;
      const content = Buffer.from(body.content, "base64").toString("utf-8");
      try { list = JSON.parse(content); if (!Array.isArray(list)) list = []; } catch { list = []; }
    } else if (getRes.status === 404) {
      list = [];
    } else {
      const txt = await getRes.text();
      return res.status(500).json({ error: "github-read-failed", detail: txt });
    }

    // Upsert by id (slug of name)
    const idx = list.findIndex(r => (r.id || slugify(r.name || "")) === slug);
    if (idx >= 0) list[idx] = { ...list[idx], ...normalized };
    else list.push(normalized);

    // Sort for readability
    list.sort((a,b) => (a.name||'').localeCompare(b.name||''));

    // Commit back
    const newContent = Buffer.from(JSON.stringify(list, null, 2), "utf-8").toString("base64");
    const putUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
    const msg = (idx>=0 ? `Update recipe: ${normalized.name}` : `Add recipe: ${normalized.name}`);
    const putBody = { message: msg, content: newContent, branch };
    if (sha) putBody.sha = sha;

    const putRes = await fetch(putUrl, { method: "PUT", headers, body: JSON.stringify(putBody) });
    if (putRes.status >= 200 && putRes.status < 300) {
      return res.status(200).json({ ok: true, id: slug });
    } else {
      const txt = await putRes.text();
      return res.status(500).json({ error: "github-write-failed", detail: txt });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server-error" });
  }
}

function slugify(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }
