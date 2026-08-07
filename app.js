/**
 * 勤怠打刻アプリ（タブレット側 / RC-S300 を WebUSB で制御）
 *
 * 操作の流れ:
 *   1. 「リーダーに接続」で PASORI RC-S300 に WebUSB 接続
 *   2. ユーザーが【出勤】または【退勤】ボタンを押す（種別が決まる）
 *   3. カードをかざすと、その種別＋IDm を GAS へ送信し記録
 *   4. 結果を表示 → 自動で最初のボタン選択画面に戻る
 *
 * RC-S300 のコマンド列は動作実績のある実装を参照:
 *   https://github.com/con3code/pasorich (Scratch3 拡張 scratch3_pasorich/index.js)
 *   https://sakura-system.com/ (RC-S300 コマンド解説シリーズ)
 */

const SONY_VENDOR_ID = 0x054c; // Sony

let device = null;
let epIn = 0, epOut = 0;
let seq = 0;
let polling = false;
let lastIdm = '';           // 直近に検出したIDm（連続検出の抑制用）
let lastSeenAt = 0;         // 直近にカードを検出した時刻
const RETAP_RESET_MS = 2500; // カードが離れて再度読めるまでの間隔

// ---- デバッグ表示 ----------------------------------------------------
// タブレットでは開発者ツールが使えないため、リーダーからの生の応答を
// 画面下部のログに出せるようにする（原因調査用。通常運用ではOFF）
let debugMode = false;
let lastDebugHexF = '';     // FeliCa応答: 同じ内容を連続表示しないための直前値
let lastDebugHexA = '';     // MIFARE応答: 同上

// ---- 画面の状態 -------------------------------------------------------
// 'idle'   … 出勤/退勤ボタンの選択待ち
// 'armed'  … 種別を選び、カードをかざす待ち
// 'result' … 打刻結果の表示中
let uiState = 'idle';
let selectedType = '';      // '出勤' | '退勤'
let armTimer = null;        // かざし待ちの自動キャンセル用タイマー
let countTimer = null;      // 残り秒数カウントダウン
const ARM_TIMEOUT_SEC = 30; // ボタンを押してからカード待ちの制限時間
const SEND_TIMEOUT_SEC = 20; // GASからの応答を待つ制限時間（無応答で固まるのを防ぐ）

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 画面(index.html)が古いキャッシュのままでも落ちないようにするための入れ物。
// 後から追加した入力欄（職員番号・合言葉）は、古い画面には存在しないため
// そのまま触ると例外になり、以降の処理がすべて止まってしまう。
const elVal     = (id) => { const el = $(id); return el ? el.value : ''; };
const setElVal  = (id, v) => { const el = $(id); if (el) el.value = v; };
const setElText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const onEl      = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };

// 打刻できたときに画面へ出す（そして読み上げる）ひとこと。打刻種別ごとに変える。
const GREETINGS = {
  '出勤': '本日もよろしくお願いします',
  '退勤': 'お疲れさまでした',
};
// 完了音（約0.4秒）と重ならないよう、これだけ置いてから読み上げる
const SPEAK_DELAY_MS = 500;
const hex2 = (v) => ('0' + (v & 0xff).toString(16).toUpperCase()).slice(-2);

// ---- 設定（GAS URL / 合言葉） ----------------------------------------
function getGasUrl() { return localStorage.getItem('gasUrl') || ''; }
function setGasUrl(u) { localStorage.setItem('gasUrl', u); }
// 合言葉。GASで setupToken() を実行して発行した文字列を入れる。
// GAS側が未設定のうちは空欄のままでも動く。
function getGasToken() { return localStorage.getItem('gasToken') || ''; }
function setGasToken(t) { localStorage.setItem('gasToken', t); }

// ---- 時計表示 --------------------------------------------------------
function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
setInterval(tickClock, 1000); tickClock();

// ---- ログ ------------------------------------------------------------
function log(msg) {
  const d = new Date();
  const t = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  const el = document.createElement('div');
  el.textContent = `${t}  ${msg}`;
  $('log').prepend(el);
  while ($('log').childElementCount > 30) $('log').lastChild.remove();
}

// ==== 音（打刻者に「今どの段階か」を耳で知らせる） =====================
//
// 音声ファイルは持たず、その場で音を合成する（追加ファイル不要・オフラインでも鳴る）。
// ブラウザは「利用者が操作する前」には音を出せない決まりなので、
// 出勤/退勤ボタンや接続ボタンを押した時点で鳴らせる状態にする（unlockAudio）。
//
//   出勤/退勤を押す … コッ、コッ…（ここから鳴りはじめる）
//   カード読取       … ピッ（読めた合図。くり返し音は続く）
//   記録が終わる     … 結果の音を鳴らして、くり返し音を止める
//
// つまり「音が鳴っている間は待つ」「音が止まったら終わり」で判断できる。
//
// 音の作り方について（タブレットで大きく聞こえるようにするための工夫）:
//   1. 低音を使わない
//      小さなスピーカーは低い音をほとんど鳴らせない。
//   2. 高さを 1500〜3000Hz にそろえる
//      人の耳はこのあたりが最も敏感で、同じ音量でもいちばん大きく聞こえる。
//      タブレットのスピーカーもこの範囲がよく鳴る。
//   3. 矩形波（square）を使う
//      倍音を多く含むので、同じ音量でも通る音になる。
//   4. コンプレッサーを通してから増幅する
//      音の大きい部分だけ自動で抑えてくれるので、
//      全体を持ち上げても音が割れない。これがいちばん効く。

