/**
 * 勤怠打刻アプリ（PC版 / 氏名を選んで打刻する）
 *
 * 操作の流れ:
 *   1. 職員一覧から氏名（職員番号）を選ぶ
 *   2. 【出勤】または【退勤】を押す
 *   3. 打刻結果を表示 → 氏名の選択画面に戻る
 *
 * 打刻時は、この端末のグローバルIPアドレスを一緒に送って記録する。
 * （院内から打刻したか、院外からかを後で確認できるようにするため）
 *
 * 設定（GASのURL・合言葉）はブラウザに保存される。
 * 職員へは次の形のリンクを配ると、設定入力なしで使える:
 *   https://（配置先）/pc.html?u=（GASのURL）&t=（合言葉）
 */

// IPアドレスの確認に使う外部サービス（返ってくるのは接続元IPのみ）
const IP_LOOKUP_URL = 'https://api.ipify.org?format=json';
const IP_TIMEOUT_SEC = 6;
// GASからの応答を待つ制限時間（無応答で固まるのを防ぐ）
const SEND_TIMEOUT_SEC = 20;
// 結果を表示してから氏名選択に戻るまでの秒数
const RESULT_HOLD_SEC = 4;

const $ = (id) => document.getElementById(id);

let staffList = [];      // [{ id, name, staffId }]
let selected = null;     // 選択中の職員
let myIp = '';           // この端末のグローバルIP
let sending = false;     // 二重送信の防止
let backTimer = null;

// ---- 設定の保存先（タブレット版と同じ localStorage を使う） ----------
function getGasUrl()      { return localStorage.getItem('gasUrl') || ''; }
function setGasUrl(v)     { localStorage.setItem('gasUrl', v); }
function getGasToken()    { return localStorage.getItem('gasToken') || ''; }
function setGasToken(v)   { localStorage.setItem('gasToken', v); }

/** URLに ?u=（GASのURL）&t=（合言葉） が付いていれば取り込んで、アドレス欄からは消す */
function importSettingsFromQuery() {
  const q = new URLSearchParams(location.search);
  const u = q.get('u');
  const t = q.get('t');
  if (!u && t === null) return;
  if (u) setGasUrl(u.trim());
  if (t !== null) setGasToken(t.trim());
  // 合言葉がアドレス欄に残り続けないよう消す
  history.replaceState(null, '', location.pathname);
}

// ---- 時計 ------------------------------------------------------------
function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
setInterval(tickClock, 1000); tickClock();

// ---- GASへの通信 -----------------------------------------------------
//
// fetch ではなく <script> タグで呼び出す（JSONP）。
// Googleアカウントにログイン中のブラウザだと、GASの応答が組織専用のアドレスへ
// 転送され、そこが外部サイトからの読み取りを許可しないため fetch は遮断される
// （Failed to fetch）。<script> タグでの読み込みはこの制限を受けない。
let jsonpSeq = 0;

function gasRequest(paramsObj) {
  return new Promise((resolve) => {
    const url = getGasUrl();
    if (!url) {
      resolve({ ok: false, message: 'GASのURLが未設定です（右下の「設定」から入力してください）' });
      return;
    }

    const cbName = '__gasCb' + (++jsonpSeq);
    const params = Object.assign({}, paramsObj);
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

    const timer = setTimeout(
      () => finish({ ok: false, message: `GASから${SEND_TIMEOUT_SEC}秒以内に応答がありません` }),
      SEND_TIMEOUT_SEC * 1000
    );

    window[cbName] = (data) => finish(data);
    script.onerror = () => finish({
      ok: false,
      message: 'GASへの通信に失敗しました（URLと公開設定を確認してください）',
    });

    script.src = url + '?' + qs;
    document.head.appendChild(script);
  });
}

// ---- グローバルIPの取得 ----------------------------------------------
// 取得できなくても打刻はできる（IP欄が空欄で記録される）。
async function loadIp() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IP_TIMEOUT_SEC * 1000);
  try {
    const r = await fetch(IP_LOOKUP_URL, { signal: ctrl.signal });
    const j = await r.json();
    myIp = String(j.ip || '');
    $('ipLabel').textContent = myIp ? `接続元IP: ${myIp}` : '接続元IPを取得できませんでした';
  } catch (e) {
    myIp = '';
    $('ipLabel').textContent = '接続元IPを取得できませんでした（打刻は可能です）';
  } finally {
    clearTimeout(timer);
  }
}

// ---- 職員一覧の読み込み ----------------------------------------------
async function loadStaff() {
  $('status').textContent = '職員一覧を読み込み中...';
  $('stafflist').innerHTML = '';
  const res = await gasRequest({ action: 'stafflist' });
  if (!res.ok) {
    $('status').textContent = '読み込みに失敗しました';
    showEmpty(res.message || '職員一覧を取得できませんでした');
    return;
  }
  staffList = res.staff || [];
  $('status').textContent = staffList.length
    ? '打刻する方を選んでください'
    : '職員マスタに氏名が登録されていません';
  renderStaff();
}

