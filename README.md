This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## i-PRO CGI 収集（Goal1）

Node.js 22 の devcontainer から店舗 VPN に接続します。`.env.example` を `.env.local` にコピーし、`IPRO_FOOD_*` と `IPRO_ISLAND_*` の `NAME`（表示名）、`BASE_URL`（HTTP(S) のオリジン、ポート指定可）、`USER`、`PASSWORD` を設定します。`IPRO_TIMEOUT_MS` は各リクエストのタイムアウトで、既定は 10000 ms です。シェルの環境変数が優先されます。カメラが HTTPS に対応している場合は HTTPS を使用してください。

```bash
cp .env.example .env.local
# .env.local に設定を入力してから実行
yarn probe
yarn fetch
yarn fetch --camera food
yarn fetch --camera island --include-images
yarn test
```

`probe` は保存期間を確認し、`fetch` は最新のラインクロスと通過・滞留ヒートマップを取得します。画像付きヒートマップは `--include-images` を指定すると追加されます。

取得したボディとメタデータは Git 管理外の `runtime/goal1/<camera>/<run-id>/` にそれぞれ `<kind>_<mode>.bin` と `<kind>_<mode>.meta.json` として保存します。受信上限は 1 応答あたり 16 MiB です。タイムアウトや上限超過などで受信が完了しなかった場合は、取得状況をメタデータに記録します。終了コードは、全リクエストが成功またはデータなしなら `0`、失敗・判定不能・スキップがあれば `1`、引数または環境ファイルの読み込みエラーなら `2` です。

## i-PRO CGI の解析と期間指定取得（Goal2）

リポジトリ直下で `yarn parse` を実行すると、VPNやカメラの設定なしで保存済みの応答を解析できます。

```bash
yarn parse
yarn parse --camera island
yarn parse --file 'runtime/goal1/island/<run-id>/heatmap_mov_info_latest_comp.bin'

yarn fetch --camera island --from 2026-11-21T09:00+09:00 --to 2026-11-21T21:00+09:00
yarn parse --camera island
```

