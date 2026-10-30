/* ものがたり紙芝居 — フロントエンド */
(() => {
'use strict';

const CFG = window.APP_CONFIG || {};
const VERSION = CFG.VERSION || '1.0.0';
const SILENCE_MS = CFG.SPEECH_SILENCE_MS || 8000;
const MAX_TEXT = CFG.MAX_TEXT || 60000;
const LS = { url: 'mk_gas_url', token: 'mk_token', name: 'mk_name', help: 'mk_help_seen' };
const EFFECTS = { zoomIn: 'ゆっくり寄る', zoomOut: 'ゆっくり引く', panLeft: '左へパン', panRight: '右へパン', panUp: '上へパン', panDown: '下へパン', slideIn: 'スライドで登場', none: '動かさない' };
const CANVAS = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [1080, 1080] };
const CHARS_PER_SEC = 6.5; // 音声未生成時の目安

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  token: localStorage.getItem(LS.token) || '',
  name: localStorage.getItem(LS.name) || '',
  project: null,
  step: 1,
  stop: false,
  running: false,
  busyScenes: new Set()
};
const assetCache = new Map(); // fileId -> Promise<{url, blob}>

/* ---------- 共通 ---------- */
function gasUrl() { return localStorage.getItem(LS.url) || CFG.GAS_URL || ''; }

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), err ? 6000 : 3000);
}

async function api(action, data = {}) {
  const url = gasUrl();
  if (!url) { openSettings(); throw new Error('接続先（GAS URL）が未設定です'); }
  let j;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token: state.token, ...data })
    });
    j = await res.json();
  } catch (e) {
    throw new Error('サーバーに接続できませんでした。GAS URLと通信状況を確認してください');
  }
  if (!j.ok) {
    const msg = j.error || 'エラーが発生しました';
    if (msg.startsWith('AUTH:')) { clearSession(); showAuth('login'); }
    else if (msg.startsWith('MUST_CHANGE:')) { showAuth('change'); }
    throw new Error(msg.replace(/^(AUTH|MUST_CHANGE):\s*/, ''));
  }
  return j;
}

function withBusy(btn, fn) {
  return async (...a) => {
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    try { await fn(...a); }
    catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; btn.textContent = label; }
  };
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

function asset(fileId) {
  if (!fileId) return Promise.resolve(null);
  if (!assetCache.has(fileId)) {
    const p = api('getAsset', { fileId }).then(j => {
      const blob = b64ToBlob(j.data, j.mimeType);
      return { url: URL.createObjectURL(blob), blob };
    }).catch(e => { assetCache.delete(fileId); throw e; });
    assetCache.set(fileId, p);
  }
  return assetCache.get(fileId);
}

/* ---------- 長い間を許す音声入力 ---------- */
class LongSpeech {
  constructor({ onFinal, onInterim, onState }) {
    this.onFinal = onFinal; this.onInterim = onInterim || (() => {}); this.onState = onState || (() => {});
    this.active = false;
  }
  static supported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  start() {
    if (!LongSpeech.supported()) { toast('このブラウザは音声入力に対応していません（Chrome推奨）', true); return; }
    this.active = true; this.onState(true); this._run();
  }
  _run() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new SR();
    r.lang = 'ja-JP'; r.continuous = true; r.interimResults = true;
    r.onresult = e => {
      let fin = '', mid = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) fin += t; else mid += t;
      }
      if (fin) this.onFinal(fin);
      this.onInterim(mid);
      this._bump();
    };
    // ブラウザ側が途中で切っても、無音タイマーが切れるまで自動で再開する
    r.onend = () => { if (this.active) setTimeout(() => this.active && this._run(), 200); };
    r.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { toast('マイクの使用が許可されていません', true); this.stop(); }
    };
    this.r = r;
    try { r.start(); } catch (e) { /* 二重開始は無視 */ }
    this._bump();
  }
  _bump() { clearTimeout(this.t); this.t = setTimeout(() => this.stop(), SILENCE_MS); }
  stop() {
    this.active = false; clearTimeout(this.t);
    try { this.r && this.r.stop(); } catch (e) { }
    this.onInterim(''); this.onState(false);
  }
  toggle() { this.active ? this.stop() : this.start(); }
}

function bindMic(btn, target, interimEl) {
  const sp = new LongSpeech({
    onFinal: t => {
      const el = typeof target === 'function' ? target() : target;
      el.value += t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    onInterim: t => { if (interimEl) interimEl.textContent = t; },
    onState: on => { btn.classList.toggle('on', on); btn.textContent = on ? '音声入力を止める' : btn.dataset.label; }
  });
  btn.dataset.label = btn.textContent;
  btn.addEventListener('click', () => sp.toggle());
  return sp;
}

/* ---------- 認証 ---------- */
function clearSession() {
  state.token = ''; state.name = '';
  localStorage.removeItem(LS.token); localStorage.removeItem(LS.name);
}

function showAuth(pane) {
  $('#appView').hidden = true;
  $('#authView').hidden = false;
  $$('.auth-pane').forEach(p => { p.hidden = p.dataset.pane !== pane; });
  const first = $(`.auth-pane[data-pane="${pane}"] input`);
  if (first) first.focus();
}

function enterApp() {
  $('#authView').hidden = true;
  $('#appView').hidden = false;
  $('#whoName').textContent = state.name ? state.name + ' さん' : '';
  showList();
  if (!localStorage.getItem(LS.help)) { $('#helpModal').showModal(); localStorage.setItem(LS.help, '1'); }
}

function initAuth() {
  $$('[data-go]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); showAuth(a.dataset.go); }));
  $$('.eye').forEach(b => b.addEventListener('click', () => {
    const inp = b.previousElementSibling;
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    b.textContent = show ? '隠す' : '表示';
    b.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
  }));

  const agrees = $$('#registerForm .agree input');
  const syncAgree = () => { $('#regSubmit').disabled = !agrees.every(c => c.checked); };
  agrees.forEach(c => c.addEventListener('change', syncAgree));

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.submitter || $('#loginForm .btn');
    await withBusy(btn, async () => {
      const j = await api('login', { email: $('#loginEmail').value, password: $('#loginPw').value });
      state.token = j.token; state.name = j.name;
      localStorage.setItem(LS.token, j.token); localStorage.setItem(LS.name, j.name);
      $('#loginPw').value = '';
      if (j.mustChange) { showAuth('change'); toast('新しいパスワードを設定してください'); }
      else enterApp();
    })();
  });

  $('#registerForm').addEventListener('submit', async e => {
    e.preventDefault();
    await withBusy($('#regSubmit'), async () => {
      if (!agrees.every(c => c.checked)) throw new Error('すべての同意項目にチェックしてください');
      const agree = {};
      agrees.forEach(c => { agree[c.dataset.k] = c.checked; });
      const j = await api('register', { name: $('#regName').value, email: $('#regEmail').value, agree });
      toast(j.message);
      $('#loginEmail').value = $('#regEmail').value;
      showAuth('login');
    })();
  });

  $('#forgotForm').addEventListener('submit', async e => {
    e.preventDefault();
    await withBusy($('#forgotForm .btn'), async () => {
      const j = await api('resetPassword', { email: $('#forgotEmail').value });
      toast(j.message);
      $('#loginEmail').value = $('#forgotEmail').value;
      showAuth('login');
    })();
  });

  $('#changeForm').addEventListener('submit', async e => {
    e.preventDefault();
    await withBusy($('#changeForm .btn'), async () => {
      if ($('#newPw').value !== $('#newPw2').value) throw new Error('新しいパスワードが確認欄と一致しません');
      const j = await api('changePassword', { current: $('#curPw').value, newPassword: $('#newPw').value });
      ['#curPw', '#newPw', '#newPw2'].forEach(s => { $(s).value = ''; });
      toast(j.message);
      enterApp();
    })();
  });

  $('#logoutBtn').addEventListener('click', async () => {
    try { await api('logout'); } catch (e) { }
    stopPlayback(true);
    clearSession();
    showAuth('login');
  });
}

