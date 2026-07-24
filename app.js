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
let lastDebugHex = '';      // 同じ応答を連続で出さないための直前値

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
const hex2 = (v) => ('0' + (v & 0xff).toString(16).toUpperCase()).slice(-2);

// ---- 設定（GAS URL） -------------------------------------------------
function getGasUrl() { return localStorage.getItem('gasUrl') || ''; }
function setGasUrl(u) { localStorage.setItem('gasUrl', u); }

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

// ==== 画面遷移 =========================================================

/** ①出勤/退勤の選択画面に戻す */
function toIdle() {
  clearArmTimers();
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
  } else if (data.ok && data.duplicated) {
    $('status').textContent = '連続打刻のためスキップ';
    $('rName').textContent = data.name || '';
    $('rType').textContent = ''; $('rTime').textContent = '';
    panel.classList.remove('flash-ok'); panel.classList.add('flash-ng');
  } else {
    $('status').textContent = 'エラー';
    $('rName').textContent = data.message || '不明なエラー';
    $('rType').textContent = ''; $('rTime').textContent = '';
    panel.classList.remove('flash-ok'); panel.classList.add('flash-ng');
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

// ---- 初期化 & 1回分のポーリング -------------------------------------
async function readOnce() {
  // トランスペアレントセッション開始 → RF ON → プロトコルF → Polling → 終了
  await send([0xff, 0x50, 0x00, 0x00, 0x02, 0x82, 0x00, 0x00]); await receive(); // end session
  await send([0xff, 0x50, 0x00, 0x00, 0x02, 0x81, 0x00, 0x00]); await receive(); // start session
  await send([0xff, 0x50, 0x00, 0x00, 0x02, 0x83, 0x00, 0x00]); await receive(); // RF off
  await send([0xff, 0x50, 0x00, 0x00, 0x02, 0x84, 0x00, 0x00]); await receive(); // RF on
  await send([0xff, 0x50, 0x00, 0x02, 0x04, 0x8f, 0x02, 0x03, 0x00, 0x00]); await receive(); // protocol type F

  // FeliCa Polling（システムコード FFFF / リクエストコード 01）
  await send([0xff, 0x50, 0x00, 0x01, 0x00, 0x00, 0x11, 0x5f, 0x46, 0x04,
              0xa0, 0x86, 0x01, 0x00, 0x95, 0x82, 0x00, 0x06, 0x06, 0x00,
              0xff, 0xff, 0x01, 0x00, 0x00, 0x00, 0x00]);
  const res = await receive();

  await send([0xff, 0x50, 0x00, 0x00, 0x02, 0x82, 0x00, 0x00]); await receive(); // end session

  const idm = extractIdm(res);

  // デバッグ中は応答の中身を画面に出す。
  // 先頭10バイトの通信ヘッダには毎回変わる通信カウンタが入っており、
  // それを含めて比較すると毎回「変化した」と判定されログが流れ続けるため、
  // ヘッダを除いた部分で比較する。
  if (debugMode) {
    const key = toHexString(res.slice(10));
    if (key !== lastDebugHex) {
      lastDebugHex = key;
      const card = getCardResponse(res);
      log(`応答${res.length}B: ${key}`);
      if (!card) {
        log('→ カード応答の入れ物(0x97)が無い＝リーダーが応答を返していない');
      } else if (card.length === 0) {
        log('→ カード応答が空＝カードが電波に反応していない');
      } else {
        log(`→ カード応答${card.length}B: ${toHexString(card)}`);
      }
      log(idm ? `→ IDm = ${idm}` : '→ IDm を取り出せず');
    }
  }

  return idm;
}

// ---- ポーリングループ ------------------------------------------------
async function pollLoop() {
  while (polling && device) {
    try {
      const idm = await readOnce();
      const now = Date.now();
      if (idm) {
        // 同じカードが載りっぱなしの間は1回だけ処理する
        const isNew = (idm !== lastIdm) || (now - lastSeenAt > RETAP_RESET_MS);
        lastSeenAt = now;
        if (isNew) {
          lastIdm = idm;
          await onCardDetected(idm);
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

// ---- カード検出時 ----------------------------------------------------
async function onCardDetected(idm) {
  log('カード検出 IDm=' + idm);

  // 出勤/退勤ボタンが押されていない間はカードを読んでも記録しない
  if (uiState !== 'armed') {
    log('種別未選択のため無視（先に出勤/退勤を押す）');
    return;
  }
  if (navigator.vibrate) { try { navigator.vibrate(80); } catch (e) { /* 非対応端末は無視 */ } }

  const url = getGasUrl();
  if (!url) {
    showResult({ ok: false, message: 'GASのURLが未設定です（設定から入力）' });
    return;
  }

  // カードを読めた時点で「かざし待ち」は完了。
  // GASの応答が遅くても「時間切れ」にならないよう、ここでカウントダウンを止める。
  clearArmTimers();
  $('count').textContent = '';
  $('status').textContent = '記録しています…';
  log('GASへ送信中…');

  const type = selectedType;

  // 応答が返らないまま固まるのを防ぐため制限時間を設ける
  const ctrl = new AbortController();
  const abortTimer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_SEC * 1000);

  try {
    // Content-Type を text/plain にして CORS プリフライトを回避（GASはe.postData.contentsで受け取れる）
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ idm, type }),
      signal: ctrl.signal,
    });

    // JSON以外（ログイン画面のHTMLなど）が返ることがあるため、
    // 先に文字列で受け取ってから解釈し、失敗時は中身を表示して原因を追えるようにする
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      log(`GASの応答が想定外(HTTP ${resp.status}): ${text.slice(0, 150)}`);
      showResult({ ok: false, message: `GASの応答が不正です（HTTP ${resp.status}）` });
      return;
    }

    showResult(data);
    log('送信結果: ' + JSON.stringify(data));
  } catch (err) {
    const msg = (err.name === 'AbortError')
      ? `GASから${SEND_TIMEOUT_SEC}秒以内に応答がありません`
      : '送信失敗: ' + err.message;
    showResult({ ok: false, message: msg });
    log(msg);
  } finally {
    clearTimeout(abortTimer);
  }
}

// ==== USB 接続処理 =====================================================
async function connect() {
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
$('settingsBtn').addEventListener('click', () => {
  $('gasUrl').value = getGasUrl();
  $('settings').showModal();
});
$('saveSettings').addEventListener('click', () => {
  setGasUrl($('gasUrl').value.trim());
  $('settings').close();
  log('GAS URL を保存しました');
});
$('closeSettings').addEventListener('click', () => $('settings').close());

$('debugBtn').addEventListener('click', () => {
  debugMode = !debugMode;
  lastDebugHex = '';
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