期間指定の両端には UTC の `Z`、または JST の `+09:00` を付けます。カメラへの `multi` リクエストは、UTC 00:00 始まりで指定範囲を覆うように組み立てます。解析時は、CSV の開始時刻が `--from` 以降かつ `--to` より前で、終了時刻が `--to` 以前の区間を採用します。除外数は `filteredRecords` に記録します。カメラ向けの `days` は Goal2 の指定どおり 1〜6 です。WV-XAE300WUX の v1.03 以降の資料には上限 7 の記載があります。画像付きヒートマップは `--include-images` で追加取得できます。 [i-PRO 仕様書 v1.05 §2.6](https://i-pro.com/products_and_solutions/sites/default/files/2025-02/WV-XAE300WUX_IF_document_V1.05.pdf#page=24)

出力先は Git 管理外の `runtime/goal2/<camera>/<run-id>/` です。1つの生レスポンスに対応する `<kind>_<mode>.json` に、CSVごとの `records` と、JPEGごとの `images` を保存します。画像の `localPath` は JSON と同じディレクトリからの相対パスです。画像とCSVをファイル名の区間識別子で一意に対応付けられる場合に、対応する計測区間を記録します。各カメラの再取得は取得元を追跡できるよう別の run として保持します。同じ原本を再解析したときは同じパスのJSONとJPEGを置き換えます。ヒートマップの合計と最大値は、種別ごとの診断値です。

正規化した通過ヒートマップレコードから主要フィールドを取り出した例です。

```json
{
  "schemaVersion": 1,
  "cameraId": "island",
  "kind": "heatmap_mov",
  "period": {
    "startUtc": "2026-11-21T00:00:00.000Z",
    "endUtc": "2026-11-21T01:00:00.000Z",
    "intervalMinutes": 60,
    "cameraTimezone": "+09:00",
    "summertime": "OUT"
  },
  "statistics": { "nonZeroCells": 421, "sum": 1054, "max": 10 }
}
```

## i-PRO 計測履歴の D1 保存（Goal3-A）

`.env.local` に `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_D1_DATABASE_ID` と、対象アカウントの D1 書き込み権限を持つ `CLOUDFLARE_API_TOKEN` を設定します。既存のカメラ接続設定は `backfill` と `sync` が参照します。保存対象は `IPRO_FOOD_HISTORY_KINDS=linecross`、`IPRO_ISLAND_HISTORY_KINDS=linecross,heatmap_mov,heatmap_loi` が既定です。カンマ区切りで変更でき、空文字でそのカメラを無効にできます。

Cloudflareで新規DBが必要な場合はダッシュボードで作成するか、認証済みのWranglerで `npx wrangler d1 create ipro-history` を実行します。そのDBのIDを設定してからスキーマを適用します。 [WranglerのD1コマンド](https://developers.cloudflare.com/d1/wrangler-commands/#d1-create)

```bash
# Cloudflare D1 のスキーマを明示的に適用
yarn d1:migrate

# カメラの range を取得して計画を表示
yarn backfill --dry-run
yarn backfill
yarn backfill --camera island --from 2026-11-21T09:00+09:00 --to 2026-11-21T21:00+09:00
yarn sync

# 保存済みの Goal2 JSON から取り込み
yarn d1:import --camera island --dry-run
yarn d1:import --camera island
```

同じSQLを使うローカル検証には、Node.js 22 の SQLite を利用します。DBは Git 管理外の `runtime/goal3-a/history.sqlite` に作成されます。

```bash
yarn d1:migrate --local
yarn d1:import --local
yarn backfill --local
yarn sync --local --dry-run
yarn sync --local
```

`cameras` と `camera_lines` には固定IDと初期表示名を登録します。ライン1〜8の元カウントを `linecross_hourly` に保持し、`include_in_visitors` の既定値は0です。 `heatmaps_hourly` は通過・滞留を種別ごとに64×64配列で保存します。集計対象ラインはD1上で確認してから設定できます。 [マイグレーションSQL](db/migrations/0001_init.sql)

`backfill` は種別ごとに実機の `range` と指定範囲の共通部分をUTCの日付に分けます。`--from` と `--to` は片方だけでも指定できます。両端の時刻には `Z` または `+09:00` が必要です。最後に報告された時刻が保存済み区間の開始を指す場合に備えて1時間先まで確認し、CSVの実時刻で絞り込みます。日をまたぐ1時間区間に備え、必要な日付境界では最大1時間分を追加して取得します。サイズ上限に達したらその重なりを外して1日分で再試行します。CGIで指定できる最小範囲はUTCの1日なので、1日応答でも上限を超える場合は失敗として記録します。

`sync` は確定済み区間を参照して保持範囲の欠落と直近24時間分を含むUTC日を再取得します。範囲指定を省略した場合、ラインクロスの `latest` とヒートマップの `latest_comp` も取得します。カメラが返した `No Data` はログで区別され、保持範囲内の空白日は次回の同期でも再確認されます。失敗日の再取得には `backfill --camera ... --from ... --to ...`、取得済みJSONの再送には `d1:import` を使えます。`--dry-run` は計画や件数を表示し、DBを書き換えません。

区間のキーは開始UTCと間隔、およびカメラ・ラインまたは種別です。確定判定はCSVの実終了時刻と期待終了時刻を比較します。確定値が変わった場合は、現在保存されている内容の取得時刻より新しい観測だけを採用し、`corrected_complete` を記録します。同一内容なら更新日時を保持します。REST APIの一時的な失敗は最大3回まで試行し、確認できなかった行は `unconfirmed` として報告します。 [D1 Query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/) · [D1の制限](https://developers.cloudflare.com/d1/platform/limits/)

任意の区間を照合するSQLの例です。D1コンソール、またはローカルSQLiteに対して実行できます。

```sql
SELECT camera_id, line_no, start_utc, interval_minutes, count_in, count_out, is_complete
FROM linecross_hourly
WHERE camera_id = 'island' AND start_utc = '2026-11-21T00:00:00.000Z'
ORDER BY line_no;

SELECT kind, start_utc, interval_minutes, max_value, nonzero_cells,
       (SELECT SUM(json_array_length(value)) FROM json_each(grid_json)) AS cells
FROM heatmaps_hourly
WHERE camera_id = 'island' AND start_utc = '2026-11-21T00:00:00.000Z'
ORDER BY kind;
```

## JPEGインデックス画像の更新（Goal3-B）

画像の取得元は両カメラとも既定で `movcnt:latest` です。`IPRO_FOOD_THUMBNAIL_KIND` と `IPRO_ISLAND_THUMBNAIL_KIND` に `heatmap_mov` または `heatmap_loi` を指定すると、そのカメラの `latest_comp` を使います。画像はカウント用途のインデックスJPEGです。表示時には、関連するCSVの計測区間、カメラからの取得日時、R2の最終更新日時を区別してください。 [i-PRO 外部インターフェース仕様書 §2.6](https://i-pro.com/products_and_solutions/sites/default/files/2025-02/WV-XAE300WUX_IF_document_V1.05.pdf#page=24)

R2で非公開バケットを作成し、対象バケットに限定した **Object Read & Write** のR2専用S3資格情報を作成します。`.env.local` に共通の `CLOUDFLARE_ACCOUNT_ID` と、R2用の `CLOUDFLARE_R2_BUCKET`、`CLOUDFLARE_R2_ACCESS_KEY_ID`、`CLOUDFLARE_R2_SECRET_ACCESS_KEY` を設定します。専用jurisdictionでは `CLOUDFLARE_R2_ENDPOINT` に同じアカウントのHTTPS R2エンドポイントを指定できます。 [R2のS3認証](https://developers.cloudflare.com/r2/api/tokens/)

```bash
yarn r2:thumbnail --camera food --dry-run
yarn r2:thumbnail --camera food
yarn r2:thumbnail --camera island
yarn r2:thumbnail --camera all
```

`--dry-run` はカメラへ読み取りリクエストを送り、`runtime/goal3-b/<camera>/<run-id>/` に原本・メタデータ・検証済みJPEGを保存します。R2を設定済みならHEADと必要に応じてGETを行い、作成・更新・変更なしの予定を表示します。R2未設定での実機確認では `plan=not_checked` が表示されます。どちらもPUTは発行しません。通常の `backfill`、`sync`、`d1:import`、`parse` から画像取得リクエストやR2更新は発行されません。

保存済み原本を再利用するには、取得時に表示された `capture=` のパスを指定します。`runtime/goal3-b/` と `runtime/goal1/` が対象です。指定カメラと取得元が隣の `.meta.json` と一致する必要があります。

```bash
yarn r2:thumbnail --camera island --source-file 'runtime/goal3-b/island/<run-id>/movcnt_latest.bin' --dry-run
```

R2の固定キーは `cameras/food/thumbnail.jpg` と `cameras/island/thumbnail.jpg` です。最大8 MiBのJPEGを元バイトのまま保存し、`Content-Type: image/jpeg` と `Cache-Control: private, no-cache` を設定します。メタデータにカメラID、SHA-256、取得日時、取得元、および一意に対応付けられる計測区間を保持します。同じSHA-256のオブジェクトはGETでも照合して `unchanged` を返し、新規・変更時はPUT後のHEADとGETで検証します。ETagは条件付きリクエストのバージョン確認に使用します。 [R2 S3 APIの対応範囲](https://developers.cloudflare.com/r2/api/s3/api/)

`no_data` はカメラのデータなし応答です。`failed` は出力のエラーコードで、カメラ認証、JPEG形式、R2権限、バケット未発見などを確認できます。`uncertain` はPUTの結果を検証できなかった状態です。同じ原本を `--source-file` で再指定して照合できます。片方が失敗しても残りを処理し、失敗または未確定があれば終了コードは1です。Goal4からは `refreshCameraThumbnail` の結果とR2の最終更新日時を利用できます。Goal5で固定キーを配信する際は、認証とキャッシュ更新の方式を決めます。

## ローカル管理画面（Goal4）

Node.js 22 のdevcontainerで依存関係をインストールし、VPNへ接続して `yarn dev` を実行します。[管理画面を開く](http://127.0.0.1:3000/admin)。`.env.local` のカメラ・D1・R2設定をサーバーが読み込みます。「設定済み」は設定の存在と形式を表します。接続結果は、読取りや明示操作の結果で確認できます。

開発・本番の起動コマンドは既定で `127.0.0.1` にバインドします。devcontainerのポート転送は **Private** に設定してください。プライベートHTTPS転送を使う場合は、Hostを保持する転送先の正確なOriginを `IPRO_ADMIN_ALLOWED_ORIGIN` に指定できます。POSTは検証済みのHostと同じOriginのJSONだけを受理します。この画面には利用者認証がないため、公衆向けのポート転送や公開デプロイを避けてください。

- **最新データを同期**で対象カメラを選び、既存の `sync` と同じ処理を開始します。
- **履歴を取得**では、必要に応じてJSTの開始日と終了日を両方指定します。終了日を含む732日以内の指定を受け付けます。日付を省略するとカメラ保持分が対象です。取得計画は範囲と想定リクエスト数を実機の保持範囲から表示します。「この範囲で履歴を取得」を押すとD1への保存が始まります。
- **画像を更新**は各カードのボタンから実行します。既存画像の表示はサーバー経由でR2を読み取ります。撮影の瞬間、取得時刻、R2の更新時刻はそれぞれ異なります。
- **実行履歴**では進捗、開始・終了時刻、結果、ログを確認できます。失敗・中断・更新結果未確認のジョブは、同じ条件で再試行できます。

同時に1件のジョブを実行できます。ブラウザを再読み込みしても状態を復元します。独立ワーカーが稼働中ならNext.jsを再起動しても追跡でき、ワーカーが停止した場合は中断として記録します。状態と直近600行のログは `runtime/goal4/jobs/jobs.sqlite` に保存します。バックフィルの計画表示はD1へ書き込まず、ページ表示中のポーリングではカメラには接続しません。R2サムネイルのGETとD1の保存状況のSELECTは画面表示に使います。

同期が失敗したら、実行ログでVPN・認証・D1の状況を確認して再試行してください。画像更新が結果未確認の場合、画面のR2更新日時と再試行の結果を確認できます。既存CLIは引き続き利用でき、保存済みデータの再投入は `yarn d1:import` を使います。カメラ側の資格情報を変更した場合は、開発サーバーを再起動してください。

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