/* ---------- 設定 ---------- */
function openSettings() {
  $('#gasUrlInput').value = gasUrl();
  $('#gasTestResult').textContent = '';
  if (!$('#settingsModal').open) $('#settingsModal').showModal();
}

function initSettings() {
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#gasSaveBtn').addEventListener('click', () => {
    const v = $('#gasUrlInput').value.trim();
    if (v && !/^https:\/\/script\.google\.com\/.+\/exec$/.test(v)) { $('#gasTestResult').textContent = 'URLは https://script.google.com/…/exec の形式で入力してください'; return; }
    if (v) localStorage.setItem(LS.url, v); else localStorage.removeItem(LS.url);
    $('#settingsModal').close();
    toast('接続先を保存しました');
  });
  $('#gasResetBtn').addEventListener('click', () => {
    localStorage.removeItem(LS.url);
    $('#gasUrlInput').value = CFG.GAS_URL || '';
    $('#gasTestResult').textContent = 'config.js の値に戻しました';
  });
  $('#gasTestBtn').addEventListener('click', async () => {
    const v = $('#gasUrlInput').value.trim();
    $('#gasTestResult').textContent = '確認中…';
    try {
      const r = await fetch(v, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'ping' }) });
      const j = await r.json();
      $('#gasTestResult').textContent = j.ok ? `接続できました（サーバー v${j.version}）` : '応答はありましたがエラーです：' + j.error;
    } catch (e) { $('#gasTestResult').textContent = '接続できません。URLとデプロイ設定（アクセス：全員）を確認してください'; }
  });
  $('#helpBtn').addEventListener('click', () => $('#helpModal').showModal());
}

/* ---------- 作品一覧 ---------- */
async function showList() {
  stopPlayback(true);
  state.project = null;
  $('#editView').hidden = true;
  $('#listView').hidden = false;
  const ul = $('#projectList');
  ul.innerHTML = '<li class="empty">読み込み中…</li>';
  try {
    const j = await api('listProjects');
    if (!j.projects.length) {
      ul.innerHTML = '<li class="empty">まだ作品がありません。「新しい作品をつくる」から始めましょう。</li>';
      return;
    }
    ul.innerHTML = j.projects.map(p => `
      <li data-id="${esc(p.id)}">
        <div><div class="t" tabindex="0">${esc(p.title)}</div>
          <div class="meta">${p.chars.toLocaleString()}字 ／ 場面${p.scenes} ／ 絵${p.images} ／ 朗読${p.audios} ／ 更新 ${esc(new Date(p.updatedAt).toLocaleString('ja-JP'))}</div></div>
        <button class="btn small ghost open">開く</button>
        <button class="btn small danger del">削除</button>
      </li>`).join('');
    $$('li[data-id]', ul).forEach(li => {
      const open = () => openProject(li.dataset.id);
      $('.t', li).addEventListener('click', open);
      $('.t', li).addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
      $('.open', li).addEventListener('click', open);
      $('.del', li).addEventListener('click', async () => {
        if (!confirm('この作品を削除しますか？（Googleドライブのゴミ箱に移動します）')) return;
        try { await api('deleteProject', { projectId: li.dataset.id }); toast('削除しました'); showList(); }
        catch (e) { toast(e.message, true); }
      });
    });
  } catch (e) {
    ul.innerHTML = `<li class="empty">${esc(e.message)}</li>`;
  }
}

async function openProject(id) {
  try {
    const j = await api('getProject', { projectId: id });
    loadEditor(j.project);
  } catch (e) { toast(e.message, true); }
}

/* ---------- 編集 ---------- */
function loadEditor(p, step) {
  state.project = p;
  $('#listView').hidden = true;
  $('#editView').hidden = false;
  $('#projTitle').value = p.title || '';
  $('#novelText').value = p.text || '';
  updateCount();
  $$('input[name=aspect]').forEach(r => { r.checked = r.value === (p.aspect || '16:9'); });
  $('#styleInput').value = p.style || '';
  $('#styleRefAttach').checked = p.styleRefAttach !== false;
  renderStyleRefs();
  $('#voiceSelect').value = p.voice || 'Kore';
  $('#subToggle').checked = p.subtitles !== false;
  $$('input[name=audioMode]').forEach(r => { r.checked = r.value === audioMode(); });
  $('#saveState').textContent = '';
  renderChars();
  renderScenes();
  goStep(step || (p.scenes && p.scenes.length ? 3 : 1));
}

function goStep(n) {
  if (state.step === 4 && n !== 4) stopPlayback(false);
  state.step = n;
  $$('.step-tab').forEach(b => {
    const on = Number(b.dataset.step) === n;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  [1, 2, 3, 4].forEach(i => { $('#pane' + i).hidden = i !== n; });
  if (n === 3) renderScenes();
  if (n === 4) preparePlayer();
}

let saveTimer;
function scheduleSave(fields) {
  state.pendingSave = Object.assign(state.pendingSave || {}, fields);
  $('#saveState').textContent = '未保存';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 1200);
}

async function flushSave() {
  clearTimeout(saveTimer);
  const f = state.pendingSave;
  if (!f || !state.project) return;
  state.pendingSave = null;
  $('#saveState').textContent = '保存中…';
  try {
    const j = await api('saveProject', { project: { id: state.project.id, ...f } });
    // 生成中の場面データを上書きしないよう、送った項目だけ反映
    // 場面・人物は画面で編集中のオブジェクトをそのまま使い続ける
    Object.keys(f).forEach(k => { if (!['scenes', 'characters', 'narrationStarts'].includes(k)) state.project[k] = j.project[k]; });
    state.project.updatedAt = j.project.updatedAt;
    $('#saveState').textContent = '保存済み';
  } catch (e) {
    $('#saveState').textContent = '保存に失敗';
    toast(e.message, true);
  }
}

function updateCount() {
  const n = $('#novelText').value.length;
  const est = Math.max(4, Math.min(60, Math.round(n / 700)));
  $('#charCount').textContent = `${n.toLocaleString()}字` + (n >= 100 ? `（絵はおよそ${est}枚の見込み）` : '');
  $('#charCount').style.color = n > MAX_TEXT ? 'var(--danger)' : '';
}

async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  let t = new TextDecoder('utf-8').decode(buf);
  if ((t.match(/\uFFFD/g) || []).length > 5) {
    try { t = new TextDecoder('shift_jis').decode(buf); } catch (e) { }
  }
  return t;
}

