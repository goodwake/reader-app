// ════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════
const GOOGLE_CLIENT_ID = '959112801007-gcl60pqaausbtl1857e9bs22adghfb3g.apps.googleusercontent.com';
const DRIVE_FOLDER_NAME = 'ORV Reader';
const AUDIO_BUFFER_AHEAD = 3;
const TTS_CHUNK_LIMIT = 1800;
const FETCH_RETRIES = 3;
const FETCH_RETRY_DELAY = 1500;
const REGISTRY_MAX_SIZE = 50;
const VOICE_POOL_VERSION = 3;
const SEGMENTS_CACHE_VERSION = 8;
const WORKER = 'https://yellow-wood-3e92.abdulazizosamaalazwari.workers.dev';

// Curated voice type search queries
const VOICE_TYPES = {
  narrator:        { label: 'Narrator',        desc: 'Deep, measured',        queries: ['narrator male', 'audiobook male', 'storyteller', 'deep voice male'] },
  old_man:         { label: 'Old Man',          desc: 'Elderly male',          queries: ['old man', 'elderly male', 'grandfather', 'aged male'] },
  adult_man:       { label: 'Adult Man',        desc: 'Male, 30s-40s',         queries: ['adult male', 'mature male', 'professional male', 'man voice'] },
  young_man:       { label: 'Young Man',        desc: 'Male, 20s',             queries: ['young man', 'casual male', 'male youth', 'twenties male'] },
  teen_boy:        { label: 'Teen Boy',         desc: 'Male teenager',         queries: ['teen boy', 'teenage male', 'young boy'] },
  old_woman:       { label: 'Old Woman',        desc: 'Elderly female',        queries: ['old woman', 'elderly female', 'grandmother', 'aged female'] },
  adult_woman:     { label: 'Adult Woman',      desc: 'Female, 30s-40s',       queries: ['adult female', 'mature female', 'professional female', 'woman voice'] },
  young_woman:     { label: 'Young Woman',      desc: 'Female, 20s',           queries: ['young woman', 'casual female', 'female youth', 'twenties female'] },
  teen_girl:       { label: 'Teen Girl',        desc: 'Female teenager',       queries: ['teen girl', 'teenage female', 'young girl'] },
  child:           { label: 'Child',            desc: 'Young child',           queries: ['child voice', 'kid voice', 'young child'] },
  inner_monologue: { label: 'Inner Monologue',  desc: 'MC thoughts, intimate', queries: ['soft male', 'thoughtful male', 'introspective male', 'whisper male'] },
  system:          { label: 'System / Status',  desc: 'Robotic, flat',         queries: ['robot voice', 'ai voice', 'computer voice', 'monotone'] },
};

// ════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════
let voicePools = {};
let db = null;

function getUserId() { return S.user?.id || S.user?.email || S.user?.sub || null; }
function workerHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  const uid = getUserId();
  if (uid) h['X-User-Id'] = uid;
  if (S.accessToken) h['X-User-Token'] = S.accessToken;
  return h;
}

let S = {
  user: null, accessToken: null, tokenExpiry: 0,
  driveFolderId: null, driveEpubFileIds: {},
  keys: { ds: '', fa: '', oa: '' },
  books: [], activeBook: null, activeChIdx: 0,
  segments: [], flatWords: [], currentWordIdx: 0,
  isPlaying: false, speed: 1.0,
  speeds: [0.75, 1.0, 1.25, 1.5, 1.75, 2.0], speedIdx: 1,
  audio: null, wordTimings: [], animFrame: null,
  customVoices: {}, audioBuffer: {},
  isMobile: window.innerWidth < 768,
  smartIdentify: true,
  loadToken: 0, bufferToken: 0,
  poolFetchPromises: {},
};

// ════════════════════════════════════════════════════════
// INDEXEDDB
// ════════════════════════════════════════════════════════
async function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('orv_reader_db', 3);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('epubs')) d.createObjectStore('epubs', { keyPath: 'bookId' });
      if (!d.objectStoreNames.contains('segments_cache')) d.createObjectStore('segments_cache', { keyPath: 'key' });
    };
    req.onsuccess = e => { db = e.target.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}

async function dbSet(store, value) {
  if (!db) return;
  return new Promise(resolve => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function dbGet(store, key) {
  if (!db) return null;
  return new Promise(resolve => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function dbDelete(store, key) {
  if (!db) return;
  return new Promise(resolve => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function cacheSegments(bookId, chIdx, segments) {
  await dbSet('segments_cache', { key: bookId+'_'+chIdx, segments, version: SEGMENTS_CACHE_VERSION, ts: Date.now() });
}

async function getCachedSegments(bookId, chIdx) {
  const rec = await dbGet('segments_cache', bookId+'_'+chIdx);
  if (!rec) return null;
  if (rec.version !== SEGMENTS_CACHE_VERSION) { await dbDelete('segments_cache', bookId+'_'+chIdx); return null; }
  return rec.segments;
}

// ════════════════════════════════════════════════════════
// LOCALSTORAGE
// ════════════════════════════════════════════════════════
function saveLocal() {
  try {
    localStorage.setItem('orv_reader', JSON.stringify({
      keys: S.keys, customVoices: S.customVoices,
      voicePools, voicePoolVersion: VOICE_POOL_VERSION,
      smartIdentify: S.smartIdentify,
      driveEpubFileIds: S.driveEpubFileIds,
      books: S.books.map(b => ({
        id: b.id, title: b.title, color: b.color,
        chapters: b.chapters || [],
        progress: b.progress || 0,
        chapterProgress: b.chapterProgress || {},
        voiceMap: b.voiceMap || {},
        characterRegistry: b.characterRegistry || {},
      }))
    }));
  } catch(e) { console.warn('saveLocal failed', e); }
}

function loadLocal() {
  try {
    const d = JSON.parse(localStorage.getItem('orv_reader') || '{}');
    if (d.keys) S.keys = d.keys;
    if (d.customVoices) S.customVoices = d.customVoices;
    if (d.voicePools && d.voicePoolVersion === VOICE_POOL_VERSION) Object.assign(voicePools, d.voicePools);
    else voicePools = {};
    if (d.driveEpubFileIds) S.driveEpubFileIds = d.driveEpubFileIds;
    if (typeof d.smartIdentify === 'boolean') S.smartIdentify = d.smartIdentify;
    return d;
  } catch(e) { return {}; }
}

// ════════════════════════════════════════════════════════
// SCREEN
// ════════════════════════════════════════════════════════
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function showView(id) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// ════════════════════════════════════════════════════════
// LOGIN
// ════════════════════════════════════════════════════════
function toggleApiFields() { document.getElementById('apiFields').classList.toggle('open'); }

function saveApiKeys() {
  saveLocal();
  localStorage.setItem('orv_auto_enter', '1');
  S.user = { name: 'Reader', email: '' };
  enterApp();
  toast('Entered');
}

function signInGoogle() {
  if (!window.google) { toast('Google SDK loading, try again'); return; }
  const client = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
    callback: async (resp) => {
      if (resp.error) { toast('Sign in failed: ' + resp.error); return; }
      S.accessToken = resp.access_token;
      S.tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
      try {
        S.user = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: 'Bearer ' + S.accessToken }
        }).then(r => r.json());
        updateUserAvatar();
      } catch(e) { S.user = { name: 'Reader' }; }
      showGenOverlay('Connecting to Drive', 'Setting up your library folder...');
      await ensureDriveFolder();
      await syncFromDrive();
      hideGenOverlay();
      enterApp();
    }
  });
  client.requestAccessToken();
}

function updateUserAvatar() {
  const av = document.getElementById('userAvatar');
  if (!av) return;
  if (S.user?.picture) av.innerHTML = '<img src="'+S.user.picture+'" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">';
  else av.textContent = S.user?.name?.[0] || '?';
}

async function ensureValidToken() {
  if (!S.accessToken) return false;
  if (Date.now() < S.tokenExpiry) return true;
  return new Promise(resolve => {
    try {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.file',
        prompt: '',
        callback: (resp) => {
          if (resp.error) { resolve(false); return; }
          S.accessToken = resp.access_token;
          S.tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
          resolve(true);
        }
      });
      client.requestAccessToken();
    } catch(e) { resolve(false); }
  });
}

function showUserMenu() { toast(S.user ? (S.user.name || S.user.email || 'Reader') : 'Not signed in'); }

function enterApp() {
  renderLibrary();
  showScreen('app');
  showView('libraryPanel');
  updateUserAvatar();
  // Pre-fetch all voice pools in background
  prefetchAllVoicePools();
}

// ════════════════════════════════════════════════════════
// GOOGLE DRIVE
// ════════════════════════════════════════════════════════
async function driveReq(path, opts = {}) {
  const valid = await ensureValidToken();
  if (!valid) return null;
  try {
    const res = await fetch('https://www.googleapis.com/drive/v3/' + path, {
      ...opts, headers: { Authorization: 'Bearer ' + S.accessToken, ...(opts.headers || {}) }
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json().catch(() => null);
    return res;
  } catch(e) { return null; }
}

async function ensureDriveFolder() {
  const list = await driveReq("files?q=name='" + DRIVE_FOLDER_NAME + "' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id)");
  if (list?.files?.length) { S.driveFolderId = list.files[0].id; return; }
  const folder = await driveReq('files', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
  });
  S.driveFolderId = folder?.id;
}

async function saveSyncToDrive() {
  saveLocal();
  if (!S.accessToken || !S.driveFolderId) return;
  const valid = await ensureValidToken();
  if (!valid) return;
  const data = JSON.stringify({
    books: S.books.map(b => ({
      id: b.id, title: b.title, color: b.color,
      chapters: b.chapters || [],
      progress: b.progress || 0,
      chapterProgress: b.chapterProgress || {},
      voiceMap: b.voiceMap || {},
      characterRegistry: b.characterRegistry || {},
    })),
    customVoices: S.customVoices, voicePools,
    driveEpubFileIds: S.driveEpubFileIds, keys: S.keys,
  });
  const list = await driveReq("files?q=name='reader_sync.json' and '" + S.driveFolderId + "' in parents and trashed=false&fields=files(id)");
  const blob = new Blob([data], { type: 'application/json' });
  const form = new FormData();
  const meta = { name: 'reader_sync.json' };
  if (!list?.files?.length) meta.parents = [S.driveFolderId];
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', blob);
  const url = list?.files?.length
    ? 'https://www.googleapis.com/upload/drive/v3/files/' + list.files[0].id + '?uploadType=multipart'
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
  await fetch(url, {
    method: list?.files?.length ? 'PATCH' : 'POST',
    headers: { Authorization: 'Bearer ' + S.accessToken },
    body: form
  }).catch(() => {});
}

async function syncFromDrive() {
  if (!S.accessToken || !S.driveFolderId) return;
  const list = await driveReq("files?q=name='reader_sync.json' and '" + S.driveFolderId + "' in parents and trashed=false&fields=files(id)");
  if (!list?.files?.length) return;
  const res = await driveReq('files/' + list.files[0].id + '?alt=media');
  if (!res) return;
  let data;
  try { data = typeof res.json === 'function' ? await res.json() : res; } catch(e) { return; }
  if (!data) return;
  if (data.customVoices) S.customVoices = data.customVoices;
  if (data.voicePools && data.voicePoolVersion === VOICE_POOL_VERSION) Object.assign(voicePools, data.voicePools);
  if (data.keys) S.keys = { ...S.keys, ...data.keys };
  if (data.driveEpubFileIds) Object.assign(S.driveEpubFileIds, data.driveEpubFileIds);
  if (data.books) {
    data.books.forEach(saved => {
      const ex = S.books.find(b => b.id === saved.id);
      if (ex) {
        ex.progress = saved.progress;
        ex.chapterProgress = saved.chapterProgress || {};
        ex.voiceMap = saved.voiceMap || {};
        ex.characterRegistry = saved.characterRegistry || {};
        if (saved.chapters?.length) ex.chapters = saved.chapters;
      } else {
        S.books.push({ ...saved, _epub: null });
      }
    });
  }
}

async function uploadEpubToDrive(bookId, arrayBuffer, filename, onProgress) {
  if (!S.accessToken || !S.driveFolderId) return null;
  const valid = await ensureValidToken();
  if (!valid) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const blob = new Blob([arrayBuffer], { type: 'application/epub+zip' });
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ name: filename, parents: [S.driveFolderId] })], { type: 'application/json' }));
      form.append('file', blob);
      const fileId = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id');
        xhr.setRequestHeader('Authorization', 'Bearer ' + S.accessToken);
        xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
        xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText).id); } catch(e) { reject(e); } } else reject(new Error('Upload failed: ' + xhr.status)); };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(form);
      });
      S.driveEpubFileIds[bookId] = fileId;
      saveLocal();
      return fileId;
    } catch(e) {
      if (attempt === 2) throw e;
      await sleep(2000 * (attempt + 1));
      toast('Upload failed, retrying... (' + (attempt+2) + '/3)');
    }
  }
  return null;
}

