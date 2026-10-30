/**
 * ものがたり紙芝居 — GAS バックエンド
 * 小説 → 場面分割 → 漫画風静止画 → 朗読音声（Gemini TTS）
 * 保存先：Google Drive（作品ごとにフォルダ / project.json）＋会員はスプレッドシート
 */
const APP_VERSION = '1.6.0';
const SP = PropertiesService.getScriptProperties();
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const USER_COLS = ['email', 'name', 'salt', 'hash', 'mustChange', 'createdAt', 'agreedAt', 'lastLogin', 'failCount', 'lockedUntil'];
const SESSION_SEC = 21600; // 6時間
const ASPECTS = ['16:9', '9:16', '1:1'];
const EFFECTS = ['zoomIn', 'zoomOut', 'panLeft', 'panRight', 'panUp', 'panDown', 'slideIn', 'none'];

function prop(k, d) { const v = SP.getProperty(k); return v ? v : d; }
function model(kind) {
  return {
    text: prop('TEXT_MODEL', 'gemini-2.5-flash'),
    image: prop('IMAGE_MODEL', 'gemini-2.5-flash-image'),
    tts: prop('TTS_MODEL', 'gemini-2.5-flash-preview-tts')
  }[kind];
}

/* ========== 初回セットアップ（エディタから1回実行） ========== */
function setup() {
  let rootId = SP.getProperty('ROOT_FOLDER_ID');
  if (!rootId) {
    rootId = DriveApp.createFolder('ものがたり紙芝居_data').getId();
    SP.setProperty('ROOT_FOLDER_ID', rootId);
  }
  let ssId = SP.getProperty('SPREADSHEET_ID');
  if (!ssId) {
    const ss = SpreadsheetApp.create('ものがたり紙芝居_会員');
    ssId = ss.getId();
    SP.setProperty('SPREADSHEET_ID', ssId);
    DriveApp.getFileById(ssId).moveTo(DriveApp.getFolderById(rootId));
  }
  const ss = SpreadsheetApp.openById(ssId);
  let sh = ss.getSheetByName('Users');
  if (!sh) { sh = ss.getSheets()[0]; sh.setName('Users'); }
  if (sh.getLastRow() === 0) { sh.appendRow(USER_COLS); sh.setFrozenRows(1); }
  if (!SP.getProperty('GEMINI_API_KEY')) Logger.log('⚠ スクリプトプロパティ GEMINI_API_KEY を設定してください');
  Logger.log('セットアップ完了 ROOT_FOLDER_ID=' + rootId + ' SPREADSHEET_ID=' + ssId);
}