function initEditor() {
  $('#newProjectBtn').addEventListener('click', withBusy($('#newProjectBtn'), async () => {
    const j = await api('saveProject', { project: { title: '無題の紙芝居' } });
    loadEditor(j.project, 1);
    $('#projTitle').select();
  }));
  $('#backBtn').addEventListener('click', async () => { await flushSave(); showList(); });
  $('#homeLink').addEventListener('click', async e => { e.preventDefault(); if (state.project) await flushSave(); showList(); });
  $$('.step-tab').forEach(b => b.addEventListener('click', async () => { await flushSave(); goStep(Number(b.dataset.step)); }));

  $('#projTitle').addEventListener('input', () => scheduleSave({ title: $('#projTitle').value }));
  $('#novelText').addEventListener('input', () => {
    updateCount();
    if ($('#novelText').value.length <= MAX_TEXT) scheduleSave({ text: $('#novelText').value });
  });
  $('#fileInput').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    const t = await readTextFile(f);
    if ($('#novelText').value && !confirm('いまの本文を置き換えますか？（キャンセルで末尾に追加）')) $('#novelText').value += '\n' + t;
    else $('#novelText').value = t;
    $('#novelText').dispatchEvent(new Event('input'));
    if (!$('#projTitle').value || $('#projTitle').value.startsWith('無題')) {
      $('#projTitle').value = f.name.replace(/\.txt$/i, '');
      scheduleSave({ title: $('#projTitle').value });
    }
    e.target.value = '';
  });
  bindMic($('#micNovel'), $('#novelText'), $('#interimNovel'));

  $('#analyzeBtn').addEventListener('click', withBusy($('#analyzeBtn'), async () => {
    const text = $('#novelText').value;
    if (text.length < 100) throw new Error('本文を100字以上入れてください');
    if (text.length > MAX_TEXT) throw new Error(`本文は${MAX_TEXT.toLocaleString()}字までです`);
    if (state.project.scenes?.length && !confirm('場面を分け直すと、生成済みの絵と朗読は削除されます。続けますか？')) return;
    $('#analyzeBtn').textContent = 'AIが読んでいます…（1分ほど）';
    scheduleSave({ text });
    await flushSave();
    const j = await api('analyze', { projectId: state.project.id });
    state.project = j.project;
    renderChars();
    toast(`${j.project.scenes.length}場面に分けました。絵と声の設定を確認してください`);
    goStep(2);
  }));

  // 設定
  $$('input[name=aspect]').forEach(r => r.addEventListener('change', () => {
    const had = state.project.scenes?.some(s => s.imageFileId);
    if (had) toast('画像の形を変えた場合、既存の絵は作り直すと新しい形になります');
    scheduleSave({ aspect: r.value });
  }));
  $('#styleInput').addEventListener('input', () => scheduleSave({ style: $('#styleInput').value }));
  $('#styleRefAttach').addEventListener('change', () => scheduleSave({ styleRefAttach: $('#styleRefAttach').checked }));
  $('#styleRefAdd').addEventListener('click', withBusy($('#styleRefAdd'), async () => {
    if ((state.project.styleRefs || []).length >= 3) throw new Error('参考絵は3枚までです。不要なものを外してください');
    const f = await pickImage();
    if (!f) return;
    $('#styleRefAdd').textContent = 'アップロード中…';
    await flushSave();
    const j = await api('uploadFile', { projectId: state.project.id, kind: 'styleRef', dataUrl: await shrinkImage(f) });
    state.project.styleRefs = j.project.styleRefs;
    renderStyleRefs();
  }));
  $('#styleAnalyzeBtn').addEventListener('click', withBusy($('#styleAnalyzeBtn'), async () => {
    if (!(state.project.styleRefs || []).length) throw new Error('先に参考絵を追加してください');
    if ($('#styleInput').value.trim() && !confirm('いまの画風の文章を、参考絵から作った作風に置き換えますか？')) return;
    $('#styleAnalyzeBtn').textContent = 'AIが絵を見ています…';
    await flushSave();
    const j = await api('analyzeStyle', { projectId: state.project.id });
    state.project.style = j.project.style;
    $('#styleInput').value = j.project.style;
    toast('参考絵から作風を作りました。文章は自由に直せます');
  }));
  $('#voiceSelect').addEventListener('change', () => scheduleSave({ voice: $('#voiceSelect').value }));
  $('#subToggle').addEventListener('change', () => scheduleSave({ subtitles: $('#subToggle').checked }));
  $('#addCharBtn').addEventListener('click', () => {
    state.project.characters = state.project.characters || [];
    state.project.characters.push({ id: Math.random().toString(36).slice(2, 10), name: '', features: '', refFileId: null });
    renderChars();
    scheduleSave({ characters: state.project.characters });
    const last = $$('.char').pop();
    if (last) $('input', last).focus();
  });

  // 生成
  $('#genImagesBtn').addEventListener('click', () => runBatch('image'));
  $('#genAudioBtn').addEventListener('click', () => runBatch('audio'));
  $('#stopBtn').addEventListener('click', () => { state.stop = true; $('#stopBtn').textContent = '止めています…'; });

  // 朗読の取り込み
  $$('input[name=audioMode]').forEach(r => r.addEventListener('change', () => {
    if (r.value === 'narration' && !state.project.narration) {
      toast('先に「朗読ファイルを取り込む」で音声を入れてください', true);
      $$('input[name=audioMode]').forEach(x => { x.checked = x.value === 'scenes'; });
      return;
    }
    state.project.audioMode = r.value;
    scheduleSave({ audioMode: r.value });
    renderScenes();
  }));
  $('#narrFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await importNarration(f);
  });
  $('#alignAiBtn').addEventListener('click', withBusy($('#alignAiBtn'), async () => {
    $('#alignAiBtn').textContent = 'AIが朗読を聞いています…（数分）';
    await flushSave();
    const j = await api('alignNarration', { projectId: state.project.id });
    state.project.narration = j.project.narration;
    renderScenes();
    toast(`${j.found}/${j.total}場面の位置をAIが見つけました。残りは文字数で割り振りました。上演で確かめて、ずれていれば「聞きながら区切る」で直せます`);
  }));
  $('#alignRatioBtn').addEventListener('click', async () => {
    const n = state.project.narration;
    if (!n) return;
    if (!confirm('いまの区切りを捨てて、文字数の比率で割り振り直しますか？')) return;
    n.starts = fillStarts(n.starts.map((x, i) => i === 0 ? 0 : null), n.duration);
    n.aligned = 'ratio';
    scheduleSave({ narrationStarts: n.starts });
    renderScenes();
  });
  $('#narrDelBtn').addEventListener('click', withBusy($('#narrDelBtn'), async () => {
    if (!confirm('取り込んだ朗読ファイルを外しますか？（Googleドライブのゴミ箱に移動します）')) return;
    await flushSave();
    const j = await api('deleteNarration', { projectId: state.project.id });
    state.project.narration = null;
    state.project.audioMode = 'scenes';
    $$('input[name=audioMode]').forEach(x => { x.checked = x.value === 'scenes'; });
    renderScenes();
  }));
  initTapAlign();

  // 場面モーダル
  $('#smCancel').addEventListener('click', () => $('#sceneModal').close());
  $('#smSave').addEventListener('click', () => {
    const i = Number($('#sceneModal').dataset.idx);
    const s = state.project.scenes[i];
    s.summary = $('#smSummary').value;
    s.location = $('#smLocation').value;
    s.characters = $('#smChars').value.split(/[、,，]\s*/).map(x => x.trim()).filter(Boolean);
    s.imagePrompt = $('#smPrompt').value;
    scheduleSave({ scenes: state.project.scenes });
    $('#sceneModal').close();
    renderScenes();
    toast('保存しました。「絵を作り直す」で反映されます');
  });
}

/* ---------- 画像の縮小 ---------- */
function shrinkImage(file, max = 1600) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      res(c.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => rej(new Error('画像を読み込めませんでした'));
    img.src = URL.createObjectURL(file);
  });
}

function pickImage() { return pickFile('image/*'); }

function pickFile(accept) {
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept;
    inp.onchange = () => res(inp.files[0] || null);
    inp.click();
  });
}

