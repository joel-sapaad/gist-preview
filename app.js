/* ⚡ Gist Preview — render a GitHub Gist as a live web page, resolving
 * references between the gist's own files (css, js, images, links).
 *
 * Routing is path-based:  <base>/<gist_id>           -> index.html (or first html)
 *                         <base>/<gist_id>/<file>    -> a specific file
 * (Legacy ?id=&file= and #id forms are accepted and rewritten to the clean URL.)
 */

(function () {
  "use strict";

  // The app root. index.html captures this in window.__APP_BASE__ before the
  // 404-redirect restore step rewrites the URL, so it's reliable even on a
  // deep-link reload. Fall back to the script's own location otherwise.
  const BASE = new URL(
    "./",
    window.__APP_BASE__ ||
      (document.currentScript && document.currentScript.src) ||
      (document.querySelector('script[src*="app.js"]') || {}).src ||
      location.href
  );

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
  };

  // Blob URLs created for the current render; revoked when we render again.
  let liveBlobs = [];
  let currentId = null;

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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  // ---- URL building / parsing ----
  function extractId(value) {
    if (!value) return "";
    value = value.trim();
    const m = value.match(/([0-9a-f]{20,40}|[0-9a-f]{7,})(?:[/?#].*)?$/i);
    return m ? m[1] : value;
  }

  // Clean path for a gist (+ optional file), relative to the document root.
  function routePath(id, file) {
    let p = BASE.pathname + encodeURIComponent(id);
    if (file) p += "/" + encodeURIComponent(file);
    return p;
  }
  // Absolute clean URL (used inside the iframe for links / open-in-new-tab).
  function routeUrl(id, file) {
    return BASE.origin + routePath(id, file);
  }

  // Work out which gist (and file) the current URL is asking for.
  function getRoute() {
    let rest = location.pathname;
    if (rest.startsWith(BASE.pathname)) rest = rest.slice(BASE.pathname.length);
    rest = rest.replace(/^\/+/, "");

    if (rest) {
      const segs = rest.split("/").filter(Boolean);
      const id = extractId(decodeURIComponent(segs[0]));
      // Gist ids are hex. Anything else (e.g. a stray "index.html") isn't a
      // route — fall through to the legacy/landing handling below.
      if (/^[0-9a-f]{7,}$/i.test(id)) {
        return {
          id,
          file: segs.length > 1 ? decodeURIComponent(segs.slice(1).join("/")) : null,
        };
      }
    }

    // Legacy fallback: the old ?id=&file= query form -> redirect to clean path.
    const u = new URL(location.href);
    const id = u.searchParams.get("id");
    if (id) return { id: extractId(id), file: u.searchParams.get("file"), legacy: true };

    return { id: null, file: null };
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
    document.title = "Gist Preview";
    els.status.hidden = true;
    els.frame.hidden = true;
    els.landing.hidden = false;
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
  function newBlob(content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    liveBlobs.push(url);
    return url;
  }

  function makeResolver(files, gistId) {
    const cache = {};

    function blobFor(ref, stack) {
      const f = findFile(files, ref);
      if (!f) return null;
      const key = f.name.toLowerCase();
      if (cache[key]) return cache[key];
      // Cycle guard: emit raw content rather than recursing forever.
      if (stack && stack.includes(key)) {
        return (cache[key] = newBlob(f.content, mimeFor(f.name)));
      }
      let content = f.content;
      if (ext(f.name) === "css") {
        content = rewriteCss(content, (stack || []).concat(key));
      }
      return (cache[key] = newBlob(content, mimeFor(f.name)));
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

    return { blobFor, rewriteCss };
  }

  // ---- rewrite the entry HTML ----
  function rewriteHtml(html, files, gistId) {
    const r = makeResolver(files, gistId);
    const doc = new DOMParser().parseFromString(html, "text/html");

    // Drop any author <base> — references are resolved here, not by the browser.
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

    // Anchors. Pure "#fragment" links are external() and left untouched — they
    // now resolve within the iframe's own (blob) document, so they just scroll.
    // Links to other HTML files in the gist re-drive this preview app; links to
    // other (non-HTML) gist files become blob URLs.
    doc.querySelectorAll("a[href]").forEach((el) => {
      const val = el.getAttribute("href");
      if (isExternal(val)) return;
      const f = findFile(files, val);
      if (!f) return;
      if (/\.html?$/i.test(f.name)) {
        // Carry any #fragment on the link through to the target page.
        const frag = (val.split("#")[1] ? "#" + val.split("#")[1] : "");
        el.setAttribute("href", routeUrl(gistId, f.name) + frag);
        el.setAttribute("data-gist-file", f.name);
        el.setAttribute("data-gist-frag", frag);
        el.setAttribute("target", "_top"); // fallback if click interception fails
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

  // Intercept clicks on in-gist HTML links so they navigate the app via
  // history (no full reload / no 404-redirect flash). The iframe is same-origin
  // (blob URL + allow-same-origin), so we can read its document.
  function attachLinkInterceptor() {
    let doc;
    try {
      doc = els.frame.contentDocument;
    } catch (e) {
      return; // cross-origin: fall back to target="_top" full navigation
    }
    if (!doc) return;
    doc.addEventListener(
      "click",
      (e) => {
        const a = e.target.closest && e.target.closest("a[data-gist-file]");
        if (!a) return;
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        const file = a.getAttribute("data-gist-file");
        const frag = a.getAttribute("data-gist-frag") || "";
        navigate(currentId, file, false, frag);
      },
      true
    );
  }

  // ---- main render flow ----
  async function render(id, requestedFile, frag) {
    currentId = id;
    showLoading(id);

    // Release blob URLs from the previous render.
    liveBlobs.forEach((u) => URL.revokeObjectURL(u));
    liveBlobs = [];

    try {
      const { files } = await fetchGist(id);
      // A newer navigation may have superseded this one mid-fetch.
      if (currentId !== id) return;

      if (!Object.keys(files).length) return showError("This gist has no files.");

      const entry = pickEntry(files, requestedFile);
      if (!entry) {
        const list = Object.keys(files).map((n) => `<code>${escapeHtml(n)}</code>`).join(", ");
        return showError(`No HTML file to preview. Files in this gist: ${list}`);
      }

      const out = rewriteHtml(files[entry].content, files, id);
      const docUrl = newBlob(out, "text/html") + (frag || "");

      els.frame.onload = () => attachLinkInterceptor();
      // Use location.replace so swapping the previewed file does NOT add an
      // entry to the joint session history — that keeps the browser Back button
      // tracking the app's own pushState entries rather than every iframe load.
      try {
        els.frame.contentWindow.location.replace(docUrl);
      } catch (e) {
        els.frame.src = docUrl;
      }

      els.landing.hidden = true;
      els.status.hidden = true;
      els.frame.hidden = false;
      document.title = `${entry} — Gist Preview`;
    } catch (err) {
      if (currentId === id) showError(err.message || String(err));
    }
  }

  // Push a clean URL and render, without a page reload.
  function navigate(id, file, replace, frag) {
    const url = routePath(id, file) + (frag || "");
    const state = { id, file };
    if (replace) history.replaceState(state, "", url);
    else history.pushState(state, "", url);
    route(frag);
  }

  // Render whatever the current URL points at. When no explicit fragment is
  // passed (e.g. on first load / popstate), honour the URL's own #fragment.
  function route(frag) {
    if (frag == null) frag = location.hash || "";
    const { id, file, legacy } = getRoute();
    if (!id) return showLanding();
    if (legacy) {
      // Normalise old ?id=/#id links to the clean path, then render.
      return navigate(id, file, true, frag);
    }
    render(id, file, frag);
  }

  // ---- wire up ----
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = extractId(els.gistInput.value);
    if (!id) return;
    const file = els.fileInput.value.trim();
    navigate(id, file || null);
  });

  window.addEventListener("popstate", () => route());

  route();
})();