async function downloadEpubFromDrive(bookId) {
  const fileId = S.driveEpubFileIds[bookId];
  if (!fileId) return null;
  const valid = await ensureValidToken();
  if (!valid) return null;
  try {
    const res = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', {
      headers: { Authorization: 'Bearer ' + S.accessToken }
    });
    if (!res.ok) return null;
    return res.arrayBuffer();
  } catch(e) { return null; }
}

// ════════════════════════════════════════════════════════
// LIBRARY
// ════════════════════════════════════════════════════════
const COLORS = ['#c9a84c','#4c7bc9','#c94c4c','#4cc97b','#c94ca8','#4cc9c9','#c97b4c'];

async function addBook(evt) {
  console.log('[addBook] Starting');
  const file = evt.target.files[0];
  if (!file) { console.log('[addBook] No file selected'); return; }
  evt.target.value = '';
  console.log('[addBook] File selected:', file.name);
  
  try {
    console.log('[addBook] Calling showGenOverlay');
    showGenOverlay('Adding Book', file.name, 'Reading file...');
    console.log('[addBook] Overlay shown');
    
    setGenProgress(5);
    console.log('[addBook] Reading arrayBuffer');
    const arrayBuffer = await file.arrayBuffer();
    
    setGenProgress(15);
    setGenStep('Parsing EPUB structure...');
    console.log('[addBook] Creating ePub instance');
    const book = ePub(arrayBuffer.slice(0));
    console.log('[addBook] Waiting for book.ready');
    await book.ready;
    
    setGenProgress(30);
    console.log('[addBook] Loading metadata');
    const meta = await book.loaded.metadata;
    const nav = await book.loaded.navigation;
    const title = meta.title || file.name.replace('.epub', '');
    
    setGenStep('Building chapter list...');
    const id = 'book_' + Date.now();
    const color = COLORS[S.books.length % COLORS.length];
    const chapters = [];
    const tocMap = {};
    nav.toc.forEach(item => { tocMap[item.href?.split('#')[0]] = item.label; });
    let idx = 0;
    book.spine.each(item => {
      const href = item.href?.split('#')[0];
      chapters.push({ id: item.idref, href: item.href, title: (tocMap[href] || 'Chapter ' + (idx+1)).trim() });
      idx++;
    });
    
    setGenProgress(40);
    console.log('[addBook] Creating book entry');
    const bookEntry = { id, title, color, chapters, progress: 0, chapterProgress: {}, voiceMap: {}, characterRegistry: {}, _epub: book };
    S.books.push(bookEntry);
    
    setGenStep('Saving locally...');
    console.log('[addBook] Saving to IndexedDB');
    await dbSet('epubs', { bookId: id, data: arrayBuffer });
    setGenProgress(60);
    
    if (S.accessToken && S.driveFolderId) {
      setGenStep('Uploading to Google Drive...');
      console.log('[addBook] Starting Drive upload');
      try {
        await uploadEpubToDrive(id, arrayBuffer, file.name, pct => {
          setGenProgress(60 + pct * 35);
          setGenStep('Uploading to Drive: ' + Math.round(pct * 100) + '%');
        });
        setGenProgress(95);
        toast('Uploaded to Drive');
      } catch(e) { 
        console.error('[addBook] Drive upload error:', e);
        toast('Drive upload failed -- saved locally'); 
      }
    } else {
      console.log('[addBook] No Drive access, skipping upload');
      setGenProgress(95);
    }
    
    setGenStep('Syncing...');
    console.log('[addBook] Rendering library');
    renderLibrary();
    console.log('[addBook] Saving sync to Drive');
    await saveSyncToDrive();
    setGenProgress(100);
    await sleep(300);
    console.log('[addBook] Hiding overlay');
    hideGenOverlay();
    toast('Added: ' + title);
    console.log('[addBook] Complete');
  } catch(e) {
    console.error('[addBook] FATAL ERROR:', e);
    hideGenOverlay();
    toast('Failed to parse EPUB: ' + e.message);
  }
}

async function restoreEpub(book) {
  if (book._epub) return true;
  const rec = await dbGet('epubs', book.id);
  if (rec?.data) {
    try { book._epub = ePub(rec.data); await book._epub.ready; return true; } catch(e) {}
  }
  if (S.driveEpubFileIds[book.id] && S.accessToken) {
    setGenStep('Downloading EPUB from Drive...');
    try {
      const ab = await downloadEpubFromDrive(book.id);
      if (ab) {
        book._epub = ePub(ab);
        await book._epub.ready;
        await dbSet('epubs', { bookId: book.id, data: ab });
        return true;
      }
    } catch(e) {}
  }
  return false;
}

async function deleteBook(bookId, e) {
  if (e) e.stopPropagation();
  if (!confirm('Remove this book from your library?')) return;
  const idx = S.books.findIndex(b => b.id === bookId);
  if (idx === -1) return;
  S.books.splice(idx, 1);
  await dbDelete('epubs', bookId);
  renderLibrary();
  saveSyncToDrive();
  toast('Book removed');
}

function calcBookProgress(book) {
  if (!book.chapters?.length) return book.progress || 0;
  const cp = book.chapterProgress || {};
  const done = Object.values(cp).filter(v => v > 0).length;
  return Math.round((done / book.chapters.length) * 100);
}

function renderLibrary() {
  const el = document.getElementById('libContent');
  if (!el) return;
  el.innerHTML = '';
  if (!S.books.length) {
    el.innerHTML = '<div class="elib">No books yet.<br>Add an EPUB to get started.</div>';
    return;
  }
  S.books.forEach(b => {
    const pct = calcBookProgress(b);
    const card = document.createElement('div');
    card.className = 'bc';
    card.style.setProperty('--cc', b.color);
    const spine = document.createElement('div'); spine.className = 'bsp'; spine.textContent = '📖';
    const info = document.createElement('div'); info.className = 'bi';
    const bname = document.createElement('div'); bname.className = 'bn'; bname.textContent = b.title;
    const bmeta = document.createElement('div'); bmeta.className = 'bm'; bmeta.textContent = (b.chapters||[]).length + ' ch · ' + pct + '% read';
    const bp = document.createElement('div'); bp.className = 'bp';
    const bpf = document.createElement('div'); bpf.className = 'bpf'; bpf.style.width = pct + '%'; bpf.style.background = b.color;
    bp.appendChild(bpf); info.append(bname, bmeta, bp);
    const ba = document.createElement('div'); ba.className = 'ba';
    const bch = document.createElement('div'); bch.className = 'bch'; bch.textContent = '›';
    // Bible build button -- shows before opening the book
    const bbible = document.createElement('div');
    bbible.className = 'del';
    bbible.title = 'Build character voices';
    bbible.textContent = '⚡';
    bbible.style.cssText = 'color:var(--gold);font-size:13px;';
    bbible.addEventListener('click', (function(id){ return async function(ev){
      ev.stopPropagation();
      const book = S.books.find(b => b.id === id);
      if (!book) return;
      S.activeBook = book;
      if (!book._epub) {
        showGenOverlay('Loading Book', 'Restoring EPUB for voice build...');
        const ok = await restoreEpub(book);
        if (!ok) { hideGenOverlay(); toast('EPUB not found — re-add the book first'); return; }
      }
      showGenOverlay('Building Voices', 'Analyzing characters across chapters...', '');
      setGenProgress(0);
      await prefetchAllVoicePools();
      const count = await buildCharacterBible(({ phase, pct }) => {
        setGenStep(phase);
        setGenProgress(pct);
      });
      hideGenOverlay();
      if (count) toast('Built voices for ' + count + ' characters ⚡');
      else toast('No characters found — try reading a chapter first');
      S.activeBook = null;
    }; })(b.id));
    const bdel = document.createElement('div'); bdel.className = 'del'; bdel.textContent = '✕';
    bdel.addEventListener('click', (function(id){ return function(ev){ deleteBook(id, ev); }; })(b.id));
    ba.append(bch, bbible, bdel);
    card.append(spine, info, ba);
    card.onclick = () => openBook(b.id);
    el.appendChild(card);
  });
}

// ════════════════════════════════════════════════════════
// CHAPTER SELECT
// ════════════════════════════════════════════════════════
async function openBook(bookId) {
  const book = S.books.find(b => b.id === bookId);
  if (!book) return;
  S.activeBook = book;
  if (!book._epub) {
    showGenOverlay('Loading Book', 'Restoring EPUB...');
    const ok = await restoreEpub(book);
    hideGenOverlay();
    if (!ok) { toast('EPUB not found — please re-add the book'); return; }
  }
  document.getElementById('chBookTitle').textContent = book.title;
  renderChapterList(book.chapters || []);
  showView('chaptersPanel');
}

function renderChapterList(chapters) {
  const list = document.getElementById('chList');
  if (!list) return;
  list.innerHTML = '';
  chapters.forEach((ch, i) => {
    const isCurrent = S.activeBook?.chapterProgress?.[i] > 0;
    const div = document.createElement('div');
    div.className = 'chi' + (isCurrent ? ' read' : '');
    div.innerHTML = '<div class="chno">'+String(i+1).padStart(3,'0')+'</div><div class="chn">'+ch.title+'</div><div class="chd"></div>';
    div.onclick = () => loadChapter(i);
    list.appendChild(div);
  });
}