let audioCtx = null;
let audioBus = null;    // 各音の入り口（コンプレッサー）
let waitingTimer = null;

// コンプレッサーを通したあとに全体を何倍にするか。
// 音が割れる寸前まで上げてある。これ以上は歪みが目立つ。
const MASTER_MAKEUP = 1.8;

// 音量の段階。ボタンを押すたびにこの順で切り替わる。
const VOL_STEPS = [
  { label: '🔇 音なし', gain: 0 },
  { label: '🔈 音 小', gain: 0.35 },
  { label: '🔊 音 中', gain: 0.65 },
  { label: '📢 音 大', gain: 1.0 },
];
const VOL_DEFAULT = 3; // 既定は「大」

/** 現在の音量段階（0=音なし 〜 3=大） */
function soundLevel() {
  const raw = localStorage.getItem('soundLevel');
  // 以前の ON/OFF だけの設定から引き継ぐ
  if (raw === null) return (localStorage.getItem('soundOff') === '1') ? 0 : VOL_DEFAULT;
  const n = parseInt(raw, 10);
  return (n >= 0 && n < VOL_STEPS.length) ? n : VOL_DEFAULT;
}
function setSoundLevel(n) { localStorage.setItem('soundLevel', String(n)); }
function soundEnabled() { return soundLevel() > 0; }
/** 音量のかけ算係数 */
function volGain() { return VOL_STEPS[soundLevel()].gain; }

/** 音を鳴らせる状態にする（利用者の操作の中から呼ぶこと） */
function unlockAudio() {
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window['webkitAudioContext'];
      if (!Ctx) return;               // 非対応の端末では音なしで動く
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (!audioBus) audioBus = buildAudioBus();
  } catch (e) { audioCtx = null; audioBus = null; }
}

/**
 * 音の通り道を作る:  各音 → コンプレッサー → 増幅 → スピーカー
 *
 * コンプレッサーが大きすぎる部分だけ自動的に抑えてくれるので、
 * そのあとで全体を持ち上げても音が割れない。
 * 単純に音量を上げるより、はっきり大きく聞こえる。
 */
function buildAudioBus() {
  if (!audioCtx.createDynamicsCompressor) return audioCtx.destination; // 非対応ならそのまま鳴らす
  const comp = audioCtx.createDynamicsCompressor();
  comp.threshold.value = -22;  // この大きさを超えた分を抑える
  comp.knee.value = 6;
  comp.ratio.value = 12;
  comp.attack.value = 0.003;
  comp.release.value = 0.15;

  const makeup = audioCtx.createGain();
  makeup.gain.value = MASTER_MAKEUP;

  comp.connect(makeup);
  makeup.connect(audioCtx.destination);
  return comp;
}

/**
 * 単音を鳴らす。
 * delay 秒あとに freq ヘルツの音を dur 秒鳴らす。
 * 音の出だしと終わりを滑らかにしないと「プツッ」というノイズが入るため、
 * 音量を短時間で上げ下げしている。
 */
function tone(freq, dur, delay, gain) {
  if (!audioCtx || !audioBus || !soundEnabled()) return;
  try {
    const peak = ((gain === undefined) ? 0.9 : gain) * volGain();
    if (peak <= 0) return;

    const t0 = audioCtx.currentTime + (delay || 0);
    const osc = audioCtx.createOscillator();
    const amp = audioCtx.createGain();
    osc.type = 'square';  // 矩形波。小さなスピーカーでも聞き取りやすい
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp); amp.connect(audioBus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  } catch (e) { /* 音が出せなくても打刻は続行する */ }
}

// ---- 読み上げ（打刻後のひとことを声で伝える） ------------------------
//
// ブラウザの読み上げ機能を使うので、音声ファイルは要らない。
// ただし実際に声が出るかは端末しだい（日本語の読み上げデータが入っていること）。
// 使えない端末では黙って何もしない。画面には文字が出るので支障はない。

let jaVoice = null;   // 日本語の声（見つからなければ端末の既定にまかせる）

function pickVoice() {
  try {
    const list = window.speechSynthesis.getVoices() || [];
    jaVoice = list.filter(v => /^ja/i.test(v.lang))[0] || null;
  } catch (e) { jaVoice = null; }
}