/* ---------- 登場人物 ---------- */
function renderChars() {
  const list = $('#charList');
  const chars = state.project?.characters || [];
  if (!chars.length) {
    list.innerHTML = '<p class="empty">登場人物はまだいません。本文をAIで場面に分けると自動で書き出されます。</p>';
    return;
  }
  list.innerHTML = chars.map((c, i) => `
    <div class="char" data-i="${i}">
      <div class="ref" data-fid="${esc(c.refFileId || '')}">${c.refFileId ? '読み込み中…' : '三面図なし'}</div>
      <div>
        <label>名前<input class="c-name" value="${esc(c.name)}" maxlength="30"></label>
        <label>特徴（髪型・服装・体格・性格など）<textarea class="c-feat">${esc(c.features)}</textarea></label>
        <div class="row">
          <button class="btn small ghost c-mic">音声で追記</button>
          <button class="btn small ghost c-up">三面図をアップロード</button>
          <button class="btn small ghost c-ai">AIで三面図を作る</button>
          <button class="btn small danger c-del">削除</button>
        </div>
      </div>
    </div>`).join('');

  $$('.char', list).forEach(el => {
    const i = Number(el.dataset.i);
    const c = chars[i];
    $('.c-name', el).addEventListener('input', e => { c.name = e.target.value; scheduleSave({ characters: chars }); });
    $('.c-feat', el).addEventListener('input', e => { c.features = e.target.value; scheduleSave({ characters: chars }); });
    bindMic($('.c-mic', el), $('.c-feat', el));
    $('.c-del', el).addEventListener('click', () => {
      if (!confirm(`「${c.name || '名前なし'}」を削除しますか？`)) return;
      chars.splice(i, 1);
      scheduleSave({ characters: chars });
      renderChars();
    });
    $('.c-up', el).addEventListener('click', withBusy($('.c-up', el), async () => {
      const f = await pickImage();
      if (!f) return;
      $('.c-up', el).textContent = 'アップロード中…';
      await flushSave();
      const j = await api('uploadFile', { projectId: state.project.id, kind: 'charRef', charId: c.id, dataUrl: await shrinkImage(f) });
      state.project.characters = j.project.characters;
      renderChars();
    }));
    $('.c-ai', el).addEventListener('click', withBusy($('.c-ai', el), async () => {
      if (!c.features.trim()) throw new Error('先に特徴を書いてください');
      $('.c-ai', el).textContent = '描いています…';
      await flushSave();
      const j = await api('generateCharacterSheet', { projectId: state.project.id, charId: c.id });
      state.project.characters = j.project.characters;
      renderChars();
      toast('三面図を作りました');
    }));
    const ref = $('.ref', el);
    if (c.refFileId) asset(c.refFileId).then(a => { ref.innerHTML = `<img src="${a.url}" alt="${esc(c.name)}の三面図">`; }).catch(() => { ref.textContent = '読み込めません'; });
  });
}

/* ---------- 場面表・タイムライン ---------- */
function sceneDur(s) { return s.duration || Math.max(3, (s.text || '').length / CHARS_PER_SEC); }

function audioMode() {
  const p = state.project;
  return p && p.audioMode === 'narration' && p.narration ? 'narration' : 'scenes';
}

// 各場面の開始時刻・長さ（取り込んだ朗読ファイル使用時はその区切り）
function sceneTimes() {
  const p = state.project;
  const sc = p?.scenes || [];
  if (audioMode() === 'narration' && p.narration.starts?.length === sc.length) {
    const st = p.narration.starts;
    return sc.map((s, i) => {
      const to = i + 1 < sc.length ? st[i + 1] : p.narration.duration;
      return { from: st[i], dur: Math.max(0.1, to - st[i]), est: p.narration.aligned === 'ratio' };
    });
  }
  let t = 0;
  return sc.map(s => { const d = sceneDur(s); const r = { from: t, dur: d, est: !s.duration }; t += d; return r; });
}

// 確定した区切り（null以外）を残し、間を文字数の比率で埋める
function fillStarts(fixed, dur) {
  const lens = state.project.scenes.map(s => (s.text || '').length || 1);
  const out = fixed.slice();
  out[0] = 0;
  let i = 1;
  while (i < out.length) {
    if (out[i] != null) { i++; continue; }
    const a = i - 1;
    let b = i;
    while (b < out.length && out[b] == null) b++;
    const t0 = out[a], t1 = b < out.length ? out[b] : dur;
    const span = lens.slice(a, b).reduce((x, y) => x + y, 0);
    let acc = lens[a];
    for (let k = i; k < b; k++) { out[k] = t0 + (t1 - t0) * acc / span; acc += lens[k]; }
    i = b;
  }
  return out.map(x => Math.round(x * 10) / 10);
}

function fmtBytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB'; }

function renderNarrInfo() {
  const n = state.project?.narration;
  const has = !!n;
  ['#alignAiBtn', '#tapAlignBtn', '#alignRatioBtn', '#narrDelBtn'].forEach(sel => { $(sel).disabled = !has || state.running; });
  if (!has) { $('#narrInfo').textContent = '作品まるごとの朗読（MP3・WAV・M4Aなど）があれば取り込めます。場面ごとに分かれた音声は、対応表の「朗読を取り込む」から入れます。'; return; }
  const how = { ratio: '文字数の比率で仮に割り振り中', ai: 'AIが推定した区切り', manual: '手で区切った位置' }[n.aligned] || '';
  $('#narrInfo').textContent = `取り込み済み：${n.name}（${fmtTime(n.duration)}・${fmtBytes(n.size)}）／ 区切り：${how}`;
}