function filterChapters(q) {
  if (!S.activeBook) return;
  document.querySelectorAll('.chi').forEach((item, i) => {
    const name = S.activeBook.chapters[i]?.title?.toLowerCase() || '';
    item.style.display = name.includes(q.toLowerCase()) ? '' : 'none';
  });
}

// ════════════════════════════════════════════════════════
// CHAPTER LOAD
// ════════════════════════════════════════════════════════
async function loadChapter(chIdx) {
  S.loadToken++;
  const myToken = S.loadToken;
  S.activeChIdx = chIdx;
  stopPlayback();
  clearAudioBuffer();
  const ch = S.activeBook.chapters[chIdx];
  document.getElementById('rChNum').textContent = 'Ch ' + (chIdx+1) + ' / ' + S.activeBook.chapters.length;
  document.getElementById('rChName').textContent = ch.title;
  showView('readerPanel');
  showGenOverlay('Opening Chapter', '"' + ch.title + '"', 'Extracting text...');
  try {
    const section = S.activeBook._epub.spine.get(ch.href);
    await section.load(S.activeBook._epub.load.bind(S.activeBook._epub));
    const doc = section.document;
    const rawText = doc ? (doc.body.innerText || doc.body.textContent) : '';
    const cleanText = rawText.replace(/\s+/g, ' ').trim();

    setGenStep('Checking analysis cache...');
    let segments = await getCachedSegments(S.activeBook.id, chIdx);

    if (!segments) {
      setGenStep('Analyzing with DeepSeek...');
      segments = await analyzeWithDeepSeek(cleanText, ch.title, chIdx);
      await cacheSegments(S.activeBook.id, chIdx, segments);
    } else {
      setGenStep('Loaded from cache');
    }

    setGenStep('Fetching voice pools...');
    await prefetchChapterVoices(segments);

    if (S.loadToken !== myToken) return;

    setGenStep('Rendering...');
    S.segments = segments;
    renderReaderPage(ch.title, segments, chIdx);
    hideGenOverlay();

    const savedWord = S.activeBook.chapterProgress?.[chIdx] || 0;
    S.currentWordIdx = Math.min(savedWord, Math.max(0, S.flatWords.length - 1));
    updateProgress();
    if (S.currentWordIdx > 0 && S.flatWords[S.currentWordIdx]) {
      S.flatWords[S.currentWordIdx].el.scrollIntoView({ block: 'center' });
    }

    // Background: identify unknowns + pre-analyze next chapter
    if (S.smartIdentify) identifyUnknownsInChapter(segments, chIdx).catch(() => {});
    preAnalyzeNextChapter(chIdx);

  } catch(e) {
    hideGenOverlay();
    toast('Error: ' + e.message);
    console.error(e);
  }
}

async function preAnalyzeNextChapter(chIdx) {
  const nextIdx = chIdx + 1;
  if (!S.activeBook || nextIdx >= S.activeBook.chapters.length) return;
  if (await getCachedSegments(S.activeBook.id, nextIdx)) return;
  await sleep(3000);
  try {
    const ch = S.activeBook.chapters[nextIdx];
    const section = S.activeBook._epub.spine.get(ch.href);
    await section.load(S.activeBook._epub.load.bind(S.activeBook._epub));
    const doc = section.document;
    const rawText = doc ? (doc.body.innerText || doc.body.textContent) : '';
    const segs = await analyzeWithDeepSeek(rawText.replace(/\s+/g, ' ').trim(), ch.title, nextIdx);
    await cacheSegments(S.activeBook.id, nextIdx, segs);
  } catch(e) {}
}

// ════════════════════════════════════════════════════════
// DEEPSEEK -- label-only, text preserved from EPUB
// ════════════════════════════════════════════════════════
function splitIntoSentences(text) {
  const raw = text.match(/[^.!?\n]+[.!?]+[\s"'」』]*|[^.!?\n]+[\n]+|[^.!?\n]+$/g) || [text];
  return raw.map(s => s.trim()).filter(s => s.length > 1);
}

async function analyzeWithDeepSeek(text, chapterTitle, chIdx) {
  const sentences = splitIntoSentences(text);
  if (!sentences.length) return fallbackSegments(text);

  const reg = getRegistry();
  const knownChars = Object.entries(reg)
    .filter(([,info]) => info.identified || info.voiceId)
    .map(([name, info]) => {
      const cap = name.split(' ').map(w => w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
      return cap + '=' + info.voiceType + (info.cadence ? '/'+info.cadence : '');
    }).join(', ');

  const SENTENCES_PER_CHUNK = 60;
  const chunks = [];
  for (let i = 0; i < sentences.length; i += SENTENCES_PER_CHUNK) {
    chunks.push(sentences.slice(i, i + SENTENCES_PER_CHUNK).map((s, j) => ({ idx: i+j, text: s })));
  }

  let allLabels = {};
  let priorPov = null;
  let priorCtx = '';

  for (let ci = 0; ci < chunks.length; ci++) {
    if (chunks.length > 1) setGenStep('Analyzing chunk ' + (ci+1) + '/' + chunks.length + '...');
    const chunk = chunks[ci];
    const prompt = buildPrompt(chapterTitle, chunk, knownChars, priorCtx, ci+1, chunks.length, priorPov);
    try {
      const res = await fetchRetry(WORKER + '/deepseek', {
        method: 'POST',
        headers: workerHeaders(),
        body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 4096, temperature: 0.0, messages: [{ role: 'user', content: prompt }] }),
        timeout: 120000,
      }, 2);
      if (!res.ok) throw new Error('DeepSeek ' + res.status);
      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content || '{}';
      const parsed = extractJSONFlexible(raw);
      if (parsed?.labels && Array.isArray(parsed.labels)) {
        for (const label of parsed.labels) {
          if (typeof label.i === 'number') {
            allLabels[label.i] = {
              type: label.type || 'narration',
              speaker: label.speaker || null,
              voice_type: label.voice_type || 'narrator',
            };
          }
        }
        if (parsed.pov?.pov_type) priorPov = parsed.pov;
        if (parsed.newCharacters?.length) silentlyRegisterCharacters(parsed.newCharacters, chIdx);
      }
      priorCtx = chunk[chunk.length-1]?.text?.slice(-150) || '';
    } catch(e) {
      console.error('DeepSeek chunk', ci, e);
    }
  }

  const pov = priorPov;
  return sentences.map((text, i) => {
    const label = allLabels[i];
    if (label) return { text, type: label.type, speaker: label.speaker, voice_type: label.voice_type || 'narrator' };
    const isFirstPerson = pov?.pov_type === 'first_person' || pov?.pov_type === 'third_limited';
    return {
      text,
      type: isFirstPerson ? 'inner_monologue' : 'narration',
      speaker: isFirstPerson ? (pov.pov_character || null) : null,
      voice_type: isFirstPerson ? 'inner_monologue' : 'narrator',
    };
  });
}

function buildPrompt(title, chunk, knownChars, priorCtx, chunkNum, total, priorPov) {
  const ctxNote = priorCtx ? '\nPrior context: "...' + priorCtx + '"' : '';
  const charNote = knownChars ? '\nKnown characters (use exact spelling + voice_type): ' + knownChars : '';
  const chunkNote = total > 1 ? ' (chunk ' + chunkNum + '/' + total + ')' : '';
  const povHint = priorPov ? '\nPrior chunk POV: ' + priorPov.pov_type + (priorPov.pov_character ? ' (' + priorPov.pov_character + ')' : '') : '';
  const numbered = chunk.map(({ idx, text }) => idx + ': ' + text.slice(0, 100) + (text.length > 100 ? '...' : '')).join('\n');

  return 'Label each numbered sentence for chapter: "' + title + '"' + chunkNote + ctxNote + charNote + povHint + '\n\n' +
    'STEP 1 - Detect this chapter\'s narrative POV:\n' +
    '- pov_type: "first_person" | "third_limited" | "third_omniscient"\n' +
    '- pov_character: name of POV character or null\n\n' +
    'STEP 2 - Label each sentence:\n' +
    '- Quoted dialogue ("..." or \u300c...\u300d) \u2192 type:"dialogue", speaker:character name, voice_type from known list or infer\n' +
    '- System/status \u3010...\u3011 or [...] \u2192 type:"system", speaker:null, voice_type:"system"\n' +
    '- POV prose (first_person/third_limited) \u2192 type:"inner_monologue", speaker:pov_character, voice_type:"inner_monologue"\n' +
    '- True 3rd omniscient prose \u2192 type:"narration", speaker:null, voice_type:"narrator"\n\n' +
    'VOICE TYPES: narrator|old_man|adult_man|young_man|teen_boy|old_woman|adult_woman|young_woman|teen_girl|child|inner_monologue|system\n\n' +
    'Return ONLY valid JSON:\n' +
    '{"pov":{"pov_type":"...","pov_character":"..." or null},"labels":[{"i":0,"type":"...","speaker":"..." or null,"voice_type":"..."},...], "newCharacters":[{"name":"...","voice_type":"..."}]}\n\n' +
    'No markdown. Label EVERY sentence index listed.\n\n' +
    'SENTENCES:\n' + numbered;
}

function fallbackSegments(text) {
  return (text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text])
    .map(s => ({ text: s.trim(), type: 'narration', speaker: null, voice_type: 'narrator' }))
    .filter(s => s.text.length > 2);
}

// ════════════════════════════════════════════════════════
// CHARACTER REGISTRY
// ════════════════════════════════════════════════════════
function getRegistry() {
  if (!S.activeBook) return {};
  if (!S.activeBook.characterRegistry) S.activeBook.characterRegistry = {};
  return S.activeBook.characterRegistry;
}

function normalizeName(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
}

// Returns true if the name looks like a real proper name (not a generic descriptor).
// Generic = instantly side character unless they appear very frequently.
const GENERIC_DESCRIPTORS = new Set([
  'man','woman','boy','girl','child','person','figure','shadow','voice','stranger',
  'guard','soldier','knight','warrior','mage','hunter','adventurer','merchant',
  'servant','receptionist','clerk','citizen','villager','elder','doctor','nurse',
  'officer','captain','commander','leader','boss','chief','king','queen','lord',
  'lady','master','teacher','student','priest','monk','noble','attendant','aide',
  'assistant','manager','director','agent','spy','assassin','thief','bandit','monster',
  'creature','beast','demon','spirit','god','hero','villain','ally','enemy','rival',
  'old man','old woman','young man','young woman','middle aged man','middle aged woman',
  'unnamed','unknown','???','nameless','the narrator','narrator',
]);

function isGenericName(name) {
  const lower = name.toLowerCase().trim();
  // Exact match against generic list
  if (GENERIC_DESCRIPTORS.has(lower)) return true;
  // Starts with a generic word followed by a number or letter (e.g. "guard a", "soldier 1")
  for (const g of GENERIC_DESCRIPTORS) {
    if (lower === g || lower.startsWith(g + ' ') || lower.endsWith(' ' + g)) return true;
  }
  return false;
}