/* ========== エントリポイント ========== */
function doGet() { return json({ ok: true, app: 'monogatari-kamishibai', version: APP_VERSION }); }

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'リクエストの形式が不正です' }); }
  try {
    const h = HANDLERS[req.action];
    if (!h) throw new Error('不明な操作です: ' + req.action);
    const open = ['ping', 'register', 'login', 'resetPassword'];
    const user = open.indexOf(req.action) >= 0 ? null : auth(req.token, req.action);
    return json(Object.assign({ ok: true }, h(req, user) || {}));
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

const HANDLERS = {
  ping: () => ({ version: APP_VERSION }),
  register, login, logout, me, changePassword, resetPassword,
  listProjects, getProject, saveProject, deleteProject,
  analyze, uploadFile, generateImage, generateCharacterSheet, generateTTS, getAsset,
  uploadSceneAudio, narrationPart, narrationCommit, deleteNarration, alignNarration,
  removeStyleRef, analyzeStyle, alignWindow
};

/* ========== 会員 ========== */
function usersSheet() { return SpreadsheetApp.openById(prop('SPREADSHEET_ID')).getSheetByName('Users'); }
function normEmail(s) { return String(s || '').trim().toLowerCase(); }
function isTrue(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

function findUser(email) {
  const v = usersSheet().getDataRange().getValues();
  for (let i = 1; i < v.length; i++) {
    if (String(v[i][0]).toLowerCase() === email) {
      const o = { row: i + 1 };
      USER_COLS.forEach((c, j) => { o[c] = v[i][j]; });
      return o;
    }
  }
  return null;
}

function setUser(u, fields) {
  const sh = usersSheet();
  Object.keys(fields).forEach(k => {
    sh.getRange(u.row, USER_COLS.indexOf(k) + 1).setValue(fields[k]);
    u[k] = fields[k];
  });
}

function hashPw(pw, salt) {
  const b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pw, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(b);
}

function tempPw() {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += cs.charAt(Math.floor(Math.random() * cs.length));
  return s;
}

function sendTempMail(email, name, pw, kind) {
  const url = prop('APP_URL', '');
  MailApp.sendEmail({
    to: email,
    subject: '【ものがたり紙芝居】仮パスワードのお知らせ',
    body: name + ' 様\n\n' + kind + 'を受け付けました。\n\n仮パスワード：' + pw +
      '\n\nログイン後、新しいパスワードへの変更が必要です。\n' + (url ? 'ログイン：' + url + '\n' : '') +
      '\nこのメールに心当たりがない場合は破棄してください。\n— ものがたり紙芝居'
  });
}

function register(req) {
  const email = normEmail(req.email);
  const name = String(req.name || '').trim();
  if (!name) throw new Error('氏名（ニックネーム可）を入力してください');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('メールアドレスの形式が正しくありません');
  const a = req.agree || {};
  if (!(a.disclaimer && a.terms && a.selfResponsibility && a.betweenParties)) {
    throw new Error('すべての同意項目にチェックしてください');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (findUser(email)) throw new Error('このメールアドレスは登録済みです。パスワードを忘れた場合は再発行してください');
    const pw = tempPw(), salt = Utilities.getUuid(), now = new Date();
    usersSheet().appendRow([email, name, salt, hashPw(pw, salt), true, now, now, '', 0, '']);
    sendTempMail(email, name, pw, '会員登録');
  } finally { lock.releaseLock(); }
  return { message: '仮パスワードをメールで送りました。メールを確認してログインしてください' };
}

function login(req) {
  const u = findUser(normEmail(req.email));
  if (!u) throw new Error('メールアドレスまたはパスワードが違います');
  if (u.lockedUntil && new Date(u.lockedUntil) > new Date()) {
    throw new Error('ログインに5回失敗したため15分間ロックしています。時間をおくか、パスワードを再発行してください');
  }
  if (hashPw(String(req.password || ''), u.salt) !== u.hash) {
    const n = Number(u.failCount || 0) + 1;
    if (n >= 5) setUser(u, { failCount: 0, lockedUntil: new Date(Date.now() + 15 * 60000) });
    else setUser(u, { failCount: n });
    throw new Error('メールアドレスまたはパスワードが違います（残り' + Math.max(0, 5 - n) + '回でロック）');
  }
  setUser(u, { failCount: 0, lockedUntil: '', lastLogin: new Date() });
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('tok_' + token, u.email, SESSION_SEC);
  return { token: token, name: u.name, email: u.email, mustChange: isTrue(u.mustChange) };
}

function logout(req) {
  if (req.token) CacheService.getScriptCache().remove('tok_' + req.token);
  return {};
}

function me(req, u) { return { name: u.name, email: u.email, mustChange: isTrue(u.mustChange) }; }

function auth(token, action) {
  if (!token) throw new Error('AUTH: ログインしてください');
  const email = CacheService.getScriptCache().get('tok_' + token);
  if (!email) throw new Error('AUTH: ログインの有効期限が切れました。もう一度ログインしてください');
  const u = findUser(email);
  if (!u) throw new Error('AUTH: 会員情報が見つかりません');
  if (isTrue(u.mustChange) && ['changePassword', 'logout', 'me'].indexOf(action) < 0) {
    throw new Error('MUST_CHANGE: 仮パスワードから新しいパスワードへ変更してください');
  }
  return u;
}

function changePassword(req, u) {
  const cur = String(req.current || ''), nw = String(req.newPassword || '');
  if (hashPw(cur, u.salt) !== u.hash) throw new Error('現在のパスワードが違います');
  if (nw.length < 8 || !/[A-Za-z]/.test(nw) || !/[0-9]/.test(nw)) throw new Error('新しいパスワードは英字と数字を含む8文字以上にしてください');
  if (nw === cur) throw new Error('現在と同じパスワードは使えません');
  const salt = Utilities.getUuid();
  setUser(u, { salt: salt, hash: hashPw(nw, salt), mustChange: false });
  return { message: 'パスワードを変更しました' };
}

function resetPassword(req) {
  const u = findUser(normEmail(req.email));
  if (u) {
    const pw = tempPw(), salt = Utilities.getUuid();
    setUser(u, { salt: salt, hash: hashPw(pw, salt), mustChange: true, failCount: 0, lockedUntil: '' });
    sendTempMail(u.email, u.name, pw, 'パスワード再発行');
  }
  return { message: '登録済みのアドレスであれば、仮パスワードを送りました' };
}

/* ========== Drive / 作品 ========== */
function rootFolder() { return DriveApp.getFolderById(prop('ROOT_FOLDER_ID')); }

function userFolder(u) {
  const key = 'u_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, u.email)).replace(/=+$/, '');
  const it = rootFolder().getFoldersByName(key);
  return it.hasNext() ? it.next() : rootFolder().createFolder(key);
}

function projectFolder(u, id) {
  if (!id) throw new Error('作品IDがありません');
  const it = userFolder(u).getFoldersByName('p_' + id);
  if (!it.hasNext()) throw new Error('作品が見つかりません');
  return it.next();
}

function readProject(folder) {
  const it = folder.getFilesByName('project.json');
  if (!it.hasNext()) throw new Error('作品データが壊れています');
  return JSON.parse(it.next().getBlob().getDataAsString('UTF-8'));
}

function writeProject(folder, p) {
  p.updatedAt = new Date().toISOString();
  const s = JSON.stringify(p);
  const it = folder.getFilesByName('project.json');
  if (it.hasNext()) it.next().setContent(s);
  else folder.createFile('project.json', s, 'application/json');
}

function withProject(u, id, fn) {
  const lock = LockService.getUserLock();
  lock.waitLock(30000);
  try {
    const folder = projectFolder(u, id);
    const p = readProject(folder);
    const r = fn(p, folder);
    writeProject(folder, p);
    return r === undefined ? p : r;
  } finally { lock.releaseLock(); }
}

function listProjects(req, u) {
  const out = [];
  const it = userFolder(u).getFolders();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf('p_') !== 0) continue;
    try {
      const p = readProject(f);
      out.push({
        id: p.id, title: p.title || '無題', chars: (p.text || '').length,
        scenes: (p.scenes || []).length,
        images: (p.scenes || []).filter(s => s.imageFileId).length,
        audios: (p.scenes || []).filter(s => s.audioFileId).length,
        updatedAt: p.updatedAt
      });
    } catch (e) { /* 壊れたフォルダは無視 */ }
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { projects: out };
}

function getProject(req, u) { return { project: readProject(projectFolder(u, req.projectId)) }; }

function saveProject(req, u) {
  const inP = req.project || {};
  if (inP.text && inP.text.length > 60000) throw new Error('本文が長すぎます（6万字まで）');
  if (inP.aspect && ASPECTS.indexOf(inP.aspect) < 0) throw new Error('画像サイズの指定が不正です');
  if (inP.audioMode && ['scenes', 'narration'].indexOf(inP.audioMode) < 0) throw new Error('音声の種類が不正です');
  const keys = ['title', 'text', 'aspect', 'style', 'voice', 'characters', 'scenes', 'subtitles', 'audioMode', 'narrationStarts', 'styleRefAttach', 'captions', 'sceneMode', 'sceneCount', 'sceneSec'];
  if (!inP.id) {
    const id = Utilities.getUuid().slice(0, 8) + Date.now().toString(36);
    const folder = userFolder(u).createFolder('p_' + id);
    const p = { id: id, createdAt: new Date().toISOString(), title: '無題', text: '', aspect: '16:9', style: '', voice: 'Kore', characters: [], scenes: [], subtitles: true };
    keys.forEach(k => { if (inP[k] !== undefined) p[k] = inP[k]; });
    writeProject(folder, p);
    return { project: p };
  }
  const p = withProject(u, inP.id, p => {
    keys.forEach(k => {
      if (inP[k] === undefined) return;
      if (k === 'scenes') {
        // 生成物（画像・音声・背景参考）は生成APIだけが書き換える。ここでは編集可能な項目のみ反映
        if (!Array.isArray(inP.scenes) || inP.scenes.length !== (p.scenes || []).length) return;
        inP.scenes.forEach((s, i) => {
          ['summary', 'location', 'characters', 'imagePrompt'].forEach(f => { if (s[f] !== undefined) p.scenes[i][f] = s[f]; });
          if (EFFECTS.indexOf(s.effect) >= 0) p.scenes[i].effect = s.effect;
        });
      } else if (k === 'characters') {
        const old = {};
        (p.characters || []).forEach(c => { old[c.id] = c; });
        p.characters = (inP.characters || []).map(c => ({
          id: String(c.id), name: String(c.name || ''), features: String(c.features || ''),
          refFileId: old[c.id] ? old[c.id].refFileId : null
        }));
      } else if (k === 'narrationStarts') {
        const st = inP.narrationStarts;
        if (!p.narration || !Array.isArray(st) || st.length !== (p.scenes || []).length) return;
        p.narration.starts = st.map(Number);
        p.narration.aligned = ['ai', 'manual'].indexOf(inP.narrationAligned) >= 0 ? inP.narrationAligned : 'manual';
      } else if (k === 'captions') {
        if (inP.captions && JSON.stringify(inP.captions).length > 800000) throw new Error('字幕データが大きすぎます');
        p.captions = inP.captions || null;
      } else p[k] = inP[k];
    });
  });
  return { project: p };
}

function deleteProject(req, u) {
  projectFolder(u, req.projectId).setTrashed(true);
  return {};
}

/* ========== Gemini 共通 ========== */
function callGemini(modelName, body) {
  const key = prop('GEMINI_API_KEY', '');
  if (!key) throw new Error('サーバーにGEMINI_API_KEYが設定されていません');
  const opt = {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': key }, payload: JSON.stringify(body)
  };
  let res, code, txt;
  for (let i = 0; i < 3; i++) {
    res = UrlFetchApp.fetch(GEMINI_BASE + modelName + ':generateContent', opt);
    code = res.getResponseCode();
    txt = res.getContentText();
    if (code === 200) return JSON.parse(txt);
    if ([429, 500, 503].indexOf(code) < 0) break;
    Utilities.sleep(3000 * (i + 1));
  }
  let msg = txt;
  try { msg = JSON.parse(txt).error.message; } catch (e) { }
  throw new Error('Gemini APIエラー(' + code + '): ' + String(msg).slice(0, 300));
}

function textOf(res) {
  const c = res.candidates && res.candidates[0];
  if (!c || !c.content) throw new Error('AIの応答が空でした（' + (c && c.finishReason || '不明') + '）');
  return c.content.parts.map(p => p.text || '').join('');
}

function inlineOf(res) {
  const c = res.candidates && res.candidates[0];
  if (!c || !c.content) {
    const r = (c && c.finishReason) || (res.promptFeedback && res.promptFeedback.blockReason) || '不明';
    throw new Error('生成できませんでした（理由: ' + r + '）。場面の描写を穏やかな表現に変えて再試行してください');
  }
  const part = c.content.parts.filter(p => p.inlineData)[0];
  if (!part) throw new Error('AIが画像/音声を返しませんでした。再試行してください');
  return part.inlineData;
}

function blobPart(fileId) {
  const b = DriveApp.getFileById(fileId).getBlob();
  return { inlineData: { mimeType: b.getContentType(), data: Utilities.base64Encode(b.getBytes()) } };
}

/* ========== ① 小説解析 ========== */
function splitParagraphs(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split(/\n+/).map(s => s.trim()).filter(s => s);
}

const MAX_SCENES = 150;

// 本文を「単位」に分ける。場面数に対して段落が少なければ文単位まで細かくする
function splitUnits(text, want) {
  const paras = splitParagraphs(text);
  const units = paras.map((t, i) => ({ t: t, p: i }));
  if (!want || paras.length >= want * 2) return units;
  const out = [];
  paras.forEach((t, i) => {
    const sents = t.match(/[^。！？!?]+[。！？!?」』）)]*/g) || [t];
    sents.forEach(x => { if (x.trim()) out.push({ t: x.trim(), p: i }); });
  });
  return out;
}

