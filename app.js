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
  $('#usageBtn').addEventListener('click', withBusy($('#usageBtn'), async () => {
    const j = await api('getUsage');
    const label = { analyze: '場面に分ける', suggestSceneCount: 'おすすめ枚数', suggestEffects: '画面の動き', analyzeStyle: '作風づくり',
      generateImage: '場面の絵', generateCharacterSheet: '三面図', generateTTS: 'AI朗読', alignWindow: '字幕同期', alignNarration: '場面合わせ（旧）' };
    const n = x => Math.round(x).toLocaleString();
    const rows = j.usage.map(u => `<tr><td>${esc(label[u.action] || u.action)}<br><small>${esc(u.model)}</small></td><td>${u.calls}</td><td>${n(u.input)}</td><td>${n(u.output)}</td><td>${n(u.thinking)}</td></tr>`).join('');
    const sum = k => j.usage.reduce((a, u) => a + u[k], 0);
    $('#usageTable').innerHTML = j.usage.length
      ? `<thead><tr><th>操作</th><th>回数</th><th>入力</th><th>出力</th><th>考える</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td>合計</td><td>${sum('calls')}</td><td>${n(sum('input'))}</td><td>${n(sum('output'))}</td><td>${n(sum('thinking'))}</td></tr></tfoot>`
      : '<tbody><tr><td>まだ記録がありません（v2.0.0以降の使用分から記録します）</td></tr></tbody>';
  }));
  // スマホ用メニュー
  const nav = $('#topnav'), mb = $('#menuBtn');
  const closeMenu = () => { nav.classList.remove('open'); mb.setAttribute('aria-expanded', 'false'); };
  mb.addEventListener('click', e => {
    e.stopPropagation();
    const open = !nav.classList.contains('open');
    nav.classList.toggle('open', open);
    mb.setAttribute('aria-expanded', String(open));
  });
  $$('.link-btn', nav).forEach(b => b.addEventListener('click', closeMenu));
  document.addEventListener('click', e => { if (!nav.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
  $('#navHome').addEventListener('click', async () => { if (state.project) await flushSave(); showList(); });
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
  $$('input[name=sceneMode]').forEach(r => { r.checked = r.value === (p.sceneMode || 'auto'); });
  $('#sceneCount').value = p.sceneCount || 40;
  $('#sceneSec').value = p.sceneSec || 60;
  renderScenePlan();
  $$('input[name=aspect]').forEach(r => { r.checked = r.value === (p.aspect || '16:9'); });
  $('#styleInput').value = p.style || '';
  $('#styleRefAttach').checked = p.styleRefAttach === true;
  renderStyleRefs();
  $('#voiceSelect').value = p.voice || 'Kore';
  $('#subToggle').checked = p.subtitles !== false;
  renderAllowedEffects();
  $$('input[name=audioMode]').forEach(r => { r.checked = r.value === audioMode(); });
  $('#saveState').textContent = '';
  renderChars();
  renderScenes();
  goStep(step || (p.scenes && p.scenes.length ? 3 : 1));
}

function goStep(n) {
  if (state.step === 4 && n !== 4) { if (isFs()) exitFs(); stopPlayback(false); }
  state.step = n;
  $$('.step-tab').forEach(b => {
    const on = Number(b.dataset.step) === n;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  [1, 2, 3, 4].forEach(i => { $('#pane' + i).hidden = i !== n; });
  if (window.matchMedia('(max-width: 860px)').matches) window.scrollTo({ top: 0 });
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
    Object.keys(f).forEach(k => { if (!['scenes', 'characters', 'narrationStarts', 'narrationAligned'].includes(k)) state.project[k] = j.project[k]; });
    state.project.updatedAt = j.project.updatedAt;
    $('#saveState').textContent = '保存済み';
  } catch (e) {
    $('#saveState').textContent = '保存に失敗';
    toast(e.message, true);
  }
}

/* ---------- 場面の数の計画 ---------- */
// 全体の長さ：取り込んだ朗読 → 生成済みの朗読の合計 → 文字数からの目安 の順で使う
function totalReadSec() {
  const p = state.project;
  if (p?.narration?.duration) return { sec: p.narration.duration, src: '取り込んだ朗読' };
  const sc = p?.scenes || [];
  if (sc.length && sc.every(s => s.duration)) return { sec: sc.reduce((a, s) => a + s.duration, 0), src: '生成済みの朗読' };
  return { sec: ($('#novelText').value.length || 0) / CHARS_PER_SEC, src: '文字数からの目安' };
}

function sceneMult() { return Number(state.project?.sceneMult) || 1; }

// AIのおすすめ枚数（未取得なら文字数からの目安）
function aiBase() {
  const p = state.project;
  const n = $('#novelText').value.length;
  if (p?.aiSceneBase) {
    const stale = Math.abs(n - (p.aiSceneTextLen || 0)) > Math.max(200, n * 0.05);
    return { base: p.aiSceneBase, ai: true, stale };
  }
  return { base: Math.max(4, Math.min(60, Math.round(n / 700))), ai: false, stale: false };
}

function scenePlan() {
  const mode = ($$('input[name=sceneMode]').find(r => r.checked) || {}).value || 'auto';
  const n = $('#novelText').value.length;
  const { sec } = totalReadSec();
  let count;
  if (mode === 'count') count = Number($('#sceneCount').value) || 0;
  else if (mode === 'seconds') count = Math.round(sec / Math.max(5, Number($('#sceneSec').value) || 60));
  else count = Math.round(aiBase().base * sceneMult());
  const capped = count > 150;
  count = Math.max(2, Math.min(150, count));
  return { mode, count, sec, capped };
}

async function suggestCount() {
  scheduleSave({ text: $('#novelText').value });
  await flushSave();
  const j = await api('suggestSceneCount', { projectId: state.project.id, durationSec: totalReadSec().sec });
  ['aiSceneBase', 'aiSceneReason', 'aiSceneTextLen'].forEach(k => { state.project[k] = j.project[k]; });
  renderScenePlan();
}

function renderScenePlan() {
  if (!state.project) return;
  const { mode, count, sec, capped } = scenePlan();
  const { src } = totalReadSec();
  const per = sec / count;
  const chars = Math.round(($('#novelText').value.length || 0) / count);
  const b = aiBase();
  const head = mode === 'auto'
    ? `${b.ai ? 'AIのおすすめ' : '目安'} ${b.base}場面 × ${sceneMult()}倍 ＝ ${count}場面${capped ? '（上限の150場面）' : ''}`
    : `${count}場面（絵${count}枚）${capped ? '※上限の150場面' : ''}`;
  $$('#multBtns button').forEach(x => x.setAttribute('aria-pressed', String(Number(x.dataset.m) === sceneMult())));
  $('#aiBaseInfo').textContent = b.ai
    ? (b.stale ? '本文が変わったので、出し直すのがおすすめです' : `おすすめ ${b.base}場面：${state.project.aiSceneReason || ''}`)
    : 'まだ出していません（いまは文字数からの目安で計算）';
  $('#sceneEstimate').textContent = `${head}　／　1場面あたり 平均${fmtTime(per)}・約${chars.toLocaleString()}字　（全体 ${fmtTime(sec)}：${src}）`;
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
    renderScenePlan();
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
  $$('input[name=sceneMode]').forEach(r => r.addEventListener('change', () => { scheduleSave({ sceneMode: r.value }); renderScenePlan(); }));
  $$('#multBtns button').forEach(b => b.addEventListener('click', () => {
    state.project.sceneMult = Number(b.dataset.m);
    $$('input[name=sceneMode]').forEach(x => { x.checked = x.value === 'auto'; });
    scheduleSave({ sceneMode: 'auto', sceneMult: state.project.sceneMult });
    renderScenePlan();
  }));
  $('#suggestBtn').addEventListener('click', withBusy($('#suggestBtn'), async () => {
    $('#suggestBtn').textContent = 'AIが読んでいます…';
    await suggestCount();
    toast(`AIのおすすめは${state.project.aiSceneBase}場面です。倍率を選んでください`);
  }));
  $('#sceneCount').addEventListener('input', () => {
    $$('input[name=sceneMode]').forEach(x => { x.checked = x.value === 'count'; });
    scheduleSave({ sceneMode: 'count', sceneCount: Number($('#sceneCount').value) || 0 });
    renderScenePlan();
  });
  $('#sceneSec').addEventListener('input', () => {
    $$('input[name=sceneMode]').forEach(x => { x.checked = x.value === 'seconds'; });
    scheduleSave({ sceneMode: 'seconds', sceneSec: Number($('#sceneSec').value) || 0 });
    renderScenePlan();
  });

  $('#analyzeBtn').addEventListener('click', withBusy($('#analyzeBtn'), async () => {
    const text = $('#novelText').value;
    if (text.length < 100) throw new Error('本文を100字以上入れてください');
    if (text.length > MAX_TEXT) throw new Error(`本文は${MAX_TEXT.toLocaleString()}字までです`);
    if (state.project.scenes?.length && !confirm('場面を分け直すと、生成済みの絵と朗読は削除されます。続けますか？')) return;
    $('#analyzeBtn').textContent = 'AIが読んでいます…（1分ほど）';
    scheduleSave({ text });
    await flushSave();
    // おまかせで、おすすめ枚数がまだ（または本文が変わった）なら先に出す
    if (($$('input[name=sceneMode]').find(r => r.checked) || {}).value === 'auto' && (!aiBase().ai || aiBase().stale)) {
      $('#analyzeBtn').textContent = 'AIが最適な枚数を考えています…';
      await suggestCount();
    }
    const plan = scenePlan();
    if (plan.count > 100 && !confirm(`${plan.count}場面に分けます。絵の生成にかなり時間がかかりますが、よろしいですか？`)) return;
    $('#analyzeBtn').textContent = plan.count > 60 ? 'AIが読んでいます…（2〜3分）' : 'AIが読んでいます…（1分ほど）';
    const j = await api('analyze', { projectId: state.project.id, sceneCount: plan.count });
    state.project = j.project;
    const got = j.project.scenes.length;
    if (got !== plan.count) toast(`本文の区切りの都合で${got}場面になりました`, true);
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
    const j = await api('uploadFile', { projectId: state.project.id, kind: 'styleRef', dataUrl: await shrinkImage(f, 768) });
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
  $('#capOffset').value = String(capOffset());
  $('#capOffset').addEventListener('change', () => localStorage.setItem('mk_cap_offset', $('#capOffset').value));
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
  // 場面の区切り合わせは字幕同期と同時に行う（同じ朗読をAIに2回聞かせない）
  $('#alignAiBtn').addEventListener('click', () => runCaptionSync());
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
  $('#effAiBtn').addEventListener('click', withBusy($('#effAiBtn'), async () => {
    if (!(state.project.scenes || []).length) throw new Error('先に本文を場面に分けてください');
    $('#effAiBtn').textContent = 'AIが演出を考えています…';
    await flushSave();
    const j = await api('suggestEffects', { projectId: state.project.id, allowed: allowedEffects() });
    j.project.scenes.forEach((s, i) => { if (state.project.scenes[i]) state.project.scenes[i].effect = s.effect; });
    state.project.allowedEffects = j.project.allowedEffects;
    renderScenes();
    pl.loadingFor = null; // 上演の準備をやり直す
    toast('全場面の動きをAIが付け直しました');
  }));
  $('#effReplaceBtn').addEventListener('click', () => {
    const n = replaceDisallowedEffects();
    if (!n) { toast('使わない動きの場面はありません'); return; }
    scheduleSave({ scenes: state.project.scenes });
    renderScenes();
    toast(`${n}場面の動きを置き換えました`);
  });
  $('#capSyncBtn').addEventListener('click', runCaptionSync);

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
      const j = await api('uploadFile', { projectId: state.project.id, kind: 'charRef', charId: c.id, dataUrl: await shrinkImage(f, 1024) });
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
        const j = await api('uploadFile', { projectId: state.project.id, kind: 'bgRef', sceneIdx: i, dataUrl: await shrinkImage(f, 768) });
        state.project.scenes[i].bgRefFileId = j.project.scenes[i].bgRefFileId;
        toast('背景参考を入れました。「絵を作り直す」で反映されます');
      } catch (e) { toast(e.message, true); }
      finally { state.busyScenes.delete(i); renderScenes(); }
    });
  });
  loadThumbs(body);
  renderTimeline();
  renderNarrInfo();
  renderCapSyncInfo();
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

/* ---------- 画面の動きの設定 ---------- */
function allowedEffects() {
  const a = state.project?.allowedEffects;
  const list = (Array.isArray(a) ? a : Object.keys(EFFECTS)).filter(k => EFFECTS[k]);
  return list.length ? list : Object.keys(EFFECTS);
}

function renderAllowedEffects() {
  const box = $('#effAllowed');
  const on = allowedEffects();
  box.innerHTML = Object.entries(EFFECTS).map(([k, v]) => `<label><input type="checkbox" value="${k}" ${on.includes(k) ? 'checked' : ''}> ${v}</label>`).join('');
  $$('input', box).forEach(c => c.addEventListener('change', () => {
    const list = $$('input', box).filter(x => x.checked).map(x => x.value);
    if (!list.length) { c.checked = true; toast('動きは1つ以上選んでください', true); return; }
    state.project.allowedEffects = list;
    scheduleSave({ allowedEffects: list });
  }));
}

// 使わない動きの場面だけ、前後と重ならない動きに置き換える
function replaceDisallowedEffects() {
  const allowed = allowedEffects();
  const sc = state.project.scenes || [];
  let n = 0;
  sc.forEach((s, i) => {
    if (allowed.includes(s.effect)) return;
    const prev = i > 0 ? sc[i - 1].effect : null, next = i + 1 < sc.length ? sc[i + 1].effect : null;
    const cand = allowed.filter(x => x !== prev && x !== next);
    const pool = cand.length ? cand : allowed;
    s.effect = pool[i % pool.length];
    n++;
  });
  return n;
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
  if (kind === 'audio' && audioMode() === 'narration') {
    toast('取り込んだ朗読ファイルを使う設定なので、AIの朗読は作りません（使用量の節約）。必要なら「場面ごとの音声」に切り替えてください', true);
    return;
  }
  if (!targets.length) {
    if (!confirm(`すべての場面で${kind === 'image' ? '絵' : '朗読'}が生成済みです。全部作り直しますか？（AIを${scenes.length}回使います）`)) return;
    targets = scenes.map((s, i) => i);
  } else if (!confirm(`${kind === 'image' ? '絵' : '朗読'}がない${targets.length}場面を生成します（AIを約${kind === 'image' ? targets.length : targets.reduce((a, i) => a + Math.ceil((scenes[i].text || '').length / 600), 0)}回使います）。よろしいですか？`)) return;
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

/* ---------- 字幕と音声の同期 ----------
   朗読の「間（無音）」を検出し、文の切れ目を実際の間に合わせる。
   文字数の比率で見込んだ位置の近くにある間を選び、選んだ位置を基準に次の見込みを立て直すので、
   読む速さが場面の途中で変わってもずれが積み重ならない。 */
const ENV_HOP = 0.02; // 音量の包絡線を20ミリ秒ごとに計算

function capSegments(text, maxLen) {
  const t = (text || '').replace(/［＃[^］]*］/g, '').replace(/《[^》]*》/g, '').replace(/[｜|]/g, '');
  const sents = t.split('\n').flatMap(line => line.match(/[^。！？!?]+[。！？!?」』）)]*/g) || []).map(s => s.trim()).filter(Boolean);
  const out = [];
  sents.forEach(s => {
    let rest = s, first = true;
    while (rest.length > maxLen) {
      // 長い文は読点で区切る（読点のところには短い間があることが多い）
      let cut = rest.lastIndexOf('、', maxLen - 1);
      // 読点がなければ均等に割り、最後に数文字だけ残る字幕を作らない
      if (cut < Math.floor(maxLen * 0.4)) cut = rest.length <= maxLen * 2 ? Math.ceil(rest.length / 2) - 1 : maxLen - 1;
      out.push({ text: rest.slice(0, cut + 1), major: first });
      rest = rest.slice(cut + 1);
      first = false;
    }
    if (rest) out.push({ text: rest, major: first });
  });
  return out;
}

function envelope(data, rate) {
  const step = Math.max(1, Math.floor(rate * ENV_HOP));
  const n = Math.floor(data.length / step);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    const o = i * step;
    for (let k = 0; k < step; k += 4) { const v = data[o + k]; s += v * v; c++; }
    env[i] = Math.sqrt(s / c);
  }
  return env;
}

function percentile(env, a, b, q) {
  const arr = [];
  const stride = Math.max(1, Math.floor((b - a) / 4000));
  for (let i = a; i < b; i += stride) arr.push(env[i]);
  if (!arr.length) return 0;
  arr.sort((x, y) => x - y);
  return arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
}

function alignCaps(segs, env, t0, t1) {
  if (!segs.length) return [];
  const total = segs.reduce((a, s) => a + s.text.length, 0) || 1;
  const cum = [0];
  segs.forEach((s, k) => { cum[k + 1] = cum[k] + s.text.length; });
  let s0 = t0, s1 = t1, gaps = [];
  if (env && env.length) {
    const a = Math.max(0, Math.floor(t0 / ENV_HOP)), b = Math.min(env.length, Math.ceil(t1 / ENV_HOP));
    if (b - a > 10) {
      const floor = percentile(env, a, b, 0.1), loud = percentile(env, a, b, 0.9);
      const thr = floor + (loud - floor) * 0.12;
      // 話し始めと話し終わり
      let i = a; while (i < b && env[i] < thr) i++;
      let j = b - 1; while (j > i && env[j] < thr) j--;
      if (j > i) { s0 = i * ENV_HOP; s1 = (j + 1) * ENV_HOP; }
      // 間（無音区間）。字幕は次の声が出る少し前に切り替える
      let run = -1;
      for (let k = i; k <= j; k++) {
        if (env[k] < thr) { if (run < 0) run = k; }
        else if (run >= 0) {
          const len = (k - run) * ENV_HOP;
          if (len >= 0.1) gaps.push({ t: k * ENV_HOP - 0.08, len });
          run = -1;
        }
      }
    }
  }
  const starts = [s0];
  let last = s0, anchorC = 0;
  for (let k = 1; k < segs.length; k++) {
    const span = total - anchorC || 1;
    const exp = last + (cum[k] - anchorC) / span * (s1 - last);
    const segDur = segs[k - 1].text.length / span * (s1 - last);
    const win = Math.max(1.0, segDur * 0.6);
    const minLen = segs[k].major ? 0.16 : 0.1;
    let best = null, bestScore = -Infinity;
    gaps.forEach(g => {
      if (g.t <= starts[k - 1] + 0.3 || g.len < minLen) return;
      const d = Math.abs(g.t - exp);
      if (d > win) return;
      const score = Math.min(g.len, 1) * (segs[k].major ? 2 : 1) - d / win;
      if (score > bestScore) { bestScore = score; best = g; }
    });
    if (best) { starts.push(best.t); last = best.t; anchorC = cum[k]; }
    else starts.push(Math.max(exp, starts[k - 1] + 0.3));
  }
  return segs.map((s, k) => ({ text: s.text, from: starts[k] - t0, to: (k + 1 < segs.length ? starts[k + 1] : t1) - t0 }));
}

let narrEnvCache = { id: null, env: null };
async function narrationEnvelope() {
  const n = state.project.narration;
  if (narrEnvCache.id === n.uploadId) return narrEnvCache.env;
  const nc = await narrationBlob();
  const rate = 8000; // 間の検出には低いサンプルレートで十分（メモリ節約）
  const ctx = new OfflineAudioContext(1, Math.ceil(n.duration * rate) + rate, rate);
  const buf = await ctx.decodeAudioData(await nc.blob.arrayBuffer());
  const env = envelope(buf.getChannelData(0), buf.sampleRate);
  narrEnvCache = { id: n.uploadId, env };
  return env;
}

async function buildAllCaptions(mode, maxLen) {
  const scenes = state.project.scenes;
  const segs = scenes.map(s => capSegments(s.text, maxLen));
  if (mode === 'narration') {
    let env = null;
    try { env = await narrationEnvelope(); } catch (e) { console.warn('朗読の解析に失敗したため文字数で割り振ります', e); }
    const times = sceneTimes();
    return scenes.map((s, i) => alignCaps(segs[i], env, times[i].from, times[i].from + times[i].dur));
  }
  return scenes.map((s, i) => {
    const b = pl.buffers[i];
    const dur = b ? b.duration : Math.max(3, (s.text || '').length / CHARS_PER_SEC);
    return alignCaps(segs[i], b ? envelope(b.getChannelData(0), b.sampleRate) : null, 0, dur);
  });
}

/* ---------- AIによる字幕同期 ----------
   朗読を2分半ずつの区間に切ってAIに聞かせ、各字幕が読まれ始める時刻を返してもらう。
   区間は「前の区間で確定した最後の字幕」から始めるので、ずれが積み重ならない。
   AIの時刻は、近くにある声の立ち上がり（無音→有音）に吸着させて精度を上げる。 */
function capMaxLen() {
  const [W, H] = CANVAS[state.project.aspect] || CANVAS['16:9'];
  return W > H ? 34 : 18;
}

function capSig() {
  const p = state.project;
  const mode = audioMode();
  const audio = mode === 'narration' ? 'n:' + p.narration.uploadId : 's:' + p.scenes.map(s => s.audioFileId || '-').join(',');
  return [mode, audio, capMaxLen(), p.scenes.map(s => (s.text || '').length).join(',')].join('|');
}

function savedCaptions(maxLen) {
  const p = state.project;
  const c = p.captions;
  if (!c || c.sig !== capSig()) return null;
  const times = sceneTimes();
  const out = [];
  for (let si = 0; si < p.scenes.length; si++) {
    const segs = capSegments(p.scenes[si].text, maxLen);
    const ts = c.times[si] || [];
    if (ts.length !== segs.length) return null;
    const base = c.abs ? times[si].from : 0;
    const end = times[si].dur;
    out.push(segs.map((g, k) => ({ text: g.text, from: ts[k] - base, to: k + 1 < segs.length ? ts[k + 1] - base : end })));
  }
  return out;
}

function renderCapSyncInfo() {
  const p = state.project;
  const el = $('#capSyncInfo');
  if (!el || !p) return;
  $('#capSyncBtn').disabled = state.running || !(p.scenes || []).length;
  if (p.captions && p.captions.sig === capSig()) el.textContent = `AIで同期済み（${new Date(p.captions.at).toLocaleString('ja-JP')}、${p.captions.found}/${p.captions.total}文を確認）`;
  else if (p.captions) el.textContent = '朗読か本文が変わったため、同期をやり直してください（いまは間の検出で表示）';
  else el.textContent = '未同期（いまは朗読の間を検出して表示しています）';
}

async function decodeMono16k(blob) {
  const ctx = new OfflineAudioContext(1, 16000, 16000); // decodeAudioData はこのサンプルレートに変換して返す
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  return { data: buf.getChannelData(0), rate: buf.sampleRate };
}

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

const SYNC_WIN = 150, SYNC_TAIL = 15;

async function alignUnit(unit, onWin) {
  const { data, rate } = unit.audio;
  const dur = data.length / rate;
  const items = unit.items;
  const totalChars = items.reduce((a, x) => a + x.text.length, 0);
  const cps = Math.max(3, totalChars / Math.max(1, dur));
  let pos = 0, k = 0, guard = 0;
  while (k < items.length && pos < dur - 0.5 && guard++ < 1000) {
    if (state.stop) throw new Error('同期を止めました');
    const w1 = Math.min(dur, pos + SYNC_WIN);
    const isLast = w1 >= dur - 0.01;
    const cap = (w1 - pos) * cps * 1.4;
    const batch = [];
    let chars = 0;
    for (let j = k; j < items.length && batch.length < 150; j++) { batch.push(j); chars += items[j].text.length; if (chars > cap) break; }
    const wav = encodeWav(data.subarray(Math.floor(pos * rate), Math.floor(w1 * rate)), rate);
    const audio = await blobToBase64(wav);
    const res = await retry(() => api('alignWindow', { projectId: state.project.id, audio, duration: w1 - pos, lines: batch.map(j => items[j].text) }), 2);
    onWin(pos, dur);
    let prev = -1, lastJ = -1;
    res.starts.forEach((t, bi) => {
      if (typeof t !== 'number' || t < 0 || t > w1 - pos || t <= prev + 0.2) return;
      if (!isLast && t > (w1 - pos) - SYNC_TAIL) return; // 区間の終わり際は次の区間で確かめる
      items[batch[bi]].t = pos + t;
      prev = t;
      lastJ = batch[bi];
    });
    if (isLast) break;
    if (lastJ < 0) { pos += (w1 - pos) * 0.8; continue; }
    k = lastJ + 1;
    pos = Math.max(pos + 10, items[lastJ].t + 0.3);
  }
}

// 確認できなかった字幕は前後の確認済みの位置から文字数で補い、声の立ち上がりに吸着させる
function finishTimes(items, audio, t0, t1) {
  const n = items.length;
  if (!n) return;
  const cum = [0];
  items.forEach((x, i) => { cum[i + 1] = cum[i] + x.text.length; });
  const known = [];
  items.forEach((x, i) => { if (x.t != null) known.push(i); });
  items.forEach((x, i) => {
    if (x.t != null) return;
    let p = -1, q = -1;
    for (const k of known) { if (k < i) p = k; else if (k > i) { q = k; break; } }
    const pT = p >= 0 ? items[p].t : t0, pC = p >= 0 ? cum[p] : 0;
    const qT = q >= 0 ? items[q].t : t1, qC = q >= 0 ? cum[q] : cum[n];
    x.t = pT + (qT - pT) * (cum[i] - pC) / Math.max(1, qC - pC);
    x.guessed = true;
  });
  // 声の立ち上がりへの吸着
  const env = envelope(audio.data, audio.rate);
  const floor = percentile(env, 0, env.length, 0.1), loud = percentile(env, 0, env.length, 0.9);
  const thr = floor + (loud - floor) * 0.12;
  items.forEach(x => {
    const range = x.guessed ? 0.8 : 0.5;
    const a = Math.max(1, Math.floor((x.t - range) / ENV_HOP)), b = Math.min(env.length - 1, Math.ceil((x.t + 0.3) / ENV_HOP));
    let best = null;
    for (let f = a; f <= b; f++) {
      if (env[f - 1] < thr && env[f] >= thr) {
        const t = f * ENV_HOP;
        if (best == null || Math.abs(t - x.t) < Math.abs(best - x.t)) best = t;
      }
    }
    if (best != null) x.t = best - 0.08;
  });
  for (let i = 1; i < n; i++) if (items[i].t < items[i - 1].t + 0.15) items[i].t = items[i - 1].t + 0.15;
}

async function runCaptionSync() {
  if (state.running) return;
  const p = state.project;
  const scenes = p.scenes || [];
  if (!scenes.length) { toast('先に本文を場面に分けてください', true); return; }
  const mode = audioMode();
  const maxLen = capMaxLen();
  const segs = scenes.map(s => capSegments(s.text, maxLen));
  if (mode === 'scenes' && !scenes.some(s => s.audioFileId)) { toast('朗読の音声がまだありません', true); return; }
  const estSec = mode === 'narration' ? p.narration.duration : scenes.reduce((a, s) => a + (s.audioFileId ? (s.duration || 0) : 0), 0);
  const estCalls = mode === 'narration' ? Math.ceil(estSec / (SYNC_WIN - SYNC_TAIL - 5)) : scenes.filter(s => s.audioFileId).reduce((a, s) => a + Math.max(1, Math.ceil((s.duration || 0) / (SYNC_WIN - SYNC_TAIL - 5))), 0);
  const already = p.captions && p.captions.sig === capSig();
  if (!confirm(`${already ? '字幕はすでに同期済みです。やり直しますか？\n' : ''}朗読（約${fmtTime(estSec)}）をAIに聞かせて、場面の区切りと字幕を合わせます。AIを約${estCalls}回使います。`)) return;
  state.running = true; state.stop = false;
  $('#genImagesBtn').disabled = $('#genAudioBtn').disabled = $('#capSyncBtn').disabled = true;
  $('#stopBtn').hidden = false; $('#stopBtn').textContent = '止める';
  $('#progressWrap').hidden = false;
  const prog = (t, r) => { $('#progressBar').style.width = (r * 100).toFixed(1) + '%'; $('#progressText').textContent = t; };
  try {
    await flushSave();
    const times = scenes.map(() => null);
    let found = 0, total = 0;
    if (mode === 'narration') {
      prog('朗読ファイルを読み込んでいます…', 0);
      const nc = await narrationBlob();
      const audio = await decodeMono16k(nc.blob);
      const items = [];
      segs.forEach((arr, si) => arr.forEach(g => items.push({ si, text: g.text, t: null })));
      const dur = audio.data.length / audio.rate;
      await alignUnit({ audio, items }, (pos, d) => prog(`AIが朗読を聞いています… ${fmtTime(pos)} / ${fmtTime(d)}`, pos / d));
      found = items.filter(x => x.t != null).length; total = items.length;
      if (found < Math.max(2, total * 0.2)) throw new Error('朗読と本文がほとんど一致しませんでした。朗読ファイルと本文が同じ作品か確認してください');
      finishTimes(items, audio, 0, dur);
      scenes.forEach((s, si) => { times[si] = items.filter(x => x.si === si).map(x => Math.round(x.t * 100) / 100); });
      // 絵の切り替え位置＝各場面の最初の字幕の少し前
      const starts = scenes.map((s, si) => si === 0 ? 0 : Math.max(0, (times[si][0] ?? 0) - 0.3));
      for (let i = 1; i < starts.length; i++) if (starts[i] <= starts[i - 1] + 0.5) starts[i] = starts[i - 1] + 0.5;
      p.narration.starts = starts.map(x => Math.round(x * 10) / 10);
      p.narration.aligned = 'ai';
      scheduleSave({ narrationStarts: p.narration.starts, narrationAligned: 'ai' });
    } else {
      const targets = scenes.map((s, i) => i).filter(i => scenes[i].audioFileId);
      for (let n = 0; n < targets.length; n++) {
        const si = targets[n];
        if (state.stop) throw new Error('同期を止めました');
        prog(`AIが朗読を聞いています… 場面${si + 1}（${n + 1}/${targets.length}）`, n / targets.length);
        const audio = await decodeMono16k((await asset(scenes[si].audioFileId)).blob);
        const items = segs[si].map(g => ({ si, text: g.text, t: null }));
        await alignUnit({ audio, items }, () => {});
        finishTimes(items, audio, 0, audio.data.length / audio.rate);
        found += items.filter(x => x.t != null && !x.guessed).length; total += items.length;
        times[si] = items.map(x => Math.round(x.t * 100) / 100);
      }
      // 音声のない場面は文字数で割り振る
      scenes.forEach((s, si) => { if (!times[si]) times[si] = alignCaps(segs[si], null, 0, sceneDur(s)).map(c => Math.round(c.from * 100) / 100); });
    }
    p.captions = { sig: capSig(), abs: mode === 'narration', times, found, total, at: new Date().toISOString() };
    scheduleSave({ captions: p.captions });
    await flushSave();
    prog(`同期が終わりました（${found}/${total}文をAIが確認、残りは前後から補完）`, 1);
    toast('字幕を音声に合わせました。「上演・書き出し」で確かめてください');
  } catch (e) {
    prog('同期を中断しました', 0);
    toast(e.message, true);
  } finally {
    state.running = false;
    $('#genImagesBtn').disabled = $('#genAudioBtn').disabled = false;
    $('#stopBtn').hidden = true;
    renderScenes();
  }
}

function capOffset() { return Number(localStorage.getItem('mk_cap_offset') || 0); }

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
  const sig = p.id + ':' + mode + ':' + (mode === 'narration' ? p.narration.uploadId + '@' + p.narration.starts.join(',') : '') + ':' + scenes.map(s => (s.imageFileId || '') + (s.audioFileId || '')).join('|') + ':' + (p.captions ? p.captions.at : '');
  if (pl.ready && pl.loadingFor === sig) { $('#prepStatus').textContent = '準備できています'; return; }
  pl.ready = false; pl.loadingFor = sig;
  if (!pl.ctx) pl.ctx = new (window.AudioContext || window.webkitAudioContext)();
  $('#playBtn').disabled = $('#recordBtn').disabled = true;
  drawCard(p.title || 'ものがたり紙芝居');
  pl.images = []; pl.buffers = [];
  const capLen = capMaxLen();
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
  $('#prepStatus').textContent = '字幕を朗読の間に合わせています…';
  pl.caps = savedCaptions(capLen) || await buildAllCaptions(mode, capLen);
  if (pl.loadingFor !== sig) return;
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

function drawCaption(i, el) {
  if (!$('#subToggle').checked) return;
  const caps = pl.caps[i] || [];
  if (!caps.length) return;
  const t = el + capOffset();
  const cap = t < caps[0].from ? caps[0] : (caps.find(c => t >= c.from && t < c.to) || caps[caps.length - 1]);
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
  drawCaption(pl.idx, el);
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
  const rec = !!(pl.rec && pl.rec.state === 'recording') || !!pl.exporting;
  $('#recordBtn').textContent = rec ? '書き出しを中止' : '動画を書き出す（高速）';
  $('#playBtn').disabled = !pl.ready || !!pl.exporting;
  $('#fsBtn').disabled = !!pl.exporting;
  $('#recordBtn').classList.toggle('rec', rec);
  $('#pauseBtn').disabled = !pl.playing || rec;
  $('#fsPlay').textContent = !pl.playing ? '最初から上演' : pl.paused ? '再開' : '一時停止';
  $('#fsPlay').disabled = rec;
  $('#fsPrev').disabled = $('#fsNext').disabled = rec || !pl.playing;
  wakeFsBar();
}

function initPlayer() {
  $('#playBtn').addEventListener('click', () => playFrom(0));
  $('#pauseBtn').addEventListener('click', togglePause);
  initFullscreen();
  $('#stopPlayBtn').addEventListener('click', () => {
    stopPlayback(false);
    drawCard(state.project.title || '');
    markNow(-1);
  });
  $('#recordBtn').addEventListener('click', () => {
    if (pl.exporting) { cancelExport(); return; }
    if (pl.rec && pl.rec.state === 'recording') { stopPlayback(false); toast('書き出しを中止しました'); return; }
    exportVideo();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && pl.rec && pl.rec.state === 'recording') toast('書き出し中は、このタブを表示したままにしてください', true);
  });
}