// Named characters are always main candidates.
// Unnamed/generic characters need 5+ chapter appearances to qualify as main.
function classifyAsMain(name, appearanceCount = null) {
  if (!isGenericName(name)) {
    // Named character: if we have count data (bible), need 2+ appearances.
    // Real-time registration (no count) -> assume main for now.
    return appearanceCount === null || appearanceCount >= 2;
  }
  // Unnamed/generic: must appear in 5+ chapters to be story-critical
  return (appearanceCount ?? 0) >= 5;
}


function findInRegistry(reg, rawName) {
  const norm = normalizeName(rawName);
  if (reg[norm]) return { key: norm, entry: reg[norm] };
  for (const [key, entry] of Object.entries(reg)) {
    if (norm.includes(key) || key.includes(norm)) return { key, entry };
  }
  return null;
}

function getVoiceId(voiceType, speakerName) {
  if (S.activeBook?.voiceMap?.[voiceType]) return S.activeBook.voiceMap[voiceType];
  if (S.customVoices[voiceType]) return S.customVoices[voiceType];
  const pool = voicePools[voiceType] || [];
  // NEVER assign a voice if the correct pool is empty
  if (!pool.length) return null;

  if (speakerName) {
    const reg = getRegistry();
    const found = findInRegistry(reg, speakerName);
    if (found) {
      found.entry.lastUsed = Date.now();
      // Verify voice is from correct pool -- if not, reassign
      if (!pool.includes(found.entry.voiceId)) {
        const usedIds = new Set(Object.values(reg).filter(e => e.voiceType === voiceType && pool.includes(e.voiceId)).map(e => e.voiceId));
        found.entry.voiceId = pool.find(id => !usedIds.has(id)) || pool[0];
        saveLocal();
      }
      return found.entry.voiceId;
    }

    const norm = normalizeName(speakerName);
    const regEntries = Object.entries(reg);
    // CRITICAL: only count voices from THIS type when checking pool exhaustion
    const usedVoiceIds = new Set(regEntries.filter(([,e]) => e.voiceType === voiceType).map(([,e]) => e.voiceId));
    let assignedId = null;

    if (usedVoiceIds.size < pool.length) {
      assignedId = pool.find(id => !usedVoiceIds.has(id));
    } else {
      // LRU -- pick voice whose owner was least recently heard, from same type
      const byLRU = regEntries
        .filter(([,e]) => e.voiceType === voiceType)
        .sort((a, b) => (a[1].lastUsed||0) - (b[1].lastUsed||0));
      assignedId = byLRU.length ? byLRU[0][1].voiceId : pool[0];
    }

    if (assignedId) {
      const keys = Object.keys(reg);
      if (keys.length >= REGISTRY_MAX_SIZE) {
        const oldest = Object.entries(reg).filter(([,e]) => !e.isMain).sort((a,b) => (a[1].lastUsed||0)-(b[1].lastUsed||0))[0];
        if (oldest) delete reg[oldest[0]];
      }
      reg[norm] = { voiceId: assignedId, voiceType, isMain: classifyAsMain(norm, null), firstChapter: S.activeChIdx || 0, lastUsed: Date.now() };
      saveLocal();
    }
    return assignedId;
  }

  return pool[0] || null;
}

// ════════════════════════════════════════════════════════
// VOICE POOLS -- fetch on startup, fix misassigned on load
// ════════════════════════════════════════════════════════
async function prefetchAllVoicePools() {
  const types = Object.keys(VOICE_TYPES);
  const missing = types.filter(t => (voicePools[t]?.length || 0) < 3);
  if (!missing.length) { fixMisassignedVoices(); return; }
  // Stagger requests 300ms apart to avoid hammering API
  for (const type of missing) {
    await fetchVoicePool(type);
    await sleep(300);
  }
  fixMisassignedVoices();
}

function fixMisassignedVoices() {
  let fixed = 0;
  for (const book of S.books) {
    const reg = book.characterRegistry || {};
    for (const [name, entry] of Object.entries(reg)) {
      const pool = voicePools[entry.voiceType];
      if (!pool?.length) continue;
      if (!pool.includes(entry.voiceId)) {
        const usedIds = new Set(Object.values(reg).filter(e => e.voiceType === entry.voiceType && pool.includes(e.voiceId)).map(e => e.voiceId));
        entry.voiceId = pool.find(id => !usedIds.has(id)) || pool[0];
        entry.identified = true;
        fixed++;
      }
    }
  }
  if (fixed > 0) {
    console.log('Fixed', fixed, 'misassigned voices');
    saveLocal();
    if (S.activeBook) clearAudioBuffer();
  }
}

async function fetchVoicePool(voiceType) {
  if ((voicePools[voiceType]?.length || 0) >= 5) return;
  if (S.poolFetchPromises[voiceType]) return S.poolFetchPromises[voiceType];
  const p = (async () => {
    const queries = VOICE_TYPES[voiceType]?.queries || ['narrator'];
    const collected = [];
    const seen = new Set();
    for (const q of queries) {
      if (collected.length >= 5) break;
      try {
        const url = WORKER + '/fish/model?page_size=10&page_number=1&language=en&sort_by=score&title=' + encodeURIComponent(q);
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        for (const item of (data.items || [])) {
          if (item._id && !seen.has(item._id)) {
            seen.add(item._id);
            collected.push(item._id);
          }
        }
      } catch(e) { console.warn('Voice query failed', voiceType, q, e); }
    }
    if (collected.length) {
      voicePools[voiceType] = collected;
      saveLocal();
      console.log('Voice pool for', voiceType, ':', collected.length, 'voices');
    } else {
      console.warn('No voices found for', voiceType);
    }
  })();
  S.poolFetchPromises[voiceType] = p;
  try { await p; } finally { delete S.poolFetchPromises[voiceType]; }
}

async function prefetchChapterVoices(segments) {
  const needed = [...new Set(segments.map(s => s.voice_type || 'narrator'))];
  const missing = needed.filter(t => (voicePools[t]?.length || 0) < 3 && !S.customVoices[t]);
  if (missing.length) await Promise.all(missing.map(t => fetchVoicePool(t)));
  // IMPORTANT: never fall back narrator pool for other types
  // If pool still empty after fetch, leave it empty -- getVoiceId returns null
  // and Fish Audio uses its own default voice (better than wrong gender)
  renderVoiceList();
}

// ════════════════════════════════════════════════════════
// TTS
// ════════════════════════════════════════════════════════
function splitForTTS(text) {
  if (text.length <= TTS_CHUNK_LIMIT) return [text];
  const chunks = [];
  const sentences = text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [text];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > TTS_CHUNK_LIMIT && current) { chunks.push(current.trim()); current = s; }
    else current += s;
    while (current.length > TTS_CHUNK_LIMIT) {
      const cut = current.lastIndexOf(' ', TTS_CHUNK_LIMIT);
      const splitAt = cut > 0 ? cut : TTS_CHUNK_LIMIT;
      chunks.push(current.slice(0, splitAt).trim());
      current = current.slice(splitAt).trim();
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function fishTTS(text, voiceId, signal) {
  const chunks = splitForTTS(text);
  if (chunks.length === 1) return fishTTSSingle(chunks[0], voiceId, signal);
  const blobs = await Promise.all(chunks.map(c => fishTTSSingle(c, voiceId, signal)));
  return new Blob(blobs, { type: 'audio/mpeg' });
}

async function fishTTSSingle(text, voiceId, signal) {
  const body = { text, format: 'mp3', mp3_bitrate: 128, latency: 'balanced' };
  if (voiceId) body.reference_id = voiceId;
  const res = await fetchRetry(WORKER + '/fish/tts', {
    method: 'POST', headers: workerHeaders(), body: JSON.stringify(body), signal,
  });
  if (!res.ok) throw new Error('Fish Audio ' + res.status);
  return res.blob();
}

async function whisperAlign(audioBlob, expectedWordCount, signal) {
  try {
    const form = new FormData();
    form.append('file', audioBlob, 'audio.mp3');
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    const res = await fetchRetry(WORKER + '/whisper', { method: 'POST', body: form, signal, timeout: 90000 }, 2);
    if (!res.ok) return null;
    const data = await res.json();
    const words = data.words || null;
    if (!words?.length) return null;
    if (expectedWordCount && Math.abs(words.length - expectedWordCount) > 2) {
      const totalDur = words[words.length-1].end || 1;
      const evenSplit = totalDur / expectedWordCount;
      return Array.from({ length: expectedWordCount }, (_, i) => ({ start: i*evenSplit, end: (i+1)*evenSplit }));
    }
    return words;
  } catch(e) { return null; }
}

// ════════════════════════════════════════════════════════
// AUDIO BUFFER
// ════════════════════════════════════════════════════════
function clearAudioBuffer() {
  S.bufferToken++;
  Object.values(S.audioBuffer).forEach(item => {
    if (item.ctrl) try { item.ctrl.abort(); } catch(e){}
    if (item.url) URL.revokeObjectURL(item.url);
  });
  S.audioBuffer = {};
}

async function bufferSegment(segIdx) {
  if (S.audioBuffer[segIdx] !== undefined) return;
  if (segIdx >= S.segments.length) return;
  const myToken = S.bufferToken;
  const ctrl = new AbortController();
  S.audioBuffer[segIdx] = { loading: true, ctrl };
  const seg = S.segments[segIdx];
  if (!seg?.text?.trim()) { if (S.bufferToken === myToken) S.audioBuffer[segIdx] = { empty: true }; return; }
  const segWords = S.flatWords.filter(w => w.segIdx === segIdx);
  if (!segWords.length) { if (S.bufferToken === myToken) S.audioBuffer[segIdx] = { empty: true }; return; }
  const text = segWords.map(w => w.el.textContent.trim()).join(' ');
  // For inner_monologue, use the character's own registered voiceType (e.g. young_man for Kim Dokja)
  // so their inner thoughts sound like them, not a generic monologue pool voice
  let effectiveVoiceType = seg.voice_type || 'narrator';
  if (effectiveVoiceType === 'inner_monologue' && seg.speaker) {
    const reg = getRegistry();
    const found = findInRegistry(reg, seg.speaker);
    if (found && found.entry.voiceType && found.entry.voiceType !== 'inner_monologue') {
      effectiveVoiceType = found.entry.voiceType;
    }
  }
  const voiceId = getVoiceId(effectiveVoiceType, seg.speaker || null);
  try {
    const blob = await fishTTS(text, voiceId, ctrl.signal);
    if (S.bufferToken !== myToken) return;
    const timings = await whisperAlign(blob, segWords.length, ctrl.signal);
    if (S.bufferToken !== myToken) return;
    const url = URL.createObjectURL(blob);
    S.audioBuffer[segIdx] = { blob, timings, url, words: segWords };
  } catch(e) {
    if (S.bufferToken !== myToken) return;
    if (e.name !== 'AbortError') { S.audioBuffer[segIdx] = { error: e.message }; console.warn('Buffer error seg', segIdx, e.message); }
  }
}

function kickBuffering(fromSegIdx) {
  for (let i = fromSegIdx; i < Math.min(fromSegIdx + AUDIO_BUFFER_AHEAD + 1, S.segments.length); i++) {
    if (S.audioBuffer[i] === undefined) bufferSegment(i);
  }
}

// ════════════════════════════════════════════════════════
// RENDER PAGE
// ════════════════════════════════════════════════════════
function renderReaderPage(title, segments, chIdx) {
  const page = document.getElementById('readerPage');
  page.innerHTML = '';
  S.flatWords = [];
  if (chIdx > 0) {
    const sep = document.createElement('div');
    sep.className = 'chsep';
    sep.innerHTML = '<div class="chsepl"></div><div class="chsept">'+title+'</div><div class="chsepl"></div>';
    page.appendChild(sep);
  } else {
    const h = document.createElement('div');
    h.className = 'rchtit';
    h.textContent = title;
    page.appendChild(h);
  }
  let lastSpeaker = null;
  segments.forEach((seg, sIdx) => {
    if (!seg.text?.trim()) return;
    const isSystem = seg.type === 'system' || seg.voice_type === 'system';
    const isMonologue = seg.type === 'inner_monologue' || seg.voice_type === 'inner_monologue';
    const isDialogue = seg.type === 'dialogue';
    const speaker = seg.speaker;
    if (isDialogue && speaker && speaker !== lastSpeaker) {
      const label = document.createElement('div');
      label.className = 'splbl';
      label.textContent = speaker;
      page.appendChild(label);
      lastSpeaker = speaker;
    } else if (!isDialogue) { lastSpeaker = null; }
    if (isSystem) {
      const box = document.createElement('div');
      box.className = 'sysbox';
      appendWords(box, seg.text, sIdx);
      page.appendChild(box);
    } else {
      const wrap = document.createElement('span');
      wrap.className = 'seg-wrap' + (isMonologue ? ' monologue' : '') + (isDialogue ? ' dialogue-seg' : '');
      appendWords(wrap, seg.text, sIdx, isMonologue);
      page.appendChild(wrap);
      page.appendChild(document.createTextNode(' '));
    }
  });
  const end = document.createElement('div');
  end.className = 'chend';
  const nextCh = S.activeBook?.chapters?.[chIdx+1];
  end.innerHTML = nextCh
    ? '<div class="chendl"></div><div class="chendt">End of Chapter '+(chIdx+1)+'</div><div class="chendn" onclick="loadChapter('+(chIdx+1)+')">Next: '+nextCh.title+' \u2192</div>'
    : '<div class="chendl"></div><div class="chendt">End of Book</div>';
  page.appendChild(end);
}

function appendWords(container, text, sIdx, isMonologue) {
  text.split(/\s+/).filter(w => w).forEach(word => {
    const span = document.createElement('span');
    span.className = 'w' + (isMonologue ? ' monologue' : '');
    const flatIdx = S.flatWords.length;
    span.textContent = word + ' ';
    span.onclick = () => jumpToWord(flatIdx);
    S.flatWords.push({ el: span, segIdx: sIdx, seg: S.segments[sIdx] });
    container.appendChild(span);
  });
}

function jumpToWord(flatIdx) { stopPlayback(); clearAudioBuffer(); S.currentWordIdx = flatIdx; updateWordHighlight(); }

// ════════════════════════════════════════════════════════
// PLAYBACK
// ════════════════════════════════════════════════════════
function togglePlay() { S.isPlaying ? pausePlayback() : startPlayback(); }

function startPlayback() {
  if (S.currentWordIdx >= S.flatWords.length) return;
  S.isPlaying = true;
  document.getElementById('playBtn').textContent = '\u23f8';
  if (window.AudioContext || window.webkitAudioContext) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume().then(() => ctx.close()).catch(() => {});
  }
  kickBuffering(S.flatWords[S.currentWordIdx]?.segIdx ?? 0);
  playFromCurrentWord();
}