function renderScenes() {
  const p = state.project;
  const body = $('#sceneBody');
  const scenes = p?.scenes || [];
  if (!scenes.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">まだ場面がありません。「本文」でAIに場面を分けてもらいましょう。</td></tr>';
    $('#timeline').innerHTML = '';
    $('#timelineNote').textContent = '';
    renderNarrInfo();
    return;
  }
  const tcls = { '9:16': 'p916', '1:1': 'p11' }[p.aspect] || '';
  const times = sceneTimes();
  const narr = audioMode() === 'narration';
  body.innerHTML = scenes.map((s, i) => {
    const { from, dur: d, est } = times[i];
    const busy = state.busyScenes.has(i);
    return `<tr data-i="${i}">
      <td class="no">${i + 1}</td>
      <td class="tm">${fmtTime(from)}〜${fmtTime(from + d)}${est ? '<br><small>（目安）</small>' : ''}</td>
      <td><div class="thumb ${tcls}" data-fid="${esc(s.imageFileId || '')}">${s.imageFileId ? '…' : '未生成'}</div></td>
      <td><div class="sum">${esc(s.summary)}</div>
        <div class="tags">${esc(s.location || '')}${s.characters?.length ? '／' + esc(s.characters.join('、')) : ''}${s.bgRefFileId ? '／背景参考あり' : ''}</div>
        <div class="ex">${esc((s.text || '').slice(0, 120))}</div>
        <div>${narr ? '' : s.audioFileId ? `<span class="ok-mark">● 朗読あり（${s.audioSource === 'upload' ? '取り込み' : 'AI生成'}）</span>` : ''}</div></td>
      <td><select class="eff" aria-label="場面${i + 1}の動き">${Object.entries(EFFECTS).map(([k, v]) => `<option value="${k}" ${s.effect === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
      <td><div class="ops">${busy ? '<span class="busy">生成中…</span>' : `
        <button class="btn small ghost r-img">${s.imageFileId ? '絵を作り直す' : '絵を作る'}</button>
        ${narr ? '' : `<button class="btn small ghost r-tts">${s.audioFileId ? '朗読を作り直す' : '朗読を作る'}</button>
        <button class="btn small ghost r-imp">朗読を取り込む</button>`}
        <button class="btn small ghost r-bg">背景参考を入れる</button>
        <button class="btn small ghost r-edit">描写を編集</button>`}</div></td>
    </tr>`;
  }).join('');

  $$('tr[data-i]', body).forEach(tr => {
    const i = Number(tr.dataset.i);
    const s = scenes[i];
    $('.eff', tr).addEventListener('change', e => { s.effect = e.target.value; scheduleSave({ scenes }); });
    const on = (sel, fn) => { const b = $(sel, tr); if (b) b.addEventListener('click', fn); };
    on('.r-img', () => genOne('image', i));
    on('.r-tts', () => genOne('audio', i));
    on('.r-edit', () => openSceneModal(i));
    on('.r-imp', () => importSceneAudio(i));
    on('.r-bg', async () => {
      const f = await pickImage();
      if (!f) return;
      try {
        state.busyScenes.add(i); renderScenes();
        await flushSave();
        const j = await api('uploadFile', { projectId: state.project.id, kind: 'bgRef', sceneIdx: i, dataUrl: await shrinkImage(f) });
        state.project.scenes[i].bgRefFileId = j.project.scenes[i].bgRefFileId;
        toast('背景参考を入れました。「絵を作り直す」で反映されます');
      } catch (e) { toast(e.message, true); }
      finally { state.busyScenes.delete(i); renderScenes(); }
    });
  });
  loadThumbs(body);
  renderTimeline();
  renderNarrInfo();
}

async function loadThumbs(root) {
  const els = $$('[data-fid]', root).filter(e => e.dataset.fid && !e.querySelector('img'));
  let k = 0;
  const worker = async () => {
    while (k < els.length) {
      const el = els[k++];
      try { const a = await asset(el.dataset.fid); el.innerHTML = `<img src="${a.url}" alt="">`; }
      catch (e) { el.textContent = '読込失敗'; }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

function renderTimeline() {
  const scenes = state.project?.scenes || [];
  const tl = $('#timeline');
  const times = sceneTimes();
  const total = times.reduce((a, t) => a + t.dur, 0);
  tl.innerHTML = scenes.map((s, i) => `<div class="tl-seg ${times[i].est ? 'est' : ''}" data-i="${i}" data-fid="${esc(s.imageFileId || '')}" style="flex:${times[i].dur.toFixed(2)}" title="場面${i + 1}：${esc(s.summary)}"><span>${i + 1}</span></div>`).join('');
  $$('.tl-seg', tl).forEach(seg => {
    seg.addEventListener('click', () => {
      const i = Number(seg.dataset.i);
      if (state.step === 4) playFrom(i);
      else { const tr = $(`#sceneBody tr[data-i="${i}"]`); tr?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    });
    if (seg.dataset.fid) asset(seg.dataset.fid).then(a => { seg.style.backgroundImage = `url(${a.url})`; }).catch(() => {});
  });
  if (audioMode() === 'narration') {
    $('#timelineNote').textContent = `全${scenes.length}場面・${fmtTime(total)}（取り込んだ朗読ファイル）。` + (state.project.narration.aligned === 'ratio' ? '斜線は文字数の比率で仮に割り振った区切りです。' : '');
  } else {
    const done = scenes.filter(s => s.duration).length;
    $('#timelineNote').textContent = `全${scenes.length}場面・約${fmtTime(total)}（朗読あり ${done}/${scenes.length}）。斜線は朗読がなく、文字数からの目安です。`;
  }
}

function openSceneModal(i) {
  const s = state.project.scenes[i];
  $('#sceneModal').dataset.idx = i;
  $('#sceneModalTitle').textContent = `場面${i + 1}の編集`;
  $('#smSummary').value = s.summary || '';
  $('#smLocation').value = s.location || '';
  $('#smChars').value = (s.characters || []).join('、');
  $('#smPrompt').value = s.imagePrompt || '';
  $('#smText').textContent = s.text || '';
  $('#sceneModal').showModal();
}

/* ---------- 作風の参考絵 ---------- */
function renderStyleRefs() {
  const ids = state.project?.styleRefs || [];
  const box = $('#styleRefList');
  box.innerHTML = ids.length
    ? ids.map(id => `<figure class="sr" data-fid="${esc(id)}"><div class="sr-img">…</div><button class="sr-del" aria-label="この参考絵を外す">外す</button></figure>`).join('')
    : '<p class="note">参考絵はまだありません。</p>';
  $('#styleRefAdd').disabled = ids.length >= 3;
  $('#styleAnalyzeBtn').disabled = !ids.length;
  $$('.sr', box).forEach(fig => {
    const id = fig.dataset.fid;
    asset(id).then(a => { $('.sr-img', fig).innerHTML = `<img src="${a.url}" alt="作風の参考絵">`; }).catch(() => { $('.sr-img', fig).textContent = '読込失敗'; });
    $('.sr-del', fig).addEventListener('click', withBusy($('.sr-del', fig), async () => {
      const j = await api('removeStyleRef', { projectId: state.project.id, fileId: id });
      state.project.styleRefs = j.project.styleRefs;
      renderStyleRefs();
    }));
  });
}

/* ---------- 既存の朗読音声の取り込み ---------- */
const NARR_CHUNK = 4 * 1024 * 1024; // GeminiのFiles APIの分割単位（256KBの倍数）に合わせる
const AUDIO_ACCEPT = 'audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac';
let narrCache = { id: null, blob: null, url: null };

function audioMime(f) {
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  const byExt = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm' };
  let t = f.type || byExt[ext] || 'audio/mpeg';
  return { 'audio/x-m4a': 'audio/mp4', 'audio/mp3': 'audio/mpeg', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/x-flac': 'audio/flac' }[t] || t;
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(new Error('ファイルを読み込めませんでした'));
    r.readAsDataURL(blob);
  });
}

function audioDuration(blob) {
  return new Promise(res => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    const done = d => { URL.revokeObjectURL(url); res(d || 0); };
    a.preload = 'metadata';
    a.onloadedmetadata = async () => {
      if (isFinite(a.duration) && a.duration > 0) return done(a.duration);
      try {
        const ctx = new OfflineAudioContext(1, 1, 44100);
        const b = await ctx.decodeAudioData(await blob.arrayBuffer());
        done(b.duration);
      } catch (e) { done(0); }
    };
    a.onerror = () => done(0);
    a.src = url;
  });
}

async function importSceneAudio(i) {
  const f = await pickFile(AUDIO_ACCEPT);
  if (!f) return;
  if (f.size > 20 * 1024 * 1024) { toast('1場面の音声は20MBまでです。長い朗読は「朗読ファイルを取り込む」を使ってください', true); return; }
  state.busyScenes.add(i);
  renderScenes();
  try {
    const duration = await audioDuration(f);
    if (!duration) throw new Error('このファイルの長さを読み取れませんでした（MP3・WAV・M4Aを推奨）');
    await flushSave();
    const dataUrl = 'data:' + audioMime(f) + ';base64,' + await blobToBase64(f);
    const j = await api('uploadSceneAudio', { projectId: state.project.id, sceneIdx: i, duration, dataUrl });
    state.project.scenes[i] = j.scene;
    toast(`場面${i + 1}に朗読を取り込みました（${fmtTime(duration)}）`);
  } catch (e) { toast(e.message, true); }
  finally { state.busyScenes.delete(i); renderScenes(); }
}

async function retry(fn, times) {
  for (let k = 0; ; k++) {
    try { return await fn(); }
    catch (e) { if (k >= times) throw e; await new Promise(r => setTimeout(r, 2000 * (k + 1))); }
  }
}