async function togglePause() {
  if (!pl.playing) return;
  if (pl.rec && pl.rec.state === 'recording') return;
  if (pl.mode === 'narration') {
    if (pl.paused) { await pl.narrEl.play(); pl.paused = false; }
    else { pl.narrEl.pause(); pl.paused = true; }
  } else if (pl.paused) { await pl.ctx.resume(); pl.paused = false; }
  else { await pl.ctx.suspend(); pl.paused = true; }
  setControls();
}

/* ---------- 全画面上演 ---------- */
function stageWrap() { return $('#stageWrap'); }
function isFs() {
  const w = stageWrap();
  return document.fullscreenElement === w || document.webkitFullscreenElement === w || w.classList.contains('pseudo-fs');
}

async function enterFs() {
  const w = stageWrap();
  try {
    if (w.requestFullscreen) await w.requestFullscreen({ navigationUI: 'hide' });
    else if (w.webkitRequestFullscreen) w.webkitRequestFullscreen();
    else throw new Error('no-api');
  } catch (e) {
    // iPhone など要素の全画面に未対応のブラウザは、画面いっぱいに広げて代用
    w.classList.add('pseudo-fs');
    document.body.style.overflow = 'hidden';
  }
  try {
    const want = state.project.aspect === '9:16' ? 'portrait' : 'landscape';
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock(want).catch(() => {});
  } catch (e) { }
  updateFsUi();
}

