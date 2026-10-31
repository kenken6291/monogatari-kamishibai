/* ものがたり紙芝居 — 動画の高速書き出し（Web Worker）
 * 再生せずに、絵・字幕・音声を1コマずつ組み立てて WebCodecs でエンコードする。
 * Worker で動くので、タブを裏に回しても止まらない。
 */
importScripts('lib/mp4-muxer.js', 'lib/webm-muxer.js', 'lib/bubble.js');

const OUT_RATE = 48000;          // AAC / Opus のサンプルレート
const AUDIO_CHUNK = 24000;       // 0.5秒ずつエンコード
const FONT = '"Yu Gothic", "YuGothic", "Hiragino Sans", "Noto Sans JP", "Meiryo", sans-serif';

let cancelled = false;
let writable = null;

self.onmessage = async e => {
  const m = e.data;
  if (m.cmd === 'cancel') { cancelled = true; return; }
  if (m.cmd === 'start') {
    try { await run(m); }
    catch (err) {
      try { if (writable) await writable.abort(); } catch (x) { }
      self.postMessage({ type: cancelled ? 'cancelled' : 'error', message: String(err && err.message || err) });
    }
  }
};

function ease(x) { return x < .5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

function waitQueue(enc, limit) {
  if (enc.encodeQueueSize <= limit) return Promise.resolve();
  return new Promise(res => {
    const check = () => { if (enc.encodeQueueSize <= limit) res(); else setTimeout(check, 2); };
    if ('ondequeue' in enc) enc.addEventListener('dequeue', function h() { if (enc.encodeQueueSize <= limit) { enc.removeEventListener('dequeue', h); res(); } });
    else check();
  });
}

async function run(m) {
  const { W, H, fps, fmt, scenes, caps, subtitles, capOffset, audio, totalDur } = m;
  const story = !!m.story; // ものがたりモード：吹き出しで表示
  const cv = new OffscreenCanvas(W, H);
  const g = cv.getContext('2d', { alpha: false });

  // ---- 出力先とmuxer
  let target;
  if (m.handle) {
    writable = await m.handle.createWritable();
    target = fmt.container === 'mp4' ? new Mp4Muxer.FileSystemWritableFileStreamTarget(writable)
      : new WebMMuxer.FileSystemWritableFileStreamTarget(writable);
  } else {
    target = fmt.container === 'mp4' ? new Mp4Muxer.ArrayBufferTarget() : new WebMMuxer.ArrayBufferTarget();
  }
  const muxer = fmt.container === 'mp4'
    ? new Mp4Muxer.Muxer({
      target,
      video: { codec: 'avc', width: W, height: H, frameRate: fps },
      audio: { codec: fmt.audioMux, numberOfChannels: 1, sampleRate: OUT_RATE },
      fastStart: m.handle ? false : 'in-memory',
      firstTimestampBehavior: 'offset'
    })
    : new WebMMuxer.Muxer({
      target,
      video: { codec: fmt.videoMux, width: W, height: H, frameRate: fps },
      audio: { codec: 'A_OPUS', numberOfChannels: 1, sampleRate: OUT_RATE },
      firstTimestampBehavior: 'offset'
    });

  // ---- エンコーダ
  let encErr = null;
  const venc = new VideoEncoder({ output: (c, meta) => muxer.addVideoChunk(c, meta), error: e => { encErr = e; } });
  venc.configure({
    codec: fmt.videoCodec, width: W, height: H, framerate: fps,
    bitrate: W * H > 1e6 ? 3000000 : 2000000, latencyMode: 'quality',
    ...(fmt.container === 'mp4' ? { avc: { format: 'avc' } } : {})
  });
  const aenc = new AudioEncoder({ output: (c, meta) => muxer.addAudioChunk(c, meta), error: e => { encErr = e; } });
  aenc.configure({ codec: fmt.audioCodec, sampleRate: OUT_RATE, numberOfChannels: 1, bitrate: 96000 });

  // ---- 音声（元のサンプルレートから48kHzへ線形補間しながら少しずつエンコード）
  const src = audio.data, srcRate = audio.rate;
  const total48 = Math.ceil(totalDur * OUT_RATE);
  let pos48 = 0;
  const encodeAudioUntil = until => {
    until = Math.min(total48, until);
    while (pos48 < until) {
      const n = Math.min(AUDIO_CHUNK, total48 - pos48);
      const out = new Float32Array(n);
      const step = srcRate / OUT_RATE;
      for (let i = 0; i < n; i++) {
        const sp = (pos48 + i) * step;
        const i0 = sp | 0, fr = sp - i0;
        const a = src[i0] || 0, b = src[i0 + 1] || 0;
        out[i] = a + (b - a) * fr;
      }
      const ad = new AudioData({ format: 'f32', sampleRate: OUT_RATE, numberOfFrames: n, numberOfChannels: 1, timestamp: Math.round(pos48 / OUT_RATE * 1e6), data: out });
      aenc.encode(ad);
      ad.close();
      pos48 += n;
    }
  };

  // ---- 絵（今と前の場面だけデコードして持つ）
  const bitmaps = new Map();
  const getImg = async i => {
    if (i < 0 || !scenes[i] || !scenes[i].blob) return null;
    if (!bitmaps.has(i)) {
      try { bitmaps.set(i, await createImageBitmap(scenes[i].blob)); } catch (e) { bitmaps.set(i, null); }
      for (const k of [...bitmaps.keys()]) if (k < i - 1) { const b = bitmaps.get(k); if (b) b.close(); bitmaps.delete(k); }
    }
    return bitmaps.get(i);
  };

  const wrap = (text, x, y, maxW, lh) => {
    const lines = [];
    let cur = '';
    for (const ch of text) { if (g.measureText(cur + ch).width > maxW) { lines.push(cur); cur = ch; } else cur += ch; }
    if (cur) lines.push(cur);
    const top = y - (lines.length - 1) * lh / 2;
    lines.forEach((l, i) => g.fillText(l, x, top + i * lh));
  };

  const drawScene = (i, img, p, elapsed, alpha) => {
    const s = scenes[i];
    g.save();
    g.globalAlpha = alpha;
    if (!img) {
      g.fillStyle = '#f2f3ee'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#26231f';
      g.font = `bold ${Math.round(W / 26)}px ${FONT}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      wrap(s.summary || '', W / 2, H / 2, W * .8, W / 18);
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
      case 'slideIn': { const k = Math.min(1, elapsed / 1.4); slide = Math.pow(1 - k, 3) * W; z = 1.04 + .06 * e; break; }
      default: z = 1;
    }
    const sw = img.width * base * z, sh = img.height * base * z;
    g.drawImage(img, (W - sw) / 2 + ox * (sw - W) + slide, (H - sh) / 2 + oy * (sh - H), sw, sh);
    g.restore();
  };

  const drawCaption = (i, el) => {
    if (story && i === 0) KamiBubble.drawTitle(g, W, H, m.title, el, FONT);
    else if (story && scenes[i].chapter) KamiBubble.drawChapter(g, W, H, scenes[i].chapter, el, FONT);
    if (!subtitles) return;
    const cs = caps[i] || [];
    if (!cs.length) return;
    if (story) { KamiBubble.draw(g, W, H, cs, el + capOffset, FONT, m.capStyle); return; }
    const t = el + capOffset;
    const cap = t < cs[0].from ? cs[0] : (cs.find(c => t >= c.from && t < c.to) || cs[cs.length - 1]);
    const fs = Math.round(Math.min(W, H) / 22);
    g.font = `500 ${fs}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const bh = fs * 2.2;
    g.fillStyle = 'rgba(20,18,15,.62)';
    g.fillRect(0, H - bh - fs * .6, W, bh);
    g.fillStyle = '#fff';
    g.fillText(cap.text, W / 2, H - bh / 2 - fs * .6, W * .94);
  };

  // ---- 1コマずつ組み立ててエンコード
  const frames = Math.ceil(totalDur * fps);
  const FADE = 0.8;
  let si = 0, lastPost = 0;
  const t0 = Date.now();
  for (let f = 0; f < frames; f++) {
    if (cancelled) throw new Error('cancelled');
    if (encErr) throw encErr;
    const t = f / fps;
    while (si + 1 < scenes.length && scenes[si + 1].from <= t) si++;
    const s = scenes[si];
    const el = t - s.from;
    const p = s.dur ? el / s.dur : 1;
    g.fillStyle = '#1c1a17';
    g.fillRect(0, 0, W, H);
    const img = await getImg(si);
    if (si > 0 && el < 1.4 && (s.effect === 'slideIn' || el < FADE)) {
      drawScene(si - 1, await getImg(si - 1), 1, 99, 1);
      drawScene(si, img, p, el, s.effect === 'slideIn' ? 1 : el / FADE);
    } else drawScene(si, img, p, el, 1);
    drawCaption(si, el);

    const frame = new VideoFrame(cv, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / fps) });
    venc.encode(frame, { keyFrame: f % (fps * 4) === 0 });
    frame.close();
    encodeAudioUntil(Math.ceil((t + 1) * OUT_RATE));
    await waitQueue(venc, 8);
    await waitQueue(aenc, 16);

    const now = Date.now();
    if (now - lastPost > 400) {
      lastPost = now;
      self.postMessage({ type: 'progress', t, total: totalDur, elapsed: (now - t0) / 1000 });
    }
  }
  encodeAudioUntil(total48);
  await venc.flush();
  await aenc.flush();
  if (encErr) throw encErr;
  muxer.finalize();
  for (const b of bitmaps.values()) if (b) b.close();
  if (m.handle) {
    await writable.close();
    self.postMessage({ type: 'done', elapsed: (Date.now() - t0) / 1000 });
  } else {
    const buf = target.buffer;
    self.postMessage({ type: 'done', buffer: buf, elapsed: (Date.now() - t0) / 1000 }, [buf]);
  }
}
