/* ものがたり紙芝居 — 吹き出し・ナレーション枠・タイトルの描画
 * 上演（app.js）と動画の書き出し（export-worker.js）の両方で使う。
 * cap = { text, from, to, speaker, tone, slot }
 * 字幕の形：吹き出し（bubble）／画面の下に名前つき字幕（bottom）。章の見出し札も描く
 */
(function (root) {
  'use strict';
  const NARRATOR = 'ナレーション';
  const PALETTE = ['#c2410c', '#1d4ed8', '#15803d', '#9333ea', '#b45309', '#0e7490', '#be185d', '#4338ca'];

  function colorOf(name) {
    let h = 0;
    for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  // 句読点が行頭に来ないように折り返す
  function wrapLines(g, text, maxW) {
    const lines = [];
    let cur = '';
    for (const ch of String(text || '')) {
      if (g.measureText(cur + ch).width > maxW && cur) {
        if ('、。，．！？!?」』）)…ー〜'.includes(ch)) { cur += ch; lines.push(cur); cur = ''; continue; }
        lines.push(cur); cur = ch;
      } else cur += ch;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // いま表示する吹き出し：直前に始まったもの（行と行の間も前の吹き出しを残す）
  function pick(caps, t) {
    let cur = null;
    for (const c of caps) { if (c.from <= t) cur = c; else break; }
    return cur || caps[0] || null;
  }

  function narrationBox(g, W, H, cap, font, fs) {
    const portrait = H > W;
    g.font = `500 ${fs}px ${font}`;
    const maxW = W * (portrait ? .84 : .82);
    const lines = wrapLines(g, cap.text, maxW);
    const lh = fs * 1.45, pad = fs * .7;
    const bw = Math.min(W * .92, Math.max(...lines.map(l => g.measureText(l).width)) + pad * 2.4);
    const bh = lines.length * lh + pad * 1.6;
    const x = (W - bw) / 2;
    const y = H - bh - H * (portrait ? .1 : .05);
    g.save();
    g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = fs * .4;
    g.fillStyle = 'rgba(255,251,240,.95)';
    g.fillRect(x, y, bw, bh);
    g.shadowBlur = 0;
    g.lineWidth = Math.max(2, fs * .08);
    g.strokeStyle = '#3a2f22';
    g.strokeRect(x, y, bw, bh);
    g.strokeRect(x + fs * .18, y + fs * .18, bw - fs * .36, bh - fs * .36);
    g.fillStyle = '#2a241c';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    lines.forEach((l, k) => g.fillText(l, W / 2, y + pad * .8 + lh * (k + .5)));
    g.restore();
  }

  function speechBubble(g, W, H, cap, font, fs, age) {
    const portrait = H > W;
    const tone = cap.tone || 'normal';
    const bold = tone === 'shout' ? 900 : 700;
    const tfs = tone === 'shout' ? fs * 1.12 : tone === 'whisper' ? fs * .92 : fs;
    g.font = `${bold} ${tfs}px ${font}`;
    const maxW = W * (portrait ? .62 : .34);
    const lines = wrapLines(g, cap.text, maxW);
    const lh = tfs * 1.4, pad = tfs * .8;
    const tw = Math.max(tfs * 3, ...lines.map(l => g.measureText(l).width));
    const bw = tw + pad * 2, bh = lines.length * lh + pad * 1.4;

    // 位置：話す人ごとに左・右・中央を割り当てる
    const slot = cap.slot || 0;
    const nameH = fs * 1.1;
    const top = H * (portrait ? .07 : .06) + nameH;
    const sx = [0, 1, .5, 0, 1][slot % 5];
    const row = slot >= 3 ? 1 : 0;
    const margin = W * .04;
    let x = margin + sx * (W - bw - margin * 2);
    let y = top + row * (bh + nameH * 1.5);
    if (portrait && slot === 2) y += bh * .9;
    // ギザギザの吹き出しは外側に広がるぶん内側へ寄せる
    const ext = tone === 'shout' ? bw * .2 + fs * .3 : 0;
    x = Math.max(margin * .5 + ext, Math.min(W - bw - margin * .5 - ext, x));
    if (tone === 'shout') y += bh * .2;

    // ポンと出る
    const k = Math.max(0, Math.min(1, age / .18));
    const pop = .82 + .18 * (1 - Math.pow(1 - k, 3));
    const cx = x + bw / 2, cy = y + bh / 2;
    g.save();
    g.translate(cx, cy); g.scale(pop, pop); g.translate(-cx, -cy);
    g.lineWidth = Math.max(2.5, fs * .1);
    g.strokeStyle = '#1b1b1b';
    g.fillStyle = '#fff';
    g.shadowColor = 'rgba(0,0,0,.3)'; g.shadowBlur = fs * .5;

    const tailX = x + bw * (sx === 1 ? .7 : sx === 0 ? .3 : .5);
    const tailY = y + bh;
    if (tone === 'shout') {
      // ギザギザの吹き出し
      const rx = bw / 2 * 1.16, ry = bh / 2 * 1.32, n = 22;
      g.beginPath();
      for (let i = 0; i <= n * 2; i++) {
        const a = Math.PI * i / n;
        const r = i % 2 ? .86 : 1.06;
        const px = cx + Math.cos(a) * rx * r, py = cy + Math.sin(a) * ry * r;
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.closePath(); g.fill(); g.shadowBlur = 0; g.stroke();
    } else if (tone === 'think') {
      // 心の声：もこもこの雲と小さな丸
      roundRect(g, x, y, bw, bh, bh / 2);
      g.fill(); g.shadowBlur = 0;
      g.setLineDash([fs * .5, fs * .25]); g.stroke(); g.setLineDash([]);
      [[.55, .5], [1.3, .32], [2.0, .2]].forEach(([d, r]) => {
        g.beginPath(); g.arc(tailX + (sx === 1 ? 1 : -1) * d * fs * .3, tailY + d * fs * .7, fs * r, 0, Math.PI * 2);
        g.fill(); g.stroke();
      });
    } else {
      roundRect(g, x, y, bw, bh, Math.min(bh / 2, fs * 1.4));
      g.fill(); g.shadowBlur = 0;
      if (tone === 'whisper') g.setLineDash([fs * .25, fs * .2]);
      g.stroke(); g.setLineDash([]);
      // しっぽ（話す人のいる下の方へ）
      const dir = sx === 1 ? 1 : sx === 0 ? -1 : 0;
      g.beginPath();
      g.moveTo(tailX - fs * .55, tailY - g.lineWidth);
      g.lineTo(tailX + dir * fs * 1.1, tailY + fs * 1.3);
      g.lineTo(tailX + fs * .55, tailY - g.lineWidth);
      g.closePath(); g.fill();
      g.beginPath();
      g.moveTo(tailX - fs * .55, tailY);
      g.lineTo(tailX + dir * fs * 1.1, tailY + fs * 1.3);
      g.lineTo(tailX + fs * .55, tailY);
      g.stroke();
    }

    // セリフ
    g.fillStyle = tone === 'whisper' ? '#555' : '#111';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `${bold} ${tfs}px ${font}`;
    lines.forEach((l, i) => g.fillText(l, cx, y + pad * .7 + lh * (i + .5)));

    // 名前の札
    const nfs = fs * .62;
    g.font = `700 ${nfs}px ${font}`;
    const nw = g.measureText(cap.speaker).width + nfs * 1.4;
    const nx = sx === 1 ? x + bw - nw - fs * .4 : x + fs * .4;
    const ny = y - nfs * 1.25 - (tone === 'shout' ? bh * .3 + fs * .3 : 0);
    g.fillStyle = colorOf(cap.speaker);
    roundRect(g, nx, ny, nw, nfs * 1.5, nfs * .4); g.fill();
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.fillText(cap.speaker, nx + nw / 2, ny + nfs * .78);
    g.restore();
  }

  // 画面の下に字幕（話す人の名前札つき）。ナレーションは名前札なし
  function bottomCaption(g, W, H, cap, font, fs) {
    const portrait = H > W;
    const narr = !cap.speaker || cap.speaker === NARRATOR;
    g.font = `${narr ? 500 : 700} ${fs}px ${font}`;
    const lines = wrapLines(g, cap.text, W * (portrait ? .86 : .84)).slice(0, 4);
    const lh = fs * 1.42;
    const bh = lines.length * lh + fs * .9;
    const y = H - bh - H * (portrait ? .09 : .035);
    g.save();
    g.fillStyle = 'rgba(16,14,12,.66)';
    g.fillRect(0, y, W, bh);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = fs * .14;
    g.strokeStyle = 'rgba(0,0,0,.55)';
    g.fillStyle = narr ? '#fff' : cap.tone === 'think' ? '#d9ecff' : '#fff6d6';
    lines.forEach((l, k) => {
      const ly = y + fs * .45 + lh * (k + .5);
      g.strokeText(l, W / 2, ly);
      g.fillText(l, W / 2, ly);
    });
    if (!narr) {
      const nfs = fs * .66;
      g.font = `700 ${nfs}px ${font}`;
      const nw = g.measureText(cap.speaker).width + nfs * 1.4;
      const nx = W * .05, ny = y - nfs * 1.2;
      g.fillStyle = colorOf(cap.speaker);
      roundRect(g, nx, ny, nw, nfs * 1.5, nfs * .4); g.fill();
      g.fillStyle = '#fff';
      g.fillText(cap.speaker, nx + nw / 2, ny + nfs * .78);
    }
    g.restore();
  }

  // 吹き出し（またはナレーション枠／下字幕）を1つ描く。t は場面の頭からの秒数
  // style：'bubble'（吹き出し）／'bottom'（画面の下に名前つき字幕）
  function draw(g, W, H, caps, t, font, style) {
    const cap = pick(caps || [], t);
    if (!cap || !cap.text) return;
    if (style === 'bottom') {
      bottomCaption(g, W, H, cap, font, Math.round(Math.min(W, H) / (H > W ? 21 : 23)));
      return;
    }
    const fs = Math.round(Math.min(W, H) / (H > W ? 19 : 21));
    if (!cap.speaker || cap.speaker === NARRATOR) narrationBox(g, W, H, cap, font, fs);
    else speechBubble(g, W, H, cap, font, fs, t - cap.from);
  }

  // 章の見出し札（「1つ目の習慣」＋見出し）。章の最初の場面の頭から4秒
  function drawChapter(g, W, H, ch, t, font) {
    if (!ch || t > 4 || (!ch.label && !ch.title)) return;
    const a = t < .5 ? t / .5 : t > 3.3 ? (4 - t) / .7 : 1;
    const portrait = H > W;
    const fs = Math.round(Math.min(W, H) / (portrait ? 11 : 12));
    const lfs = Math.round(fs * .52);
    g.save();
    g.globalAlpha = Math.max(0, Math.min(1, a));
    g.font = `900 ${fs}px ${font}`;
    const lines = wrapLines(g, ch.title || '', W * .82);
    const lh = fs * 1.3;
    const bh = (ch.label ? lfs * 2 : 0) + lines.length * lh + fs * .9;
    const y = H * (portrait ? .36 : .4) - bh / 2;
    const k = Math.min(1, t / .6), slide = (1 - (1 - Math.pow(1 - k, 3))) * W * .06;
    g.fillStyle = 'rgba(250,246,236,.93)';
    g.fillRect(0, y, W, bh);
    g.fillStyle = '#7a4b22';
    const bar = Math.max(3, fs * .07);
    g.fillRect(0, y + bar * 1.5, W, bar * .5);
    g.fillRect(0, y + bh - bar * 2, W, bar * .5);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    let cy = y + fs * .45;
    if (ch.label) {
      g.font = `700 ${lfs}px ${font}`;
      const lw = g.measureText(ch.label).width + lfs * 2;
      g.fillStyle = '#7a4b22';
      roundRect(g, W / 2 - lw / 2 - slide, cy, lw, lfs * 1.6, lfs * .8); g.fill();
      g.fillStyle = '#fff';
      g.fillText(ch.label, W / 2 - slide, cy + lfs * .82);
      cy += lfs * 2;
    }
    g.font = `900 ${fs}px ${font}`;
    g.fillStyle = '#2a2018';
    lines.forEach((l, i) => g.fillText(l, W / 2 + slide, cy + lh * (i + .5)));
    g.restore();
  }

  // 最初の場面に重ねるタイトル（4秒で消える）
  function drawTitle(g, W, H, title, t, font) {
    if (!title || t > 4) return;
    const a = t < .4 ? t / .4 : t > 3.4 ? (4 - t) / .6 : 1;
    const fs = Math.round(Math.min(W, H) / (H > W ? 13 : 12));
    g.save();
    g.globalAlpha = Math.max(0, Math.min(1, a));
    g.font = `900 ${fs}px ${font}`;
    const lines = wrapLines(g, title, W * .84);
    const lh = fs * 1.3;
    const bh = lines.length * lh + fs * 1.2;
    const y = H * (H > W ? .5 : .58) - bh / 2;
    g.fillStyle = 'rgba(15,12,10,.62)';
    g.fillRect(0, y, W, bh);
    g.fillStyle = '#e2a31f';
    g.fillRect(0, y, W, Math.max(3, fs * .08));
    g.fillRect(0, y + bh - Math.max(3, fs * .08), W, Math.max(3, fs * .08));
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = fs * .16;
    g.strokeStyle = '#111';
    g.fillStyle = '#fff';
    lines.forEach((l, k) => {
      const ly = y + fs * .6 + lh * (k + .5);
      g.strokeText(l, W / 2, ly);
      g.fillText(l, W / 2, ly);
    });
    g.restore();
  }

  root.KamiBubble = { draw, drawTitle, drawChapter, colorOf, pick, NARRATOR };
})(typeof self !== 'undefined' ? self : window);