function exitFs() {
  const w = stageWrap();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
  w.classList.remove('pseudo-fs');
  document.body.style.overflow = '';
  try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch (e) { }
  updateFsUi();
}

let fsIdleTimer;
function wakeFsBar() {
  const w = stageWrap();
  w.classList.remove('idle');
  clearTimeout(fsIdleTimer);
  if (isFs() && pl.playing && !pl.paused) fsIdleTimer = setTimeout(() => w.classList.add('idle'), 2500);
}

function updateFsUi() {
  const fs = isFs();
  $('#fsBtn').textContent = fs ? '全画面を閉じる' : '全画面で上演';
  if (!fs) { stageWrap().classList.remove('idle'); clearTimeout(fsIdleTimer); }
  else wakeFsBar();
}

function stepScene(d) {
  if (!pl.ready || (pl.rec && pl.rec.state === 'recording')) return;
  const n = (state.project.scenes || []).length;
  const i = Math.min(n - 1, Math.max(0, (pl.playing ? pl.idx : (pl.idx || 0)) + d));
  playFrom(i);
}

async function playPauseKey() {
  if (!pl.ready) return;
  if (!pl.playing) await playFrom(0);
  else await togglePause();
  wakeFsBar();
}

function initFullscreen() {
  const w = stageWrap();
  $('#fsBtn').addEventListener('click', async () => {
    if (isFs()) { exitFs(); return; }
    if (!pl.ready) { toast('素材の読み込みが終わるまでお待ちください', true); return; }
    await enterFs();
    if (!pl.playing) playFrom(0);
  });
  $('#fsExit').addEventListener('click', exitFs);
  $('#fsPlay').addEventListener('click', playPauseKey);
  $('#fsPrev').addEventListener('click', () => { stepScene(-1); wakeFsBar(); });
  $('#fsNext').addEventListener('click', () => { stepScene(1); wakeFsBar(); });
  ['mousemove', 'touchstart', 'click'].forEach(ev => w.addEventListener(ev, wakeFsBar, { passive: true }));
  document.addEventListener('fullscreenchange', updateFsUi);
  document.addEventListener('webkitfullscreenchange', updateFsUi);
  document.addEventListener('keydown', e => {
    if (state.step !== 4 || $('#editView').hidden || document.querySelector('dialog[open]')) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); playPauseKey(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepScene(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); stepScene(-1); }
    else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); isFs() ? exitFs() : $('#fsBtn').click(); }
    else if (e.key === 'Escape' && stageWrap().classList.contains('pseudo-fs')) exitFs();
  });
}