// 同じ段落の文はつなげ、段落が変わるところで改行する
function joinUnits(units, a, b) {
  let s = '';
  for (let i = a; i <= b; i++) s += (i > a && units[i].p !== units[i - 1].p ? '\n' : '') + units[i].t;
  return s;
}

// AIの場面数が指定と違うとき、短い場面同士をまとめる／長い場面を分けて合わせる
function adjustSceneCount(scenes, units, want) {
  const len = s => s.text.length;
  while (scenes.length > want) {
    let bi = 0, bl = Infinity;
    for (let i = 0; i < scenes.length - 1; i++) { const l = len(scenes[i]) + len(scenes[i + 1]); if (l < bl) { bl = l; bi = i; } }
    const a = scenes[bi], b = scenes[bi + 1];
    a.paraEnd = b.paraEnd;
    a.text = joinUnits(units, a.paraStart, a.paraEnd);
    a.characters = a.characters.concat(b.characters.filter(c => a.characters.indexOf(c) < 0));
    scenes.splice(bi + 1, 1);
  }
  while (scenes.length < want) {
    let bi = -1, bl = 0;
    scenes.forEach((s, i) => { if (s.paraEnd > s.paraStart && len(s) > bl) { bl = len(s); bi = i; } });
    if (bi < 0) break;
    const s = scenes[bi];
    let acc = 0, mid = s.paraStart;
    for (let i = s.paraStart; i < s.paraEnd; i++) { acc += units[i].t.length; mid = i; if (acc >= len(s) / 2) break; }
    const second = JSON.parse(JSON.stringify(s));
    s.paraEnd = mid; s.text = joinUnits(units, s.paraStart, mid);
    second.paraStart = mid + 1; second.text = joinUnits(units, mid + 1, second.paraEnd);
    second.summary = s.summary + '（続き）';
    second.imagePrompt = s.imagePrompt + '（前の場面の続き。構図・カメラアングル・人物の動きを変えて描く）';
    second.effect = s.effect === 'zoomIn' ? 'panRight' : 'zoomIn';
    scenes.splice(bi + 1, 0, second);
  }
}

