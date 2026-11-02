/**
 * MedCal 用 GAS（服薬回数・体重・日記の同期）
 *
 * 端末内（localStorage）が正本。アプリは服薬回数や日記が変わるたびに、裏でここへ送る。
 * 送るのは「薬の一覧」「日ごとの服薬回数」「体重」「日記の本文」。写真は端末内に残す。
 * ホーム画面（Home Dashboard）は、ここから「昨日の日記」を読む。
 *
 * セットアップ:
 *  1. 新しいスプレッドシートを作り、拡張機能 > Apps Script を開く
 *  2. このファイルを貼り、appsscript.json も同じ内容に揃える（タイムゾーンは Asia/Tokyo）
 *  3. プロジェクトの設定 > スクリプト プロパティに MEDCAL_TOKEN を追加し、合言葉を入れる（必須）。
 *     日記は私的なデータなので、合言葉が未設定の間は ping 以外をすべて拒否する
 *  4. デプロイ > ウェブアプリ（実行: 自分 / アクセス: 全員）。発行された URL をアプリの設定に入れる
 *  5. コードを直したら、デプロイを管理 > 編集 > 新バージョン で再デプロイする
 *
 * シート:
 *   薬   … id, name, color, order
 *   服薬 … date(yyyy-MM-dd), medId, count, updatedAt
 *   日記 … date(yyyy-MM-dd), note, updatedAt
 *   体重 … date(yyyy-MM-dd), kg, updatedAt（初回の体重送信時に自動で作られる）
 */
const GAS_VERSION = '1.2.0';
const MEDS_SHEET = '薬';
const LOG_SHEET = '服薬';
const MEDS_HEADERS = ['id', 'name', 'color', 'order'];
const LOG_HEADERS = ['date', 'medId', 'count', 'updatedAt'];
const NOTES_SHEET = '日記';
const NOTES_HEADERS = ['date', 'note', 'updatedAt'];
const WEIGHT_SHEET = '体重';
const WEIGHT_HEADERS = ['date', 'kg', 'updatedAt'];
const NOTE_MAX = 40000;   // セルの上限（50000 字）に収める

function doPost(e) {
  var result;
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'ping') {
      result = { version: GAS_VERSION, today: todayStr_() };
    } else {
      checkToken_(body.token);
      switch (body.action) {
        case 'sync': result = sync_(body.meds, body.days); break;
        case 'get':  result = getAll_(); break;
        case 'day':  result = day_(body.date); break;
        default: throw new Error('unknown action: ' + body.action);
      }
    }
    result = { ok: true, data: result };
  } catch (err) {
    result = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ version: GAS_VERSION, actions: ['ping', 'sync', 'get', 'day'] }))
    .setMimeType(ContentService.MimeType.JSON);
}