function showEmpty(msg) {
  const box = $('stafflist');
  box.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = msg;
  box.appendChild(d);
}

function renderStaff() {
  const kw = $('search').value.trim().toLowerCase();
  const box = $('stafflist');
  box.innerHTML = '';

  const hits = staffList.filter(s => {
    if (!kw) return true;
    return s.name.toLowerCase().includes(kw) || String(s.staffId || '').toLowerCase().includes(kw);
  });

  if (hits.length === 0) {
    showEmpty(staffList.length ? '該当する職員が見つかりません' : '職員が登録されていません');
    return;
  }

  hits.forEach(s => {
    const btn = document.createElement('button');
    btn.className = 'staffitem';
    btn.type = 'button';

    // 氏名は職員マスタの入力値なので、HTMLとして解釈させず文字として表示する
    const nm = document.createElement('span');
    nm.textContent = s.name;

    const sid = document.createElement('span');
    sid.className = 'sid';
    sid.textContent = s.staffId ? `（${s.staffId}）` : '（番号未登録）';

    btn.appendChild(nm);
    btn.appendChild(sid);
    btn.addEventListener('click', () => toTypeView(s));
    box.appendChild(btn);
  });
}

// ---- 画面遷移 --------------------------------------------------------
function showView(name) {
  $('selectView').style.display = (name === 'select') ? 'block' : 'none';
  $('typeView').style.display   = (name === 'type')   ? 'block' : 'none';
  $('resultView').style.display = (name === 'result') ? 'block' : 'none';
}

function toSelectView() {
  if (backTimer) { clearTimeout(backTimer); backTimer = null; }
  selected = null;
  showView('select');
  $('status').textContent = staffList.length ? '打刻する方を選んでください' : '職員が登録されていません';
  $('search').value = '';
  renderStaff();
  $('search').focus();
}

function toTypeView(staff) {
  selected = staff;
  showView('type');
  $('status').textContent = '打刻の種類を選んでください';
  $('whoName').textContent = staff.name;
  $('whoId').textContent = staff.staffId ? `職員番号 ${staff.staffId}` : '職員番号が未登録です';
}

function showResult(res) {
  showView('result');
  const box = $('resultBox');
  box.classList.remove('ok', 'ng');

  if (res.ok && !res.duplicated) {
    $('status').textContent = '打刻しました';
    $('rName').textContent = res.name || (selected ? selected.name : '');
    $('rType').textContent = res.type || '';
    $('rTime').textContent = res.time || '';
    box.classList.add('ok');
  } else if (res.ok && res.duplicated) {
    $('status').textContent = '連続打刻のためスキップしました';
    $('rName').textContent = res.name || (selected ? selected.name : '');
    $('rType').textContent = 'すでに打刻済みです';
    $('rTime').textContent = '';
    box.classList.add('ng');
  } else {
    $('status').textContent = '打刻できませんでした';
    $('rName').textContent = res.message || '不明なエラー';
    $('rType').textContent = '';
    $('rTime').textContent = '';
    box.classList.add('ng');
  }

  backTimer = setTimeout(toSelectView, RESULT_HOLD_SEC * 1000);
}

// ---- 打刻 ------------------------------------------------------------
async function punch(type) {
  if (!selected || sending) return;
  sending = true;
  $('status').textContent = '記録しています…';
  $('btnIn').disabled = true;
  $('btnOut').disabled = true;
  try {
    const res = await gasRequest({ action: 'punch', who: selected.id, type: type, ip: myIp });
    showResult(res);
  } finally {
    sending = false;
    $('btnIn').disabled = false;
    $('btnOut').disabled = false;
  }
}

// ==== イベント ========================================================
$('search').addEventListener('input', renderStaff);
$('btnIn').addEventListener('click', () => punch('出勤'));
$('btnOut').addEventListener('click', () => punch('退勤'));
$('btnBack').addEventListener('click', toSelectView);
$('btnDone').addEventListener('click', toSelectView);
$('reloadBtn').addEventListener('click', () => { toSelectView(); loadStaff(); });

$('settingsBtn').addEventListener('click', () => {
  $('gasUrl').value = getGasUrl();
  $('gasToken').value = getGasToken();
  $('settings').showModal();
});
$('saveSettings').addEventListener('click', () => {
  setGasUrl($('gasUrl').value.trim());
  setGasToken($('gasToken').value.trim());
  $('settings').close();
  loadStaff();
});
$('closeSettings').addEventListener('click', () => $('settings').close());

// ==== 起動 ============================================================
importSettingsFromQuery();
showView('select');
loadIp();
if (getGasUrl()) {
  loadStaff().then(() => $('search').focus());
} else {
  $('status').textContent = 'はじめに設定が必要です';
  showEmpty('右下の「設定」からGASのURLを入力してください');
}