async function importNarration(f) {
  if (state.running) return;
  if (f.size > 300 * 1024 * 1024) { toast('朗読ファイルは300MBまでです', true); return; }
  if (state.project.narration && !confirm('取り込み済みの朗読ファイルを置き換えますか？')) return;
  const duration = await audioDuration(f);
  if (!duration) { toast('このファイルの長さを読み取れませんでした（MP3・WAV・M4Aを推奨）', true); return; }
  state.running = true; state.stop = false;
  $('#genImagesBtn').disabled = $('#genAudioBtn').disabled = true;
  renderNarrInfo();
  $('#stopBtn').hidden = false; $('#stopBtn').textContent = '止める';
  $('#progressWrap').hidden = false;
  try {
    await flushSave();
    const uploadId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const total = Math.ceil(f.size / NARR_CHUNK);
    for (let i = 0; i < total; i++) {
      if (state.stop) throw new Error('取り込みを止めました');
      $('#progressBar').style.width = (i / total * 100) + '%';
      $('#progressText').textContent = `朗読ファイルを送信中… ${i + 1}/${total}（${fmtBytes(f.size)}）`;
      const data = await blobToBase64(f.slice(i * NARR_CHUNK, (i + 1) * NARR_CHUNK));
      await retry(() => api('narrationPart', { projectId: state.project.id, uploadId, index: i, total, data }), 2);
    }
    $('#progressText').textContent = '仕上げ中…';
    const j = await api('narrationCommit', { projectId: state.project.id, uploadId, total, mimeType: audioMime(f), name: f.name, duration });
    state.project.narration = j.project.narration;
    state.project.audioMode = 'narration';
    $$('input[name=audioMode]').forEach(x => { x.checked = x.value === 'narration'; });
    $('#progressBar').style.width = '100%';
    $('#progressText').textContent = `取り込み完了：${f.name}（${fmtTime(duration)}）`;
    toast(state.project.scenes?.length
      ? '取り込みました。いまは文字数で仮に区切っています。「AIで場面に合わせる」か「聞きながら区切る」で合わせてください'
      : '取り込みました。本文を場面に分けると、区切りを合わせられます');
  } catch (e) {
    $('#progressText').textContent = '取り込みを中断しました';
    toast(e.message, true);
  } finally {
    state.running = false;
    $('#genImagesBtn').disabled = $('#genAudioBtn').disabled = false;
    $('#stopBtn').hidden = true;
    renderScenes();
  }
}

// 分割保存された朗読を1本に戻す（作品ごとに1回だけ）
async function narrationBlob(onProg) {
  const n = state.project.narration;
  if (narrCache.id === n.uploadId) return narrCache;
  const blobs = [];
  for (let i = 0; i < n.parts.length; i++) {
    if (onProg) onProg(i, n.parts.length);
    blobs.push((await asset(n.parts[i])).blob);
  }
  const blob = new Blob(blobs, { type: n.mimeType });
  n.parts.forEach(id => { const c = assetCache.get(id); if (c) c.then(a => URL.revokeObjectURL(a.url)).catch(() => {}); assetCache.delete(id); });
  if (narrCache.url) URL.revokeObjectURL(narrCache.url);
  narrCache = { id: n.uploadId, blob, url: URL.createObjectURL(blob) };
  return narrCache;
}

function initTapAlign() {
  const m = $('#tapModal'), au = $('#tapAudio');
  let marks = [], k = 1;
  const head = t => (t || '').replace(/\s+/g, '').slice(0, 40) + '…';
  const show = () => {
    const sc = state.project.scenes;
    $('#tapCur').textContent = `場面${k}／${sc.length}　${sc[k - 1].summary}`;
    $('#tapNext').textContent = k < sc.length ? `場面${k + 1}：${head(sc[k].text)}` : '（最後の場面です）';
    $('#tapMark').disabled = k >= sc.length;
    $('#tapUndo').disabled = k <= 1;
  };
  const mark = () => {
    const sc = state.project.scenes;
    if (k >= sc.length) return;
    const t = au.currentTime;
    if (t <= marks[k - 1] + 0.3) { toast('前の区切りより後ろで押してください', true); return; }
    marks[k] = Math.round(t * 10) / 10;
    k++;
    show();
    if (k >= sc.length) toast('最後の場面まで区切りました。「区切りを保存」を押してください');
  };
  $('#tapAlignBtn').addEventListener('click', withBusy($('#tapAlignBtn'), async () => {
    const sc = state.project.scenes || [];
    if (sc.length < 2) throw new Error('場面が2つ以上必要です');
    $('#tapAlignBtn').textContent = '朗読を読み込み中…';
    const nc = await narrationBlob();
    if (au.src !== nc.url) au.src = nc.url;
    au.currentTime = 0;
    marks = sc.map((x, i) => i === 0 ? 0 : null);
    k = 1;
    show();
    m.showModal();
    $('#tapMark').focus();
  }));
  $('#tapRate').addEventListener('change', () => { au.playbackRate = Number($('#tapRate').value); });
  au.addEventListener('play', () => { au.playbackRate = Number($('#tapRate').value); });
  $('#tapMark').addEventListener('click', mark);
  $('#tapUndo').addEventListener('click', () => {
    if (k <= 1) return;
    k--;
    marks[k] = null;
    au.currentTime = Math.max(0, marks[k - 1]);
    show();
  });
  m.addEventListener('keydown', e => {
    if (e.code === 'Space' && e.target.tagName !== 'SELECT') { e.preventDefault(); e.stopPropagation(); mark(); }
  }, true);
  m.addEventListener('close', () => au.pause());
  $('#tapCancel').addEventListener('click', () => m.close());
  $('#tapSave').addEventListener('click', () => {
    const n = state.project.narration;
    n.starts = fillStarts(marks, n.duration);
    n.aligned = 'manual';
    scheduleSave({ narrationStarts: n.starts });
    m.close();
    renderScenes();
    toast('区切りを保存しました');
  });
}

/* ---------- 生成 ---------- */
async function genOne(kind, i) {
  if (state.busyScenes.has(i)) return;
  state.busyScenes.add(i);
  renderScenes();
  try {
    await flushSave();
    const j = await api(kind === 'image' ? 'generateImage' : 'generateTTS', { projectId: state.project.id, sceneIdx: i });
    state.project.scenes[i] = j.scene;
    return true;
  } catch (e) {
    toast(`場面${i + 1}：${e.message}`, true);
    return false;
  } finally {
    state.busyScenes.delete(i);
    renderScenes();
  }
}

async function runBatch(kind) {
  if (state.running) return;
  const scenes = state.project?.scenes || [];
  if (!scenes.length) { toast('先に本文をAIで場面に分けてください', true); return; }
  const key = kind === 'image' ? 'imageFileId' : 'audioFileId';
  let targets = scenes.map((s, i) => i).filter(i => !scenes[i][key]);
  if (!targets.length) {
    if (!confirm(`すべての場面で${kind === 'image' ? '絵' : '朗読'}が生成済みです。全部作り直しますか？`)) return;
    targets = scenes.map((s, i) => i);
  }
  state.running = true; state.stop = false;
  $('#genImagesBtn').disabled = $('#genAudioBtn').disabled = true;
  $('#stopBtn').hidden = false; $('#stopBtn').textContent = '止める';
  $('#progressWrap').hidden = false;
  let ok = 0, ng = 0;
  for (let n = 0; n < targets.length; n++) {
    if (state.stop) break;
    $('#progressBar').style.width = (n / targets.length * 100) + '%';
    $('#progressText').textContent = `${kind === 'image' ? '絵' : '朗読'}を生成中… ${n + 1}/${targets.length}（場面${targets[n] + 1}）`;
    (await genOne(kind, targets[n])) ? ok++ : ng++;
  }
  $('#progressBar').style.width = '100%';
  $('#progressText').textContent = `完了：成功${ok}・失敗${ng}${state.stop ? '（途中で止めました）' : ''}`;
  state.running = false;
  $('#genImagesBtn').disabled = $('#genAudioBtn').disabled = false;
  $('#stopBtn').hidden = true;
  toast(ng ? `${ng}件失敗しました。個別に作り直してください` : '生成が終わりました', !!ng);
}

/* ---------- 上演（Canvas＋Web Audio） ---------- */
const pl = {
  ctx: null, cv: null, g: null, images: [], buffers: [], caps: [],
  idx: 0, prev: null, src: null, startAt: 0, dur: 0, raf: 0,
  playing: false, paused: false, dest: null, rec: null, recChunks: [], ready: false, loadingFor: null
};

function ease(x) { return x < .5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

function buildCaptions(text, maxLen) {
  const sents = (text || '').replace(/\n/g, '').match(/[^。！？!?]+[。！？!?」』）)]*/g) || [];
  const pieces = [];
  sents.forEach(s => { for (let i = 0; i < s.length; i += maxLen) pieces.push(s.slice(i, i + maxLen)); });
  const total = pieces.reduce((a, s) => a + s.length, 0) || 1;
  let acc = 0;
  return pieces.map(s => { const from = acc / total; acc += s.length; return { text: s, from, to: acc / total }; });
}