function analyze(req, u) {
  const folder = projectFolder(u, req.projectId);
  const p = readProject(folder);
  const total = (p.text || '').length;
  if (total < 100) throw new Error('本文が短すぎます（100字以上にしてください）');
  let want = Math.round(Number(req.sceneCount) || 0);
  if (want) want = Math.max(2, Math.min(MAX_SCENES, want));
  const paras = splitUnits(p.text, want);
  if (want > paras.length) want = paras.length;
  const target = want || Math.max(4, Math.min(60, Math.round(total / 700)));
  const known = (p.characters || []).map(c => '・' + c.name + '：' + c.features).join('\n');
  const prompt = [
    'あなたは紙芝居と漫画の演出家です。下の番号つき小説を、静止画（漫画風の1枚絵）を切り替える「場面」に分けてください。',
    want
      ? '・場面数は必ず ' + want + ' 個にしてください（全' + total + '字）。山場や場面転換は細かく、説明的な部分はまとめつつ、なるべく均等な長さに近づける。'
      : '・場面数の目安：' + Math.round(target * 0.7) + '〜' + Math.round(target * 1.3) + '（全' + total + '字）。山場や場面転換は細かく、説明的な部分はまとめる。',
    '・各場面は連続した番号の範囲 paraStart〜paraEnd（両端を含む）。最初の場面は0から、最後の場面は' + (paras.length - 1) + 'まで。抜けや重なりがないこと。',
    '・imagePrompt：その場面の1枚絵の具体的な描写（構図、人物の表情・動作、背景、時間帯、天候、カメラアングル）を' + (target > 60 ? '80' : '150') + '字以内で。文字や吹き出しは含めない。',
    '・summary：場面のあらすじを' + (target > 60 ? '25' : '40') + '字以内で。',
    '・effect：場面の雰囲気に合う画面の動き。' + EFFECTS.join(' / ') + ' から1つ。',
    '・characters：その場面に描く人物名。cast の name と完全一致させる。',
    '・cast：主要登場人物。features には年齢感・髪型・髪色・服装・体格・性格を本文から推定して書く。',
    known ? '・すでに登録済みの人物（名前はこれに合わせる）：\n' + known : '',
    '', '【小説】',
    paras.map((x, i) => '[' + i + '] ' + x.t).join('\n')
  ].join('\n');

  const schema = {
    type: 'OBJECT',
    properties: {
      cast: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, features: { type: 'STRING' } }, required: ['name', 'features'] } },
      scenes: {
        type: 'ARRAY', items: {
          type: 'OBJECT', properties: {
            paraStart: { type: 'INTEGER' }, paraEnd: { type: 'INTEGER' },
            summary: { type: 'STRING' }, location: { type: 'STRING' },
            characters: { type: 'ARRAY', items: { type: 'STRING' } },
            imagePrompt: { type: 'STRING' }, effect: { type: 'STRING' }
          }, required: ['paraStart', 'paraEnd', 'summary', 'location', 'characters', 'imagePrompt', 'effect']
        }
      }
    }, required: ['cast', 'scenes']
  };
  const res = callGemini(model('text'), {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.4, maxOutputTokens: 60000 }
  });
  let out;
  try { out = JSON.parse(textOf(res)); } catch (e) { throw new Error('解析結果を読み取れませんでした。場面数を減らすか、もう一度お試しください'); }

  // 範囲を正規化（抜け・重なりを補正）
  const raw = (out.scenes || []).filter(s => isFinite(s.paraStart)).sort((a, b) => a.paraStart - b.paraStart);
  if (!raw.length) throw new Error('場面を分割できませんでした');
  const scenes = [];
  let next = 0;
  raw.forEach(s => {
    if (next > paras.length - 1) return;
    const st = next;
    const en = Math.min(Math.max(Number(s.paraEnd), st), paras.length - 1);
    scenes.push({
      paraStart: st, paraEnd: en,
      text: joinUnits(paras, st, en),
      summary: s.summary, location: s.location, characters: s.characters || [],
      imagePrompt: s.imagePrompt,
      effect: EFFECTS.indexOf(s.effect) >= 0 ? s.effect : 'zoomIn',
      imageFileId: null, bgRefFileId: null, audioFileId: null, duration: 0
    });
    next = en + 1;
  });
  if (next <= paras.length - 1) {
    const last = scenes[scenes.length - 1];
    last.paraEnd = paras.length - 1;
    last.text = joinUnits(paras, last.paraStart, last.paraEnd);
  }
  if (want) adjustSceneCount(scenes, paras, want);

  return {
    project: withProject(u, p.id, pp => {
      // 既存の生成物はゴミ箱へ（再解析時）
      (pp.scenes || []).forEach(s => {
        ['imageFileId', 'audioFileId'].forEach(k => { if (s[k]) try { DriveApp.getFileById(s[k]).setTrashed(true); } catch (e) { } });
      });
      pp.scenes = scenes;
      pp.paraCount = paras.length;
      pp.captions = null;
      if (pp.narration) { pp.narration.starts = ratioStarts(scenes, pp.narration.duration); pp.narration.aligned = 'ratio'; }
      pp.characters = pp.characters || [];
      (out.cast || []).forEach(c => {
        if (!pp.characters.some(x => x.name === c.name)) {
          pp.characters.push({ id: Utilities.getUuid().slice(0, 8), name: c.name, features: c.features, refFileId: null, fromAi: true });
        }
      });
    })
  };
}

