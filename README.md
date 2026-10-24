# MedCal（服薬記録・日記）

単一の `index.html`（バニラ JS、ビルドなし）。データは端末内の localStorage に保存する。
任意で、服薬回数と薬の一覧だけを GAS 経由でスプレッドシートに同期できる（日記と写真は送らない）。

## ファイル

| パス | 役割 |
|---|---|
| `index.html` | アプリ本体 |
| `gas/Code.gs`, `gas/appsscript.json` | 同期用の GAS。**編集したら GAS エディタに貼り直し、新バージョンで再デプロイが必要** |
| `capacitor-app/capacitor.config.json` | Android アプリ（Capacitor）の設定。下記「Pages を読む方式に切り替える」用 |

## サーバ同期

- 端末内が正本。服薬回数が変わると、3 秒後に裏で GAS へ送る。失敗しても端末内の保存には影響せず、60 秒後と次回起動時に再試行する
- 送る内容は薬の一覧（id・名前・色）と日ごとの服薬回数だけ。日記と写真は送らない
- 変わった日だけを送る（送った内容は `medcal_sync_state` に覚えている）。日記の入力では通信しない
- 設定（⚙）の「サーバ同期」に GAS の URL（と合言葉）を入れると有効になる。入れた直後に全件を送る
- 「サーバの記録で服薬回数を復元」: 端末を替えたときなどに、サーバの服薬回数・薬の一覧で上書きする（日記と写真は変わらない）
- `fetch` に `Content-Type` を付けない（CORS のプリフライトが飛んで GAS が応答できなくなる）

### GAS のセットアップ

1. 新しいスプレッドシートを作り、拡張機能 → Apps Script を開く
2. `gas/Code.gs` を貼る。プロジェクトの設定で「appsscript.json を表示」をオンにし、`gas/appsscript.json` の内容に揃える（タイムゾーン Asia/Tokyo）
3. **（推奨）** プロジェクトの設定 → スクリプト プロパティに `MEDCAL_TOKEN` を追加し、合言葉を入れる（服薬の記録は私的なデータ。URL だけで読めないようにする）
4. デプロイ → ウェブアプリ（実行: 自分 / アクセス: 全員）。発行された URL をアプリの設定と、ホーム（Home Dashboard）の設定に入れる
5. 反映できたかは、アプリの設定に URL を入れて「同期しました」と出るかで確かめる

## Android アプリ（Capacitor）

現状（同梱方式）は `server.url` が無く、`index.html` を APK に同梱している。この方式では、
アプリを直すたびに APK の作り直しが要る。Food Inv. Manager や Home Dashboard と同じ
**GitHub Pages を直接読む方式**に切り替えると、`index.html` の変更が push だけで反映される。

`capacitor-app/capacitor.config.json` が切り替え後の設定。**`appId`（`com.kei.medcal`）は変えないこと**
（変えると別のアプリとして入ってしまう）。

### 切り替えるときの注意：端末内のデータは引き継がれない

localStorage はオリジンごとに分かれる。同梱方式のオリジンは `https://localhost`、
Pages を読む方式は `https://memotan.github.io` なので、**切り替え直後は記録が空に見える**
（古いデータが消えるのではなく、別の保管場所を見ているだけ）。必ず次の順で行う。

1. **切り替える前に、今のアプリで ⚙ →「JSONでエクスポート」を実行し、ファイルを保管しておく**（日記と写真もここに含まれる）。可能なら先に GAS 同期を有効にして、サーバにも服薬回数を送っておく
2. GitHub の Settings → Pages で、`main` ブランチ `/ (root)` を配信元にする。`https://memotan.github.io/Medical-Calendar/` が開くことを確認する
3. PC の既存の Capacitor プロジェクトの `capacitor.config.json` に、`server` ブロックを足す（上のファイルのとおり）
4. `npx cap sync android` → Android Studio でビルドし、実機に入れる（同じ PC でビルドすれば上書きインストールできる）
5. 新しいアプリで ⚙ →「JSONからインポート」で 1 のファイルを読み込む。同期を有効にしてあれば「サーバの記録で服薬回数を復元」でもよい（その場合、日記と写真は戻らない）

- 署名鍵は PC ごとに別。別の PC でビルドした APK は上書きできないので、一度アンインストールする（その前に必ず 1 のエクスポートを済ませる）
- エクスポートは Capacitor の `@capacitor/filesystem` と `@capacitor/share` を使う。切り替え後も同じプロジェクトなので動く
