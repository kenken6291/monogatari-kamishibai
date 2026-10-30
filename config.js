// ものがたり紙芝居 — 設定
// GAS_URL：GASを「ウェブアプリ」としてデプロイしたURL（…/exec）
// 画面右上の「設定」からも上書きできます（その端末のブラウザに保存）
window.APP_CONFIG = {
  GAS_URL: 'https://script.google.com/macros/s/AKfycbzTR2q7J2LvuCwxuRWqfpZnywuVK8d1huRa_HAiCQV8NKXJ8zBMpu94EMolseVg6g27Vg/exec',
  VERSION: '1.7.0',
  SPEECH_SILENCE_MS: 8000,   // 音声入力：この時間（ミリ秒）無音が続いたら自動で終了
  MAX_TEXT: 60000            // 本文の上限文字数
};
