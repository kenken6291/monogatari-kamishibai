// ものがたり紙芝居 — 設定
// GAS_URL：GASを「ウェブアプリ」としてデプロイしたURL（…/exec）
// 画面右上の「設定」からも上書きできます（その端末のブラウザに保存）
window.APP_CONFIG = {
  GAS_URL: 'https://script.google.com/macros/s/AKfycbzTR2q7J2LvuCwxuRWqfpZnywuVK8d1huRa_HAiCQV8NKXJ8zBMpu94EMolseVg6g27Vg/exec',
  VERSION: '2.6.2',
  SPEECH_SILENCE_MS: 8000,   // 音声入力：この時間（ミリ秒）無音が続いたら自動で終了
  MAX_TEXT: 60000,           // 本文の上限文字数

  // 既定のGeminiモデル（画面で選ばなかった時に使う）　'' = 自動（汎用の最新）
  GEMINI_MODEL: '',

  // 「設定」→「AIモデル」の選択肢（value がAPIのモデルID）
  // 文章づくり・場面分け・字幕同期などに使う。絵と朗読の声は専用モデルなので変わらない
  // 指定モデルに該当がない（廃止・未公開・名前違い）場合は、GAS側で汎用の最新モデルへ自動で切り替わる
  GEMINI_MODEL_OPTIONS: [
    { value: '',                  label: '自動モード（汎用の最新）' },
    { value: 'gemini-4-hydrogen', label: '4 Hydrogen（日々の暮らしをサポート）' },
    { value: 'gemini-4-neon',     label: '4 Neon（Deeper analysis）' },
    { value: 'gemini-4-carbon',   label: '4 Carbon（Code & complex work）' },
    { value: 'gemini-4-argon',    label: '4 Argon' },
    { value: 'gemini-3.8-flash',  label: '3.8 Flash' },
    { value: 'gemini-3.5-flash',  label: '3.5 Flash' }
  ]
};