/* ========== 参考画像アップロード ========== */
function uploadFile(req, u) {
  const m = /^data:([\w\/+.-]+);base64,(.+)$/.exec(String(req.dataUrl || ''));
  if (!m) throw new Error('画像データが不正です');
  if (m[2].length > 11 * 1024 * 1024) throw new Error('画像が大きすぎます（8MBまで）');
  if (!/^image\//.test(m[1])) throw new Error('画像ファイルを選んでください');
  return {
    project: withProject(u, req.projectId, (p, folder) => {
      const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], (req.kind || 'ref') + '_' + Date.now());
      const id = folder.createFile(blob).getId();
      if (req.kind === 'charRef') {
        const c = (p.characters || []).filter(x => x.id === req.charId)[0];
        if (!c) throw new Error('人物が見つかりません');
        c.refFileId = id;
      } else if (req.kind === 'styleRef') {
        p.styleRefs = p.styleRefs || [];
        if (p.styleRefs.length >= 3) { DriveApp.getFileById(id).setTrashed(true); throw new Error('参考絵は3枚までです'); }
        p.styleRefs.push(id);
      } else if (req.kind === 'bgRef') {
        const s = p.scenes[req.sceneIdx];
        if (!s) throw new Error('場面が見つかりません');
        s.bgRefFileId = id;
      } else throw new Error('種類が不正です');
    })
  };
}

/* ========== ② 人物の三面図 ========== */
function generateCharacterSheet(req, u) {
  const folder = projectFolder(u, req.projectId);
  const p = readProject(folder);
  const c = (p.characters || []).filter(x => x.id === req.charId)[0];
  if (!c) throw new Error('人物が見つかりません');
  const parts = [];
  const sNotes = styleRefParts(p, parts);
  if (c.refFileId) parts.push(blobPart(c.refFileId));
  parts.push({
    text: [
      'キャラクター設定画（三面図）を1枚に描いてください。左から正面・横向き・後ろ姿の全身を同じ大きさで並べる。',
      '画風：' + (p.style || '日本の漫画風、くっきりした線画とやわらかい彩色'),
      '人物：' + c.name + '（' + c.features + '）',
      sNotes.join('\n'),
      c.refFileId ? parts.length + '枚目の画像の人物の顔立ち・髪型・服装を忠実に引き継ぐこと。' : '',
      '背景は無地の白。文字・名前・注釈は入れない。'
    ].join('\n')
  });
  const data = inlineOf(callGemini(model('image'), {
    contents: [{ parts: parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } }
  }));
  const fid = folder.createFile(Utilities.newBlob(Utilities.base64Decode(data.data), data.mimeType, 'char_' + c.id + '_' + Date.now())).getId();
  return { project: withProject(u, p.id, pp => { pp.characters.filter(x => x.id === c.id)[0].refFileId = fid; }) };
}

/* ========== ③ 場面画像 ========== */
function generateImage(req, u) {
  const folder = projectFolder(u, req.projectId);
  const p = readProject(folder);
  const idx = Number(req.sceneIdx);
  const s = p.scenes[idx];
  if (!s) throw new Error('場面が見つかりません');
  const parts = [];
  const notes = styleRefParts(p, parts);
  const chars = (p.characters || []).filter(c => (s.characters || []).indexOf(c.name) >= 0);
  chars.slice(0, 3).forEach(c => {
    if (!c.refFileId) return;
    try { parts.push(blobPart(c.refFileId)); notes.push(parts.length + '枚目の画像は「' + c.name + '」の設定画。顔・髪型・服装を一致させる。'); } catch (e) { }
  });
  if (s.bgRefFileId) {
    try { parts.push(blobPart(s.bgRefFileId)); notes.push(parts.length + '枚目の画像は背景・ロケーションの参考（Google Earth Studio等の風景）。地形と構図を参考に漫画風に描き直す。'); } catch (e) { }
  }
  parts.push({
    text: [
      '紙芝居の1場面として、漫画風の1枚絵を描いてください。',
      '画風：' + (p.style || '日本の漫画風、くっきりした線画とやわらかい彩色'),
      '画面比率：' + (p.aspect || '16:9'),
      notes.join('\n'),
      chars.length ? '登場人物：' + chars.map(c => c.name + '（' + c.features + '）').join(' / ') : '',
      '場所：' + (s.location || ''),
      '場面：' + (s.imagePrompt || s.summary),
      '注意：文字・吹き出し・効果音の文字・ロゴ・コマ割り・枠線は入れない。1枚の絵として描く。'
    ].filter(x => x).join('\n')
  });
  const data = inlineOf(callGemini(model('image'), {
    contents: [{ parts: parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: p.aspect || '16:9' } }
  }));
  const fid = folder.createFile(Utilities.newBlob(Utilities.base64Decode(data.data), data.mimeType, 'scene_' + idx + '_' + Date.now())).getId();
  let scene;
  withProject(u, p.id, pp => {
    const ss = pp.scenes[idx];
    if (ss.imageFileId) try { DriveApp.getFileById(ss.imageFileId).setTrashed(true); } catch (e) { }
    ss.imageFileId = fid;
    scene = ss;
  });
  return { scene: scene };
}

