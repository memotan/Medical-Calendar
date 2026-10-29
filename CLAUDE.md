# CLAUDE.md

## プロジェクト概要

**MedCal** — 服薬記録と日記のカレンダー。**単一の `index.html`**（インライン CSS + バニラ JS、ビルド工程なし）。
データは端末内の `localStorage` が正本。任意で、薬の一覧・服薬回数・日記の本文を GAS 経由でスプレッドシートに同期できる
（**写真は送らない**）。同期した日記は、ホーム（Home Dashboard）の「昨日の日記」カードが読む。

- テスト・lint・ビルドの仕組みはない。ブラウザで動作確認する
- 見た目はクリーム色の和風（`--` 変数ではなく直書きの色。背景 `#faf8f4`、文字 `#2c2416`、アクセント `#c9614a`、フォントは Noto Serif JP / Shippori Mincho）。他の姉妹アプリのダークテーマとは別物なので揃えない

## ファイル構成

| パス | 役割 |
|---|---|
| `index.html` | アプリ本体 |
| `gas/Code.gs`, `gas/appsscript.json` | 同期用の GAS。**編集したら GAS エディタに貼り直し、再デプロイが必要** |
| `capacitor-app/capacitor.config.json` | Pages を読む方式（`server.url`）に切り替えるときの設定**案**。現在の APK はこれを使っていない |
| `README.md` | 同期のセットアップと、Capacitor 切り替えの手順 |

## データ

```js
meds    = [{ id, name, color }]
records = { 'yyyy-MM-dd': { meds: { [medId]: 回数 }, note: '日記', images: [dataURL, ...] } }
```

- `localStorage`: `medcal_meds` / `medcal_records` / `medcal_gas_url` / `medcal_gas_token` / `medcal_sync_state`
- 服薬回数の上限は `MAX_COUNT`（3）。タップするたびに 0→1→2→3→0
- **写真は `records` の中に base64 の dataURL として入っている**（長辺 1024px・JPEG 品質 0.7 に縮小）。`localStorage` の容量（約 5MB）に限りがあり、超えると `saveRecords()` が `false` を返してアラートを出す。**写真を同期に含めないこと**（容量とプライバシーの面で）
- **保存は必ず `saveMeds()` / `saveRecords()` を通す。** 同期の予約（`scheduleSync()`）がここに仕込んである
- JSON のエクスポート / インポート（`handleExport` / `handleImport`）がある。**日記と写真もここに含まれる**。Capacitor では `@capacitor/filesystem` と `@capacitor/share` を使うので、この 2 つのプラグインを外さないこと

## サーバ同期

- 端末内が正本。服薬回数・日記が変わると、最後の変更から 3 秒後に裏で GAS へ送る。失敗しても端末内の保存には影響せず、60 秒後と次回起動時・オンライン復帰時に再試行する
- 送った内容の指紋（服薬回数＋日記のハッシュ）を `medcal_sync_state` に覚え、**変わった日だけ**送る。日記は入力のたびに保存されるが、指紋が同じなら通信しない
- **`fetch` に `Content-Type` を付けないこと。** 付けると CORS のプリフライトが飛び、GAS が応答できずに失敗する
- 「サーバの記録から復元」は、**サーバにある項目だけを上書きする**（サーバに無い日記・写真を、端末内のものごと消さない）
- GAS は **`MEDCAL_TOKEN`（合言葉）が未設定だと `ping` 以外をすべて拒否する**。日記は私的なデータなので、この方針を緩めない
- GAS のシート: `薬`（id, name, color, order）/ `服薬`（date, medId, count, updatedAt）/ `日記`（date, note, updatedAt）。日付・ID・日記の列は**テキスト書式**にして書き込む（`=` で始まる日記が数式にならないように。日付が日付値に変換されないように）。読むときは `getDisplayValues()`
- GAS のアクション: `ping` / `sync` / `get` / `day`。`day` はホームが使う（日付を省略すると昨日）。**`day` の返り値の形を変えるときは、Home Dashboard 側も直す**

## バージョン

| 定数 | 場所 | いつ上げるか |
|---|---|---|
| `GAS_VERSION` | `gas/Code.gs` | `Code.gs` を直したとき |

アプリ側にバージョン定数はない（変更履歴は git で追う）。GAS を直したら、再デプロイまで行わないと反映されない。

## Capacitor（Android アプリ）

- **現在の APK は同梱方式**（`capacitor.config.json` に `server.url` が無く、`index.html` を APK に同梱している）。Capacitor のプロジェクト本体は**自宅 PC にあり、このリポジトリには入っていない**。したがって、アプリを直すたびに APK の作り直しが要る
- **`appId`（`com.kei.medcal`）は変えない**（変えると別のアプリとして入ってしまう）
- Pages を読む方式に切り替えると、WebView のオリジンが `https://localhost` から `https://memotan.github.io` に変わる。**`localStorage` はオリジンごとなので、切り替え直後は記録が空に見える**（消えたのではなく別の場所を見ている）。必ず、先に JSON でエクスポートし、切り替え後にインポートする。手順は README を参照
- 署名鍵は PC ごとに別。別の PC でビルドした APK は上書きできない

## 動作確認

- `localStorage` が使える HTTP サーバ経由か、スタブを足したコピーで開く。確認用ファイルはコミットしない
- GAS 同期はモックで確認する（Playwright の `page.route`）。実機・実際の GAS での確認はユーザーが行う

## デプロイ

- Pages を有効にすれば、`main` ブランチの `/ (root)` から配信できる（現時点で有効かどうかは未確認）。ただし現在の APK は Pages を読んでいないので、push しただけでは APK の中身は変わらない
- GAS は `GAS_VERSION` を上げ、GAS エディタに貼り直したうえで「デプロイを管理 → 編集 → 新バージョン → デプロイ」まで行う
