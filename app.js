/* Ref Hub — static site; data lives in data/hub.json + images/ in this GitHub repo.
   Edits are committed through the GitHub API using a token stored only in this browser. */
'use strict';

const BUILTIN = ['keyword', 'style', 'trend', 'brand'];
const DATA_PATH = 'data/hub.json';
const $ = (s) => document.querySelector(s);

// ---------- tiny DOM helper ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

// ---------- config / GitHub ----------
const cfgKey = 'refhub.cfg';
function loadCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(cfgKey) || '{}'); } catch (e) {}
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  if (m && !c.owner) { c.owner = m[1]; c.repo = location.pathname.split('/')[1] || c.repo; }
  c.branch = c.branch || 'main';
  return c;
}
let cfg = loadCfg();
function saveCfg() { try { localStorage.setItem(cfgKey, JSON.stringify(cfg)); } catch (e) {} }

const api = (path) => `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`;
function headers() {
  const hd = { Accept: 'application/vnd.github+json' };
  if (cfg.token) hd.Authorization = 'Bearer ' + cfg.token;
  return hd;
}
const b64 = {
  fromText: (t) => { const b = new TextEncoder().encode(t); let s = ''; b.forEach((x) => (s += String.fromCharCode(x))); return btoa(s); },
  toText: (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), (c) => c.charCodeAt(0))),
};

async function fetchRemote() {
  const r = await fetch(api(DATA_PATH) + `?ref=${cfg.branch}&t=${Date.now()}`, { headers: headers(), cache: 'no-store' });
  if (!r.ok) throw new Error('GitHub ' + r.status);
  const j = await r.json();
  return { data: JSON.parse(b64.toText(j.content)), sha: j.sha };
}

async function putFile(path, contentB64, message, sha) {
  const r = await fetch(api(path), {
    method: 'PUT', headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: contentB64, branch: cfg.branch, ...(sha ? { sha } : {}) }),
  });
  if (!r.ok) { const e = new Error('GitHub ' + r.status); e.status = r.status; throw e; }
  return r.json();
}
async function deleteFile(path, message) {
  const g = await fetch(api(path) + `?ref=${cfg.branch}`, { headers: headers() });
  if (!g.ok) return;
  const { sha } = await g.json();
  await fetch(api(path), {
    method: 'DELETE', headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha, branch: cfg.branch }),
  });
}

// ---------- state ----------
let hub = { categories: [], items: [] };
let sha = null;
let remote = false;           // true once loaded through GitHub API
const sel = {};               // catId -> Set(values)
let query = '';

async function load() {
  setStatus('Loading…');
  try {
    if (!cfg.owner || !cfg.repo) throw new Error('no repo');
    const r = await fetchRemote();
    hub = r.data; sha = r.sha; remote = true;
  } catch (e) {
    try { hub = await (await fetch(DATA_PATH + '?t=' + Date.now())).json(); } catch (e2) { hub = { categories: [], items: [] }; }
  }
  render();
}

// Apply a change against the freshest remote copy so phone + laptop never clobber each other.
async function mutate(fn, message) {
  if (!cfg.token || !cfg.owner || !cfg.repo) { openSettings('Add a GitHub token to save changes.'); throw new Error('no token'); }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fresh = await fetchRemote();
      fn(fresh.data);
      const res = await putFile(DATA_PATH, b64.fromText(JSON.stringify(fresh.data, null, 2) + '\n'), message, fresh.sha);
      hub = fresh.data; sha = res.content.sha; remote = true;
      render();
      return;
    } catch (e) {
      if (attempt === 0 && (e.status === 409 || e.status === 422)) continue;
      if (e.status === 401 || e.status === 403 || e.status === 404) openSettings('GitHub rejected the token (' + e.status + '). Check it has Contents: read & write on this repo.');
      throw e;
    }
  }
}