/* ---------- 動画の高速書き出し（WebCodecs＋Worker） ----------
   再生せずに1コマずつ組み立ててエンコードする。実時間より何倍も速く、タブを裏に回しても止まらない。
   保存先を先に選ぶと、作りながらファイルへ直接書き込むので長い作品でもメモリを使い切らない。 */
const EXPORT_FPS = 24;

async function pickExportFormat(W, H) {
  const videos = [
    { container: 'mp4', videoCodec: 'avc1.640028', ext: 'mp4', mime: 'video/mp4' },
    { container: 'mp4', videoCodec: 'avc1.4d0028', ext: 'mp4', mime: 'video/mp4' },
    { container: 'webm', videoCodec: 'vp09.00.10.08', videoMux: 'V_VP9', ext: 'webm', mime: 'video/webm' },
    { container: 'webm', videoCodec: 'vp8', videoMux: 'V_VP8', ext: 'webm', mime: 'video/webm' }
  ];
  for (const v of videos) {
    try {
      const vs = await VideoEncoder.isConfigSupported({ codec: v.videoCodec, width: W, height: H, bitrate: 2000000, framerate: EXPORT_FPS });
      if (!vs.supported) continue;
      const audios = v.container === 'mp4' ? [['mp4a.40.2', 'aac'], ['opus', 'opus']] : [['opus', 'opus']];
      for (const [codec, mux] of audios) {
        const as = await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 1, bitrate: 96000 });
        if (as.supported) return { ...v, audioCodec: codec, audioMux: mux };
      }
    } catch (e) { }
  }
  return null;
}