function pausePlayback() {
  S.isPlaying = false;
  document.getElementById('playBtn').textContent = '\u25b6';
  if (S.audio) S.audio.pause();
  cancelAnimationFrame(S.animFrame);
}

function stopPlayback() {
  pausePlayback();
  if (S.audio) { try { S.audio.src = ''; } catch(e){} S.audio = null; }
  S.wordTimings = [];
}

async function playFromCurrentWord() {
  if (!S.isPlaying || S.currentWordIdx >= S.flatWords.length) { pausePlayback(); return; }
  const segIdx = S.flatWords[S.currentWordIdx].segIdx;
  kickBuffering(segIdx);
  let waited = 0;
  while (S.audioBuffer[segIdx]?.loading && waited < 20000) { await sleep(100); waited += 100; if (!S.isPlaying) return; }
  const buf = S.audioBuffer[segIdx];
  if (!buf || buf.error || buf.empty) { advanceToNextSegment(segIdx); if (S.isPlaying) playFromCurrentWord(); return; }
  const { url, timings, words: segWords } = buf;
  if (!url) { advanceToNextSegment(segIdx); if (S.isPlaying) playFromCurrentWord(); return; }
  S.audio = new Audio(url);
  S.audio.playbackRate = S.speed;
  const relevantWords = segWords.filter(w => S.flatWords.indexOf(w) >= S.currentWordIdx);
  S.wordTimings = relevantWords.map((w, i) => ({
    el: w.el,
    start: timings?.[i]?.start ?? 0,
    end: timings?.[i]?.end ?? 1,
    approx: !timings,
  }));
  S.audio.play().catch(err => { toast('Tap play again to start audio'); pausePlayback(); });
  animateWords();
  S.audio.onended = () => {
    cancelAnimationFrame(S.animFrame);
    relevantWords.forEach(w => { w.el.classList.remove('active'); w.el.classList.add('past'); });
    URL.revokeObjectURL(url);
    delete S.audioBuffer[segIdx];
    advanceToNextSegment(segIdx);
    saveProgress();
    if (S.isPlaying && S.currentWordIdx < S.flatWords.length) playFromCurrentWord();
    else pausePlayback();
  };
  S.audio.onerror = () => { delete S.audioBuffer[segIdx]; setTimeout(() => { if (S.isPlaying) playFromCurrentWord(); }, 1000); };
}

function advanceToNextSegment(segIdx) {
  const next = segIdx + 1;
  if (next < S.segments.length) { const ni = S.flatWords.findIndex(w => w.segIdx === next); S.currentWordIdx = ni >= 0 ? ni : S.flatWords.length; }
  else S.currentWordIdx = S.flatWords.length;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ════════════════════════════════════════════════════════
// FETCH HELPERS
// ════════════════════════════════════════════════════════
async function fetchRetry(url, opts = {}, retries = FETCH_RETRIES) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), opts.timeout || 60000);
      const res = await fetch(url, { ...opts, signal: opts.signal || ctrl.signal });
      clearTimeout(tid);
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res;
      lastErr = new Error('HTTP ' + res.status);
    } catch(e) {
      lastErr = e;
      if (e.name === 'AbortError' && opts.signal?.aborted) throw e;
    }
    if (i < retries-1) await sleep(FETCH_RETRY_DELAY * (i+1));
  }
  throw lastErr;
}

function extractJSONFlexible(raw) {
  if (!raw) return null;
  raw = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(raw); } catch(e) {}
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']';
    const startIdx = raw.indexOf(open);
    if (startIdx === -1) continue;
    let depth = 0;
    for (let i = startIdx; i < raw.length; i++) {
      if (raw[i] === open) depth++;
      else if (raw[i] === close) { depth--; if (depth === 0) { try { return JSON.parse(raw.slice(startIdx, i+1)); } catch(e) { break; } } }
    }
  }
  return null;
}

function animateWords() {
  if (!S.audio || !S.isPlaying) return;
  const progress = S.audio.currentTime / (S.audio.duration || 1);
  let activeIdx = 0;
  for (let i = 0; i < S.wordTimings.length; i++) {
    const start = S.wordTimings[i].approx ? S.wordTimings[i].start : S.wordTimings[i].start / (S.audio.duration || 1);
    if (start <= progress) activeIdx = i; else break;
  }
  S.wordTimings.forEach((wt, i) => {
    wt.el.classList.toggle('active', i === activeIdx);
    wt.el.classList.toggle('past', i < activeIdx);
  });
  const activeEl = S.wordTimings[activeIdx]?.el;
  if (activeEl) {
    const rect = activeEl.getBoundingClientRect();
    const body = document.getElementById('readerBody');
    const br = body.getBoundingClientRect();
    if (rect.top < br.top + 100 || rect.bottom > br.bottom - 100) activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  const wi = S.flatWords.findIndex(w => w.el === S.wordTimings[activeIdx]?.el);
  if (wi >= 0) S.currentWordIdx = wi;
  updateProgressBar(S.currentWordIdx / Math.max(S.flatWords.length, 1));
  S.animFrame = requestAnimationFrame(animateWords);
}

function updateWordHighlight() {
  S.flatWords.forEach((w, i) => { w.el.classList.toggle('active', i === S.currentWordIdx); w.el.classList.toggle('past', i < S.currentWordIdx); });
  updateProgress();
}

// ════════════════════════════════════════════════════════
// CHARACTER IDENTIFICATION (OPTION A)
// ════════════════════════════════════════════════════════
const _idInFlight = {};

async function lookAheadIdentify(name, fromChIdx, maxChapters = 3) {
  if (!S.activeBook || !name) return null;
  const norm = normalizeName(name);
  if (_idInFlight[norm]) return _idInFlight[norm];
  const promise = (async () => {
    try {
      const sampleSentences = [];
      const nameRegex = new RegExp('\\b' + name.split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      for (let ci = fromChIdx; ci < Math.min(fromChIdx + maxChapters, S.activeBook.chapters.length); ci++) {
        if (sampleSentences.length > 15) break;
        try {
          const ch = S.activeBook.chapters[ci];
          const section = S.activeBook._epub.spine.get(ch.href);
          await section.load(S.activeBook._epub.load.bind(S.activeBook._epub));
          const doc = section.document;
          const text = doc ? (doc.body.innerText || doc.body.textContent) : '';
          for (const s of (text.match(/[^.!?]+[.!?]+/g) || [])) {
            if (nameRegex.test(s)) { sampleSentences.push(s.trim()); if (sampleSentences.length > 15) break; }
          }
        } catch(e) {}
      }
      if (!sampleSentences.length) return null;
      const prompt = 'These sentences mention a character named "' + name + '". From pronouns and descriptive language ONLY, identify their voice characteristics.\n\nReturn ONLY a JSON object: {"gender": "male"|"female"|"unknown", "age": "child"|"teen"|"young_adult"|"adult"|"old", "cadence": "soft"|"sharp"|"loud"|"deep"|"gruff"|"smooth"|"high"|"cold"|null}\n\nUse null where unclear. Do NOT include plot or story details.\n\nSentences:\n' + sampleSentences.map((s, i) => (i+1)+'. '+s.replace(/[\r\n]+/g, ' ')).join('\n');
      const res = await fetchRetry(WORKER + '/deepseek', {
        method: 'POST', headers: workerHeaders(),
        body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 200, temperature: 0.0, messages: [{ role: 'user', content: prompt }] }),
        timeout: 60000,
      }, 2);
      if (!res.ok) return null;
      const data = await res.json();
      const parsed = extractJSONFlexible(data.choices?.[0]?.message?.content || '{}');
      if (!parsed || parsed.gender === 'unknown' || !parsed.gender) return null;
      return mapIdentityToVoiceType(parsed);
    } catch(e) { return null; }
    finally { delete _idInFlight[norm]; }
  })();
  _idInFlight[norm] = promise;
  return promise;
}

