/* Radar ELO: guarda o aplicativo no aparelho (abre rápido e sem internet, com a última leitura)
   e desembaralha, na hora, os arquivos protegidos (desenhos, normas, dados) com a chave do aparelho. */
const V = 'elo-202611251915';
const SHELL = ['./', 'index.html', 'shim.js', 'config.js', 'cofre.json', 'lista.json', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-180.png'];
const EXTERNOS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const TIPOS = {webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', json: 'application/json', pdf: 'application/pdf', html: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8'};

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(new Request(u, {cache: 'reload'})).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('elo-') && k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

/* ---------- chave guardada no aparelho (IndexedDB) ---------- */
let CHAVE = null;
function idb() { return new Promise((ok, no) => { const r = indexedDB.open('elo', 1); r.onupgradeneeded = () => r.result.createObjectStore('k'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); }
async function chave() {
  if (CHAVE) return CHAVE;
  const db = await idb();
  CHAVE = await new Promise(ok => { const t = db.transaction('k').objectStore('k').get('chave'); t.onsuccess = () => ok(t.result || null); t.onerror = () => ok(null); });
  return CHAVE;
}
self.addEventListener('message', e => { if (e.data === 'chave-nova') CHAVE = null; });

/* ---------- quais caminhos são protegidos ---------- */
let LISTA = null;
async function lista() {
  if (LISTA) return LISTA;
  try {
    const c = await caches.open(V);
    let r = await fetch('lista.json', {cache: 'no-cache'}).catch(() => null);
    if (r && r.ok) c.put('lista.json', r.clone()); else r = await c.match('lista.json');
    LISTA = r ? new Set(await r.json()) : new Set();
  } catch (e) { LISTA = new Set(); }
  return LISTA;
}

async function abrirProtegido(rel, dadoVivo) {
  const k = await chave();
  if (!k) return new Response('', {status: 401});
  const c = await caches.open(V), url = rel + '.enc';
  let r = null;
  if (dadoVivo) {   // dados (json): tenta a versão nova primeiro
    r = await fetch(url, {cache: 'no-cache'}).then(x => { if (x.ok) c.put(url, x.clone()); return x.ok ? x : null; }).catch(() => null);
    if (!r) r = await c.match(url);
  } else {          // imagens: usa a guardada; busca se não tiver
    r = await c.match(url);
    if (!r) r = await fetch(url).then(x => { if (x.ok) c.put(url, x.clone()); return x.ok ? x : null; }).catch(() => null);
  }
  if (!r) return new Response('', {status: 404});
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length < 17 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'ELO2') return new Response('', {status: 500});
  const gz = b[4] === 1, iv = b.slice(5, 17), ct = b.slice(17);
  let pt;
  try { pt = await crypto.subtle.decrypt({name: 'AES-GCM', iv}, k, ct); } catch (e) { return new Response('', {status: 401}); }
  let corpo = new Blob([pt]);
  if (gz) corpo = await new Response(corpo.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
  const ext = (rel.split('.').pop() || '').toLowerCase();
  return new Response(corpo, {headers: {'Content-Type': TIPOS[ext] || 'application/octet-stream', 'Cache-Control': 'no-store'}});
}

async function redeFirst(req) {
  const c = await caches.open(V);
  try {
    const r = await fetch(req, {cache: 'no-cache'});
    if (r && r.ok) c.put(req, r.clone());
    return r;
  } catch (e) {
    const hit = await c.match(req, {ignoreSearch: true});
    if (hit) return hit;
    throw e;
  }
}
async function cacheFirst(req) {
  const c = await caches.open(V);
  const hit = await c.match(req);
  const rede = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(() => null);
  return hit || (await rede) || Response.error();
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === location.origin) {
    const base = new URL(self.registration.scope).pathname;
    const rel = decodeURIComponent(u.pathname.startsWith(base) ? u.pathname.slice(base.length) : u.pathname.replace(/^\//, ''));
    e.respondWith((async () => {
      const L = await lista();
      if (L.has(rel)) return abrirProtegido(rel, rel.endsWith('.json'));
      if (req.mode === 'navigate' || rel === '' || /^(index\.html|app\.enc|shim\.js|config\.js|sw\.js|cofre\.json|lista\.json)$/.test(rel)) return redeFirst(req);
      return cacheFirst(req);
    })());
    return;
  }
  if (EXTERNOS.includes(u.hostname)) e.respondWith(cacheFirst(req));
});
