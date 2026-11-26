// Serveur de synchronisation pour l'application de prise de notes.
// Aucune dépendance : Node.js >= 18 suffit.  Lancer avec `node server.js`.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 8 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Stockage des notes (un fichier JSON par note)
// ---------------------------------------------------------------------------

/** @type {Map<string, any>} */
const notes = new Map();
const saveTimers = new Map();

function newId(len = 10) {
  return crypto.randomBytes(16).toString('base64url').replace(/[-_]/g, '').slice(0, len);
}

function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9]{1,40}$/.test(id);
}

function loadNotes() {
  for (const file of fs.readdirSync(DATA_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
      if (doc && validId(doc.id)) notes.set(doc.id, doc);
    } catch (err) {
      console.warn(`Impossible de lire ${file} :`, err.message);
    }
  }
}

function saveNow(id) {
  saveTimers.delete(id);
  const doc = notes.get(id);
  if (!doc) return;
  const file = path.join(DATA_DIR, `${id}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, file);
}

function scheduleSave(id) {
  if (saveTimers.has(id)) return;
  saveTimers.set(id, setTimeout(() => saveNow(id), 400));
}

function flushAll() {
  for (const [id, t] of saveTimers) {
    clearTimeout(t);
    saveNow(id);
  }
}

function createNote(title) {
  const blockId = newId(8);
  const now = Date.now();
  const doc = {
    id: newId(),
    title: (typeof title === 'string' && title.trim()) || 'Sans titre',
    created: now,
    updated: now,
    version: 0,
    paper: 'lines',
    blocks: { [blockId]: { type: 'p', html: '', checked: false } },
    order: [blockId],
    strokes: [],
  };
  notes.set(doc.id, doc);
  saveNow(doc.id);
  return doc;
}

function preview(doc) {
  for (const id of doc.order) {
    const b = doc.blocks[id];
    if (!b) continue;
    const text = b.html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    if (text) return text.slice(0, 140);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Application des opérations
// ---------------------------------------------------------------------------

const BLOCK_TYPES = new Set(['p', 'h1', 'h2', 'li', 'todo']);
const TOOLS = new Set(['pen', 'hl']);
const PAPERS = new Set(['lines', 'grid', 'dots', 'blank']);

function cleanBlock(b) {
  return {
    type: BLOCK_TYPES.has(b.type) ? b.type : 'p',
    html: typeof b.html === 'string' ? b.html.slice(0, 200000) : '',
    checked: !!b.checked,
  };
}

function cleanStroke(s) {
  if (!s || !validId(s.id) || !Array.isArray(s.points)) return null;
  const points = s.points.slice(0, 30000).map((n) => (Number.isFinite(n) ? n : 0));
  if (points.length < 3) return null;
  return {
    id: s.id,
    tool: TOOLS.has(s.tool) ? s.tool : 'pen',
    color: typeof s.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s.color) ? s.color : '#1f2937',
    size: Math.min(Math.max(Number(s.size) || 2, 0.5), 60),
    points,
  };
}

/** Applique une opération au document. Retourne l'opération à diffuser (ou null). */
function applyOp(doc, op) {
  if (!op || typeof op !== 'object') return null;
  switch (op.t) {
    case 'title': {
      doc.title = String(op.title || '').slice(0, 200);
      return { t: 'title', title: doc.title };
    }
    case 'paper': {
      if (!PAPERS.has(op.paper)) return null;
      doc.paper = op.paper;
      return { t: 'paper', paper: doc.paper };
    }
    case 'blocks': {
      const upsert = [];
      for (const b of Array.isArray(op.upsert) ? op.upsert : []) {
        if (!b || !validId(b.id)) continue;
        doc.blocks[b.id] = cleanBlock(b);
        upsert.push({ id: b.id, ...doc.blocks[b.id] });
      }
      const removed = new Set((Array.isArray(op.remove) ? op.remove : []).filter(validId));
      for (const id of removed) delete doc.blocks[id];

      // Fusion de l'ordre : on prend l'ordre du client, en conservant les blocs
      // que d'autres appareils ont ajoutés entre-temps.
      const seen = new Set();
      const order = [];
      for (const id of Array.isArray(op.order) ? op.order : doc.order) {
        if (doc.blocks[id] && !seen.has(id)) { seen.add(id); order.push(id); }
      }
      doc.order.forEach((id, idx) => {
        if (seen.has(id) || !doc.blocks[id]) return;
        let pos = 0;
        for (let j = idx - 1; j >= 0; j--) {
          const k = order.indexOf(doc.order[j]);
          if (k >= 0) { pos = k + 1; break; }
        }
        order.splice(pos, 0, id);
        seen.add(id);
      });
      for (const id of Object.keys(doc.blocks)) {
        if (!seen.has(id)) { seen.add(id); order.push(id); }
      }
      if (order.length === 0) {
        const id = newId(8);
        doc.blocks[id] = { type: 'p', html: '', checked: false };
        order.push(id);
        upsert.push({ id, ...doc.blocks[id] });
      }
      doc.order = order;
      return { t: 'blocks', upsert, remove: [...removed], order };
    }
    case 'stroke': {
      const s = cleanStroke(op.stroke);
      if (!s) return null;
      if (!doc.strokes.some((x) => x.id === s.id)) doc.strokes.push(s);
      return { t: 'stroke', stroke: s };
    }
    case 'erase': {
      const ids = new Set((Array.isArray(op.ids) ? op.ids : []).filter(validId));
      if (!ids.size) return null;
      doc.strokes = doc.strokes.filter((s) => !ids.has(s.id));
      return { t: 'erase', ids: [...ids] };
    }
    case 'live': {
      // Trait en cours de tracé : diffusé mais jamais stocké.
      if (!validId(op.id) || !Array.isArray(op.points)) return null;
      return {
        t: 'live', id: op.id, from: Number(op.from) || 0,
        tool: TOOLS.has(op.tool) ? op.tool : 'pen',
        color: typeof op.color === 'string' ? op.color.slice(0, 9) : '#1f2937',
        size: Number(op.size) || 2,
        points: op.points.slice(0, 30000),
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Temps réel (Server-Sent Events)
// ---------------------------------------------------------------------------

/** @type {Map<string, Set<{res: http.ServerResponse, client: string}>>} */
const listeners = new Map();

function sendEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(noteId, data, exceptClient) {
  const set = listeners.get(noteId);
  if (!set) return;
  for (const l of set) if (l.client !== exceptClient) sendEvent(l.res, data);
}

function broadcastPresence(noteId) {
  const set = listeners.get(noteId);
  if (!set) return;
  const clients = new Set([...set].map((l) => l.client));
  broadcast(noteId, { type: 'presence', count: clients.size });
}

setInterval(() => {
  for (const set of listeners.values()) for (const l of set) l.res.write(': ping\n\n');
}, 20000).unref();

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Introuvable'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] !== 'api') return serveStatic(req, res, url.pathname);

  // GET /api/info
  if (parts[1] === 'info' && req.method === 'GET') {
    return json(res, 200, { port: PORT, addresses: lanAddresses() });
  }

  if (parts[1] !== 'notes') return json(res, 404, { error: 'not found' });

  // /api/notes
  if (parts.length === 2) {
    if (req.method === 'GET') {
      const list = [...notes.values()]
        .sort((a, b) => b.updated - a.updated)
        .map((d) => ({ id: d.id, title: d.title, updated: d.updated, created: d.created, preview: preview(d), strokes: d.strokes.length }));
      return json(res, 200, list);
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 201, createNote(body.title));
    }
    return json(res, 405, { error: 'method' });
  }

  const id = parts[2];
  const doc = validId(id) && notes.get(id);
  if (!doc) return json(res, 404, { error: 'note introuvable' });

  // /api/notes/:id
  if (parts.length === 3) {
    if (req.method === 'GET') return json(res, 200, doc);
    if (req.method === 'DELETE') {
      notes.delete(id);
      clearTimeout(saveTimers.get(id));
      saveTimers.delete(id);
      fs.rmSync(path.join(DATA_DIR, `${id}.json`), { force: true });
      broadcast(id, { type: 'deleted' });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'method' });
  }

  // POST /api/notes/:id/ops
  if (parts[3] === 'ops' && req.method === 'POST') {
    const body = await readBody(req);
    const client = String(body.client || '');
    const out = [];
    let changed = false;
    for (const op of Array.isArray(body.ops) ? body.ops : []) {
      const applied = applyOp(doc, op);
      if (!applied) continue;
      out.push(applied);
      if (applied.t !== 'live') changed = true;
    }
    if (changed) {
      doc.version++;
      doc.updated = Date.now();
      scheduleSave(id);
    }
    if (out.length) broadcast(id, { type: 'ops', from: client, version: doc.version, ops: out }, client);
    // Renvoie l'ordre fusionné au client émetteur pour qu'il se recale si besoin.
    const lastBlocks = [...out].reverse().find((o) => o.t === 'blocks');
    return json(res, 200, { version: doc.version, order: lastBlocks ? lastBlocks.order : undefined });
  }

  // GET /api/notes/:id/events
  if (parts[3] === 'events' && req.method === 'GET') {
    const client = url.searchParams.get('client') || newId();
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    const entry = { res, client };
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(entry);
    sendEvent(res, { type: 'hello', version: doc.version });
    broadcastPresence(id);
    req.on('close', () => {
      const set = listeners.get(id);
      if (!set) return;
      set.delete(entry);
      if (!set.size) listeners.delete(id);
      else broadcastPresence(id);
    });
    return;
  }

  return json(res, 404, { error: 'not found' });
}

loadNotes();

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 400, { error: String(err.message || err) });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log('\n  Prise de notes est prête !\n');
  console.log(`  Sur cet ordinateur :   http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Sur l'iPad (même Wi-Fi) : http://${ip}:${PORT}`);
  console.log(`\n  Notes enregistrées dans : ${DATA_DIR}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { flushAll(); process.exit(0); });
}
process.on('exit', flushAll);

module.exports = { applyOp, createNote };
