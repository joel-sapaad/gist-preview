# ⚡ Gist Preview

A static, dependency-free web app that renders any GitHub Gist as a live web page —
like [gistpreview.github.io](https://gistpreview.github.io/), but it also **resolves
references between the gist's own files** (stylesheets, scripts, images, and links).

## Usage

```
https://<you>.github.io/gist-preview/?id=<gist_id>
```

Optionally point at a specific file:

```
https://<you>.github.io/gist-preview/?id=<gist_id>&file=login.html
```

If `file` is omitted it renders `index.html`, or the first `*.html` file in the gist.

You can also paste a gist id or a full `gist.github.com` URL into the box at the top.

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
4. Renders the result in a sandboxed `<iframe>` (scripts run, the page can't reach
   your GitHub session).

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
