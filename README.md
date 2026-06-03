# ⚡ Gist Preview

A static, dependency-free web app that renders any GitHub Gist as a live web page —
like [gistpreview.github.io](https://gistpreview.github.io/), but it also **resolves
references between the gist's own files** (stylesheets, scripts, images, and links).

## Usage

```
https://<you>.github.io/gist-preview/<gist_id>
```

Optionally point at a specific file:

```
https://<you>.github.io/gist-preview/<gist_id>/login.html
```

If the file is omitted it renders `index.html`, or the first `*.html` file in the
gist. You can also paste a gist id or a full `gist.github.com` URL into the box at the
top. The legacy `?id=<gist_id>&file=<name>` query form still works — it redirects to
the clean path.

## How it works

1. Fetches `https://api.github.com/gists/<id>` (truncated files are re-fetched in full
   from their `raw_url`).
2. Picks the entry HTML file.
3. Rewrites references so the gist renders as if its files lived side by side:
   - `<link>`, `<script>`, `<img>`, `<source>`/`srcset`, `<video poster>`,
     `<audio>`, `<track>`, `<iframe>`, `<embed>`, `<object data>` → blob URLs
     built from the matching gist files.
   - `<style>` blocks, `style="…"` attributes, and linked CSS — `url(...)` and
     `@import` are resolved recursively to blob URLs.
   - `<a>` links to **other HTML files** in the gist re-drive this preview app
     (`?id=…&file=…`); links to other files become blob URLs.
4. Renders the result into a sandboxed `<iframe>` via a **blob URL** (so the document
   has its own base URL — same-page `#section` anchors scroll inside the preview
   instead of navigating the app).
5. Links between HTML files in the gist navigate the app via `history.pushState`
   (clean `/{gist_id}/{file}` URLs, no reload), with a full-navigation fallback.

### Routing on GitHub Pages

GitHub Pages has no server-side routing, so clean paths use the well-known
[spa-github-pages](https://github.com/rafgraph/spa-github-pages) trick: `404.html`
encodes the requested path into a query and redirects to the app root, and
`index.html` restores the real URL before the app boots. If you deploy under a
different layout, adjust `pathSegmentsToKeep` in `404.html` (1 for a project page like
`user.github.io/repo/`, 0 for a user page or custom domain at the root).

Gists are a flat list of files, so references are matched by filename (e.g.
`./css/style.css`, `/style.css`, and `style.css` all resolve to the gist file
`style.css`). External URLs (`http(s):`, `//`, `data:`, anchors, `mailto:`) are left
untouched.

### Limitations

- Paths referenced from **inside JavaScript at runtime** (e.g. `fetch('data.json')`)
  aren't rewritten — only references in HTML/CSS markup are.
- Gists only store text files, so binary assets must be referenced externally or
  inlined as data URIs (this matches GitHub's own constraint).

## Deploying to GitHub Pages

Push these files to a repo and enable Pages (Settings → Pages → deploy from branch).
There is no build step — it's plain HTML/CSS/JS.

## Local development

```
python3 -m http.server 8766
# open http://localhost:8766/?id=<gist_id>
```