// 声の一覧は少し遅れて用意されることがあるため、届いた時点で選び直す
if (window.speechSynthesis) {
  pickVoice();
  window.speechSynthesis.onvoiceschanged = pickVoice;
}

/** 文字を読み上げる */
function speak(text) {
  if (!text || !soundEnabled()) return;
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
  try {
    window.speechSynthesis.cancel();   // 前の読み上げが残っていれば止める
    const u = new window.SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    if (jaVoice) u.voice = jaVoice;
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;
    window.speechSynthesis.speak(u);
  } catch (e) { /* 読み上げできなくても打刻は続行する */ }
}

/** 読み上げを止める（次の人の操作が始まったとき） */
function stopSpeaking() {
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
}

/** カードを読めた合図（いちばんよく通る高さ） */
function beepRead() { tone(2600, 0.11, 0, 1.0); }

/**
 * 待っている間ずっと鳴らす。
 * 出勤/退勤を押した時点から鳴りはじめ、記録が終わったら stopWaiting() で止める。
 * ずっと聞くことになるので、合図の音より少し控えめにする。
 */
function startWaiting() {
  stopWaiting();
  if (!audioCtx || !soundEnabled()) return;
  const tick = () => tone(1500, 0.08, 0, 0.62);
  tick();
  waitingTimer = setInterval(tick, 700);
}

function stopWaiting() {
  if (waitingTimer) { clearInterval(waitingTimer); waitingTimer = null; }
}

/** 打刻できた（上がる2音） */
function beepOk() { tone(2000, 0.13, 0, 1.0); tone(2800, 0.28, 0.14, 1.0); }

/** 連続打刻でスキップした（同じ高さで2回） */
function beepSkip() { tone(1800, 0.12, 0, 0.9); tone(1800, 0.12, 0.18, 0.9); }

/**
 * エラー（打刻できなかった）＝ 警告音。
 *
 * 2つの高さを息つぎなしで交互にくり返す、サイレン型の警告音。
 * 救急車や医療機器のアラームと同じ作りで、「異常」だと直感的に伝わる。
 *
 * 2音の高さの比を約1.41倍（増四度）にしてあるのがポイント。
 * この組み合わせは不安定に響き、人が落ち着かない音として警報によく使われる。
 * 打刻できていないのに気づかず立ち去るのが一番困るため、
 * 他の音（一瞬で終わる短い音）とは明らかに違う、長く鳴り続ける音にしている。
 */
// 他の音（1500〜2800Hz）よりはっきり低くして、ブザーに近い重い響きにしてある。
// ただし 600Hz を下回るとタブレットのスピーカーが鳴らしきれず、
// せっかくの警告が聞こえにくくなるため、そこは下限とする。
const NG_HI = 880;       // 高いほう
const NG_LO = 622;       // 低いほう（880 ÷ 622 ≒ 1.41 の関係）
const NG_STEP = 0.13;    // 1音の長さ（秒）
const NG_COUNT = 10;     // 交互に鳴らす回数（全体で約1.3秒）

function beepNg() {
  for (let i = 0; i < NG_COUNT; i++) {
    // 音と音のあいだにわずかな切れ目を作る（続けて鳴らすと「プツッ」と鳴るため）
    tone(i % 2 === 0 ? NG_HI : NG_LO, NG_STEP * 0.92, i * NG_STEP, 1.0);
  }
}

// ==== 画面遷移 =========================================================

/** ①出勤/退勤の選択画面に戻す */
function toIdle() {
  clearArmTimers();
  stopWaiting(); // どの経路で戻ってきても記録中の音を残さない
  uiState = 'idle';
  selectedType = '';
  lastIdm = '';
  $('status').textContent = '打刻の種類を選んでください';
  $('choose').style.display = 'flex';
  $('armed').style.display  = 'none';
  $('panel').style.display  = 'none';
  $('panel').classList.remove('flash-ok', 'flash-ng');
  setElText('rMsg', ''); // 前の人へのひとことが残らないようにする
}

/** ②種別を選んで「カードをかざしてください」画面へ */
function toArmed(type) {
  if (!device || !polling) { alert('先にリーダーへ接続してください'); return; }
  unlockAudio();   // ボタンを押した「今」なら音を鳴らせる状態にできる
  stopSpeaking();  // 前の人へのひとことが残っていれば止める
  clearArmTimers();
  uiState = 'armed';
  selectedType = type;
  lastIdm = ''; // 直前の読み取りを引きずらない

  $('status').textContent = '';
  $('choose').style.display = 'none';
  $('panel').style.display  = 'none';
  $('armed').style.display  = 'flex';

  const badge = $('armedBadge');
  badge.textContent = type;
  badge.className = 'badge ' + (type === '出勤' ? 'in' : 'out');

  // ボタンを押した時点から音を鳴らしはじめる。
  // 記録が終わる（showResult）か、時間切れ・キャンセルで戻るまで鳴り続ける。
  startWaiting();

  // 制限時間のカウントダウン（無操作なら自動でidleに戻す）
  let remain = ARM_TIMEOUT_SEC;
  $('count').textContent = `（${remain}秒以内にかざしてください）`;
  countTimer = setInterval(() => {
    remain--;
    $('count').textContent = remain > 0 ? `（${remain}秒以内にかざしてください）` : '';
  }, 1000);
  armTimer = setTimeout(() => { log('時間切れのため選択に戻ります'); toIdle(); }, ARM_TIMEOUT_SEC * 1000);
}