/* ========== ④ 朗読音声（Gemini TTS） ========== */
// 指示文の残骸・注記・記号を取り除き、本文だけを読ませる
function cleanForTTS(t) {
  let lines = String(t || '')
    .replace(/［＃[^］]*］/g, '')      // 青空文庫の注記
    .replace(/《[^》]*》/g, '')        // ルビ
    .replace(/[｜|]/g, '')
    .replace(/[#*_`>~]+/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .split('\n').map(s => s.trim()).filter(s => s);
  const instr = /(読み上げ|朗読|ナレーション|読んで)(て|して)?(ください|下さい|ね)|^(以下|次)の(文章|テキスト|文)を/;
  while (lines.length && lines[0].length < 60 && instr.test(lines[0])) lines.shift();
  return lines.join('\n');
}

function splitChunks(text, max) {
  const sents = text.match(/[^。！？!?\n]+[。！？!?」』）)]*\n?|\n/g) || [text];
  const out = [];
  let cur = '';
  sents.forEach(s => {
    if ((cur + s).length > max && cur) { out.push(cur); cur = ''; }
    cur += s;
    while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  });
  if (cur.trim()) out.push(cur);
  return out.map(s => s.trim()).filter(s => s);
}

function pcmToWav(chunks, rate) {
  let len = 0;
  chunks.forEach(c => { len += c.length; });
  const out = new Array(44 + len);
  const w = (o, v, n) => { for (let i = 0; i < n; i++) { const b = (v >> (8 * i)) & 255; out[o + i] = b > 127 ? b - 256 : b; } };
  const s = (o, str) => { for (let i = 0; i < 4; i++) out[o + i] = str.charCodeAt(i); };
  s(0, 'RIFF'); w(4, 36 + len, 4); s(8, 'WAVE'); s(12, 'fmt ');
  w(16, 16, 4); w(20, 1, 2); w(22, 1, 2); w(24, rate, 4); w(28, rate * 2, 4); w(32, 2, 2); w(34, 16, 2);
  s(36, 'data'); w(40, len, 4);
  let pos = 44;
  chunks.forEach(c => { for (let i = 0; i < c.length; i++) out[pos++] = c[i]; });
  return out;
}

function generateTTS(req, u) {
  const folder = projectFolder(u, req.projectId);
  const p = readProject(folder);
  const idx = Number(req.sceneIdx);
  const s = p.scenes[idx];
  if (!s) throw new Error('場面が見つかりません');
  const text = cleanForTTS(s.text);
  if (!text) throw new Error('読み上げる本文がありません');
  const pcm = [];
  let rate = 24000;
  splitChunks(text, 600).forEach(ch => {
    // 指示文は付けず本文のみを渡す（指示語が音声に混ざるのを防ぐ）
    const d = inlineOf(callGemini(model('tts'), {
      contents: [{ parts: [{ text: ch }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: p.voice || 'Kore' } } }
      }
    }));
    const m = /rate=(\d+)/.exec(d.mimeType || '');
    if (m) rate = Number(m[1]);
    pcm.push(Utilities.base64Decode(d.data));
    pcm.push(new Array(Math.round(rate * 0.25) * 2).fill(0)); // 区切りに0.25秒の間
  });
  const bytes = pcmToWav(pcm, rate);
  const duration = (bytes.length - 44) / (rate * 2);
  const fid = folder.createFile(Utilities.newBlob(bytes, 'audio/wav', 'voice_' + idx + '_' + Date.now() + '.wav')).getId();
  let scene;
  withProject(u, p.id, pp => {
    const ss = pp.scenes[idx];
    if (ss.audioFileId) try { DriveApp.getFileById(ss.audioFileId).setTrashed(true); } catch (e) { }
    ss.audioFileId = fid;
    ss.duration = Math.round(duration * 100) / 100;
    scene = ss;
  });
  return { scene: scene };
}

/* ========== ファイル取得（本人の作品のみ） ========== */
function getAsset(req, u) {
  const f = DriveApp.getFileById(String(req.fileId || ''));
  const uid = userFolder(u).getId();
  const parents = f.getParents();
  let ok = false;
  while (parents.hasNext()) {
    const pf = parents.next();
    const gp = pf.getParents();
    while (gp.hasNext()) { if (gp.next().getId() === uid) ok = true; }
  }
  if (!ok) throw new Error('このファイルにはアクセスできません');
  const b = f.getBlob();
  return { mimeType: b.getContentType(), data: Utilities.base64Encode(b.getBytes()) };
}

/* ========== 既存の朗読音声の取り込み ========== */
const AUDIO_MIME = /^(audio\/|video\/(mp4|webm))/;

// 場面ごとの音声ファイル
function uploadSceneAudio(req, u) {
  const m = /^data:([\w\/+.-]+);base64,(.+)$/.exec(String(req.dataUrl || ''));
  if (!m || !AUDIO_MIME.test(m[1])) throw new Error('音声ファイルを選んでください');
  if (m[2].length > 28 * 1024 * 1024) throw new Error('1場面の音声は20MBまでです。長い朗読は「朗読ファイルを取り込む」を使ってください');
  const dur = Number(req.duration);
  if (!(dur > 0)) throw new Error('音声の長さを読み取れませんでした');
  const idx = Number(req.sceneIdx);
  let scene;
  withProject(u, req.projectId, (p, folder) => {
    const s = p.scenes[idx];
    if (!s) throw new Error('場面が見つかりません');
    const id = folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], 'voice_upload_' + idx + '_' + Date.now())).getId();
    if (s.audioFileId) try { DriveApp.getFileById(s.audioFileId).setTrashed(true); } catch (e) { }
    s.audioFileId = id;
    s.duration = Math.round(dur * 100) / 100;
    s.audioSource = 'upload';
    scene = s;
  });
  return { scene: scene };
}

