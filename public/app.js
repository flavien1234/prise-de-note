// Prise de notes — texte au clavier + encre Apple Pencil, synchronisés en direct.
'use strict';

(() => {
  // -------------------------------------------------------------------------
  // Utilitaires
  // -------------------------------------------------------------------------
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const PAGE_W = 800;
  const uid = (n = 10) => {
    const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    const r = crypto.getRandomValues(new Uint8Array(n));
    for (const x of r) s += a[x % a.length];
    return s;
  };
  const clientId = uid(12);
  const isTouchDevice = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Nettoyage du HTML des paragraphes : seulement gras / italique / souligné / barré / retour ligne.
  const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'BR']);
  function cleanNode(node) {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) continue;
      if (child.nodeType !== 1) { child.remove(); continue; }
      cleanNode(child);
      if (ALLOWED.has(child.tagName)) {
        for (const a of [...child.attributes]) child.removeAttribute(a.name);
      } else {
        child.replaceWith(...child.childNodes);
      }
    }
  }
  function sanitize(html) {
    const t = document.createElement('template');
    t.innerHTML = html;
    cleanNode(t.content);
    let out = t.innerHTML;
    if (out === '<br>' || out.trim() === '') out = '';
    return out;
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------
  const homeView = $('#home');
  const editorView = $('#editor-view');

  function route() {
    const m = location.hash.match(/^#\/note\/([A-Za-z0-9]+)/);
    if (m) openNote(m[1]);
    else showHome();
  }
  window.addEventListener('hashchange', route);

  // -------------------------------------------------------------------------
  // Liste des notes
  // -------------------------------------------------------------------------
  const fmtDate = (t) => new Date(t).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  async function showHome() {
    closeNote();
    editorView.hidden = true;
    homeView.hidden = false;
    document.title = 'Prise de notes';
    const list = $('#note-list');
    try {
      const notes = await api('GET', '/api/notes');
      list.innerHTML = '';
      if (!notes.length) {
        list.innerHTML = '<div class="empty">Aucune note pour l\'instant. Créez-en une !</div>';
      }
      for (const n of notes) {
        const card = document.createElement('div');
        card.className = 'note-card';
        card.tabIndex = 0;
        const h = document.createElement('h2'); h.textContent = n.title || 'Sans titre';
        const p = document.createElement('p'); p.textContent = n.preview || (n.strokes ? `✍️ ${n.strokes} trait${n.strokes > 1 ? 's' : ''}` : 'Note vide');
        const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = `Modifiée ${fmtDate(n.updated)}`;
        card.append(h, p, meta);
        card.onclick = () => { location.hash = `#/note/${n.id}`; };
        card.onkeydown = (e) => { if (e.key === 'Enter') card.onclick(); };
        list.append(card);
      }
    } catch {
      list.innerHTML = '<div class="empty">Impossible de joindre le serveur. Est-il lancé ?</div>';
    }
    try {
      const info = await api('GET', '/api/info');
      const here = location.hostname;
      const addrs = info.addresses.filter((a) => a !== here);
      if (addrs.length) {
        $('#connect-hint').innerHTML = `Sur votre iPad ou un autre ordinateur (même Wi-Fi), ouvrez ${addrs
          .map((a) => `<code>http://${a}:${info.port}</code>`).join(' ou ')}`;
      } else {
        $('#connect-hint').textContent = 'Ouvrez cette même adresse sur vos autres appareils pour éditer la note ensemble.';
      }
    } catch { /* ignore */ }
  }

  $('#new-note').onclick = async () => {
    const doc = await api('POST', '/api/notes', { title: 'Sans titre' });
    location.hash = `#/note/${doc.id}`;
    setTimeout(() => { $('#title').focus(); $('#title').select(); }, 150);
  };

  // -------------------------------------------------------------------------
  // État de l'éditeur
  // -------------------------------------------------------------------------
  const editor = $('#editor');
  const page = $('#page');
  const scaler = $('#scaler');
  const scroller = $('#scroller');
  const stage = $('#stage');
  const inkCanvas = $('#ink');
  const liveCanvas = $('#live');
  const inkCtx = inkCanvas.getContext('2d');
  const liveCtx = liveCanvas.getContext('2d');

  let doc = null;            // document courant
  let noteId = null;
  let events = null;         // EventSource
  let connectedOnce = false;
  let scale = 1;
  let local = {};            // miroir des blocs connus { id: {type, html, checked} }
  let localOrder = [];

  const COLORS = ['#1f2937', '#2f6fed', '#d93025', '#188038', '#8e44ad', '#e67e22'];
  const HL_COLORS = ['#ffe34d', '#9cf29c', '#8fd3ff', '#ffadd6', '#ffc078'];
  const PEN_SIZES = [1.6, 2.6, 4.2];
  const HL_SIZES = [12, 18, 26];
  const ERASER_SIZES = [8, 16, 30];

  const prefs = Object.assign({
    tool: isTouchDevice ? 'pen' : 'text',
    penColor: COLORS[0], hlColor: HL_COLORS[0],
    penSize: 1, hlSize: 1, eraserSize: 1,
    fingerDraw: false,
  }, store.get('prefs', {}));
  const savePrefs = () => store.set('prefs', prefs);

  // -------------------------------------------------------------------------
  // Envoi des opérations (file d'attente, reprise si hors ligne)
  // -------------------------------------------------------------------------
  let outbox = [];
  let inflight = [];
  let sending = false;
  let flushTimer = null;
  const pendingBlockIds = () => {
    const s = new Set();
    for (const op of [...outbox, ...inflight]) if (op.t === 'blocks') {
      for (const u of op.upsert) s.add(u.id);
      for (const r of op.remove) s.add(r);
    }
    return s;
  };

  function send(op, immediate) {
    if (!noteId) return;
    if (op.t === 'live') {
      // regroupe les morceaux successifs d'un même trait
      const prev = outbox.find((o) => o.t === 'live' && o.id === op.id);
      if (prev && prev.from + prev.points.length === op.from) { prev.points.push(...op.points); return scheduleFlush(40); }
    }
    outbox.push(op);
    scheduleFlush(immediate ? 0 : 40);
  }

  function scheduleFlush(ms) {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, ms);
  }

  async function flush() {
    if (sending || !outbox.length || !noteId) return;
    sending = true;
    inflight = outbox;
    outbox = [];
    const id = noteId;
    try {
      const res = await api('POST', `/api/notes/${id}/ops`, { client: clientId, ops: inflight });
      inflight = [];
      if (id === noteId && res.order && !outbox.some((o) => o.t === 'blocks')
          && res.order.join() !== localOrder.join()) {
        applyRemoteBlocks({ upsert: [], remove: [], order: res.order });
      }
    } catch {
      // on remet les opérations en tête (sauf les traits « en direct » périmés)
      if (id !== noteId) { inflight = []; return; }
      outbox = inflight.filter((o) => o.t !== 'live').concat(outbox);
      inflight = [];
      setStatus('off', 'Hors ligne');
      setTimeout(() => scheduleFlush(0), 1500);
    } finally {
      sending = false;
      if (outbox.length) scheduleFlush(20);
    }
  }

  function setStatus(cls, text) {
    const el = $('#status');
    el.className = `status ${cls}`;
    el.querySelector('span').textContent = text;
  }

  // -------------------------------------------------------------------------
  // Ouverture / fermeture d'une note
  // -------------------------------------------------------------------------
  async function openNote(id) {
    if (noteId === id && doc) return;
    closeNote();
    homeView.hidden = true;
    editorView.hidden = false;
    noteId = id;
    setStatus('', 'Connexion…');
    try {
      const d = await api('GET', `/api/notes/${id}`);
      if (noteId !== id) return;
      loadDoc(d);
    } catch {
      alert('Cette note est introuvable.');
      location.hash = '#/';
      return;
    }
    connectEvents();
    layout();
    if (!isTouchDevice && prefs.tool === 'text') placeCaretAtEnd();
  }

  function closeNote() {
    if (events) { events.close(); events = null; }
    if (noteId) {
      reconcile();
      flush();
      if (outbox.length) {
        navigator.sendBeacon?.(`/api/notes/${noteId}/ops`, new Blob([JSON.stringify({ client: clientId, ops: outbox })], { type: 'application/json' }));
      }
    }
    outbox = [];
    noteId = null; doc = null; connectedOnce = false;
    undoStack.length = 0; redoStack.length = 0;
    remoteLive.clear();
  }

  function loadDoc(d) {
    doc = d;
    doc.strokes.forEach(prepStroke);
    $('#title').value = doc.title;
    document.title = doc.title || 'Note';
    setPaper(doc.paper || 'lines', false);
    local = {};
    for (const id of doc.order) local[id] = { ...doc.blocks[id] };
    localOrder = doc.order.slice();
    renderBlocks();
    layout();
  }

  function connectEvents() {
    const id = noteId;
    events = new EventSource(`/api/notes/${id}/events?client=${clientId}`);
    events.onmessage = (e) => {
      if (id !== noteId) return;
      const msg = JSON.parse(e.data);
      if (msg.type === 'hello') {
        setStatus('ok', 'Synchronisé');
        if (connectedOnce) resync();
        connectedOnce = true;
      } else if (msg.type === 'presence') {
        setStatus('ok', msg.count > 1 ? `${msg.count} appareils` : 'Synchronisé');
      } else if (msg.type === 'ops') {
        for (const op of msg.ops) applyRemote(op);
      } else if (msg.type === 'deleted') {
        alert('Cette note a été supprimée sur un autre appareil.');
        location.hash = '#/';
      }
    };
    events.onerror = () => { if (id === noteId) setStatus('off', 'Reconnexion…'); };
  }

  // Après une coupure : on renvoie ce qui est en attente puis on recharge le document.
  async function resync() {
    reconcile();
    await flush();
    try {
      const d = await api('GET', `/api/notes/${noteId}`);
      const caret = saveCaret();
      loadDoc(d);
      restoreCaret(caret);
      redrawInk();
    } catch { /* ignore */ }
  }

  // -------------------------------------------------------------------------
  // Mise en page (page de 800 px logiques, mise à l'échelle selon l'écran)
  // -------------------------------------------------------------------------
  let pageHeight = 1200;

  function layout() {
    if (!doc) return;
    const avail = scroller.clientWidth - (scroller.clientWidth > 700 ? 48 : 16);
    scale = Math.max(0.35, Math.min(1.6, avail / PAGE_W));
    page.style.transform = `scale(${scale})`;
    scaler.style.width = `${PAGE_W * scale}px`;
    updatePageHeight();
    resizeCanvases();
  }

  function updatePageHeight() {
    if (!doc) return;
    const textH = editor.offsetHeight;
    let inkMax = 0;
    for (const s of doc.strokes) inkMax = Math.max(inkMax, s.bbox[3]);
    const minH = (scroller.clientHeight - 100) / scale;
    const h = Math.ceil(Math.max(textH + 200, inkMax + 500, minH, 1100));
    if (Math.abs(h - pageHeight) > 1 || !page.style.height) {
      pageHeight = h;
      page.style.height = `${h}px`;
      scaler.style.height = `${h * scale}px`;
    }
  }

  function resizeCanvases() {
    const dpr = window.devicePixelRatio || 1;
    const w = stage.clientWidth, h = stage.clientHeight;
    for (const c of [inkCanvas, liveCanvas]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    redrawInk();
    redrawLive();
  }

  window.addEventListener('resize', () => layout());
  new ResizeObserver(() => { if (doc) { updatePageHeight(); } }).observe(editor);
  scroller.addEventListener('scroll', () => { requestRedraw(); }, { passive: true });

  // -------------------------------------------------------------------------
  // Texte : rendu et synchronisation par paragraphe
  // -------------------------------------------------------------------------
  function blockEl(id, b) {
    const el = document.createElement('div');
    el.className = 'blk';
    el.dataset.id = id;
    el.dataset.type = b.type || 'p';
    if (b.checked) el.dataset.checked = '1';
    el.innerHTML = sanitize(b.html || '') || '<br>';
    return el;
  }

  function renderBlocks() {
    editor.replaceChildren(...localOrder.map((id) => blockEl(id, local[id])));
    updatePlaceholder();
  }

  function updatePlaceholder() {
    const first = editor.firstElementChild;
    for (const el of editor.querySelectorAll('.placeholder')) el.classList.remove('placeholder');
    if (first && editor.children.length === 1 && !first.textContent && !doc?.strokes.length) first.classList.add('placeholder');
  }

  function normalizeEditor() {
    // Les navigateurs insèrent parfois du texte ou des balises directement dans l'éditeur.
    let current = null;
    for (const node of [...editor.childNodes]) {
      const isBlock = node.nodeType === 1 && node.tagName === 'DIV';
      if (isBlock) { node.classList.add('blk'); current = null; continue; }
      if (node.nodeType === 3 && !node.textContent.trim() && !current) { node.remove(); continue; }
      if (node.nodeType === 1 && (node.tagName === 'P' || /^H\d$/.test(node.tagName))) {
        const d = document.createElement('div');
        d.className = 'blk';
        d.dataset.type = node.tagName === 'H1' ? 'h1' : /^H\d$/.test(node.tagName) ? 'h2' : 'p';
        d.append(...node.childNodes);
        node.replaceWith(d);
        current = null;
        continue;
      }
      if (!current) {
        current = document.createElement('div');
        current.className = 'blk';
        current.dataset.type = 'p';
        editor.insertBefore(current, node);
      }
      current.append(node);
    }
    if (!editor.firstElementChild) {
      const d = blockEl(uid(8), { type: 'p', html: '' });
      editor.append(d);
      setCaret(d, 0);
    }
  }

  let reconcileTimer = null;
  function scheduleReconcile() {
    if (reconcileTimer) return;
    reconcileTimer = setTimeout(() => { reconcileTimer = null; reconcile(); }, 100);
  }

  // Compare le DOM avec l'état connu et envoie les paragraphes modifiés.
  function reconcile() {
    if (reconcileTimer) { clearTimeout(reconcileTimer); reconcileTimer = null; }
    if (!doc) return;
    normalizeEditor();
    const seen = new Set();
    const order = [];
    const upsert = [];
    for (const el of editor.children) {
      let id = el.dataset.id;
      if (!id || seen.has(id)) { id = uid(8); el.dataset.id = id; }
      if (!el.dataset.type) el.dataset.type = 'p';
      seen.add(id);
      order.push(id);
      const b = { type: el.dataset.type, html: sanitize(el.innerHTML), checked: el.dataset.checked === '1' };
      const prev = local[id];
      if (!prev || prev.html !== b.html || prev.type !== b.type || !!prev.checked !== b.checked) {
        upsert.push({ id, ...b });
        local[id] = b;
      }
    }
    const remove = Object.keys(local).filter((id) => !seen.has(id));
    for (const id of remove) delete local[id];
    const orderChanged = order.join() !== localOrder.join();
    localOrder = order;
    if (upsert.length || remove.length || orderChanged) {
      send({ t: 'blocks', upsert, remove, order });
    }
    updatePlaceholder();
    updateToolbarState();
  }

  function applyRemoteBlocks(op) {
    const pending = pendingBlockIds();
    const caret = saveCaret();
    const byId = new Map([...editor.children].map((el) => [el.dataset.id, el]));
    for (const u of op.upsert) {
      if (pending.has(u.id)) continue;
      local[u.id] = { type: u.type, html: u.html, checked: u.checked };
      const el = byId.get(u.id);
      if (!el) { byId.set(u.id, blockEl(u.id, u)); continue; }
      if (el.dataset.type !== u.type) el.dataset.type = u.type;
      if (u.checked) el.dataset.checked = '1'; else delete el.dataset.checked;
      if (sanitize(el.innerHTML) !== u.html) el.innerHTML = u.html || '<br>';
    }
    for (const id of op.remove) {
      if (pending.has(id)) continue;
      delete local[id];
      byId.get(id)?.remove();
      byId.delete(id);
    }
    // Ordre : celui du serveur, en gardant à leur place les paragraphes locaux pas encore envoyés.
    const desired = op.order.filter((id) => byId.has(id));
    const desiredSet = new Set(desired);
    const domIds = [...editor.children].map((el) => el.dataset.id);
    domIds.forEach((id, i) => {
      if (desiredSet.has(id) || !pending.has(id)) return;
      const prevId = domIds.slice(0, i).reverse().find((x) => desiredSet.has(x));
      desired.splice(prevId ? desired.indexOf(prevId) + 1 : 0, 0, id);
      desiredSet.add(id);
    });
    for (const id of domIds) if (!desiredSet.has(id)) { byId.get(id)?.remove(); delete local[id]; }
    if (desired.join() !== [...editor.children].map((el) => el.dataset.id).join()) {
      editor.replaceChildren(...desired.map((id) => byId.get(id)));
    }
    localOrder = desired.filter((id) => local[id]);
    if (caret) restoreCaret(caret);
    updatePlaceholder();
    updatePageHeight();
  }

  // --- Curseur (sauvegarde/restauration par paragraphe + position texte) ---
  function blockOf(node) {
    while (node && node !== editor) {
      if (node.parentNode === editor) return node;
      node = node.parentNode;
    }
    return null;
  }
  function textOffset(blk, node, offset) {
    const r = document.createRange();
    r.selectNodeContents(blk);
    try { r.setEnd(node, offset); } catch { return 0; }
    return r.toString().length;
  }
  function saveCaret() {
    const sel = getSelection();
    if (!sel.rangeCount || document.activeElement !== editor) return null;
    const r = sel.getRangeAt(0);
    const a = blockOf(r.startContainer), b = blockOf(r.endContainer);
    if (!a || !b) return null;
    return { a: a.dataset.id, ao: textOffset(a, r.startContainer, r.startOffset), b: b.dataset.id, bo: textOffset(b, r.endContainer, r.endOffset) };
  }
  function pointAt(blk, offset) {
    const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
    let n, left = offset;
    while ((n = walker.nextNode())) {
      if (left <= n.length) return [n, left];
      left -= n.length;
    }
    return [blk, blk.childNodes.length && blk.lastChild.nodeName === 'BR' ? blk.childNodes.length - 1 : blk.childNodes.length];
  }
  function restoreCaret(c) {
    if (!c) return;
    const find = (id) => [...editor.children].find((el) => el.dataset.id === id);
    const a = find(c.a), b = find(c.b);
    if (!a || !b) return;
    const r = document.createRange();
    r.setStart(...pointAt(a, c.ao));
    r.setEnd(...pointAt(b, c.bo));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function setCaret(blk, offset) {
    const r = document.createRange();
    r.setStart(...pointAt(blk, offset));
    r.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function placeCaretAtEnd() {
    const last = editor.lastElementChild;
    if (!last) return;
    editor.focus({ preventScroll: true });
    setCaret(last, last.textContent.length);
  }
  function currentBlock() {
    const sel = getSelection();
    return sel.rangeCount ? blockOf(sel.getRangeAt(0).startContainer) : null;
  }

  // --- Saisie ---
  editor.addEventListener('input', () => {
    markdownShortcuts();
    scheduleReconcile();
  });
  editor.addEventListener('blur', () => reconcile());

  function markdownShortcuts() {
    const blk = currentBlock();
    if (!blk) return;
    const text = blk.textContent;
    const m = text.match(/^(##?|[-*•]|\[ ?\])[  ]/);
    if (!m || blk.dataset.type !== 'p') return;
    const type = { '#': 'h1', '##': 'h2', '-': 'li', '*': 'li', '•': 'li', '[]': 'todo', '[ ]': 'todo' }[m[1]];
    // supprime le préfixe tapé
    let toRemove = m[0].length;
    const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
    let n;
    while (toRemove > 0 && (n = walker.nextNode())) {
      const k = Math.min(toRemove, n.length);
      n.deleteData(0, k);
      toRemove -= k;
    }
    blk.dataset.type = type;
    if (!blk.textContent) blk.innerHTML = '<br>';
    setCaret(blk, 0);
  }

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      splitBlock();
    } else if (e.key === 'Backspace' && !e.isComposing) {
      // Retour arrière au début d'une liste / case / titre : on repasse en texte simple.
      const sel = getSelection();
      const blk = currentBlock();
      if (blk && sel.isCollapsed && blk.dataset.type !== 'p') {
        const r = sel.getRangeAt(0);
        if (textOffset(blk, r.startContainer, r.startOffset) === 0) {
          e.preventDefault();
          blk.dataset.type = 'p';
          delete blk.dataset.checked;
          reconcile();
        }
      }
    } else if (e.key === 'Escape') {
      editor.blur();
    }
  });

  function splitBlock() {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    let r = sel.getRangeAt(0);
    if (!r.collapsed) { r.deleteContents(); r = sel.getRangeAt(0); }
    const blk = blockOf(r.startContainer);
    if (!blk) return;
    const type = blk.dataset.type;
    // Entrée sur un élément de liste vide : on sort de la liste.
    if ((type === 'li' || type === 'todo') && !blk.textContent) {
      blk.dataset.type = 'p';
      delete blk.dataset.checked;
      reconcile();
      return;
    }
    const tail = document.createRange();
    tail.setStart(r.startContainer, r.startOffset);
    tail.setEnd(blk, blk.childNodes.length);
    const frag = tail.extractContents();
    const nb = document.createElement('div');
    nb.className = 'blk';
    nb.dataset.id = uid(8);
    nb.dataset.type = type === 'li' || type === 'todo' ? type : 'p';
    nb.append(frag);
    // nettoie les balises vides laissées par la coupure
    for (const el of [blk, nb]) {
      for (const x of [...el.querySelectorAll('b,i,u,s,strong,em')]) if (!x.textContent && !x.querySelector('br')) x.remove();
      if (!el.textContent && !el.querySelector('br')) el.innerHTML = '<br>';
      if (el.textContent && el.lastChild?.nodeName === 'BR' && el.childNodes.length > 1 && el === blk) {
        // conserve un éventuel saut de ligne volontaire
      }
    }
    blk.after(nb);
    setCaret(nb, 0);
    nb.scrollIntoView?.({ block: 'nearest' });
    reconcile();
  }

  editor.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain');
    if (text == null) return;
    e.preventDefault();
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    document.execCommand('insertText', false, lines[0]);
    let blk = currentBlock();
    if (lines.length > 1 && blk) {
      // coupe le paragraphe courant et insère une ligne par paragraphe
      const sel = getSelection();
      const r = sel.getRangeAt(0);
      const tail = document.createRange();
      tail.setStart(r.startContainer, r.startOffset);
      tail.setEnd(blk, blk.childNodes.length);
      const rest = tail.extractContents();
      if (!blk.textContent) blk.innerHTML = '<br>';
      for (let i = 1; i < lines.length; i++) {
        const nb = blockEl(uid(8), { type: blk.dataset.type === 'li' || blk.dataset.type === 'todo' ? blk.dataset.type : 'p', html: '' });
        nb.textContent = lines[i];
        if (!lines[i]) nb.innerHTML = '<br>';
        blk.after(nb);
        blk = nb;
      }
      const len = blk.textContent.length;
      if (rest.textContent) { if (!blk.textContent) blk.innerHTML = ''; blk.append(rest); }
      setCaret(blk, len);
    }
    reconcile();
  });

  // Cocher / décocher une case « À faire »
  editor.addEventListener('pointerdown', (e) => {
    const blk = blockOf(e.target);
    if (!blk || blk.dataset.type !== 'todo' || isInkPointer(e)) return;
    const x = (e.clientX - blk.getBoundingClientRect().left) / scale;
    if (x < 26) {
      e.preventDefault();
      if (blk.dataset.checked === '1') delete blk.dataset.checked; else blk.dataset.checked = '1';
      reconcile();
    }
  });

  // --- Barre d'outils texte ---
  const blockTypeSel = $('#block-type');
  for (const b of $$('.fmt')) {
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      if (prefs.tool !== 'text') setTool('text');
      document.execCommand(b.dataset.cmd);
      reconcile();
    });
  }
  let savedRange = null;
  blockTypeSel.addEventListener('pointerdown', () => {
    const sel = getSelection();
    savedRange = sel.rangeCount && editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  });
  blockTypeSel.addEventListener('change', () => {
    const type = blockTypeSel.value;
    const sel = getSelection();
    let range = sel.rangeCount && editor.contains(sel.anchorNode) ? sel.getRangeAt(0) : savedRange;
    if (!range) {
      const last = editor.lastElementChild;
      range = document.createRange();
      range.selectNodeContents(last);
    }
    const a = blockOf(range.startContainer), b = blockOf(range.endContainer);
    if (!a || !b) return;
    let el = a;
    while (el) {
      el.dataset.type = type;
      if (type !== 'todo') delete el.dataset.checked;
      if (el === b) break;
      el = el.nextElementSibling;
    }
    editor.focus({ preventScroll: true });
    sel.removeAllRanges();
    sel.addRange(range);
    if (prefs.tool !== 'text') setTool('text');
    reconcile();
  });
  function updateToolbarState() {
    const blk = currentBlock();
    if (blk) blockTypeSel.value = blk.dataset.type || 'p';
    for (const b of $$('.fmt')) {
      let on = false;
      try { on = document.queryCommandState(b.dataset.cmd); } catch { /* ignore */ }
      b.classList.toggle('active', on && document.activeElement === editor);
    }
  }
  document.addEventListener('selectionchange', () => { if (document.activeElement === editor) updateToolbarState(); });

  // -------------------------------------------------------------------------
  // Encre
  // -------------------------------------------------------------------------
  // Un trait : { id, tool: 'pen'|'hl', color, size, points: [x, y, pression, x, y, pression, ...] }
  function prepStroke(s) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < s.points.length; i += 3) {
      const x = s.points[i], y = s.points[i + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const pad = s.size * 2 + 2;
    s.bbox = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
    return s;
  }

  const widthFor = (s, p) => (s.tool === 'hl' ? s.size : s.size * (0.45 + 1.1 * p));

  function drawStroke(ctx, s) {
    const P = s.points;
    const n = P.length / 3;
    if (n < 1) return;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.tool === 'hl') {
      ctx.globalCompositeOperation = 'multiply';
      ctx.lineWidth = s.size;
      ctx.beginPath();
      ctx.moveTo(P[0], P[1]);
      if (n === 1) ctx.lineTo(P[0] + 0.1, P[1]);
      for (let i = 1; i < n; i++) {
        const cx = P[i * 3], cy = P[i * 3 + 1];
        if (i < n - 1) ctx.quadraticCurveTo(cx, cy, (cx + P[i * 3 + 3]) / 2, (cy + P[i * 3 + 4]) / 2);
        else ctx.lineTo(cx, cy);
      }
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      return;
    }
    if (n === 1) {
      ctx.beginPath();
      ctx.arc(P[0], P[1], widthFor(s, P[2]) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    let px = P[0], py = P[1], pp = P[2];
    for (let i = 1; i < n; i++) {
      const cx = P[i * 3], cy = P[i * 3 + 1], cp = P[i * 3 + 2];
      let ex = cx, ey = cy, ep = cp;
      if (i < n - 1) { ex = (cx + P[i * 3 + 3]) / 2; ey = (cy + P[i * 3 + 4]) / 2; ep = (cp + P[i * 3 + 5]) / 2; }
      ctx.lineWidth = widthFor(s, (pp + cp + ep) / 3);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(cx, cy, ex, ey);
      ctx.stroke();
      px = ex; py = ey; pp = ep;
    }
  }

  function viewTransform(ctx) {
    const dpr = window.devicePixelRatio || 1;
    const sr = stage.getBoundingClientRect();
    const pr = page.getBoundingClientRect();
    const ox = pr.left - sr.left, oy = pr.top - sr.top;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
    return { top: -oy / scale, bottom: (sr.height - oy) / scale };
  }

  function redrawInk() {
    const ctx = inkCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
    if (!doc) return;
    const v = viewTransform(ctx);
    for (const s of doc.strokes) {
      if (s.bbox[3] < v.top || s.bbox[1] > v.bottom) continue;
      drawStroke(ctx, s);
    }
  }

  let current = null;               // trait en cours (local)
  let eraser = null;                // { x, y, r } position de la gomme
  const remoteLive = new Map();     // traits en cours sur les autres appareils

  function redrawLive() {
    const ctx = liveCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
    if (!doc) return;
    viewTransform(ctx);
    for (const s of remoteLive.values()) drawStroke(ctx, s);
    if (current) drawStroke(ctx, current);
    if (eraser) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = 1.2 / scale;
      ctx.strokeStyle = '#888';
      ctx.fillStyle = 'rgba(200,200,200,.25)';
      ctx.beginPath();
      ctx.arc(eraser.x, eraser.y, eraser.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  let rafInk = false, rafLive = false;
  function requestRedraw(liveOnly) {
    if (!liveOnly && !rafInk) { rafInk = true; requestAnimationFrame(() => { rafInk = false; redrawInk(); }); }
    if (!rafLive) { rafLive = true; requestAnimationFrame(() => { rafLive = false; redrawLive(); }); }
  }

  // --- Saisie au stylet / souris ---
  let penSeenAt = 0;
  function isInkPointer(e) {
    if (prefs.tool === 'text') return false;
    if (e.pointerType === 'pen' || e.pointerType === 'mouse') return true;
    // doigt : seulement si l'option est activée et qu'aucun stylet n'a été utilisé récemment (repose-paume)
    return e.pointerType === 'touch' && prefs.fingerDraw && Date.now() - penSeenAt > 3000;
  }

  // Empêche le défilement / Scribble quand on écrit avec l'Apple Pencil.
  scroller.addEventListener('touchstart', (e) => {
    if (prefs.tool === 'text') return;
    const stylus = [...e.touches].some((t) => t.touchType === 'stylus');
    if (stylus || (prefs.fingerDraw && Date.now() - penSeenAt > 3000)) e.preventDefault();
  }, { passive: false });
  scroller.addEventListener('touchmove', (e) => {
    if (current || eraser) e.preventDefault();
  }, { passive: false });

  let pageRect = null;
  let activePointer = null;
  let erased = [];

  const toPage = (e) => [
    Math.round(((e.clientX - pageRect.left) / scale) * 10) / 10,
    Math.round(((e.clientY - pageRect.top) / scale) * 10) / 10,
    e.pointerType === 'pen' ? Math.round((e.pressure || 0.5) * 100) / 100 : 0.5,
  ];

  scroller.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen') penSeenAt = Date.now();
    if (!isInkPointer(e) || activePointer !== null || !doc) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    activePointer = e.pointerId;
    try { scroller.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (document.activeElement === editor) editor.blur();
    pageRect = page.getBoundingClientRect();
    const [x, y, p] = toPage(e);
    if (prefs.tool === 'eraser') {
      erased = [];
      eraser = { x, y, r: ERASER_SIZES[prefs.eraserSize] };
      eraseAt(x, y);
    } else {
      const hl = prefs.tool === 'hl';
      current = {
        id: uid(10),
        tool: hl ? 'hl' : 'pen',
        color: hl ? prefs.hlColor : prefs.penColor,
        size: hl ? HL_SIZES[prefs.hlSize] : PEN_SIZES[prefs.penSize],
        points: [x, y, p],
        sent: 0,
      };
      sendLive();
    }
    requestRedraw(true);
  });

  scroller.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activePointer) return;
    e.preventDefault();
    const evts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evts.length ? evts : [e]) {
      const [x, y, p] = toPage(ev);
      if (eraser) {
        eraser.x = x; eraser.y = y;
        eraseAt(x, y);
      } else if (current) {
        const P = current.points;
        const dx = x - P[P.length - 3], dy = y - P[P.length - 2];
        if (dx * dx + dy * dy < 0.25) continue;
        P.push(x, y, p);
      }
    }
    if (current) sendLive();
    requestRedraw(true);
  });

  const endPointer = (e) => {
    if (e.pointerId !== activePointer) return;
    activePointer = null;
    if (current) {
      sendLive();
      const s = prepStroke({ id: current.id, tool: current.tool, color: current.color, size: current.size, points: current.points });
      current = null;
      addStroke(s, true);
      pushUndo({ add: [s] });
    }
    if (eraser) {
      eraser = null;
      if (erased.length) {
        send({ t: 'erase', ids: erased.map((s) => s.id) }, true);
        pushUndo({ erase: erased });
      }
      erased = [];
    }
    requestRedraw(true);
  };
  scroller.addEventListener('pointerup', endPointer);
  scroller.addEventListener('pointercancel', endPointer);

  let liveTimer = null;
  function sendLive() {
    if (liveTimer || !current) return;
    liveTimer = setTimeout(() => {
      liveTimer = null;
      if (!current) return;
      const pts = current.points.slice(current.sent);
      if (!pts.length) return;
      send({ t: 'live', id: current.id, from: current.sent, tool: current.tool, color: current.color, size: current.size, points: pts });
      current.sent = current.points.length;
    }, 30);
  }

  function addStroke(s, local) {
    if (doc.strokes.some((x) => x.id === s.id)) return;
    doc.strokes.push(s);
    if (local) send({ t: 'stroke', stroke: { id: s.id, tool: s.tool, color: s.color, size: s.size, points: s.points } }, true);
    // dessin incrémental sur le calque principal
    viewTransform(inkCtx);
    drawStroke(inkCtx, s);
    if (s.bbox[3] + 500 > pageHeight) updatePageHeight();
    updatePlaceholder();
  }

  function removeStrokes(ids, local) {
    const set = new Set(ids);
    const removed = doc.strokes.filter((s) => set.has(s.id));
    if (!removed.length) return [];
    doc.strokes = doc.strokes.filter((s) => !set.has(s.id));
    if (local) send({ t: 'erase', ids: removed.map((s) => s.id) }, true);
    requestRedraw();
    return removed;
  }

  function eraseAt(x, y) {
    const r = eraser.r;
    const hit = [];
    for (const s of doc.strokes) {
      const b = s.bbox;
      if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) continue;
      const P = s.points;
      const lim = (r + s.size / 2) ** 2;
      for (let i = 0; i < P.length; i += 3) {
        // distance au segment [i, i+1]
        const ax = P[i], ay = P[i + 1];
        const bx = i + 3 < P.length ? P[i + 3] : ax, by = i + 3 < P.length ? P[i + 4] : ay;
        const dx = bx - ax, dy = by - ay;
        const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0;
        const qx = ax + t * dx - x, qy = ay + t * dy - y;
        if (qx * qx + qy * qy <= lim) { hit.push(s.id); break; }
      }
    }
    if (hit.length) erased.push(...removeStrokes(hit, false));
  }

  // --- Annuler / rétablir (encre) ---
  const undoStack = [];
  const redoStack = [];
  function pushUndo(entry) {
    undoStack.push(entry);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    updateUndoButtons();
  }
  function invert(entry, stackTo) {
    if (entry.add) removeStrokes(entry.add.map((s) => s.id), true);
    if (entry.erase) for (const s of entry.erase) addStroke(s, true);
    stackTo.push(entry);
    requestRedraw();
    updateUndoButtons();
  }
  function undoInk() { const e = undoStack.pop(); if (e) invert(e, redoStack); }
  function redoInk() {
    const e = redoStack.pop();
    if (!e) return;
    if (e.add) for (const s of e.add) addStroke(s, true);
    if (e.erase) removeStrokes(e.erase.map((s) => s.id), true);
    undoStack.push(e);
    requestRedraw();
    updateUndoButtons();
  }
  function updateUndoButtons() {
    $('#undo').disabled = !undoStack.length;
    $('#redo').disabled = !redoStack.length;
    $('#undo').style.opacity = undoStack.length ? 1 : 0.35;
    $('#redo').style.opacity = redoStack.length ? 1 : 0.35;
  }
  $('#undo').onclick = undoInk;
  $('#redo').onclick = redoInk;
  document.addEventListener('keydown', (e) => {
    if (editorView.hidden || document.activeElement === editor || document.activeElement?.tagName === 'INPUT') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redoInk(); else undoInk(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redoInk(); }
    else if (!mod && !e.altKey) {
      const map = { t: 'text', p: 'pen', h: 'hl', e: 'eraser' };
      if (map[e.key]) setTool(map[e.key]);
    }
  });

  // -------------------------------------------------------------------------
  // Opérations reçues des autres appareils
  // -------------------------------------------------------------------------
  function applyRemote(op) {
    switch (op.t) {
      case 'title':
        doc.title = op.title;
        if (document.activeElement !== $('#title')) $('#title').value = op.title;
        document.title = op.title || 'Note';
        break;
      case 'paper': setPaper(op.paper, false); break;
      case 'blocks':
        reconcile(); // envoie d'abord nos propres modifications en attente
        applyRemoteBlocks(op);
        break;
      case 'live': {
        let s = remoteLive.get(op.id);
        if (op.from === 0 || !s) {
          if (op.from !== 0) break;
          s = { id: op.id, tool: op.tool, color: op.color, size: op.size, points: [] };
          remoteLive.set(op.id, s);
        }
        if (s.points.length === op.from) s.points.push(...op.points);
        s.seen = Date.now();
        requestRedraw(true);
        break;
      }
      case 'stroke':
        remoteLive.delete(op.stroke.id);
        addStroke(prepStroke(op.stroke), false);
        requestRedraw(true);
        break;
      case 'erase':
        removeStrokes(op.ids, false);
        break;
    }
  }
  setInterval(() => {
    let changed = false;
    for (const [id, s] of remoteLive) if (Date.now() - s.seen > 4000) { remoteLive.delete(id); changed = true; }
    if (changed) requestRedraw(true);
  }, 2000);

  // -------------------------------------------------------------------------
  // Barre d'outils
  // -------------------------------------------------------------------------
  function setTool(tool) {
    prefs.tool = tool;
    savePrefs();
    for (const b of $$('.tool')) b.classList.toggle('active', b.dataset.tool === tool);
    document.body.classList.toggle('tool-ink', tool !== 'text');
    if (tool !== 'text' && document.activeElement === editor) editor.blur();
    editor.contentEditable = tool === 'text' ? 'true' : 'false';
    renderInkOptions();
  }
  for (const b of $$('.tool')) {
    b.addEventListener('pointerdown', (e) => { if (prefs.tool !== 'text' || b.dataset.tool !== 'text') e.preventDefault(); });
    b.addEventListener('click', () => {
      setTool(b.dataset.tool);
      if (b.dataset.tool === 'text' && !isTouchDevice) placeCaretAtEnd();
    });
  }

  function renderInkOptions() {
    const colors = $('#colors');
    const sizes = $('#sizes');
    colors.innerHTML = '';
    sizes.innerHTML = '';
    const t = prefs.tool;
    if (t === 'pen' || t === 'hl') {
      const list = t === 'hl' ? HL_COLORS : COLORS;
      const cur = t === 'hl' ? prefs.hlColor : prefs.penColor;
      for (const c of list) {
        const b = document.createElement('button');
        b.className = `swatch${c === cur ? ' active' : ''}`;
        b.style.background = c;
        b.title = c;
        b.setAttribute('aria-label', `Couleur ${c}`);
        b.onclick = () => { if (t === 'hl') prefs.hlColor = c; else prefs.penColor = c; savePrefs(); renderInkOptions(); };
        colors.append(b);
      }
    }
    const key = t === 'hl' ? 'hlSize' : t === 'eraser' ? 'eraserSize' : 'penSize';
    if (t !== 'text') {
      [6, 10, 15].forEach((d, i) => {
        const b = document.createElement('button');
        b.className = `size-btn${prefs[key] === i ? ' active' : ''}`;
        b.setAttribute('aria-label', `Taille ${i + 1}`);
        const dot = document.createElement('span');
        dot.style.width = dot.style.height = `${t === 'pen' ? d * 0.7 : d}px`;
        if (t === 'pen') dot.style.color = prefs.penColor;
        if (t === 'hl') dot.style.color = prefs.hlColor;
        if (t === 'eraser') { dot.style.background = 'transparent'; dot.style.border = '1.5px solid #6b7280'; }
        b.append(dot);
        b.onclick = () => { prefs[key] = i; savePrefs(); renderInkOptions(); };
        sizes.append(b);
      });
    }
  }

  // Clic sous le texte : place le curseur à la fin.
  page.addEventListener('pointerdown', (e) => {
    if (e.target !== page || prefs.tool !== 'text' || isInkPointer(e)) return;
    const last = editor.lastElementChild;
    if (last && e.clientY > last.getBoundingClientRect().bottom) {
      e.preventDefault();
      placeCaretAtEnd();
    }
  });

  $('#back').onclick = () => { location.hash = '#/'; };

  let titleTimer = null;
  $('#title').addEventListener('input', () => {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      const title = $('#title').value;
      document.title = title || 'Note';
      send({ t: 'title', title });
    }, 250);
  });
  $('#title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#title').blur(); if (prefs.tool === 'text') placeCaretAtEnd(); }
  });

  function setPaper(p, sendIt) {
    page.className = `paper-${p}`;
    $('#paper').value = p;
    if (doc) doc.paper = p;
    if (sendIt) send({ t: 'paper', paper: p });
  }
  $('#paper').onchange = () => setPaper($('#paper').value, true);

  $('#finger-draw').checked = prefs.fingerDraw;
  $('#finger-draw').onchange = () => { prefs.fingerDraw = $('#finger-draw').checked; savePrefs(); };

  $('#menu-btn').onclick = (e) => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; };
  document.addEventListener('pointerdown', (e) => {
    if (!$('#menu').hidden && !$('#menu').contains(e.target) && e.target !== $('#menu-btn') && !$('#menu-btn').contains(e.target)) $('#menu').hidden = true;
  });

  $('#delete-note').onclick = async () => {
    if (!confirm('Supprimer définitivement cette note ?')) return;
    const id = noteId;
    closeNote();
    await api('DELETE', `/api/notes/${id}`).catch(() => {});
    location.hash = '#/';
  };

  // Envoie ce qui reste avant de quitter / passer en arrière-plan.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && noteId) {
      reconcile();
      if (outbox.length) {
        navigator.sendBeacon?.(`/api/notes/${noteId}/ops`, new Blob([JSON.stringify({ client: clientId, ops: outbox })], { type: 'application/json' }));
        outbox = [];
      }
    }
  });

  // -------------------------------------------------------------------------
  // Démarrage
  // -------------------------------------------------------------------------
  setTool(prefs.tool);
  updateUndoButtons();
  route();
})();