function clearArmTimers() {
  if (armTimer)  { clearTimeout(armTimer);  armTimer = null; }
  if (countTimer){ clearInterval(countTimer); countTimer = null; }
}

/** ③結果を表示 → 一定時間後にidleへ */
function showResult(data) {
  clearArmTimers();
  stopWaiting(); // 応答が返ったので「記録中」の音を止める
  uiState = 'result';
  $('choose').style.display = 'none';
  $('armed').style.display  = 'none';
  const panel = $('panel');
  panel.style.display = 'block';

  if (data.ok && !data.duplicated) {
    const type = data.type || selectedType || '';
    $('status').textContent = '打刻しました';
    $('rName').textContent = data.name ? data.name : '（未登録カード）';
    $('rType').textContent = type;
    $('rTime').textContent = data.time || '';
    // 打刻できたときだけ、出勤/退勤に応じたひとことを出す
    const greeting = GREETINGS[type] || '';
    setElText('rMsg', greeting);
    panel.classList.remove('flash-ng'); panel.classList.add('flash-ok');
    beepOk();
    // 完了音と重ならないよう、少し置いてから読み上げる
    if (greeting) setTimeout(() => speak(greeting), SPEAK_DELAY_MS);
  } else if (data.ok && data.duplicated) {
    $('status').textContent = '連続打刻のためスキップ';
    $('rName').textContent = data.name || '';
    $('rType').textContent = ''; $('rTime').textContent = '';
    setElText('rMsg', '');
    panel.classList.remove('flash-ok'); panel.classList.add('flash-ng');
    beepSkip();
  } else {
    $('status').textContent = 'エラー';
    $('rName').textContent = data.message || '不明なエラー';
    $('rType').textContent = ''; $('rTime').textContent = '';
    setElText('rMsg', '');
    panel.classList.remove('flash-ok'); panel.classList.add('flash-ng');
    beepNg();
  }

  setTimeout(toIdle, 3500);
}

// ==== USB 送受信（RC-S300 CCID風フレーム） ============================
async function send(data) {
  const payload = new Uint8Array(data);
  const len = payload.length;
  const pkt = new Uint8Array(10 + len);
  pkt[0] = 0x6b;               // メッセージ種別
  pkt[1] = len & 0xff;         // データ長（4バイト リトルエンディアン）
  pkt[2] = (len >> 8) & 0xff;
  pkt[3] = (len >> 16) & 0xff;
  pkt[4] = (len >> 24) & 0xff;
  pkt[5] = 0x00;               // スロット番号
  pkt[6] = (++seq) & 0xff;     // シーケンス番号
  if (len) pkt.set(payload, 10);
  await device.transferOut(epOut, pkt);
  await sleep(20);
}

async function receive(maxLen = 512) {
  const res = await device.transferIn(epIn, maxLen);
  const d = res.data;
  if (!d) return new Uint8Array(0);
  // .buffer だけを渡すと「確保した器のサイズ」になってしまうため、
  // 実際に届いたバイト数(byteLength)だけを切り出す。
  return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
}

/** バイト列を "12 34 AB" 形式にする（デバッグ表示用） */
function toHexString(bytes) {
  return Array.from(bytes).map(hex2).join(' ');
}

/**
 * 応答の中から指定タグの中身を取り出す。
 *
 * RC-S300 の応答は、先頭10バイトの通信ヘッダの後ろに
 *   [タグ][長さ][中身...][タグ][長さ][中身...]
 * という並び（TLV形式）が続く。例:
 *   C0 03 00 90 00 / 92 01 00 / 96 02 00 00 / 97 14 (カードからの応答20バイト)
 * カードからの応答は タグ 0x97 に入っている。
 */
function findTlv(res, tag) {
  let i = 10; // 通信ヘッダ10バイトの後ろから並びが始まる
  while (i + 2 <= res.length) {
    const t = res[i];
    const len = res[i + 1];
    const start = i + 2;
    if (start + len > res.length) break; // 長さが合わない＝解釈できないので終了
    if (t === tag) return res.slice(start, start + len);
    i = start + len;
  }
  return null;
}

/** デバッグ用: カードからの応答部分（タグ0x97の中身）を取り出す */
function getCardResponse(res) {
  return findTlv(res, 0x97);
}