function mapIdentityToVoiceType({ gender, age, tone, energy, speech, cadence }) {
  // Determine the base voice pool (for fallback only)
  let voiceType = 'narrator';
  if (gender === 'male') {
    if (age === 'child') voiceType = 'child';
    else if (age === 'teen') voiceType = 'teen_boy';
    else if (age === 'young_adult') voiceType = 'young_man';
    else if (age === 'old') voiceType = 'old_man';
    else voiceType = 'adult_man';
  } else if (gender === 'female') {
    if (age === 'child') voiceType = 'child';
    else if (age === 'teen') voiceType = 'teen_girl';
    else if (age === 'young_adult') voiceType = 'young_woman';
    else if (age === 'old') voiceType = 'old_woman';
    else voiceType = 'adult_woman';
  }
  return { voiceType, tone: tone || cadence || null, energy: energy || null, speech: speech || null };
}

// Build a descriptive Fish Audio search query from personality traits
// e.g. { gender:'male', age:'young_adult', tone:'sardonic', energy:'low' } → "tired sarcastic young man"
function buildPersonalityQuery({ gender, age, tone, energy, speech }) {
  const genderWord = gender === 'female' ? 'woman' : 'man';
  const ageMap = { child: 'child', teen: 'teenage', young_adult: 'young', adult: 'adult', old: 'elderly' };
  const ageWord = ageMap[age] || 'adult';

  // Tone → descriptive adjectives
  const toneMap = {
    sardonic: 'dry sarcastic', dry: 'dry sarcastic', deadpan: 'dry deadpan',
    warm: 'warm friendly', cheerful: 'cheerful upbeat', bright: 'bright cheerful',
    cold: 'cold detached', stoic: 'stoic calm', flat: 'flat monotone',
    gruff: 'gruff rough', harsh: 'harsh gruff', intense: 'intense dramatic',
    soft: 'soft gentle', gentle: 'soft gentle', quiet: 'quiet soft',
    tired: 'tired weary', weary: 'tired weary', exhausted: 'exhausted weary',
    sharp: 'sharp crisp', formal: 'formal measured', smooth: 'smooth calm',
    deep: 'deep resonant', high: 'high light',
  };
  const toneWords = toneMap[tone] || '';

  // Low energy → add weary/quiet modifier unless tone already covers it
  const energyWords = (energy === 'low' && !toneWords.includes('tired') && !toneWords.includes('weary') && !toneWords.includes('quiet'))
    ? 'quiet' : '';

  const parts = [toneWords, energyWords, ageWord, genderWord].filter(Boolean);
  return [...new Set(parts)].join(' '); // dedupe, e.g. "dry sarcastic young man"
}

// Search Fish Audio directly with a personality query, return a voice ID or null
async function fetchPersonalityVoice(identity, fallbackVoiceType) {
  const query = buildPersonalityQuery(identity);
  if (!query) return null;
  try {
    const url = WORKER + '/fish/model?page_size=8&page_number=1&language=en&sort_by=score&title=' + encodeURIComponent(query);
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.items || [];
    if (!items.length) return null;
    // Pick the top result that isn't already in use by another character
    const reg = getRegistry();
    const used = new Set(Object.values(reg).map(e => e.voiceId));
    const fresh = items.find(it => it._id && !used.has(it._id));
    return (fresh || items[0])?._id || null;
  } catch(e) {
    console.warn('fetchPersonalityVoice failed for query:', buildPersonalityQuery(identity), e);
    return null;
  }
}

async function identifyUnknownsInChapter(segments, chIdx) {
  const reg = getRegistry();
  const unknownNames = new Set();
  for (const seg of segments) {
    if (!seg.speaker) continue;
    const norm = normalizeName(seg.speaker);
    const existing = reg[norm];
    if (!existing || (!existing.identified && (seg.voice_type === 'narrator' || seg.voice_type === 'unknown'))) {
      unknownNames.add(seg.speaker);
    }
  }
  if (!unknownNames.size) return;
  const names = [...unknownNames];
  for (let i = 0; i < names.length; i += 5) {
    await Promise.all(names.slice(i, i+5).map(async name => {
      if (!S.smartIdentify) return;
      const result = await lookAheadIdentify(name, chIdx);
      if (result) {
        const norm = normalizeName(name);
        const pool = voicePools[result.voiceType] || [];
        if (!pool.length) return;
        const usedIds = new Set(Object.values(reg).filter(e => e.voiceType === result.voiceType).map(v => v.voiceId));
        const voiceId = pool.find(id => !usedIds.has(id)) || pool[0];
        if (voiceId) {
          reg[norm] = { voiceId, voiceType: result.voiceType, tone: result.tone, energy: result.energy, isMain: classifyAsMain(norm, null), identified: true, firstChapter: chIdx, lastUsed: Date.now() };
          for (const seg of segments) {
            if (seg.speaker && normalizeName(seg.speaker) === norm) seg.voice_type = result.voiceType;
          }
          saveLocal();
          console.log('Identified', name, '->', result.voiceType, result.cadence ? '('+result.cadence+')' : '');
        }
      }
    }));
  }
}

function silentlyRegisterCharacters(newChars) {
  if (!S.activeBook) return;
  const reg = getRegistry();
  for (const c of newChars) {
    if (!c?.name || !c?.voice_type) continue;
    const norm = normalizeName(c.name);
    if (!norm || reg[norm]) continue;
    const pool = voicePools[c.voice_type] || [];
    // Never fall back to narrator pool -- skip if correct pool not ready
    if (!pool.length) continue;
    const mainVoiceIds = new Set(Object.values(reg).filter(e => e.isMain).map(e => e.voiceId));
    const usedIds = new Set(Object.values(reg).filter(e => e.voiceType === c.voice_type).map(v => v.voiceId));
    const voiceId = pool.find(id => !usedIds.has(id) && !mainVoiceIds.has(id)) || pool.find(id => !usedIds.has(id)) || pool[0];
    reg[norm] = { voiceId, voiceType: c.voice_type, isMain: classifyAsMain(norm, null), firstChapter: chIdx, lastUsed: 0 };
  }
  saveLocal();
}

// ════════════════════════════════════════════════════════
// CHARACTER BIBLE (OPTION C)
// ════════════════════════════════════════════════════════
async function buildCharacterBible(progressCb) {
  if (!S.activeBook?._epub) return false;
  const chapters = S.activeBook.chapters;
  const reg = getRegistry();
  if (!chapters.length) return false;
  const SAMPLE_COUNT = Math.min(20, chapters.length);
  const step = Math.max(1, Math.floor(chapters.length / SAMPLE_COUNT));
  const samples = [];
  if (progressCb) progressCb({ phase: 'Sampling chapters', pct: 0 });
  for (let i = 0; i < chapters.length; i += step) {
    if (samples.length >= SAMPLE_COUNT) break;
    try {
      const section = S.activeBook._epub.spine.get(chapters[i].href);
      await section.load(S.activeBook._epub.load.bind(S.activeBook._epub));
      const doc = section.document;
      const text = doc ? (doc.body.innerText || doc.body.textContent) : '';
      samples.push(text.slice(0, 3000).replace(/\s+/g, ' ').trim());
    } catch(e) {}
    if (progressCb) progressCb({ phase: 'Sampling chapters', pct: (i/chapters.length)*30 });
  }
  if (!samples.length) return false;
  const allDiscovered = {};
  for (let si = 0; si < samples.length; si++) {
    if (progressCb) progressCb({ phase: 'Identifying characters', pct: 30 + (si/samples.length)*60 });
    const prompt = 'Identify named characters in this text. Return ONLY a JSON array with one object per character:\n[{"name":"...","gender":"male"|"female"|"unknown","age":"child"|"teen"|"young_adult"|"adult"|"old","tone":"sardonic"|"dry"|"warm"|"cold"|"cheerful"|"gruff"|"soft"|"tired"|"intense"|"stoic"|"sharp"|"gentle"|"formal"|"smooth"|null,"energy":"high"|"medium"|"low"|null,"speech":"terse"|"verbose"|"casual"|"formal"|null}]\nRules: Skip characters whose gender is unknown. Base tone/energy on HOW they speak, not what happens to them. Do NOT include plot details.\nTEXT:\n' + samples[si];
    try {
      const res = await fetchRetry(WORKER + '/deepseek', {
        method: 'POST', headers: workerHeaders(),
        body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 1200, temperature: 0.0, messages: [{ role: 'user', content: prompt }] }),
        timeout: 90000,
      }, 2);
      if (!res.ok) continue;
      const data = await res.json();
      const list = extractJSONFlexible(data.choices?.[0]?.message?.content || '[]');
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        if (!c?.name || c.gender === 'unknown' || !c.gender) continue;
        const norm = normalizeName(c.name);
        if (!norm) continue;
        const mapped = mapIdentityToVoiceType(c);
        if (!allDiscovered[norm]) allDiscovered[norm] = { name: c.name, ...mapped, count: 1 };
        else { allDiscovered[norm].count++; if (mapped.cadence && !allDiscovered[norm].cadence) allDiscovered[norm].cadence = mapped.cadence; }
      }
    } catch(e) {}
  }
  if (progressCb) progressCb({ phase: 'Assigning voices', pct: 90 });
  // Named chars first (best voices), then unnamed sorted by frequency
  const bibleEntries = Object.entries(allDiscovered).sort((a, b) => {
    const aMain = classifyAsMain(a[0], a[1].count);
    const bMain = classifyAsMain(b[0], b[1].count);
    if (aMain !== bMain) return bMain ? 1 : -1;
    return b[1].count - a[1].count;
  });
  for (let ei = 0; ei < bibleEntries.length; ei++) {
    const [norm, info] = bibleEntries[ei];
    if (reg[norm]?.identified) continue;
    if (progressCb) progressCb({ phase: 'Finding voice for ' + info.name, pct: 90 + (ei / bibleEntries.length) * 9 });
    const isMain = classifyAsMain(norm, info.count);
    let voiceId = await fetchPersonalityVoice(info, info.voiceType);
    if (!voiceId) {
      const pool = voicePools[info.voiceType] || [];
      if (!pool.length) continue;
      const mainVoiceIds = new Set(Object.values(reg).filter(e => e.isMain).map(e => e.voiceId));
      const usedIds = new Set(Object.values(reg).filter(e => e.voiceType === info.voiceType).map(v => v.voiceId));
      voiceId = (isMain
        ? pool.find(id => !usedIds.has(id))
        : pool.find(id => !usedIds.has(id) && !mainVoiceIds.has(id)) || pool.find(id => !usedIds.has(id))
      ) || pool[Object.keys(reg).length % pool.length];
    }
    if (voiceId) {
      reg[norm] = {
        voiceId, voiceType: info.voiceType, tone: info.tone, energy: info.energy,
        isMain, firstChapter: info.firstChapter ?? 0, identified: true, lastUsed: 0
      };
      console.log('Bible:', info.name, isMain ? '[MAIN]' : '[SIDE]', '->', buildPersonalityQuery(info), '| voice:', voiceId);
    }
  }
  saveLocal();
  saveSyncToDrive();
  if (progressCb) progressCb({ phase: 'Complete', pct: 100 });
  return Object.keys(allDiscovered).length;
}