function checkToken_(token) {
  var want = String(PropertiesService.getScriptProperties().getProperty('MEDCAL_TOKEN') || '');
  if (!want) throw new Error('スクリプト プロパティ MEDCAL_TOKEN（合言葉）が未設定です');
  if (String(token || '') !== want) throw new Error('合言葉(token)が違います');
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

function writeAll_(sh, headers, rows, textCols) {
  sh.clearContents();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (!rows.length) return;
  // 日記が「=」で始まっても数式にならないよう、書き込む範囲にその都度テキスト書式を指定する
  (textCols || []).forEach(function (c) { sh.getRange(2, c, rows.length, 1).setNumberFormat('@'); });
  sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

/**
 * meds: [{id,name,color}] を渡すと薬の一覧を丸ごと置き換える（省略可）
 * days: {'yyyy-MM-dd': {meds: {medId: count}, note: '日記', weight: 62.5}} を渡すと、その日の服薬回数と日記を置き換える
 *       （meds が空・note が空なら、その日の記録を消す）。weight は項目があるときだけ置き換える（null なら消す）
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
      }), [1, 2]);
      sentMeds = meds.length;
    }
    if (days && typeof days === 'object') {
      var targets = {};
      Object.keys(days).forEach(function (d) { if (dateStr_(d)) targets[dateStr_(d)] = days[d] || {}; });
      var inTargets = function (r) { return r[0] && (dateStr_(r[0]) in targets); };

      var log = sheet_(LOG_SHEET, LOG_HEADERS, [1, 2]);
      var keptLog = readRows_(log).filter(function (r) { return r[0] && !inTargets(r); })
        .map(function (r) { return [dateStr_(r[0]), r[1], Number(r[2]) || 0, r[3]]; });
      var notes = sheet_(NOTES_SHEET, NOTES_HEADERS, [1, 2]);
      var keptNotes = readRows_(notes).filter(function (r) { return r[0] && !inTargets(r); })
        .map(function (r) { return [dateStr_(r[0]), r[1], r[2]]; });

      Object.keys(targets).forEach(function (d) {
        var counts = targets[d].meds || {};
        Object.keys(counts).forEach(function (medId) {
          var c = Number(counts[medId]) || 0;
          if (c > 0) keptLog.push([d, String(medId), c, now]);
        });
        var note = String(targets[d].note || '');
        if (note.trim()) keptNotes.push([d, note.slice(0, NOTE_MAX), now]);
        sentDays++;
      });
      var byDate = function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; };
      writeAll_(log, LOG_HEADERS, keptLog.sort(byDate), [1, 2]);
      writeAll_(notes, NOTES_HEADERS, keptNotes.sort(byDate), [1, 2]);

      // 体重は 'weight' の項目がある日だけ置き換える（項目を知らない古いアプリが体重を消さないように）
      var wTargets = {}, hasW = false;
      Object.keys(targets).forEach(function (d) { if ('weight' in targets[d]) { wTargets[d] = targets[d].weight; hasW = true; } });
      if (hasW) {
        var wsh = sheet_(WEIGHT_SHEET, WEIGHT_HEADERS, [1, 2]);
        var keptW = readRows_(wsh).filter(function (r) { return r[0] && !(dateStr_(r[0]) in wTargets); })
          .map(function (r) { return [dateStr_(r[0]), r[1], r[2]]; });
        Object.keys(wTargets).forEach(function (d) {
          var kg = Number(wTargets[d]);
          if (wTargets[d] != null && isFinite(kg) && kg > 0) keptW.push([d, String(kg), now]);
        });
        writeAll_(wsh, WEIGHT_HEADERS, keptW.sort(byDate), [1, 2]);
      }
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

function getNotes_() {
  var notes = {};
  readRows_(sheet_(NOTES_SHEET, NOTES_HEADERS, [1, 2])).forEach(function (r) {
    var d = dateStr_(r[0]);
    if (d && String(r[1]).trim()) notes[d] = r[1];
  });
  return notes;
}

function getWeights_() {
  var weights = {};
  readRows_(sheet_(WEIGHT_SHEET, WEIGHT_HEADERS, [1, 2])).forEach(function (r) {
    var d = dateStr_(r[0]);
    var kg = Number(r[1]);
    if (d && isFinite(kg) && kg > 0) weights[d] = kg;
  });
  return weights;
}

/** 端末の復元用 */
function getAll_() { return { meds: getMeds_(), days: getDays_(), notes: getNotes_(), weights: getWeights_() }; }

/** ホーム画面用。日記と、その日の薬ごとの回数。date 省略時は昨日 */
function day_(date) {
  var d = dateStr_(date);
  if (!d) {
    var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    d = Utilities.formatDate(new Date(Date.now() - 86400000), tz, 'yyyy-MM-dd');
  }
  var counts = getDays_()[d] || {};
  return {
    date: d,
    note: getNotes_()[d] || '',
    weight: getWeights_()[d] || null,
    meds: getMeds_().map(function (m) { return { id: m.id, name: m.name, color: m.color, count: counts[m.id] || 0 }; })
  };
}