/**
 * FeliCa Polling の応答から IDm を取り出す。
 *
 * カードからの応答（タグ0x97の中身）は次の形:
 *   [長さ][応答コード 0x01][IDm 8バイト][PMm 8バイト](+[システムコード 2バイト])
 * カードが無い場合はこの中身が空、または応答コードが 0x01 にならない。
 */
function extractIdm(res) {
  const card = getCardResponse(res);
  if (!card || card.length < 10 || card[1] !== 0x01) return null;

  let idm = '';
  for (let j = 2; j < 10; j++) idm += hex2(card[j]);
  if (/^0+$/.test(idm)) return null; // 全ゼロは無効なIDm
  return idm;
}

/**
 * MIFARE (Type A) の GET UID 応答から UID を取り出す。
 *
 * GET UID コマンド(FF CA 00 00)の応答は末尾が成功ステータス 90 00 で、
 * その直前に UID（4バイトまたは7バイト）が入る:
 *   [...通信ヘッダ...][UID 4 or 7バイト][90 00]
 * カードが無い / 失敗のときは 90 00 で終わらない（63 00 等になる）。
 */
function extractUidA(res) {
  if (res.length < 4) return null;
  // 末尾が 90 00（成功）でなければUIDは取れていない
  if (res[res.length - 2] !== 0x90 || res[res.length - 1] !== 0x00) return null;

  // 90 00 の手前にあるデータ部を取り出す。通信ヘッダ(先頭10バイト)は除く。
  const body = res.slice(10, res.length - 2);
  if (body.length < 4 || body.length > 10) return null; // UIDは通常4 or 7バイト

  let uid = '';
  for (let j = 0; j < body.length; j++) uid += hex2(body[j]);
  if (/^0+$/.test(uid)) return null;
  return uid;
}

// ---- リーダー制御コマンド（共通） ------------------------------------
const CMD_END_SESSION   = [0xff, 0x50, 0x00, 0x00, 0x02, 0x82, 0x00, 0x00];
const CMD_START_SESSION = [0xff, 0x50, 0x00, 0x00, 0x02, 0x81, 0x00, 0x00];
const CMD_RF_OFF        = [0xff, 0x50, 0x00, 0x00, 0x02, 0x83, 0x00, 0x00];
const CMD_RF_ON         = [0xff, 0x50, 0x00, 0x00, 0x02, 0x84, 0x00, 0x00];

// ---- FeliCa（Type F）を1回読む --------------------------------------
async function readOnceFelica() {
  await send(CMD_END_SESSION);   await receive();
  await send(CMD_START_SESSION); await receive();
  await send(CMD_RF_OFF);        await receive();
  await send(CMD_RF_ON);         await receive();
  await send([0xff, 0x50, 0x00, 0x02, 0x04, 0x8f, 0x02, 0x03, 0x00, 0x00]); await receive(); // protocol type F

  // FeliCa Polling（システムコード FFFF / リクエストコード 01）
  await send([0xff, 0x50, 0x00, 0x01, 0x00, 0x00, 0x11, 0x5f, 0x46, 0x04,
              0xa0, 0x86, 0x01, 0x00, 0x95, 0x82, 0x00, 0x06, 0x06, 0x00,
              0xff, 0xff, 0x01, 0x00, 0x00, 0x00, 0x00]);
  const res = await receive();

  await send(CMD_END_SESSION); await receive();
  return res;
}

// ---- MIFARE（Type A）を1回読む --------------------------------------
async function readOnceTypeA() {
  await send(CMD_END_SESSION);   await receive();
  await send(CMD_START_SESSION); await receive();
  await send(CMD_RF_OFF);        await receive();
  await send(CMD_RF_ON);         await receive();
  await send([0xff, 0x50, 0x00, 0x02, 0x04, 0x8f, 0x02, 0x00, 0x03, 0x00]); await receive(); // protocol type A

  // GET UID（PC/SC標準）: FF CA 00 00 00
  await send([0xff, 0xca, 0x00, 0x00, 0x00]);
  const res = await receive();

  await send(CMD_END_SESSION); await receive();
  return res;
}