// 作品全体の朗読ファイル（4MBずつ分割して受け取る）
function narrationPart(req, u) {
  const folder = projectFolder(u, req.projectId);
  if (!/^[a-z0-9]{6,20}$/.test(String(req.uploadId))) throw new Error('アップロードIDが不正です');
  const bytes = Utilities.base64Decode(String(req.data || ''));
  if (!bytes.length) throw new Error('空のデータです');
  folder.createFile(Utilities.newBlob(bytes, 'application/octet-stream',
    'narr_' + req.uploadId + '_' + ('0000' + Number(req.index)).slice(-4)));
  return {};
}

function narrationFiles(folder, uploadId) {
  const out = [];
  const it = folder.searchFiles('title contains "narr_' + uploadId + '_"');
  while (it.hasNext()) { const f = it.next(); out.push({ name: f.getName(), id: f.getId(), size: f.getSize() }); }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function trashNarration(n) {
  (n && n.parts || []).forEach(id => { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { } });
}

function sceneLens(scenes) { return scenes.map(s => cleanForTTS(s.text).length || 1); }

function ratioStarts(scenes, dur) {
  const lens = sceneLens(scenes);
  const tot = lens.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return lens.map(l => { const st = acc / tot * dur; acc += l; return Math.round(st * 10) / 10; });
}

// 確定した位置（null以外）を残し、間の場面を文字数の比率で埋める
function fillStarts(fixed, scenes, dur) {
  const lens = sceneLens(scenes);
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

function narrationCommit(req, u) {
  const folder = projectFolder(u, req.projectId);
  const files = narrationFiles(folder, req.uploadId);
  if (files.length !== Number(req.total)) throw new Error('アップロードの一部が欠けました。もう一度取り込んでください');
  const dur = Number(req.duration);
  if (!(dur > 0)) throw new Error('音声の長さを読み取れませんでした');
  return {
    project: withProject(u, req.projectId, p => {
      if (p.narration) trashNarration(p.narration);
      p.narration = {
        uploadId: req.uploadId, parts: files.map(f => f.id),
        size: files.reduce((a, f) => a + f.size, 0),
        mimeType: String(req.mimeType || 'audio/mpeg'), name: String(req.name || '').slice(0, 120),
        duration: Math.round(dur * 100) / 100,
        starts: ratioStarts(p.scenes || [], dur), aligned: 'ratio'
      };
      p.audioMode = 'narration';
    })
  };
}

function deleteNarration(req, u) {
  return {
    project: withProject(u, req.projectId, p => {
      trashNarration(p.narration);
      p.narration = null;
      p.audioMode = 'scenes';
    })
  };
}

// Geminiに朗読を聞かせて、各場面の冒頭が読まれる時刻を推定
function alignNarration(req, u) {
  const folder = projectFolder(u, req.projectId);
  const p = readProject(folder);
  const n = p.narration;
  if (!n) throw new Error('朗読ファイルが取り込まれていません');
  if (!(p.scenes || []).length) throw new Error('先に場面を分けてください');
  const key = prop('GEMINI_API_KEY', '');
  if (!key) throw new Error('サーバーにGEMINI_API_KEYが設定されていません');
  const API = 'https://generativelanguage.googleapis.com/';

  // 1) Files API へ分割アップロード
  const start = UrlFetchApp.fetch(API + 'upload/v1beta/files', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: {
      'x-goog-api-key': key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(n.size), 'X-Goog-Upload-Header-Content-Type': n.mimeType
    },
    payload: JSON.stringify({ file: { display_name: 'narration_' + p.id } })
  });
  const hd = start.getAllHeaders();
  let upUrl = '';
  Object.keys(hd).forEach(k => { if (k.toLowerCase() === 'x-goog-upload-url') upUrl = hd[k]; });
  if (!upUrl) throw new Error('音声をAIへ送れませんでした(' + start.getResponseCode() + ')');
  let offset = 0, file = null;
  n.parts.forEach((id, i) => {
    const bytes = DriveApp.getFileById(id).getBlob().getBytes();
    const last = i === n.parts.length - 1;
    const r = UrlFetchApp.fetch(upUrl, {
      method: 'post', contentType: 'application/octet-stream', muteHttpExceptions: true, payload: bytes,
      headers: { 'X-Goog-Upload-Command': last ? 'upload, finalize' : 'upload', 'X-Goog-Upload-Offset': String(offset) }
    });
    if (r.getResponseCode() !== 200) throw new Error('音声の送信に失敗しました(' + r.getResponseCode() + ')');
    offset += bytes.length;
    if (last) file = JSON.parse(r.getContentText()).file;
  });

  try {
    // 2) 処理完了を待つ
    for (let k = 0; k < 40 && file.state !== 'ACTIVE'; k++) {
      if (file.state === 'FAILED') throw new Error('AIが音声を処理できませんでした（MP3かWAVを推奨）');
      Utilities.sleep(3000);
      file = JSON.parse(UrlFetchApp.fetch(API + 'v1beta/' + file.name, { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true }).getContentText());
    }
    if (file.state !== 'ACTIVE') throw new Error('音声の処理が時間内に終わりませんでした');

    // 3) 場面の冒頭が読まれる時刻を聞く
    const list = p.scenes.map((s, i) => '[' + i + '] ' + cleanForTTS(s.text).replace(/\s+/g, '').slice(0, 40)).join('\n');
    const res = callGemini(model('text'), {
      contents: [{
        parts: [
          { fileData: { mimeType: n.mimeType, fileUri: file.uri } },
          { text: 'この音声は小説の朗読です。下の各場面について、その冒頭の文が読まれ始める時刻を、音声の先頭からの秒数（小数1桁）で答えてください。場面0は朗読の最初です。見つからない場面は -1 にしてください。\n' + list }
        ]
      }],
      generationConfig: {
        responseMimeType: 'application/json', temperature: 0,
        responseSchema: { type: 'OBJECT', properties: { starts: { type: 'ARRAY', items: { type: 'OBJECT', properties: { i: { type: 'INTEGER' }, sec: { type: 'NUMBER' } }, required: ['i', 'sec'] } } }, required: ['starts'] }
      }
    });
    const ai = JSON.parse(textOf(res)).starts || [];
    const fixed = p.scenes.map(() => null);
    ai.forEach(a => { if (a.i > 0 && a.i < fixed.length && a.sec > 0 && a.sec < n.duration) fixed[a.i] = Number(a.sec); });
    // 前後が逆転している値は捨てる
    let prev = 0;
    for (let i = 1; i < fixed.length; i++) {
      if (fixed[i] == null) continue;
      if (fixed[i] <= prev + 0.5) fixed[i] = null; else prev = fixed[i];
    }
    const found = fixed.filter(x => x != null).length;
    const starts = fillStarts(fixed, p.scenes, n.duration);
    const pp = withProject(u, p.id, q => { q.narration.starts = starts; q.narration.aligned = 'ai'; });
    return { project: pp, found: found + 1, total: p.scenes.length };
  } finally {
    try { UrlFetchApp.fetch(API + 'v1beta/' + file.name, { method: 'delete', headers: { 'x-goog-api-key': key }, muteHttpExceptions: true }); } catch (e) { }
  }
}

/* ========== 作風（参考絵） ========== */
// 参考絵を最大2枚、生成リクエストの先頭に添付する
function styleRefParts(p, parts) {
  const notes = [];
  if (p.styleRefAttach === false) return notes;
  (p.styleRefs || []).slice(0, 2).forEach(id => {
    try {
      parts.push(blobPart(id));
      notes.push(parts.length + '枚目の画像は画風の参考。線・塗り・陰影・色づかいのタッチだけを真似し、描かれている人物・構図・内容は使わない。');
    } catch (e) { }
  });
  return notes;
}

function removeStyleRef(req, u) {
  return {
    project: withProject(u, req.projectId, p => {
      p.styleRefs = (p.styleRefs || []).filter(id => id !== req.fileId);
      try { DriveApp.getFileById(req.fileId).setTrashed(true); } catch (e) { }
    })
  };
}

function analyzeStyle(req, u) {
  const folder = projectFolder(u, req.projectId);
  const p = readProject(folder);
  const refs = p.styleRefs || [];
  if (!refs.length) throw new Error('参考絵がありません');
  const parts = refs.map(blobPart);
  parts.push({
    text: [
      'これらの参考絵に共通する「作風」を、画像生成AIに渡す画風指示として日本語で書いてください。',
      '次の観点を、実際に描き分けられる具体的な言葉で200〜320字にまとめる：',
      '線（太さ・強弱・質感・主線の色）、彩色（ベタ塗り/グラデーション/水彩/トーン風など）、陰影の付け方、色調とよく使う色、',
      '人物のデフォルメ度合い（頭身・目や顔の描き方）、背景の描き込み量、画面全体の質感や時代感・媒体感。',
      '作品名・作家名・キャラクター名・描かれている具体的な内容は書かない。前置きや見出しは不要で、指示文だけを出力する。'
    ].join('\n')
  });
  const text = textOf(callGemini(model('text'), { contents: [{ parts: parts }], generationConfig: { temperature: 0.3 } })).trim();
  if (!text) throw new Error('作風を読み取れませんでした');
  return { project: withProject(u, p.id, pp => { pp.style = text; }) };
}

/* ========== 字幕の同期（朗読の一部を聞かせて各行の読み始め時刻を得る） ========== */
function alignWindow(req, u) {
  projectFolder(u, req.projectId); // 本人の作品か確認
  const lines = (req.lines || []).slice(0, 150).map(t => String(t).slice(0, 200));
  if (!lines.length) return { starts: [] };
  const data = String(req.audio || '');
  if (!data) throw new Error('音声がありません');
  if (data.length > 15 * 1024 * 1024) throw new Error('区間の音声が大きすぎます');
  const prompt = [
    'この音声は小説の朗読の一部です（長さ ' + Number(req.duration || 0).toFixed(1) + ' 秒）。',
    '下の各行について、その行の最初の言葉が読み始められる時刻を、この音声の先頭からの秒数（小数2桁）で答えてください。',
    '行は朗読の順番どおりに並んでいます。この音声の中で読まれていない行（音声の範囲より前や後ろの行）は -1 にしてください。',
    'ルビ・表記の違い・言い換え・読み飛ばしがあっても、最も近い位置を答えてください。',
    '',
    lines.map((t, i) => '[' + i + '] ' + t).join('\n')
  ].join('\n');
  const res = callGemini(prop('ALIGN_MODEL', model('text')), {
    contents: [{ parts: [{ inlineData: { mimeType: 'audio/wav', data: data } }, { text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json', temperature: 0,
      responseSchema: { type: 'OBJECT', properties: { starts: { type: 'ARRAY', items: { type: 'OBJECT', properties: { i: { type: 'INTEGER' }, sec: { type: 'NUMBER' } }, required: ['i', 'sec'] } } }, required: ['starts'] }
    }
  });
  const out = lines.map(() => -1);
  let arr = [];
  try { arr = JSON.parse(textOf(res)).starts || []; } catch (e) { }
  arr.forEach(a => { if (a.i >= 0 && a.i < out.length && isFinite(a.sec)) out[a.i] = Number(a.sec); });
  return { starts: out };
}
