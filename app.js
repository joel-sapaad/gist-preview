/* ⚡ Gist Preview — render a GitHub Gist as a live web page, resolving
 * references between the gist's own files (css, js, images, links). */

(function () {
  "use strict";

  const API = "https://api.github.com/gists/";

  const MIME = {
    html: "text/html", htm: "text/html",
    css: "text/css",
    js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript",
    json: "application/json", map: "application/json",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
    jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    avif: "image/avif", ico: "image/x-icon", bmp: "image/bmp",
    xml: "application/xml", txt: "text/plain", md: "text/markdown",
    csv: "text/csv", wasm: "application/wasm",
    woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
    eot: "application/vnd.ms-fontobject",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
    mp4: "video/mp4", webm: "video/webm",
  };

  // ---- DOM handles ----
  const $ = (id) => document.getElementById(id);
  const els = {
    form: $("form"),
    gistInput: $("gist-input"),
    fileInput: $("file-input"),
    landing: $("landing"),
    status: $("status"),
    frame: $("frame"),
    rawLink: $("raw-link"),
  };

  // ---- small helpers ----
  const ext = (name) => {
    const m = /\.([^./\\]+)$/.exec(name || "");
    return m ? m[1].toLowerCase() : "";
  };
  const mimeFor = (name) => MIME[ext(name)] || "application/octet-stream";

  // A reference we should NOT touch (absolute, protocol-relative, anchors, etc.)
  const isExternal = (url) =>
    !url || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:|blob:|mailto:|tel:|javascript:)/i.test(url.trim());

  // Last path segment of a (possibly relative) reference, query/hash stripped.
  const basename = (url) => {
    const clean = url.trim().split("#")[0].split("?")[0].replace(/\/+$/, "");
    const parts = clean.split("/");
    return parts[parts.length - 1];
  };

  // Gists are a flat list of files, so we match references by their basename.
  function findFile(files, ref) {
    if (files[ref]) return files[ref];
    const want = basename(ref).toLowerCase();
    if (!want) return null;
    const key = Object.keys(files).find(
      (n) => n.toLowerCase() === want || basename(n).toLowerCase() === want
    );
    return key ? files[key] : null;
  }

  // ---- UI state ----
  function showStatus(html, isError) {
    els.landing.hidden = true;
    els.frame.hidden = true;
    els.status.hidden = false;
    els.status.className = isError ? "error" : "";
    els.status.innerHTML = html;
  }
  function showLoading(id) {
    showStatus(`<div class="spinner"></div><p>Loading gist <code>${escapeHtml(id)}</code>…</p>`);
  }
  function showError(msg) {
    showStatus(`<h2>Couldn't load gist</h2><p>${escapeHtml(msg)}</p>`, true);
  }
  function showLanding() {
    els.status.hidden = true;
    els.frame.hidden = true;
    els.landing.hidden = false;
    els.rawLink.hidden = true;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  // ---- query parsing ----
  // Accepts a bare id, a gist URL, or a gist.github.com/user/<id> URL.
  function extractId(value) {
    if (!value) return "";
    value = value.trim();
    const m = value.match(/([0-9a-f]{20,40}|[0-9a-f]{7,})(?:[/?#].*)?$/i);
    return m ? m[1] : value;
  }
  function getParams() {
    const u = new URL(location.href);
    let id = u.searchParams.get("id");
    let file = u.searchParams.get("file");
    // also tolerate hash form: #<id> or #<id>/<file>
    if (!id && u.hash) {
      const parts = u.hash.replace(/^#/, "").split("/");
      id = parts[0] || null;
      if (!file && parts[1]) file = decodeURIComponent(parts.slice(1).join("/"));
    }
    return { id: id ? extractId(id) : null, file };
  }

  // ---- fetching ----
  async function fetchGist(id) {
    const res = await fetch(API + encodeURIComponent(id), {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      if (res.status === 404) throw new Error("No gist with that id (404).");
      if (res.status === 403) throw new Error("GitHub API rate limit reached. Try again later.");
      throw new Error(`GitHub API returned ${res.status}.`);
    }
    const data = await res.json();
    const files = {};
    // Truncated files only ship partial content; fetch the raw blob in full.
    await Promise.all(
      Object.values(data.files).map(async (f) => {
        let content = f.content;
        if (f.truncated || content == null) {
          content = await (await fetch(f.raw_url)).text();
        }
        files[f.filename] = { name: f.filename, content };
      })
    );
    return { files, meta: data };
  }

  // ---- choose entry file ----
  function pickEntry(files, requested) {
    const names = Object.keys(files);
    if (requested && findFile(files, requested)) return findFile(files, requested).name;
    const index = names.find((n) => n.toLowerCase() === "index.html");
    if (index) return index;
    const html = names.find((n) => /\.html?$/i.test(n));
    return html || null;
  }

  // ---- blob URLs for referenced files (with recursive CSS rewriting) ----
  function makeResolver(files, gistId) {
    const cache = {};

    function blobFor(ref, stack) {
      const f = findFile(files, ref);
      if (!f) return null;
      const key = f.name.toLowerCase();
      if (cache[key]) return cache[key];
      // Cycle guard: emit raw content rather than recursing forever.
      if (stack && stack.includes(key)) {
        return (cache[key] = URL.createObjectURL(
          new Blob([f.content], { type: mimeFor(f.name) })
        ));
      }
      let content = f.content;
      if (ext(f.name) === "css") {
        content = rewriteCss(content, (stack || []).concat(key));
      }
      return (cache[key] = URL.createObjectURL(
        new Blob([content], { type: mimeFor(f.name) })
      ));
    }

    // Resolve url(...) and @import inside CSS to blob URLs of sibling files.
    function rewriteCss(css, stack) {
      css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, ref) => {
        if (isExternal(ref)) return m;
        const u = blobFor(ref, stack);
        return u ? `url(${q}${u}${q})` : m;
      });
      css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, ref) => {
        if (isExternal(ref)) return m;
        const u = blobFor(ref, stack);
        return u ? `@import ${q}${u}${q}` : m;
      });
      return css;
    }

    // App URL pointing at another file of the same gist.
    function appUrl(name) {
      return `?id=${encodeURIComponent(gistId)}&file=${encodeURIComponent(name)}`;
    }

    return { blobFor, rewriteCss, appUrl };
  }

  // ---- rewrite the entry HTML ----
  function rewriteHtml(html, files, gistId) {
    const r = makeResolver(files, gistId);
    const doc = new DOMParser().parseFromString(html, "text/html");

    // Strip any author <base> — it would break our blob-relative resolution.
    doc.querySelectorAll("base").forEach((b) => b.remove());

    const swap = (el, attr) => {
      const val = el.getAttribute(attr);
      if (isExternal(val)) return;
      const f = findFile(files, val);
      if (!f) return;
      const u = r.blobFor(f.name, []);
      if (u) el.setAttribute(attr, u);
    };

    doc.querySelectorAll("link[href]").forEach((el) => swap(el, "href"));
    doc.querySelectorAll("script[src]").forEach((el) => swap(el, "src"));
    doc
      .querySelectorAll("img[src],audio[src],video[src],source[src],track[src],iframe[src],embed[src]")
      .forEach((el) => swap(el, "src"));
    doc.querySelectorAll("video[poster]").forEach((el) => swap(el, "poster"));
    doc.querySelectorAll("object[data]").forEach((el) => swap(el, "data"));

    // srcset: "url1 1x, url2 2x"
    doc.querySelectorAll("img[srcset],source[srcset]").forEach((el) => {
      const out = el
        .getAttribute("srcset")
        .split(",")
        .map((part) => {
          const seg = part.trim();
          if (!seg) return "";
          const [u, ...rest] = seg.split(/\s+/);
          if (isExternal(u)) return seg;
          const f = findFile(files, u);
          const b = f ? r.blobFor(f.name, []) : null;
          return (b || u) + (rest.length ? " " + rest.join(" ") : "");
        })
        .filter(Boolean)
        .join(", ");
      el.setAttribute("srcset", out);
    });

    // Anchors: links to other HTML files re-drive this preview app; links to
    // other (non-HTML) gist files become blob downloads/views.
    doc.querySelectorAll("a[href]").forEach((el) => {
      const val = el.getAttribute("href");
      if (isExternal(val)) return;
      const f = findFile(files, val);
      if (!f) return;
      if (/\.html?$/i.test(f.name)) {
        el.setAttribute("href", r.appUrl(f.name));
        el.setAttribute("target", "_top");
      } else {
        const u = r.blobFor(f.name, []);
        if (u) el.setAttribute("href", u);
      }
    });

    // Inline CSS (both <style> blocks and style="" attributes).
    doc.querySelectorAll("style").forEach((el) => {
      el.textContent = r.rewriteCss(el.textContent, []);
    });
    doc.querySelectorAll("[style]").forEach((el) => {
      el.setAttribute("style", r.rewriteCss(el.getAttribute("style"), []));
    });

    return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  }

  // ---- main render flow ----
  async function render(id, requestedFile) {
    showLoading(id);
    try {
      const { files, meta } = await fetchGist(id);

      els.rawLink.href = meta.html_url || `https://gist.github.com/${id}`;
      els.rawLink.hidden = false;

      if (!Object.keys(files).length) {
        showError("This gist has no files.");
        return;
      }

      const entry = pickEntry(files, requestedFile);
      if (!entry) {
        const list = Object.keys(files).map((n) => `<code>${escapeHtml(n)}</code>`).join(", ");
        showError(`No HTML file to preview. Files in this gist: ${list}`);
        return;
      }

      els.fileInput.value = entry === requestedFile ? requestedFile : "";
      els.gistInput.value = id;

      const out = rewriteHtml(files[entry].content, files, id);
      els.landing.hidden = true;
      els.status.hidden = true;
      els.frame.hidden = false;
      els.frame.srcdoc = out;
      document.title = `${entry} — Gist Preview`;
    } catch (err) {
      showError(err.message || String(err));
    }
  }

  // ---- wire up ----
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = extractId(els.gistInput.value);
    if (!id) return;
    const file = els.fileInput.value.trim();
    const url = "?id=" + encodeURIComponent(id) + (file ? "&file=" + encodeURIComponent(file) : "");
    // Navigating updates the URL (shareable) and re-triggers boot().
    location.assign(url);
  });

  function boot() {
    const { id, file } = getParams();
    if (id) {
      els.gistInput.value = id;
      if (file) els.fileInput.value = file;
      render(id, file);
    } else {
      showLanding();
    }
  }

  boot();
})();