// ---- 1回分のポーリング（FeliCa→ダメならMIFARE） ---------------------
async function readOnce() {
  // ① まず FeliCa（Suica等）を試す
  const resF = await readOnceFelica();
  const idm = extractIdm(resF);

  if (debugMode) {
    const keyF = toHexString(resF.slice(10));
    if (keyF !== lastDebugHexF) {
      lastDebugHexF = keyF;
      const card = getCardResponse(resF);
      log(`F応答${resF.length}B: ${keyF}`);
      if (card && card.length > 0) log(`→ FeliCaカード応答${card.length}B: ${toHexString(card)}`);
      log(idm ? `→ FeliCa IDm = ${idm}` : '→ FeliCaでは読めず（MIFAREを試します）');
    }
  }
  if (idm) return { type: 'F', id: idm };

  // ② FeliCaで読めなければ MIFARE（Type A）を試す
  const resA = await readOnceTypeA();
  const uid = extractUidA(resA);

  if (debugMode) {
    const keyA = toHexString(resA.slice(10));
    if (keyA !== lastDebugHexA) {
      lastDebugHexA = keyA;
      log(`A応答${resA.length}B: ${keyA}`);
      log(uid ? `→ MIFARE UID = ${uid}` : '→ MIFAREでも読めず（末尾が90 00でない＝UID未取得）');
    }
  }
  if (uid) return { type: 'A', id: uid };

  return null;
}

// ---- ポーリングループ ------------------------------------------------
async function pollLoop() {
  while (polling && device) {
    try {
      const card = await readOnce(); // { type:'F'|'A', id } または null
      const now = Date.now();
      if (card) {
        // 同じカードが載りっぱなしの間は1回だけ処理する
        const isNew = (card.id !== lastIdm) || (now - lastSeenAt > RETAP_RESET_MS);
        lastSeenAt = now;
        if (isNew) {
          lastIdm = card.id;
          await onCardDetected(card.id);
        }
      } else {
        // カードが離れたら状態リセット（同じカードの再タッチを許可）
        if (now - lastSeenAt > RETAP_RESET_MS) lastIdm = '';
      }
    } catch (err) {
      log('読取エラー: ' + err.message);
      await sleep(500);
    }
    await sleep(400);
  }
}

// ---- GASへの通信（打刻・登録 共通） ----------------------------------
//
// fetch ではなく <script> タグで呼び出す（JSONP）。
// Googleアカウントにログイン中のブラウザだと、GASの応答が組織専用のアドレス
// （script.googleusercontent.com/a/macros/<ドメイン>/echo）へ転送され、
// そこが外部サイトからの読み取りを許可しないため fetch が遮断される。
// <script> タグでの読み込みはこの制限を受けないので、ログイン状態に左右されない。
//
// paramsObj 例: { idm, type } / { action:'register', idm, name, staffId }
let jsonpSeq = 0;

function gasRequest(paramsObj) {
  return new Promise((resolve) => {
    const url = getGasUrl();
    if (!url) { resolve({ ok: false, message: 'GASのURLが未設定です（設定から入力）' }); return; }

    const cbName = '__gasCb' + (++jsonpSeq);
    const params = Object.assign({}, paramsObj);
    // 合言葉が設定されていれば一緒に送る（GAS側が未設定なら無視される）
    const token = getGasToken();
    if (token) params.token = token;
    params.callback = cbName;

    const qs = Object.entries(params)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');

    const script = document.createElement('script');
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
      resolve(result);
    };

    // 応答が返らないまま固まるのを防ぐため制限時間を設ける
    const timer = setTimeout(
      () => finish({ ok: false, message: `GASから${SEND_TIMEOUT_SEC}秒以内に応答がありません` }),
      SEND_TIMEOUT_SEC * 1000
    );

    window[cbName] = (data) => finish(data);
    script.onerror = () => finish({
      ok: false,
      message: 'GASへの通信に失敗しました（設定のURLと公開設定を確認してください）',
    });

    script.src = url + '?' + qs;
    document.head.appendChild(script);
  });
}

// ---- カード検出時 ----------------------------------------------------
async function onCardDetected(idm) {
  log('カード検出 IDm=' + idm);

  // 登録モード中ならカードIDを取り込んで氏名入力ダイアログを開く
  if (uiState === 'enroll') {
    enrollCapture(idm);
    return;
  }

  // 出勤/退勤ボタンが押されていない間はカードを読んでも記録しない
  if (uiState !== 'armed') {
    log('種別未選択のため無視（先に出勤/退勤を押す）');
    return;
  }
  if (navigator.vibrate) { try { navigator.vibrate(80); } catch (e) { /* 非対応端末は無視 */ } }
  beepRead(); // 「カードは読めました」の合図。くり返し音はそのまま続く

  // カードを読めた時点で「かざし待ち」は完了。
  // GASの応答が遅くても「時間切れ」にならないよう、ここでカウントダウンを止める。
  // （くり返し音は clearArmTimers では止めない。記録が終わるまで鳴らし続ける）
  clearArmTimers();
  $('count').textContent = '';
  $('status').textContent = '記録しています…';
  log('GASへ送信中…');

  const data = await gasRequest({ idm: idm, type: selectedType });
  showResult(data);
  log('送信結果: ' + JSON.stringify(data));
}

// ---- 社員証の登録（新入職員用） -------------------------------------
let enrollIdm = '';