// 書き出す音声を1本の配列にまとめる（長い作品はメモリ節約のため16kHz）
async function buildExportAudio(timeline, totalDur) {
  if (pl.mode === 'narration') {
    const rate = totalDur > 2400 ? 16000 : 24000;
    const nc = await narrationBlob();
    const ctx = new OfflineAudioContext(1, rate, rate);
    const buf = await ctx.decodeAudioData(await nc.blob.arrayBuffer());
    return { data: buf.getChannelData(0), rate: buf.sampleRate };
  }
  const rate = 24000;
  const data = new Float32Array(Math.ceil(totalDur * rate) + 1);
  timeline.forEach((t, i) => {
    const b = pl.buffers[i];
    if (!b) return;
    const src = b.getChannelData(0), ratio = b.sampleRate / rate;
    const off = Math.round(t.from * rate), n = Math.min(Math.floor(b.duration * rate), data.length - off);
    for (let j = 0; j < n; j++) {
      const sp = j * ratio, i0 = sp | 0, fr = sp - i0;
      const a = src[i0] || 0, c = src[i0 + 1] || 0;
      data[off + j] = a + (c - a) * fr;
    }
  });
  return { data, rate };
}

function exportProgress(text, ratio) {
  $('#expWrap').hidden = false;
  $('#expBar').style.width = (Math.max(0, Math.min(1, ratio)) * 100).toFixed(1) + '%';
  $('#expText').textContent = text;
}