// ════════════════════════════════════════════════════════
// SPEED + NAV
// ════════════════════════════════════════════════════════
function slowDown() { S.speedIdx = Math.max(0, S.speedIdx-1); S.speed = S.speeds[S.speedIdx]; if (S.audio) S.audio.playbackRate = S.speed; document.getElementById('speedLabel').textContent = S.speed + '\xd7'; }
function speedUp() { S.speedIdx = Math.min(S.speeds.length-1, S.speedIdx+1); S.speed = S.speeds[S.speedIdx]; if (S.audio) S.audio.playbackRate = S.speed; document.getElementById('speedLabel').textContent = S.speed + '\xd7'; }
function prevChapter() { if (S.activeChIdx > 0) loadChapter(S.activeChIdx-1); }
function nextChapter() { if (S.activeBook && S.activeChIdx < S.activeBook.chapters.length-1) loadChapter(S.activeChIdx+1); }

function seekProgress(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  jumpToWord(Math.floor(Math.max(0, Math.min(1, (e.clientX-rect.left)/rect.width)) * S.flatWords.length));
}

function saveProgress() {
  if (!S.activeBook) return;
  S.activeBook.progress = S.flatWords.length ? (S.currentWordIdx/S.flatWords.length)*100 : 0;
  if (!S.activeBook.chapterProgress) S.activeBook.chapterProgress = {};
  S.activeBook.chapterProgress[S.activeChIdx] = S.currentWordIdx;
  saveSyncToDrive();
}

function updateProgress() { updateProgressBar(S.flatWords.length ? S.currentWordIdx/S.flatWords.length : 0); }
function updateProgressBar(pct) {
  document.getElementById('progFill').style.width = (pct*100).toFixed(1)+'%';
  document.getElementById('progPct').textContent = (pct*100).toFixed(0)+'%';
}

// ════════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════════
function openSettings() { renderVoiceList(); document.getElementById('settingsPanel').classList.add('open'); document.getElementById('panelBackdrop').classList.add('open'); }
function closeSettings() { document.getElementById('settingsPanel').classList.remove('open'); document.getElementById('panelBackdrop').classList.remove('open'); saveLocal(); }
function setFontSize(v) { document.documentElement.style.setProperty('--font-size', v+'px'); document.getElementById('fontVal').textContent = v; }
function setLineHeight(v) { const lh=(v/10).toFixed(1); document.documentElement.style.setProperty('--line-height', lh); document.getElementById('lineVal').textContent = lh; }

// ════════════════════════════════════════════════════════
// VOICE SAMPLING + PICKER
// ════════════════════════════════════════════════════════
const SAMPLE_PHRASES = {
  narrator:        "In the beginning, there was only silence, and the weight of what was to come.",
  young_man:       "I didn't ask for any of this. Just tell me what you need from me.",
  adult_man:       "Understood. I'll handle it. Don't worry about the details.",
  old_man:         "I've seen this before, long ago. Listen carefully — it matters.",
  teen_boy:        "Wait — seriously? You want me to do that? Right now?",
  young_woman:     "Oh! Sorry, I didn't see you there. Are you alright?",
  adult_woman:     "Let me be clear. This is the only chance we're going to get.",
  old_woman:       "Come now, child. I've lived long enough to know how this ends.",
  teen_girl:       "I can't believe this is happening. What do we do now?",
  child:           "Um... hello? Is somebody there? I'm not scared, I promise.",
  inner_monologue: "This is fine. Everything is fine. I just need to focus.",
  system:          "Notification received. Processing complete. Standing by.",
};

let _sampleAudio = null;
async function sampleVoice(voiceId, voiceType, btnEl) {
  if (!voiceId) return;
  // Stop any playing sample
  if (_sampleAudio) { _sampleAudio.pause(); _sampleAudio = null; }
  const phrase = SAMPLE_PHRASES[voiceType] || SAMPLE_PHRASES.narrator;
  const origText = btnEl ? btnEl.textContent : '';
  if (btnEl) { btnEl.textContent = '...'; btnEl.disabled = true; }
  try {
    const blob = await fishTTS(phrase, voiceId, null);
    const url = URL.createObjectURL(blob);
    _sampleAudio = new Audio(url);
    _sampleAudio.playbackRate = S.speed || 1.0;
    _sampleAudio.play();
    if (btnEl) btnEl.textContent = '■ Stop';
    _sampleAudio.onended = () => { if (btnEl) { btnEl.textContent = origText; btnEl.disabled = false; } _sampleAudio = null; URL.revokeObjectURL(url); };
    if (btnEl) btnEl.onclick = () => { _sampleAudio?.pause(); _sampleAudio = null; URL.revokeObjectURL(url); btnEl.textContent = origText; btnEl.disabled = false; btnEl.onclick = () => sampleVoice(voiceId, voiceType, btnEl); };
  } catch(e) {
    if (btnEl) { btnEl.textContent = origText; btnEl.disabled = false; }
    toast('Sample failed: ' + e.message);
  }
}

async function fetchVoiceCandidates(identity, count = 8) {
  const query = buildPersonalityQuery(identity);
  if (!query) return [];
  const reg = getRegistry();
  const allUsed = new Set(Object.values(reg).map(e => e.voiceId));
  const candidates = [];
  const seen = new Set();
  // Use a single large request — pagination often unsupported by the worker proxy
  for (const q of [query, (identity.gender === 'female' ? 'woman' : 'man')]) {
    if (candidates.length >= count) break;
    try {
      const url = WORKER + '/fish/model?page_size=20&page_number=1&language=en&sort_by=score&title=' + encodeURIComponent(q);
      const res = await fetchRetry(url, {}, 2);
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of (data.items || [])) {
        if (item._id && !seen.has(item._id)) {
          seen.add(item._id);
          candidates.push({ id: item._id, inUse: allUsed.has(item._id) });
          if (candidates.length >= count) break;
        }
      }
    } catch(e) {
      console.warn('fetchVoiceCandidates failed for query:', q, e);
    }
  }
  return candidates;
}

let _pickerChar = null;
function openVoicePicker(charName) {
  _pickerChar = charName;
  const modal = document.getElementById('voicePickerModal');
  if (!modal) return;
  const reg = getRegistry();
  const entry = reg[charName];
  if (!entry) { toast('Character not found in registry'); return; }
  modal.style.display = 'flex';
  document.getElementById('vpCharName').textContent = charName.charAt(0).toUpperCase() + charName.slice(1);
  const desc = [entry.tone, entry.energy, VOICE_TYPES[entry.voiceType]?.label].filter(Boolean).join(' · ');
  document.getElementById('vpCharDesc').textContent = desc || VOICE_TYPES[entry.voiceType]?.desc || 'Searching personality-matched voices...';
  const cands = document.getElementById('vpCandidates');
  cands.innerHTML = '<div style="color:var(--text-mute);text-align:center;padding:24px 16px;font-size:13px;">Searching voices...<br><span style="font-size:11px;opacity:.6;">' + (buildPersonalityQuery({tone:entry.tone,energy:entry.energy,gender:entry.voiceType?.includes("woman")||entry.voiceType?.includes("girl")?"female":"male",age:entry.voiceType?.includes("teen")?"teen":entry.voiceType?.includes("old")?"old":entry.voiceType?.includes("child")?"child":entry.voiceType?.includes("young")?"young_adult":"adult"}) || entry.voiceType) + '</span></div>';

  const identity = {
    gender: entry.voiceType?.includes('woman') || entry.voiceType?.includes('girl') ? 'female' : 'male',
    age: entry.voiceType?.includes('teen') ? 'teen' : entry.voiceType?.includes('old') ? 'old' : entry.voiceType?.includes('child') ? 'child' : entry.voiceType?.includes('young') ? 'young_adult' : 'adult',
    tone: entry.tone, energy: entry.energy
  };

  fetchVoiceCandidates(identity, 8)
    .then(candidates => {
      cands.innerHTML = '';
      if (!candidates.length) {
        cands.innerHTML = '<div style="color:var(--text-mute);text-align:center;padding:24px;font-size:13px;">No voices found — try resetting and letting the system auto-pick</div>';
        return;
      }
      candidates.forEach(c => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border);';
        const isCurrent = c.id === entry.voiceId;
        const label = document.createElement('div');
        label.style.cssText = 'flex:1;font-size:12px;color:' + (isCurrent ? 'var(--gold)' : 'var(--text-dim)') + ';font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        label.textContent = c.id;
        if (isCurrent) label.title = 'Currently assigned';
        const sampleBtn = document.createElement('button');
        sampleBtn.className = 'ctrl csm';
        sampleBtn.style.cssText = 'font-size:12px;width:auto;padding:0 10px;flex-shrink:0;';
        sampleBtn.textContent = '▶';
        sampleBtn.title = 'Sample this voice';
        sampleBtn.onclick = () => sampleVoice(c.id, entry.voiceType || 'narrator', sampleBtn);
        const selBtn = document.createElement('button');
        selBtn.className = 'ctrl csm';
        selBtn.style.cssText = 'font-size:12px;width:auto;padding:0 12px;flex-shrink:0;' + (isCurrent ? 'border-color:var(--gold);color:var(--gold);' : '');
        selBtn.textContent = isCurrent ? '✓' : 'Use';
        selBtn.title = isCurrent ? 'Current voice' : 'Assign this voice';
        selBtn.onclick = () => {
          selectVoiceForChar(charName, c.id);
          // Update all select buttons in modal
          cands.querySelectorAll('button:last-child').forEach(b => { b.textContent = 'Use'; b.style.color = ''; b.style.borderColor = ''; });
          selBtn.textContent = '✓'; selBtn.style.color = 'var(--gold)'; selBtn.style.borderColor = 'var(--gold)';
          label.style.color = 'var(--gold)';
        };
        row.append(label, sampleBtn, selBtn);
        cands.appendChild(row);
      });
    })
    .catch(err => {
      console.error('Voice picker failed:', err);
      cands.innerHTML = '<div style="color:var(--red);text-align:center;padding:24px;font-size:13px;">Failed to load voices: ' + err.message + '<br><span style="color:var(--text-mute);font-size:11px;">Check console for details</span></div>';
    });
}

function closeVoicePicker() {
  document.getElementById('voicePickerModal').style.display = 'none';
  if (_sampleAudio) { _sampleAudio.pause(); _sampleAudio = null; }
  _pickerChar = null;
}

function selectVoiceForChar(charName, voiceId) {
  const reg = getRegistry();
  if (reg[charName]) { reg[charName].voiceId = voiceId; saveLocal(); clearAudioBuffer(); toast('Voice updated for ' + charName); }
}