/** 登録モードに入る（カードをかざす待ち） */
function toEnroll() {
  if (!device || !polling) { alert('先にリーダーへ接続してください'); return; }
  unlockAudio();
  stopSpeaking();
  clearArmTimers();
  uiState = 'enroll';
  lastIdm = '';
  enrollIdm = '';

  $('status').textContent = '登録：社員証をかざしてください';
  $('choose').style.display = 'none';
  $('panel').style.display  = 'none';
  $('armed').style.display  = 'flex';

  const badge = $('armedBadge');
  badge.textContent = '登録';
  badge.className = 'badge in';

  startWaiting(); // 登録も「かざし待ち」なので同じように鳴らす

  // 無操作なら自動で選択画面に戻す
  let remain = ARM_TIMEOUT_SEC;
  $('count').textContent = `（${remain}秒以内にかざしてください）`;
  countTimer = setInterval(() => {
    remain--;
    $('count').textContent = remain > 0 ? `（${remain}秒以内にかざしてください）` : '';
  }, 1000);
  armTimer = setTimeout(() => { log('時間切れのため選択に戻ります'); toIdle(); }, ARM_TIMEOUT_SEC * 1000);
}

/** 登録モードでカードを読めたら、氏名入力ダイアログを開く */
function enrollCapture(idm) {
  clearArmTimers();
  stopWaiting(); // 氏名を入力してもらう間は鳴らさない
  enrollIdm = idm;
  uiState = 'result'; // ダイアログ入力中は打刻・再検出をしない中立状態
  $('count').textContent = '';
  $('status').textContent = '';
  $('enrollIdm').textContent = idm;
  $('enrollName').value = '';
  setElVal('enrollStaffId', '');
  $('enrollDlg').showModal();
  setTimeout(() => $('enrollName').focus(), 50);
  if (navigator.vibrate) { try { navigator.vibrate(80); } catch (e) {} }
  beepRead();
}

/** 氏名を入力して「登録する」を押したとき */
async function enrollSubmit() {
  const name = $('enrollName').value.trim();
  if (!name) { alert('氏名を入力してください'); return; }
  // 職員番号はPC打刻の一覧で同姓同名を見分けるために使う（未入力でも登録はできる）
  const staffId = elVal('enrollStaffId').trim();
  const idm = enrollIdm;
  $('enrollDlg').close();

  $('status').textContent = '登録しています…';
  startWaiting();
  const data = await gasRequest({ action: 'register', idm: idm, name: name, staffId: staffId });
  log('登録結果: ' + JSON.stringify(data));

  if (data.ok) {
    showResult({ ok: true, duplicated: false, name: name, type: data.updated ? '氏名を更新' : '登録完了', time: idm });
  } else {
    showResult({ ok: false, message: data.message || '登録に失敗しました' });
  }
}

// ==== USB 接続処理 =====================================================
async function connect() {
  unlockAudio();
  try {
    // 既に許可済みのデバイスがあれば選択ダイアログ無しで使う
    const granted = await navigator.usb.getDevices();
    device = granted.find(d => d.vendorId === SONY_VENDOR_ID) || null;
    if (!device) {
      device = await navigator.usb.requestDevice({ filters: [{ vendorId: SONY_VENDOR_ID }] });
    }

    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);

    // ベンダ固有インタフェース(class 255)を選ぶ
    const intf = device.configuration.interfaces.find(
      i => i.alternate.interfaceClass === 255
    );
    if (!intf) throw new Error('対応インタフェースが見つかりません');
    epIn = intf.alternate.endpoints.find(e => e.direction === 'in').endpointNumber;
    epOut = intf.alternate.endpoints.find(e => e.direction === 'out').endpointNumber;
    await device.claimInterface(intf.interfaceNumber);

    setConnected(true);
    log('接続成功');
    polling = true;
    pollLoop();
  } catch (err) {
    setConnected(false);
    log('接続失敗: ' + err.message);
    alert('接続に失敗しました: ' + err.message);
  }
}

function setConnected(on) {
  $('dot').classList.toggle('on', on);
  $('connLabel').textContent = on ? '接続中' : '未接続';
  $('connectBtn').textContent = on ? '再接続' : 'リーダーに接続';
  if (on) toIdle();
}

// USBが抜かれたとき
if (navigator.usb) {
  navigator.usb.addEventListener('disconnect', (e) => {
    if (e.device === device) {
      polling = false; device = null; setConnected(false);
      log('リーダーが切断されました');
      $('status').textContent = 'リーダーが切断されました（再接続してください）';
    }
  });
}

// ==== UIイベント =======================================================
$('btnIn').addEventListener('click', () => toArmed('出勤'));
$('btnOut').addEventListener('click', () => toArmed('退勤'));
$('cancelBtn').addEventListener('click', toIdle);

$('connectBtn').addEventListener('click', connect);