let exportWorker = null, baseTitle = document.title;

function endExport(msg, err) {
  pl.exporting = false;
  if (exportWorker) { exportWorker.terminate(); exportWorker = null; }
  document.title = baseTitle;
  setControls();
  if (msg) toast(msg, !!err);
}

function cancelExport() {
  if (!exportWorker) return;
  exportWorker.postMessage({ cmd: 'cancel' });
  setTimeout(() => { if (pl.exporting) { exportProgress('書き出しを中止しました', 0); endExport('書き出しを中止しました'); } }, 1500);
}

async function exportVideo() {
  if (!pl.ready) return;
  if (!('VideoEncoder' in window) || !('OffscreenCanvas' in window) || !window.Worker) {
    toast('このブラウザは高速書き出しに対応していないため、上演しながら録画します（パソコンのChrome・Edge推奨）', true);
    return startRecording();
  }
  const p = state.project;
  const W = pl.cv.width, H = pl.cv.height;
  const fmt = await pickExportFormat(W, H);
  if (!fmt) {
    toast('この端末では高速書き出しができないため、上演しながら録画します', true);
    return startRecording();
  }
  // 保存先を先に決める（ここで決めるとファイルへ直接書き込める）
  let handle = null;
  const name = (p.title || 'kamishibai').replace(/[\\/:*?"<>|]/g, '_') + '.' + fmt.ext;
  if (window.showSaveFilePicker) {
    try {
      handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: '動画ファイル', accept: { [fmt.mime]: ['.' + fmt.ext] } }] });
    } catch (e) {
      if (e.name === 'AbortError') return;
      handle = null;
    }
  }
  stopPlayback(false);
  if (isFs()) exitFs();
  pl.exporting = true;
  setControls();
  try {
    // 場面ごとの開始時刻と長さ
    const scenes = p.scenes;
    let timeline, totalDur;
    if (pl.mode === 'narration') {
      timeline = sceneTimes();
      totalDur = p.narration.duration;
    } else {
      let t = 0;
      timeline = scenes.map((s, i) => {
        const d = pl.buffers[i] ? pl.buffers[i].duration : Math.max(3, (s.text || '').length / CHARS_PER_SEC);
        const r = { from: t, dur: d }; t += d; return r;
      });
      totalDur = t;
    }
    if (!handle && totalDur > 1800) toast('保存先を選べないブラウザのため、書き出し中に多くのメモリを使います', true);
    exportProgress('音声を準備しています…', 0);
    const audio = await buildExportAudio(timeline, totalDur);
    exportProgress('絵を準備しています…', 0);
    const items = [];
    for (let i = 0; i < scenes.length; i++) {
      let blob = null;
      if (scenes[i].imageFileId) { try { blob = (await asset(scenes[i].imageFileId)).blob; } catch (e) { } }
      items.push({ from: timeline[i].from, dur: timeline[i].dur, effect: scenes[i].effect, summary: scenes[i].summary, blob });
    }
    const msg = {
      cmd: 'start', W, H, fps: EXPORT_FPS, fmt, handle, totalDur,
      scenes: items, caps: pl.caps, subtitles: $('#subToggle').checked, capOffset: capOffset(),
      audio: { data: audio.data, rate: audio.rate }
    };
    exportWorker = new Worker('export-worker.js');
    exportWorker.onmessage = e => {
      const d = e.data;
      if (d.type === 'progress') {
        const speed = d.elapsed > 0 ? d.t / d.elapsed : 0;
        const left = speed > 0 ? (d.total - d.t) / speed : 0;
        const pct = Math.round(d.t / d.total * 100);
        exportProgress(`書き出し中 ${fmtTime(d.t)} / ${fmtTime(d.total)}（${speed.toFixed(1)}倍速・残り約${fmtTime(left)}）`, d.t / d.total);
        document.title = `（${pct}%）書き出し中 - ${baseTitle}`;
      } else if (d.type === 'done') {
        if (d.buffer) {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([d.buffer], { type: fmt.mime }));
          a.download = name;
          document.body.appendChild(a); a.click(); a.remove();
        }
        exportProgress(`書き出し完了：${fmtTime(totalDur)}の動画を${fmtTime(d.elapsed)}で作成（${fmt.ext.toUpperCase()}）`, 1);
        endExport('動画を保存しました');
        if (document.hidden) document.title = `✅ 書き出し完了 - ${baseTitle}`;
      } else if (d.type === 'cancelled') {
        exportProgress('書き出しを中止しました', 0);
        endExport('書き出しを中止しました');
      } else if (d.type === 'error') {
        exportProgress('書き出しに失敗しました', 0);
        endExport('書き出しに失敗しました：' + d.message, true);
      }
    };
    exportWorker.onerror = e => { exportProgress('書き出しに失敗しました', 0); endExport('書き出しに失敗しました：' + (e.message || ''), true); };
    // 音声の配列はコピーせず Worker へ渡す（渡せない場合はコピー）
    try { exportWorker.postMessage(msg, [audio.data.buffer]); }
    catch (e) { exportWorker.postMessage(msg); }
    exportProgress('書き出しを始めました…', 0);
  } catch (e) {
    exportProgress('書き出しに失敗しました', 0);
    endExport('書き出しに失敗しました：' + e.message, true);
  }
}

// 予備：WebCodecs に対応していないブラウザ用（上演しながら録画）
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