function renderVoiceList() {
  const list = document.getElementById('voiceList');
  if (!list) return;
  list.innerHTML = '';
  const reg = getRegistry();
  const noSpoiler = localStorage.getItem('nospoiler') === '1';
  const currentCh = S.activeChIdx || 0;

  // ── Smart Identify toggle ──
  const smartRow = document.createElement('div');
  smartRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);margin-bottom:8px;';
  smartRow.innerHTML = '<div><div style="font-size:14px;color:var(--text)">Smart Identification</div>'
    + '<div style="font-size:11px;color:var(--text-mute);margin-top:2px">Auto-detect characters via look-ahead</div></div>'
    + '<input type="checkbox" ' + (S.smartIdentify ? 'checked' : '') + ' onclick="toggleSmartIdentify(this.checked)" style="transform:scale(1.3)">';
  list.appendChild(smartRow);

  // ── No-spoiler toggle ──
  const spoilerRow = document.createElement('div');
  spoilerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);margin-bottom:12px;';
  spoilerRow.innerHTML = '<div><div style="font-size:14px;color:var(--text)">No-Spoiler Mode</div>'
    + '<div style="font-size:11px;color:var(--text-mute);margin-top:2px">Hide characters not yet introduced</div></div>'
    + '<input type="checkbox" ' + (noSpoiler ? 'checked' : '') + ' onclick="toggleNoSpoiler(this.checked)" style="transform:scale(1.3)">';
  list.appendChild(spoilerRow);

  // ── Bible build button ──
  const bibleBtn = document.createElement('button');
  bibleBtn.className = 'pcbtn';
  bibleBtn.style.cssText = 'margin-bottom:12px;background:var(--gold-glow);border-color:var(--gold);color:var(--gold2);width:100%;';
  bibleBtn.textContent = '⚡ Build Character Bible';
  bibleBtn.onclick = () => runBibleBuild();
  list.appendChild(bibleBtn);

  // ── Character list ──
  const entries = Object.entries(reg);
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:13px;color:var(--text-mute);text-align:center;padding:16px 0;';
    empty.textContent = 'No characters identified yet. Build the bible or start reading.';
    list.appendChild(empty);
  } else {
    // Split into main and side
    const visible = entries.filter(([, e]) => !noSpoiler || (e.firstChapter ?? 0) <= currentCh);
    const hidden = entries.length - visible.length;
    const mains = visible.filter(([, e]) => e.isMain);
    const sides = visible.filter(([, e]) => !e.isMain);

    const renderSection = (label, chars) => {
      if (!chars.length) return;
      const hdr = document.createElement('div'); hdr.className = 'vlt'; hdr.textContent = label; list.appendChild(hdr);
      chars.forEach(([norm, info]) => {
        const card = document.createElement('div');
        card.style.cssText = 'background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px;';
        const top = document.createElement('div');
        top.style.cssText = 'display:flex;align-items:center;gap:8px;';
        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'flex:1;font-size:14px;color:var(--text);font-weight:500;';
        nameEl.textContent = norm.charAt(0).toUpperCase() + norm.slice(1);
        const badge = document.createElement('div');
        badge.style.cssText = 'font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--gold);border:1px solid var(--gold);border-radius:4px;padding:2px 6px;';
        badge.textContent = VOICE_TYPES[info.voiceType]?.label || info.voiceType;
        top.append(nameEl, badge);

        const meta = document.createElement('div');
        meta.style.cssText = 'font-size:11px;color:var(--text-mute);margin-top:3px;';
        const parts = [info.tone, info.energy ? info.energy + ' energy' : null].filter(Boolean);
        meta.textContent = parts.length ? parts.join(' · ') : 'auto-assigned';

        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:6px;margin-top:8px;';

        const sampleBtn = document.createElement('button');
        sampleBtn.className = 'ctrl csm';
        sampleBtn.style.cssText = 'font-size:12px;width:auto;padding:0 12px;height:32px;';
        sampleBtn.textContent = '▶ Sample';
        sampleBtn.onclick = () => sampleVoice(info.voiceId, info.voiceType, sampleBtn);

        const changeBtn = document.createElement('button');
        changeBtn.className = 'ctrl csm';
        changeBtn.style.cssText = 'font-size:12px;width:auto;padding:0 12px;height:32px;border-color:var(--border2);';
        changeBtn.textContent = '✏ Change';
        changeBtn.onclick = () => openVoicePicker(norm);

        const resetBtn = document.createElement('button');
        resetBtn.className = 'ctrl csm';
        resetBtn.style.cssText = 'font-size:12px;width:auto;padding:0 12px;height:32px;border-color:var(--red);color:var(--red);';
        resetBtn.textContent = '↺ Reset';
        resetBtn.title = 'Remove voice assignment — system will pick again';
        resetBtn.onclick = () => {
          if (!confirm('Reset voice for ' + norm + '? The system will pick a new voice next time they appear.')) return;
          const reg = getRegistry();
          delete reg[norm];
          saveLocal();
          clearAudioBuffer();
          toast('Voice reset for ' + norm);
          renderVoiceList();
        };
        btns.append(sampleBtn, changeBtn, resetBtn);
        card.append(top, meta, btns);
        list.appendChild(card);
      });
    };

    renderSection('Main Characters', mains);
    renderSection('Supporting Characters', sides);

    if (hidden > 0) {
      const hid = document.createElement('div');
      hid.style.cssText = 'font-size:12px;color:var(--text-mute);text-align:center;padding:8px 0;';
      hid.textContent = hidden + ' character' + (hidden > 1 ? 's' : '') + ' hidden (no-spoiler mode)';
      list.appendChild(hid);
    }
  }

  // ── Side character voice banks (collapsed) ──
  const banksToggle = document.createElement('div');
  banksToggle.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 0;margin-top:8px;border-top:1px solid var(--border);cursor:pointer;';
  banksToggle.innerHTML = '<div style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-mute)">Side Character Voice Banks</div><div id="bankChevron" style="color:var(--text-mute);font-size:14px;">▸</div>';
  const banksBody = document.createElement('div');
  banksBody.id = 'voiceBanksBody';
  banksBody.style.display = 'none';
  banksToggle.onclick = () => {
    const open = banksBody.style.display !== 'none';
    banksBody.style.display = open ? 'none' : 'block';
    document.getElementById('bankChevron').textContent = open ? '▸' : '▾';
  };

  Object.entries(VOICE_TYPES).forEach(([type, info]) => {
    const row = document.createElement('div'); row.className = 'vrow'; row.style.marginBottom = '6px';
    const manual = S.customVoices[type] || S.activeBook?.voiceMap?.[type] || '';
    const pool = voicePools[type] || [];
    const isAuto = !manual && pool.length > 0;
    row.innerHTML = '<div style="flex:1;min-width:0"><div class="vlbl">'+info.label+'</div>'
      + '<div class="vtyp">'+info.desc+(isAuto ? ' · <span style="color:var(--gold)">'+pool.length+' voices</span>' : '')+'</div></div>'
      + '<input class="viid" placeholder="'+(isAuto ? 'auto' : 'voice ID...')+'" value="'+manual+'" oninput="setVoiceOverride(\''+type+'\',this.value)">';
    banksBody.appendChild(row);
  });

  list.appendChild(banksToggle);
  list.appendChild(banksBody);
}

function toggleSmartIdentify(on) { S.smartIdentify = !!on; saveLocal(); toast(on ? 'Smart Identify ON' : 'Smart Identify OFF'); }
function toggleCharacterVisibility(show) { localStorage.setItem('show_character_voices', show ? '1' : '0'); renderVoiceList(); }
function setCharVoiceOverride(k, v) { const reg=getRegistry(); if(reg[k]){reg[k].voiceId=v.trim();saveLocal();} }
function setVoiceOverride(t, v) { S.customVoices[t]=v.trim(); if(S.activeBook){if(!S.activeBook.voiceMap)S.activeBook.voiceMap={};S.activeBook.voiceMap[t]=v.trim();} }

async function runBibleBuild() {
  if (!S.activeBook) { toast('Open a book first'); return; }
  if (!confirm('This will scan the entire book to identify all characters.\n\nThis uses DeepSeek API and may take 1-3 minutes.\nContinue?')) return;
  showGenOverlay('Building Character Bible', 'Pre-scanning book for character identification...', 'Starting...');
  try {
    const count = await buildCharacterBible(({ phase, pct }) => {
      setGenStep(phase + ' \u2014 ' + Math.round(pct) + '%');
      setGenProgress(pct);
    });
    hideGenOverlay();
    if (count) { toast('Identified ' + count + ' characters'); renderVoiceList(); }
    else toast('Bible build failed -- check console');
  } catch(e) { hideGenOverlay(); toast('Bible error: ' + e.message); }
}

// ════════════════════════════════════════════════════════
// OVERLAY / TOAST
// ════════════════════════════════════════════════════════
function showGenOverlay(title, sub, step='') {
  document.getElementById('genTitle').textContent = title;
  document.getElementById('genSub').textContent = sub;
  document.getElementById('genStep').textContent = step;
  document.getElementById('genProgressBar').classList.remove('show');
  document.getElementById('genProgressFill').style.width = '0%';
  document.getElementById('genOverlay').classList.add('show');
}
function hideGenOverlay() {
  document.getElementById('genOverlay').classList.remove('show');
  document.getElementById('genProgressBar').classList.remove('show');
  document.getElementById('genProgressFill').style.width = '0%';
}
function setGenStep(s) { document.getElementById('genStep').textContent = s; }
function setGenProgress(pct) {
  const bar = document.getElementById('genProgressBar');
  const fill = document.getElementById('genProgressFill');
  bar.classList.add('show');
  fill.style.width = Math.min(100, Math.max(0, pct)).toFixed(1) + '%';
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'ArrowRight') speedUp();
  if (e.code === 'ArrowLeft') slowDown();
  if (e.code === 'ArrowDown') { e.preventDefault(); nextChapter(); }
  if (e.code === 'ArrowUp') { e.preventDefault(); prevChapter(); }
});

// ════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════
(async function init() {
  S.isMobile = window.innerWidth < 768;
  await initDB();
  const saved = loadLocal();

  if (S.keys.ds) document.getElementById('dsKey').value = S.keys.ds;
  if (S.keys.fa) document.getElementById('faKey').value = S.keys.fa;
  if (S.keys.oa) document.getElementById('oaKey').value = S.keys.oa;

  if (saved.books?.length) {
    saved.books.forEach(sb => {
      S.books.push({
        id: sb.id, title: sb.title, color: sb.color,
        chapters: sb.chapters || [],
        progress: sb.progress || 0,
        chapterProgress: sb.chapterProgress || {},
        voiceMap: sb.voiceMap || {},
        characterRegistry: sb.characterRegistry || {},
        _epub: null,
      });
    });
  }

  if (localStorage.getItem('orv_auto_enter')) { S.user = { name: 'Reader' }; enterApp(); }

  window.addEventListener('resize', () => {
    S.isMobile = window.innerWidth < 768;
    document.body.classList.toggle('mobile', S.isMobile);
    document.body.classList.toggle('desktop', !S.isMobile);
  });
  document.body.classList.toggle('mobile', S.isMobile);
  document.body.classList.toggle('desktop', !S.isMobile);
})();