// 社員証の登録
$('enrollBtn').addEventListener('click', toEnroll);
$('enrollSave').addEventListener('click', enrollSubmit);
$('enrollCancel').addEventListener('click', () => { $('enrollDlg').close(); toIdle(); });
$('enrollName').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const sid = $('enrollStaffId');
  if (sid) sid.focus(); else enrollSubmit();
});
onEl('enrollStaffId', 'keydown', (e) => { if (e.key === 'Enter') enrollSubmit(); });

$('settingsBtn').addEventListener('click', () => {
  $('gasUrl').value = getGasUrl();
  setElVal('gasToken', getGasToken());
  $('settings').showModal();
});
$('saveSettings').addEventListener('click', () => {
  setGasUrl($('gasUrl').value.trim());
  // 古い画面には合言葉欄が無い。その場合に空文字で上書きすると保存済みの合言葉が消えるので触らない。
  if ($('gasToken')) setGasToken(elVal('gasToken').trim());
  $('settings').close();
  log('設定を保存しました');
});
$('closeSettings').addEventListener('click', () => $('settings').close());

// GASへの疎通テスト。カードを使わず、保存中のURLへ実際に通信して原因を切り分ける。
$('testBtn').addEventListener('click', async () => {
  const url = getGasUrl();
  if (!url) { log('テスト: GAS URLが未設定です（設定から入力してください）'); return; }

  // 保存されているURLを画面に出して、正しい /exec かを目で確認できるようにする
  log('保存中URL: ' + url);
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) {
    log('⚠ URLの形が想定と違います。正しくは script.google.com/macros/s/.../exec で終わる形です');
  }

  // ① 稼働確認（実際の打刻と同じ経路で送る）
  log('テスト①稼働確認 送信中…');
  const r1 = await gasRequest({});
  log('テスト①結果: ' + JSON.stringify(r1));

  // ② 実際の打刻と同じ内容（ダミーIDm）で確認
  log('テスト②ダミー打刻 送信中…');
  const r2 = await gasRequest({ idm: 'TESTCARD00000001', type: '出勤' });
  log('テスト②結果: ' + JSON.stringify(r2));
});

// 音量の切り替え。押すたびに 音なし → 小 → 中 → 大 → 音なし… と変わる。
// 設定はこの端末に保存される（夜勤帯だけ音なしにする、といった使い方ができる）。
function refreshSoundBtn() {
  const b = $('soundBtn');
  if (b) b.textContent = VOL_STEPS[soundLevel()].label;
}
onEl('soundBtn', 'click', () => {
  const next = (soundLevel() + 1) % VOL_STEPS.length;
  setSoundLevel(next);
  refreshSoundBtn();
  if (next > 0) { unlockAudio(); beepOk(); } // 実際に鳴らして音量を確かめられるように
  else { stopWaiting(); stopSpeaking(); }
  log('音量を「' + VOL_STEPS[next].label.replace(/^\S+\s*/, '') + '」にしました');
});
refreshSoundBtn();

// 4種類の音を順に鳴らして、実際の聞こえ方を確かめるためのボタン。
// エラー音はわざと失敗させないと聞けないため、ここで確認できるようにしてある。
let soundTesting = false;
onEl('soundTestBtn', 'click', async () => {
  if (soundTesting) return;
  if (!soundEnabled()) { alert('いまは音なしの設定です。左の音量ボタンで音を出す設定にしてください。'); return; }
  soundTesting = true;
  unlockAudio();
  const items = [
    ['① カードを読めたとき',     () => beepRead(), 1200],
    ['② 出勤の打刻ができたとき', () => { beepOk(); setTimeout(() => speak(GREETINGS['出勤']), SPEAK_DELAY_MS); }, 3500],
    ['③ 退勤の打刻ができたとき', () => { beepOk(); setTimeout(() => speak(GREETINGS['退勤']), SPEAK_DELAY_MS); }, 3000],
    ['④ 連続打刻のとき',         () => beepSkip(), 1400],
    ['⑤ エラーのとき（警告音）', () => beepNg(),   2200],
  ];
  for (const [label, play, waitMs] of items) {
    log('音を聞く: ' + label);
    play();
    await sleep(waitMs);
  }
  if (!window.speechSynthesis) log('※この端末は読み上げに対応していません（音だけ鳴ります）');
  log('音を聞く: 終わりました');
  soundTesting = false;
});

$('debugBtn').addEventListener('click', () => {
  debugMode = !debugMode;
  lastDebugHexF = '';
  lastDebugHexA = '';
  $('debugBtn').textContent = debugMode ? 'デバッグOFF' : 'デバッグ';
  log(debugMode ? 'デバッグ表示を開始（リーダーの応答を表示します）' : 'デバッグ表示を停止');
});

// WebUSB 非対応チェック
if (!navigator.usb) {
  $('status').textContent = 'この端末/ブラウザは WebUSB 非対応です';
  $('choose').style.display = 'none';
  $('connectBtn').disabled = true;
}

// PWA: Service Worker 登録
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// 初期表示
toIdle();