// ---------- helpers ----------
const catById = (id) => hub.categories.find((c) => c.id === id);
const itemTags = (it, cid) => (it.tags && it.tags[cid]) || [];
function toast(msg, ms = 2500) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); }
function setStatus(s) { $('#status').textContent = s; }
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function imgSrcFallback(img, path) {
  img.addEventListener('error', () => {
    if (img.dataset.fb || !cfg.owner) return;
    img.dataset.fb = 1; img.src = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}/${path}`;
  });
}

function matches(it) {
  for (const [cid, set] of Object.entries(sel)) {
    if (!set.size) continue;
    if (!itemTags(it, cid).some((v) => set.has(v))) return false;
  }
  if (query) {
    const hay = [it.title, it.note, it.source, ...Object.values(it.tags || {}).flat()].join(' ').toLowerCase();
    if (!query.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

// ---------- render ----------
function render() {
  // filters
  const f = $('#filters'); f.replaceChildren();
  for (const c of hub.categories) {
    const counts = {};
    hub.items.forEach((it) => itemTags(it, c.id).forEach((v) => (counts[v] = (counts[v] || 0) + 1)));
    const vals = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
    if (!sel[c.id]) sel[c.id] = new Set();
    f.append(h('div', { class: 'fcat' },
      h('h3', {}, h('span', { class: 'dot', style: `background:${c.color}` }), c.name),
      vals.length ? h('div', { class: 'chips' }, vals.map((v) =>
        h('button', { class: 'chip' + (sel[c.id].has(v) ? ' on' : ''), style: `--c:${c.color}`, onclick: () => { sel[c.id].has(v) ? sel[c.id].delete(v) : sel[c.id].add(v); render(); } }, v, h('small', {}, counts[v]))))
        : h('div', { class: 'help' }, 'No tags yet')));
  }
  // grid
  const shown = hub.items.filter(matches).sort((a, b) => (b.added || '').localeCompare(a.added || ''));
  const g = $('#grid'); g.replaceChildren();
  for (const it of shown) {
    const img = h('img', { src: it.image, alt: it.title || '', loading: 'lazy' });
    imgSrcFallback(img, it.image);
    const tags = hub.categories.flatMap((c) => itemTags(it, c.id).map((v) => h('span', { class: 'tag', style: `--c:${c.color}` }, v)));
    g.append(h('div', { class: 'card', onclick: () => openItem(it.id) }, img,
      (it.title || tags.length) ? h('div', { class: 'meta' }, it.title && h('div', { class: 't' }, it.title), tags.length && h('div', { class: 'tags' }, tags)) : null));
  }
  const filtering = query || Object.values(sel).some((s) => s.size);
  $('#empty').hidden = shown.length > 0;
  $('#empty').textContent = hub.items.length ? 'Nothing matches those filters.' : 'No references yet — tap “+ Add” to save your first one.';
  setStatus(`${shown.length}${filtering ? ' of ' + hub.items.length : ''} reference${shown.length === 1 ? '' : 's'}` + (remote ? '' : ' · read-only (not synced)'));
}

// ---------- modal ----------
function openModal(...kids) { const s = $('#sheet'); s.replaceChildren(...kids.flat(Infinity).filter(Boolean)); $('#modal').hidden = false; document.body.style.overflow = 'hidden'; }
function closeModal() { $('#modal').hidden = true; document.body.style.overflow = ''; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function tagEditor(cat, initial) {
  const values = [...initial];
  const box = h('div', { class: 'tagbox' });
  const input = h('input', { type: 'text', placeholder: `Add ${cat.name.toLowerCase()}…` });
  const sugg = h('div', { class: 'sugg' });
  const freq = {};
  hub.items.forEach((it) => itemTags(it, cat.id).forEach((v) => (freq[v] = (freq[v] || 0) + 1)));
  function draw() {
    box.replaceChildren(...values.map((v) => h('span', { class: 'chip', style: `--c:${cat.color}` }, v, h('span', { class: 'x', onclick: () => { values.splice(values.indexOf(v), 1); draw(); } }, '×'))), input);
    const q = input.value.trim().toLowerCase();
    const options = Object.keys(freq).filter((v) => !values.includes(v) && v.toLowerCase().includes(q)).sort((a, b) => freq[b] - freq[a]).slice(0, 10);
    sugg.replaceChildren(...options.map((v) => h('button', { type: 'button', class: 'chip', onclick: () => { values.push(v); input.value = ''; draw(); input.focus(); } }, v)));
  }
  function commit() { const v = input.value.replace(/,/g, '').trim(); if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) values.push(v); input.value = ''; draw(); }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); input.focus(); } else if (e.key === 'Backspace' && !input.value && values.length) { values.pop(); draw(); input.focus(); } });
  input.addEventListener('input', draw);
  input.addEventListener('blur', () => { if (input.value.trim()) commit(); });
  draw();
  return { el: h('div', {}, h('label', {}, cat.name), box, sugg), get: () => { if (input.value.trim()) commit(); return values; } };
}

async function toJpegBlob(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.86));
}
const blobToB64 = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(blob); });

function openEditor(existing) {
  if (!cfg.token) return openSettings('Add a GitHub token first so the Hub can save to your repo.');
  let blob = null, previewUrl = null;
  const isNew = !existing;
  const it = existing || { tags: {} };
  const preview = h('img', { class: 'preview', hidden: isNew, src: isNew ? '' : it.image });
  const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: isNew, hidden: true });
  const drop = h('div', { class: 'drop' }, 'Tap to choose image(s) — select several for a batch — or drop / paste here');
  async function setFile(f, all) {
    if (isNew && all && all.filter((x) => x.type.startsWith('image/')).length > 1) { document.removeEventListener('paste', onPaste); return openBatch(all.filter((x) => x.type.startsWith('image/'))); }
    if (!f || !f.type.startsWith('image/')) return;
    drop.textContent = 'Processing…';
    blob = await toJpegBlob(f);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    preview.src = previewUrl; preview.hidden = false; drop.textContent = 'Change image';
  }
  drop.onclick = () => fileIn.click();
  fileIn.onchange = () => setFile(fileIn.files[0], [...fileIn.files]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); setFile(e.dataTransfer.files[0], [...e.dataTransfer.files]); };
  const onPaste = (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs[0]) setFile(fs[0], fs); };
  document.addEventListener('paste', onPaste);

  const title = h('input', { type: 'text', value: it.title || '', placeholder: 'Optional title' });
  const source = h('input', { type: 'url', value: it.source || '', placeholder: 'https://… where you found it' });
  const note = h('textarea', { placeholder: 'Notes' }, it.note || '');
  const editors = hub.categories.map((c) => ({ c, ed: tagEditor(c, itemTags(it, c.id)) }));
  const saveBtn = h('button', { class: 'btn primary' }, isNew ? 'Save reference' : 'Save changes');
  const done = () => { document.removeEventListener('paste', onPaste); closeModal(); };

  saveBtn.onclick = async () => {
    if (isNew && !blob) return toast('Choose an image first');
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      const tags = {};
      editors.forEach(({ c, ed }) => { const v = ed.get(); if (v.length) tags[c.id] = v; });
      const fields = { title: title.value.trim(), source: source.value.trim(), note: note.value.trim(), tags };
      if (isNew) {
        const id = uid(); const path = `images/${id}.jpg`;
        await putFile(path, await blobToB64(blob), 'Add image ' + id);
        await mutate((d) => d.items.push({ id, image: path, added: new Date().toISOString(), ...fields }), 'Add reference ' + (fields.title || id));
      } else {
        await mutate((d) => { const t = d.items.find((x) => x.id === it.id); if (t) Object.assign(t, fields); }, 'Edit reference ' + (fields.title || it.id));
      }
      done(); toast('Saved ✓');
    } catch (e) { saveBtn.disabled = false; saveBtn.textContent = isNew ? 'Save reference' : 'Save changes'; if (e.message !== 'no token') toast('Save failed: ' + e.message, 4000); }
  };
  openModal(h('h2', {}, isNew ? 'Add reference' : 'Edit reference'), preview, drop, fileIn,
    h('label', {}, 'Title'), title, h('label', {}, 'Source link'), source, h('label', {}, 'Notes'), note,
    editors.map((x) => x.ed.el),
    h('div', { class: 'row' }, saveBtn, h('button', { class: 'btn', onclick: done }, 'Cancel')));
}

function openBatch(files) {
  let list = files.map((f) => ({ f, url: URL.createObjectURL(f) }));
  const grid = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:8px;margin-top:8px' });
  const count = h('div', { class: 'help' });
  function drawThumbs() {
    count.textContent = `${list.length} image${list.length === 1 ? '' : 's'} — the tags below apply to all of them`;
    grid.replaceChildren(...list.map((x) => h('div', { style: 'position:relative' },
      h('img', { src: x.url, style: 'width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;display:block' }),
      h('button', { class: 'icon-btn', style: 'position:absolute;top:2px;right:2px;background:#000a;color:#fff;border-radius:50%;width:22px;height:22px;font-size:13px;padding:0', onclick: () => { list = list.filter((y) => y !== x); drawThumbs(); } }, '×'))));
  }
  drawThumbs();
  const source = h('input', { type: 'url', placeholder: 'https://… (optional, same for all)' });
  const editors = hub.categories.map((c) => ({ c, ed: tagEditor(c, []) }));
  const bar = h('div', { style: 'height:6px;background:var(--chip);border-radius:3px;overflow:hidden;margin-top:12px', hidden: true }, h('div', { style: 'height:100%;width:0;background:var(--accent);transition:width .2s' }));
  const saveBtn = h('button', { class: 'btn primary' }, 'Upload all');
  const done = () => { list.forEach((x) => URL.revokeObjectURL(x.url)); closeModal(); };
  saveBtn.onclick = async () => {
    if (!list.length) return toast('No images selected');
    saveBtn.disabled = true; bar.hidden = false;
    const tags = {};
    editors.forEach(({ c, ed }) => { const v = ed.get(); if (v.length) tags[c.id] = v; });
    const added = []; let failed = 0;
    for (let i = 0; i < list.length; i++) {
      saveBtn.textContent = `Uploading ${i + 1} of ${list.length}…`;
      try {
        const id = uid(); const path = `images/${id}.jpg`;
        await putFile(path, await blobToB64(await toJpegBlob(list[i].f)), 'Add image ' + id);
        added.push({ id, image: path, added: new Date(Date.now() + i).toISOString(), title: '', source: source.value.trim(), note: '', tags: JSON.parse(JSON.stringify(tags)) });
      } catch (e) {
        if (e.status === 401 || e.status === 403 || e.status === 404) { openSettings('GitHub rejected the token (' + e.status + ').'); return; }
        failed++;
      }
      bar.firstChild.style.width = Math.round(((i + 1) / list.length) * 100) + '%';
    }
    try {
      if (added.length) await mutate((d) => { d.items.push(...added); }, `Add ${added.length} references`);
      done(); toast(failed ? `Added ${added.length}, ${failed} failed` : `Added ${added.length} ✓`, 4000);
    } catch (e) { saveBtn.disabled = false; saveBtn.textContent = 'Retry'; toast('Save failed: ' + e.message, 4000); }
  };
  openModal(h('h2', {}, 'Batch add'), count, grid, h('label', {}, 'Source link'), source, editors.map((x) => x.ed.el), bar,
    h('div', { class: 'row' }, saveBtn, h('button', { class: 'btn', onclick: done }, 'Cancel')));
}

function openItem(id) {
  const it = hub.items.find((x) => x.id === id); if (!it) return;
  const img = h('img', { class: 'preview', src: it.image }); imgSrcFallback(img, it.image);
  const tagRows = hub.categories.filter((c) => itemTags(it, c.id).length).map((c) =>
    h('div', { style: 'margin-top:10px' }, h('div', { class: 'help' }, c.name), h('div', { class: 'chips', style: 'margin-top:4px' }, itemTags(it, c.id).map((v) => h('span', { class: 'tag', style: `--c:${c.color};font-size:13px;padding:2px 10px;cursor:pointer`, onclick: () => { closeModal(); Object.values(sel).forEach((s) => s.clear()); sel[c.id].add(v); render(); window.scrollTo(0, 0); } }, v)))));
  let srcLink = null;
  try { if (it.source && /^https?:$/.test(new URL(it.source).protocol)) srcLink = h('a', { href: it.source, target: '_blank', rel: 'noopener noreferrer' }, new URL(it.source).hostname); } catch (e) {}
  openModal(img, h('h2', { style: 'margin-top:14px' }, it.title || 'Untitled'),
    srcLink && h('div', { class: 'help' }, 'Source: ', srcLink), it.note && h('p', {}, it.note), tagRows,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => openEditor(it) }, 'Edit'),
      h('button', { class: 'btn danger', onclick: async (e) => {
        if (!cfg.token) return openSettings('Add a GitHub token to delete.');
        if (!confirm('Delete this reference permanently?')) return;
        e.target.disabled = true;
        try { await mutate((d) => { d.items = d.items.filter((x) => x.id !== id); }, 'Delete reference ' + id); await deleteFile(it.image, 'Delete image ' + id); closeModal(); toast('Deleted'); }
        catch (err) { e.target.disabled = false; if (err.message !== 'no token') toast('Delete failed: ' + err.message, 4000); }
      } }, 'Delete'),
      h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: closeModal }, 'Close')));
}

function openCategories() {
  if (!cfg.token) return openSettings('Add a GitHub token to manage categories.');
  const cats = hub.categories.map((c) => ({ ...c }));
  const list = h('div');
  function draw() {
    list.replaceChildren(...cats.map((c) => h('div', { class: 'catrow' },
      h('input', { type: 'color', value: c.color, oninput: (e) => (c.color = e.target.value) }),
      h('input', { type: 'text', value: c.name, oninput: (e) => (c.name = e.target.value) }),
      BUILTIN.includes(c.id) ? h('span', { class: 'help', style: 'width:60px' }, 'built-in')
        : h('button', { class: 'btn small danger', onclick: () => { if (confirm(`Delete “${c.name}” and remove its tags from all references?`)) { cats.splice(cats.indexOf(c), 1); draw(); } } }, 'Delete'))));
  }
  draw();
  const palette = ['#8b5cf6', '#06b6d4', '#ef4444', '#84cc16', '#f97316', '#14b8a6', '#d946ef'];
  const saveBtn = h('button', { class: 'btn primary' }, 'Save');
  saveBtn.onclick = async () => {
    const final = cats.map((c) => ({ ...c, name: c.name.trim() })).filter((c) => c.name);
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      await mutate((d) => {
        const keep = new Set(final.map((c) => c.id));
        d.categories = final;
        d.items.forEach((it) => { for (const k of Object.keys(it.tags || {})) if (!keep.has(k)) delete it.tags[k]; });
      }, 'Update categories');
      closeModal(); toast('Saved ✓');
    } catch (e) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; if (e.message !== 'no token') toast('Save failed: ' + e.message, 4000); }
  };
  openModal(h('h2', {}, 'Categories'), h('p', { class: 'help' }, 'Keyword, Style, Trend and Brand are built in. Add any other category you like (Industry, Season, Client…).'), list,
    h('button', { class: 'btn small', onclick: () => { cats.push({ id: 'c' + uid(), name: 'New category', color: palette[cats.length % palette.length] }); draw(); } }, '+ Add category'),
    h('div', { class: 'row' }, saveBtn, h('button', { class: 'btn', onclick: closeModal }, 'Cancel')));
}

function openSettings(msg) {
  const tok = h('input', { type: 'password', value: cfg.token || '', placeholder: 'github_pat_…', autocomplete: 'off' });
  const own = h('input', { type: 'text', value: cfg.owner || '', placeholder: 'GitHub username' });
  const rep = h('input', { type: 'text', value: cfg.repo || '', placeholder: 'Repository name' });
  openModal(h('h2', {}, 'Sync settings'), msg && h('p', { style: 'color:#d33' }, msg),
    h('p', { class: 'help' }, 'Viewing works for anyone. To add or edit from this device, paste a fine-grained GitHub token limited to this one repo with ', h('code', {}, 'Contents: Read and write'), '. It stays in this browser only — repeat once on each device (phone, laptop).'),
    h('label', {}, 'GitHub username'), own, h('label', {}, 'Repository'), rep, h('label', {}, 'Token'), tok,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => { cfg.token = tok.value.trim(); cfg.owner = own.value.trim(); cfg.repo = rep.value.trim(); saveCfg(); closeModal(); await load(); toast(remote ? 'Connected ✓' : 'Could not reach the repo'); } }, 'Save'),
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('span', { class: 'spacer' }),
      cfg.token && h('button', { class: 'btn danger', onclick: () => { delete cfg.token; saveCfg(); closeModal(); toast('Token removed from this device'); } }, 'Remove token')));
}

// ---------- wire up ----------
$('#addBtn').onclick = () => openEditor();
$('#settingsBtn').onclick = () => openSettings();
$('#manageCats').onclick = openCategories;
$('#clearFilters').onclick = () => { Object.values(sel).forEach((s) => s.clear()); $('#search').value = ''; query = ''; render(); };
$('#search').addEventListener('input', (e) => { query = e.target.value.trim(); render(); });
const side = $('#sidebar'), scrim = $('#scrim');
function toggleSide(open) { side.classList.toggle('open', open); scrim.hidden = !open; }
$('#menuBtn').onclick = () => toggleSide(!side.classList.contains('open'));
scrim.onclick = () => toggleSide(false);
document.addEventListener('visibilitychange', () => { if (!document.hidden && remote && $('#modal').hidden) load(); });
load();