async function preparePlayer() {
  const p = state.project;
  const scenes = p?.scenes || [];
  pl.cv = $('#stageCanvas'); pl.g = pl.cv.getContext('2d');
  const [W, H] = CANVAS[p.aspect] || CANVAS['16:9'];
  pl.cv.width = W; pl.cv.height = H;
  $('#butaiTitle').textContent = p.title || '';
  renderCueList();
  if (!scenes.length) { $('#prepStatus').textContent = '場面がありません'; drawCard('場面がまだありません'); return; }
  const mode = audioMode();
  const sig = p.id + ':' + mode + ':' + (mode === 'narration' ? p.narration.uploadId : '') + ':' + scenes.map(s => (s.imageFileId || '') + (s.audioFileId || '')).join('|');
  if (pl.ready && pl.loadingFor === sig) { $('#prepStatus').textContent = '準備できています'; return; }
  pl.ready = false; pl.loadingFor = sig;
  if (!pl.ctx) pl.ctx = new (window.AudioContext || window.webkitAudioContext)();
  $('#playBtn').disabled = $('#recordBtn').disabled = true;
  drawCard(p.title || 'ものがたり紙芝居');
  pl.images = []; pl.buffers = [];
  const capLen = W > H ? 34 : 18;
  pl.caps = scenes.map(s => buildCaptions(s.text, capLen));
  let done = 0;
  const total = scenes.length;
  const status = () => { $('#prepStatus').textContent = `素材を読み込み中… ${done}/${total}`; };
  status();
  let k = 0;
  const worker = async () => {
    while (k < total) {
      const i = k++;
      const s = scenes[i];
      try {
        if (s.imageFileId) {
          const a = await asset(s.imageFileId);
          pl.images[i] = await createImageBitmap(a.blob);
        }
        if (mode === 'scenes' && s.audioFileId) {
          const a = await asset(s.audioFileId);
          pl.buffers[i] = await pl.ctx.decodeAudioData(await a.blob.arrayBuffer());
        }
      } catch (e) { console.warn('素材の読み込み失敗', i, e); }
      done++; status();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (pl.loadingFor !== sig) return;
  pl.mode = mode;
  if (mode === 'narration') {
    try {
      const nc = await narrationBlob((i, t) => { $('#prepStatus').textContent = `朗読ファイルを読み込み中… ${i + 1}/${t}`; });
      if (pl.narrUrl !== nc.url) {
        if (pl.narrEl) pl.narrEl.pause();
        const el = new Audio();
        el.preload = 'auto';
        el.src = nc.url;
        el.addEventListener('ended', () => { if (pl.playing) finishPlayback(); });
        pl.narrEl = el;
        pl.narrNode = pl.ctx.createMediaElementSource(el);
        pl.narrNode.connect(pl.ctx.destination);
        pl.narrUrl = nc.url;
      }
    } catch (e) {
      $('#prepStatus').textContent = '朗読ファイルを読み込めませんでした：' + e.message;
      pl.loadingFor = null;
      return;
    }
    if (pl.loadingFor !== sig) return;
  }
  pl.ready = true;
  const noImg = scenes.filter((s, i) => !pl.images[i]).length;
  const noAud = mode === 'narration' ? 0 : scenes.filter((s, i) => !pl.buffers[i]).length;
  $('#prepStatus').textContent = (noImg || noAud)
    ? `準備できました（絵なし${noImg}場面・朗読なし${noAud}場面は、文字の札と無音で進みます）`
    : '準備できました';
  $('#playBtn').disabled = $('#recordBtn').disabled = false;
}

function renderCueList() {
  const scenes = state.project?.scenes || [];
  $('#cueList').innerHTML = scenes.map((s, i) => `<li data-i="${i}"><b>${i + 1}</b><span>${esc(s.summary)}</span></li>`).join('');
  $$('#cueList li').forEach(li => li.addEventListener('click', () => pl.ready && playFrom(Number(li.dataset.i))));
}

function markNow(i) {
  $$('#cueList li').forEach(li => li.classList.toggle('now', Number(li.dataset.i) === i));
  const cur = $(`#cueList li[data-i="${i}"]`);
  cur?.scrollIntoView({ block: 'nearest' });
}

function drawCard(text) {
  const { g, cv } = pl;
  if (!g) return;
  g.fillStyle = '#f2f3ee'; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#26231f';
  g.font = `${Math.round(cv.width / 20)}px "Dela Gothic One", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  wrapText(text, cv.width / 2, cv.height / 2, cv.width * .8, cv.width / 14);
}

function wrapText(text, x, y, maxW, lh) {
  const g = pl.g;
  const lines = [];
  let cur = '';
  for (const ch of text) { if (g.measureText(cur + ch).width > maxW) { lines.push(cur); cur = ch; } else cur += ch; }
  if (cur) lines.push(cur);
  const top = y - (lines.length - 1) * lh / 2;
  lines.forEach((l, i) => g.fillText(l, x, top + i * lh));
}

function drawScene(i, p, elapsed, alpha) {
  const { g, cv } = pl;
  const W = cv.width, H = cv.height;
  const s = state.project.scenes[i];
  const img = pl.images[i];
  g.save();
  g.globalAlpha = alpha;
  if (!img) {
    g.fillStyle = '#f2f3ee'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#26231f';
    g.font = `${Math.round(W / 26)}px "Dela Gothic One", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    wrapText(s.summary || '', W / 2, H / 2, W * .8, W / 18);
    g.restore();
    return;
  }
  const e = ease(Math.min(1, Math.max(0, p)));
  const base = Math.max(W / img.width, H / img.height);
  let z = 1.12, ox = 0, oy = 0, slide = 0;
  switch (s.effect) {
    case 'zoomIn': z = 1.0 + .16 * e; break;
    case 'zoomOut': z = 1.16 - .16 * e; break;
    case 'panLeft': z = 1.18; ox = -.5 + e; break;
    case 'panRight': z = 1.18; ox = .5 - e; break;
    case 'panUp': z = 1.18; oy = -.5 + e; break;
    case 'panDown': z = 1.18; oy = .5 - e; break;
    case 'slideIn': {
      const k = Math.min(1, elapsed / 1.4);
      slide = (1 - (1 - Math.pow(1 - k, 3))) * W;
      z = 1.04 + .06 * e; break;
    }
    default: z = 1;
  }
  const sw = img.width * base * z, sh = img.height * base * z;
  const x = (W - sw) / 2 + ox * (sw - W) + slide;
  const y = (H - sh) / 2 + oy * (sh - H);
  g.drawImage(img, x, y, sw, sh);
  g.restore();
}

function drawCaption(i, p) {
  if (!$('#subToggle').checked) return;
  const cap = (pl.caps[i] || []).find(c => p >= c.from && p < c.to) || (pl.caps[i] || []).slice(-1)[0];
  if (!cap) return;
  const { g, cv } = pl;
  const W = cv.width, H = cv.height;
  const fs = Math.round(Math.min(W, H) / 22);
  g.font = `500 ${fs}px "Zen Kaku Gothic New", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const bh = fs * 2.2;
  g.fillStyle = 'rgba(20,18,15,.62)';
  g.fillRect(0, H - bh - fs * .6, W, bh);
  g.fillStyle = '#fff';
  g.fillText(cap.text, W / 2, H - bh / 2 - fs * .6, W * .94);
}

function frame() {
  if (!pl.playing) return;
  let el, p;
  if (pl.mode === 'narration') {
    const t = pl.narrEl.currentTime;
    const times = sceneTimes();
    let i = 0;
    for (let k = 0; k < times.length; k++) if (times[k].from <= t) i = k;
    if (i !== pl.idx) {
      pl.prev = i === pl.idx + 1 ? pl.idx : null;
      pl.idx = i;
      markNow(i);
    }
    el = t - times[i].from;
    p = el / times[i].dur;
  } else {
    el = pl.ctx.currentTime - pl.startAt;
    p = pl.dur ? el / pl.dur : 1;
  }
  const fade = 0.8;
  pl.g.fillStyle = '#1c1a17';
  pl.g.fillRect(0, 0, pl.cv.width, pl.cv.height);
  if (pl.prev != null && el < fade && state.project.scenes[pl.idx].effect !== 'slideIn') {
    drawScene(pl.prev, 1, 99, 1);
    drawScene(pl.idx, p, el, el / fade);
  } else if (pl.prev != null && el < 1.4 && state.project.scenes[pl.idx].effect === 'slideIn') {
    drawScene(pl.prev, 1, 99, 1);
    drawScene(pl.idx, p, el, 1);
  } else {
    drawScene(pl.idx, p, el, 1);
  }
  drawCaption(pl.idx, p);
  pl.raf = requestAnimationFrame(frame);
}

function startScene() {
  const i = pl.idx;
  const s = state.project.scenes[i];
  let buf = pl.buffers[i];
  if (!buf) {
    const sec = Math.max(3, (s.text || '').length / CHARS_PER_SEC);
    buf = pl.ctx.createBuffer(1, Math.round(pl.ctx.sampleRate * sec), pl.ctx.sampleRate);
  }
  const src = pl.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(pl.ctx.destination);
  if (pl.dest) src.connect(pl.dest);
  src.onended = () => {
    if (src !== pl.src || !pl.playing) return;
    if (pl.idx + 1 < state.project.scenes.length) { pl.prev = pl.idx; pl.idx++; startScene(); }
    else finishPlayback();
  };
  pl.src = src;
  pl.dur = buf.duration;
  pl.startAt = pl.ctx.currentTime;
  src.start();
  markNow(i);
  $$('.tl-seg').forEach(t => t.classList.toggle('now', Number(t.dataset.i) === i));
}

async function playFrom(i) {
  if (!pl.ready) return;
  await pl.ctx.resume();
  stopSource();
  pl.prev = null; pl.idx = i; pl.playing = true; pl.paused = false;
  setControls();
  cancelAnimationFrame(pl.raf);
  if (pl.mode === 'narration') {
    pl.narrEl.currentTime = sceneTimes()[i].from;
    markNow(i);
    try { await pl.narrEl.play(); } catch (e) { toast('朗読を再生できませんでした', true); pl.playing = false; setControls(); return; }
  } else startScene();
  pl.raf = requestAnimationFrame(frame);
}

function stopSource() {
  if (pl.narrEl) pl.narrEl.pause();
  if (pl.src) { const s = pl.src; pl.src = null; try { s.onended = null; s.stop(); } catch (e) { } }
}

function finishPlayback() {
  pl.playing = false;
  cancelAnimationFrame(pl.raf);
  stopSource();
  // 最後の絵を少し残してから「おしまい」
  drawScene(pl.idx, 1, 99, 1);
  if (pl.rec) setTimeout(() => { if (pl.rec && pl.rec.state !== 'inactive') pl.rec.stop(); }, 800);
  setControls();
  markNow(-1);
}

function stopPlayback(full) {
  if (!pl.ctx) return;
  pl.playing = false;
  cancelAnimationFrame(pl.raf);
  stopSource();
  if (pl.rec && pl.rec.state !== 'inactive') { pl.recCancel = true; pl.rec.stop(); }
  if (pl.ctx.state === 'suspended') pl.ctx.resume();
  pl.paused = false;
  if (full) { pl.ready = false; pl.loadingFor = null; }
  setControls();
}

function setControls() {
  $('#playBtn').textContent = pl.playing ? '最初から上演' : '上演する';
  $('#pauseBtn').disabled = !pl.playing;
  $('#pauseBtn').textContent = pl.paused ? '再開' : '一時停止';
  $('#stopPlayBtn').disabled = !pl.playing;
  const rec = !!(pl.rec && pl.rec.state === 'recording');
  $('#recordBtn').textContent = rec ? '書き出しを中止' : '動画として書き出す（WebM）';
  $('#recordBtn').classList.toggle('rec', rec);
  $('#pauseBtn').disabled = !pl.playing || rec;
}

function initPlayer() {
  $('#playBtn').addEventListener('click', () => playFrom(0));
  $('#pauseBtn').addEventListener('click', async () => {
    if (!pl.playing) return;
    if (pl.mode === 'narration') {
      if (pl.paused) { await pl.narrEl.play(); pl.paused = false; }
      else { pl.narrEl.pause(); pl.paused = true; }
    } else if (pl.paused) { await pl.ctx.resume(); pl.paused = false; }
    else { await pl.ctx.suspend(); pl.paused = true; }
    setControls();
  });
  $('#stopPlayBtn').addEventListener('click', () => {
    stopPlayback(false);
    drawCard(state.project.title || '');
    markNow(-1);
  });
  $('#recordBtn').addEventListener('click', () => {
    if (pl.rec && pl.rec.state === 'recording') { stopPlayback(false); toast('書き出しを中止しました'); return; }
    startRecording();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && pl.rec && pl.rec.state === 'recording') toast('書き出し中は、このタブを表示したままにしてください', true);
  });
}

async function startRecording() {
  if (!pl.ready) return;
  if (!window.MediaRecorder || !pl.cv.captureStream) { toast('このブラウザは動画の書き出しに対応していません（Chrome推奨）', true); return; }
  const total = pl.mode === 'narration' ? state.project.narration.duration
    : state.project.scenes.reduce((a, s, i) => a + (pl.buffers[i] ? pl.buffers[i].duration : sceneDur(s)), 0);
  if (!confirm(`上演をそのまま録画します（約${fmtTime(total)}）。終わるまでこのタブを表示したままにしてください。始めますか？`)) return;
  await pl.ctx.resume();
  pl.dest = pl.ctx.createMediaStreamDestination();
  if (pl.mode === 'narration') pl.narrNode.connect(pl.dest);
  const stream = new MediaStream([...pl.cv.captureStream(30).getVideoTracks(), ...pl.dest.stream.getAudioTracks()]);
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m));
  pl.recChunks = []; pl.recCancel = false;
  pl.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5e6 });
  pl.rec.ondataavailable = e => { if (e.data.size) pl.recChunks.push(e.data); };
  pl.rec.onstop = () => {
    if (pl.narrNode && pl.dest) try { pl.narrNode.disconnect(pl.dest); } catch (e) { }
    pl.dest = null;
    const cancelled = pl.recCancel;
    pl.rec = null;
    setControls();
    if (cancelled) return;
    const blob = new Blob(pl.recChunks, { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.project.title || 'kamishibai') + (mime.includes('mp4') ? '.mp4' : '.webm');
    document.body.appendChild(a); a.click(); a.remove();
    toast('動画を保存しました');
  };
  pl.rec.start(1000);
  await playFrom(0);
  setControls();
}

/* ---------- 起動 ---------- */
async function boot() {
  $('#version').textContent = 'v' + VERSION;
  initAuth(); initSettings(); initEditor(); initPlayer();
  window.addEventListener('beforeunload', e => {
    if (state.pendingSave || state.running || (pl.rec && pl.rec.state === 'recording')) { e.preventDefault(); e.returnValue = ''; }
  });
  if (!gasUrl()) { showAuth('login'); openSettings(); return; }
  if (!state.token) { showAuth('login'); return; }
  try {
    const j = await api('me');
    state.name = j.name;
    if (j.mustChange) showAuth('change'); else enterApp();
  } catch (e) {
    if (!$('#authView').hidden) return;
    showAuth('login');
  }
}

boot();
})();
