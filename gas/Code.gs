/**
 * MedCal 用 GAS（服薬回数の同期）
 *
 * 端末内（localStorage）が正本。アプリは服薬回数が変わるたびに、裏でここへ送る。
 * 送るのは「薬の一覧」と「日ごとの服薬回数」だけ。日記と写真は端末内に残す。
 *
 * セットアップ:
 *  1. 新しいスプレッドシートを作り、拡張機能 > Apps Script を開く
 *  2. このファイルを貼り、appsscript.json も同じ内容に揃える（タイムゾーンは Asia/Tokyo）
 *  3. （推奨）プロジェクトの設定 > スクリプト プロパティに MEDCAL_TOKEN を追加し、合言葉を入れる。
 *     服薬の記録は私的なデータなので、URL だけで読めないようにする
 *  4. デプロイ > ウェブアプリ（実行: 自分 / アクセス: 全員）。発行された URL をアプリの設定に入れる
 *  5. コードを直したら、デプロイを管理 > 編集 > 新バージョン で再デプロイする
 *
 * シート:
 *   薬   … id, name, color, order
 *   服薬 … date(yyyy-MM-dd), medId, count, updatedAt
 */
const GAS_VERSION = '1.0.0';
const MEDS_SHEET = '薬';
const LOG_SHEET = '服薬';
const MEDS_HEADERS = ['id', 'name', 'color', 'order'];
const LOG_HEADERS = ['date', 'medId', 'count', 'updatedAt'];

function doPost(e) {
  var result;
  try {
    var body = JSON.parse(e.postData.contents);
    checkToken_(body.token);
    switch (body.action) {
      case 'ping':  result = { version: GAS_VERSION, today: todayStr_() }; break;
      case 'sync':  result = sync_(body.meds, body.days); break;
      case 'get':   result = getAll_(); break;
      case 'today': result = today_(); break;
      default: throw new Error('unknown action: ' + body.action);
    }
    result = { ok: true, data: result };
  } catch (err) {
    result = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ version: GAS_VERSION, actions: ['ping', 'sync', 'get', 'today'] }))
    .setMimeType(ContentService.MimeType.JSON);
}

function checkToken_(token) {
  var want = String(PropertiesService.getScriptProperties().getProperty('MEDCAL_TOKEN') || '');
  if (want && String(token || '') !== want) throw new Error('合言葉(token)が違います');
}

function todayStr_() {
  return Utilities.formatDate(new Date(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

function sheet_(name, headers, textCols) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    // 日付やIDを日付値に変換されないよう、列ごと「書式なしテキスト」にしておく
    (textCols || []).forEach(function (c) { sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@'); });
  }
  return sh;
}

/** 表示されている文字列から読む（日付セルが文字列か日付値かに左右されない） */
function readRows_(sh) {
  if (sh.getLastRow() < 2) return [];
  var width = sh.getLastColumn();
  return sh.getRange(2, 1, sh.getLastRow() - 1, width).getDisplayValues();
}

function dateStr_(display) {
  var m = String(display || '').trim().match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : '';
}

function writeAll_(sh, headers, rows) {
  sh.clearContents();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

/**
 * meds: [{id,name,color}] を渡すと薬の一覧を丸ごと置き換える（省略可）
 * days: {'yyyy-MM-dd': {medId: count}} を渡すと、その日の行を置き換える（空のオブジェクトならその日の記録を消す）
 */
function sync_(meds, days) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var now = Utilities.formatDate(new Date(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
    var sentMeds = 0, sentDays = 0;
    if (Array.isArray(meds)) {
      var sh = sheet_(MEDS_SHEET, MEDS_HEADERS, [1]);
      writeAll_(sh, MEDS_HEADERS, meds.map(function (m, i) {
        return [String(m.id), String(m.name || ''), String(m.color || ''), i];
      }));
      sentMeds = meds.length;
    }
    if (days && typeof days === 'object') {
      var log = sheet_(LOG_SHEET, LOG_HEADERS, [1, 2]);
      var targets = {};
      Object.keys(days).forEach(function (d) { if (dateStr_(d)) targets[dateStr_(d)] = days[d] || {}; });
      var kept = readRows_(log).filter(function (r) { return r[0] && !(dateStr_(r[0]) in targets); })
        .map(function (r) { return [dateStr_(r[0]), r[1], Number(r[2]) || 0, r[3]]; });
      Object.keys(targets).forEach(function (d) {
        Object.keys(targets[d]).forEach(function (medId) {
          var c = Number(targets[d][medId]) || 0;
          if (c > 0) kept.push([d, String(medId), c, now]);
        });
        sentDays++;
      });
      kept.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
      writeAll_(log, LOG_HEADERS, kept);
    }
    return { meds: sentMeds, days: sentDays };
  } finally {
    lock.releaseLock();
  }
}

function getMeds_() {
  return readRows_(sheet_(MEDS_SHEET, MEDS_HEADERS, [1]))
    .filter(function (r) { return r[0]; })
    .sort(function (a, b) { return Number(a[3]) - Number(b[3]); })
    .map(function (r) { return { id: r[0], name: r[1], color: r[2] }; });
}

function getDays_() {
  var days = {};
  readRows_(sheet_(LOG_SHEET, LOG_HEADERS, [1, 2])).forEach(function (r) {
    var d = dateStr_(r[0]);
    var c = Number(r[2]) || 0;
    if (!d || !r[1] || c <= 0) return;
    (days[d] = days[d] || {})[r[1]] = c;
  });
  return days;
}

/** 端末の復元用 */
function getAll_() { return { meds: getMeds_(), days: getDays_() }; }

/** ホーム画面用。薬ごとの今日の回数（記録のない薬は 0） */
function today_() {
  var d = todayStr_();
  var counts = getDays_()[d] || {};
  return {
    date: d,
    meds: getMeds_().map(function (m) { return { id: m.id, name: m.name, color: m.color, count: counts[m.id] || 0 }; })
  };
}
