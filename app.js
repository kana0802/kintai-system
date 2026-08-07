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
const elVal    = (id) => { const el = $(id); return el ? el.value : ''; };
const setElVal = (id, v) => { const el = $(id); if (el) el.value = v; };
const onEl     = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
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
//   カード読取   … ピッ（短い高音1回）
//   記録中       … コッ、コッ…（待っている間くり返す。これが「何待ちか」の合図）
//   打刻できた   … ピンポーン（上がる2音）
//   連続打刻     … ププッ（同じ高さで2回）
//   エラー       … ブー（低い音）

let audioCtx = null;
let waitingTimer = null;

function soundEnabled() { return localStorage.getItem('soundOff') !== '1'; }
function setSoundEnabled(on) { localStorage.setItem('soundOff', on ? '0' : '1'); }

/** 音を鳴らせる状態にする（利用者の操作の中から呼ぶこと） */
function unlockAudio() {
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window['webkitAudioContext'];
      if (!Ctx) return;               // 非対応の端末では音なしで動く
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { audioCtx = null; }
}

/**
 * 単音を鳴らす。
 * delay 秒あとに freq ヘルツの音を dur 秒鳴らす。
 * 音の出だしと終わりを滑らかにしないと「プツッ」というノイズが入るため、
 * 音量を短時間で上げ下げしている。
 */
function tone(freq, dur, delay, gain) {
  if (!audioCtx || !soundEnabled()) return;
  try {
    const t0 = audioCtx.currentTime + (delay || 0);
    const osc = audioCtx.createOscillator();
    const amp = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const peak = (gain === undefined) ? 0.25 : gain;
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp); amp.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  } catch (e) { /* 音が出せなくても打刻は続行する */ }
}

/** カードを読めた合図 */
function beepRead() { tone(1180, 0.09, 0, 0.3); }

/** 記録中: 待っている間ずっと鳴らす。応答が返ったら必ず stopWaiting() で止める */
function startWaiting() {
  stopWaiting();
  if (!audioCtx || !soundEnabled()) return;
  const tick = () => tone(660, 0.06, 0, 0.14);  // 控えめな音量でくり返す
  tick();
  waitingTimer = setInterval(tick, 700);
}

function stopWaiting() {
  if (waitingTimer) { clearInterval(waitingTimer); waitingTimer = null; }
}

/** 打刻できた（上がる2音） */
function beepOk() { tone(880, 0.12, 0, 0.3); tone(1320, 0.22, 0.13, 0.3); }

/** 連続打刻でスキップした（同じ高さで2回） */
function beepSkip() { tone(760, 0.1, 0, 0.25); tone(760, 0.1, 0.16, 0.25); }

/** エラー（低い音） */
function beepNg() { tone(240, 0.45, 0, 0.3); }

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
}

/** ②種別を選んで「カードをかざしてください」画面へ */
function toArmed(type) {
  if (!device || !polling) { alert('先にリーダーへ接続してください'); return; }
  unlockAudio(); // ボタンを押した「今」なら音を鳴らせる状態にできる
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
    $('status').textContent = '打刻しました';
    $('rName').textContent = data.name ? data.name : '（未登録カード）';
    $('rType').textContent = data.type || selectedType || '';
    $('rTime').textContent = data.time || '';
    panel.classList.remove('flash-ng'); panel.classList.add('flash-ok');
    beepOk();
  } else if (data.ok && data.duplicated) {
    $('status').textContent = '連続打刻のためスキップ';
    $('rName').textContent = data.name || '';
    $('rType').textContent = ''; $('rTime').textContent = '';
    panel.classList.remove('flash-ok'); panel.classList.add('flash-ng');
    beepSkip();
  } else {
    $('status').textContent = 'エラー';
    $('rName').textContent = data.message || '不明なエラー';
    $('rType').textContent = ''; $('rTime').textContent = '';
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
  beepRead(); // 「カードは読めました」の合図

  // カードを読めた時点で「かざし待ち」は完了。
  // GASの応答が遅くても「時間切れ」にならないよう、ここでカウントダウンを止める。
  clearArmTimers();
  $('count').textContent = '';
  $('status').textContent = '記録しています…';
  startWaiting(); // 応答が返るまで鳴らし続ける（カードを離してよいことが分かる）
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

// 音のON/OFF（夜勤帯など、鳴らしたくない場面のため）。設定はこの端末に保存される。
function refreshSoundBtn() {
  const b = $('soundBtn');
  if (b) b.textContent = soundEnabled() ? '🔊 音あり' : '🔇 音なし';
}
onEl('soundBtn', 'click', () => {
  const next = !soundEnabled();
  setSoundEnabled(next);
  refreshSoundBtn();
  if (next) { unlockAudio(); beepOk(); }   // ONにしたときは実際に鳴らして確認できるように
  else stopWaiting();
  log(next ? '音を鳴らす設定にしました' : '音を鳴らさない設定にしました');
});
refreshSoundBtn();

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
