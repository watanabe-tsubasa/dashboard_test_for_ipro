# Goal2：i-PRO CGIレスポンスの解析・正規化

## 1. 目的・前提

収集用リポジトリ `https://github.com/watanabe-tsubasa/dashboard_test_for_ipro` の **Goal1実装を引き継ぎ**、保存済みの生レスポンス（`.bin` と `.meta.json`）を解析して、Cloudflare D1への保存に適した共通JSONへ変換してください。

- 表示用の `https://github.com/watanabe-tsubasa/sample_dashboard` は**別リポジトリ**です。今回は変更しません。ただし既存の `scripts/parse-cgi.js` と表示用データ型は参考にできます。
- Goal1で2台（`food` / `island`）へのVPN経由のBasic認証・CGI取得が実機で成功しています。`testing` タグは初期技術検証の保存点なので変更しません。
- 現在の収集CLIは `src/collector/cli.mts` を起点とし、`yarn probe` / `yarn fetch` / `yarn test` が利用可能です。**作業前にローカルの実際の構造を確認**し、既存実装を優先して拡張してください。GitHub上のmainがローカルより古い可能性があります。
- TypeScript / Node.js 22 / Yarn v1 / Biome / devcontainer を維持してください。不要な全面改修やパッケージマネージャー移行はしません。
- 定期収集・GUI・D1/R2への書き込みはまだ実装しません。

**完了条件：** Goal1の実機取得データを壊さずに解析でき、1計測区間ごとのラインクロス・通過ヒートマップ・滞留ヒートマップと画像のメタデータをJSONへ正規化し、自動テストで検証できること。実機取得済みデータの解析結果も確認してください。

## 2. Goal1で確認した実機データ

- 生ファイル配置：`runtime/goal1/<camera>/<run-id>/*.bin` と対応する `*.meta.json`。
- `movcnt_info:latest` は両カメラでHTTP 200、約317～322 B。
- `heatmap_mov_info:latest_comp` / `heatmap_loi_info:latest_comp` はHTTP 200、約8,472 B。
- islandの `heatmap_mov:latest_comp` / `heatmap_loi:latest_comp` はJPEGを含む応答で約52,641 B。
- 実際のヒートマップ応答は `--myboundary` を使うMultipartで、CSVパートに `Content-Disposition` / `Content-Type` / `Content-Length` が含まれていました。
- ヒートマップCSVの例：`20261122,1300,20261122,1400,01:00,+09:00,OUT`。**日時はUTC**で、日本時間では22:00～23:00です。`01:00` は保存間隔です。
- 確認済みのisland通過・滞留ヒートマップ、およびfood滞留ヒートマップは64×64の全ゼロデータです。閉店時間帯の取得であり、全ゼロ自体を異常とみなさないでください。
- `range` はfoodのヒートマップで `No Data.` となる一方、`latest_comp` は成功したケースがあります。各レスポンス種別を区別してください。

これらの数値は参考実測値であり、サイズ・boundary文字列・計測間隔をハードコードしないでください。

## 3. 実装範囲

### 3.1. バイナリ安全なMultipart解析

- `Buffer`を入力に使い、JPEGを含む応答全体を安易にUTF-8文字列化しないこと。
- HTTPヘッダー側の `Content-Type` からboundaryを取得し、実データが示す `--myboundary` に対応する。ヘッダー表記差・CRLFを考慮する。
- CSVパート（複数可）・JPEGパート（複数可）を抽出し、元ファイル名・Content-Type・データのbyte数を保持する。
- JPEGのバイト列は変更せずローカルに抽出保存する。`Content-Length` があれば検証し、破損や欠落は黙って成功にしない。
- `range` の `DataFrom` / `DataUntil` や `No Data.` 系はCSVと誤認せず、型付き結果として扱う。
- 不明なパート・未知の形式は安全に記録し、解析できない理由を返す。カメラが返した `filename` をそのままファイルパスに使用せず、パストラバーサルを防止する。
- `mode=multi` では1レスポンス中に複数のCSV・JPEGが含まれることを前提とする。

### 3.2. CSVパーサー

- 共通先頭行 `s_yyyymmdd,s_hhmm,e_yyyymmdd,e_hhmm,p_hhmm,timezone,summertime` に対応。これは**列名ではなく値の並び**を示す仕様書表記であることに注意。
- `s_*` / `e_*` はUTCの開始・終了時刻。`HHmm` の**分**を失わず、日付跨ぎ・月跨ぎ・年跨ぎに対応。`timezone` と `summertime` は元値のまま保持する。
- 保存間隔 `p_hhmm` は分に変換し、最低でも `00:15` / `01:00` / `12:00` / `24:00` を解析可能にする。異常値は勝手に補正せずエラーにする。
- 正規化時刻はISO 8601 UTC（`...Z`）で保持。JSTでの表示に使う日付・時刻は別途算出可能にする。`timezone=+09:00` をUTC時刻へ二重加算しない。
- `movcnt_info`：ライン1～8について始点/終点座標・IN/OUT人数を取得。ライン未設定（全座標0）は `configured: false` 等で識別し、データを黙って破棄しない。末尾の余分な列には仕様に沿って対処する。
- `heatmap_mov_info` / `heatmap_loi_info`：正確に64行×64列の非負整数グリッドへ変換。行・列方向を保持し、勝手に転置・回転しない。
- 非ゼロセル数・合計・最大値は**診断用統計**として計算する。滞留（LOI）と通過（MOV）を同じ意味の値と扱わない。滞留値を時間帯で単純加算して「滞留人数」とする処理は実装しない。
- 不正な時刻、NaN、列不足、グリッドサイズ不一致などは明示的にエラーにし、`0` で穴埋めしない。

### 3.3. 正規化データ型

1つのCSVにつき1レコードを基本とし、共通に以下を持たせる：

- `schemaVersion`（例：`1`）
- `cameraId`（`food` / `island`）
- `kind`（`linecross` / `heatmap_mov` / `heatmap_loi`）
- `period.startUtc` / `period.endUtc` / `period.intervalMinutes`
- `period.cameraTimezone` / `period.summertime`
- `source.runId` / `source.requestKind` / `source.requestMode` / `source.rawFile` / `source.partFilename`
- 必要に応じて `acquiredAtUtc`（取得時刻と計測時刻を分離）

種類別フィールド：

- ラインクロス：`lines: [{ lineNumber, start:{x,y}, end:{x,y}, countIn, countOut, configured }]`
- ヒートマップ：`grid: number[][]`、`statistics: { nonZeroCells, sum, max }`
- 画像付き応答：抽出JPEGのローカルパス・元ファイル名・対応計測区間を保持。対応付けが曖昧なら勝手に紐付けしない。

型はTypeScriptの判別可能Union等で定義し、後続Goal3でD1レコードへの変換を実装しやすくしてください。

### 3.4. オフライン解析CLI

少なくとも次のように、**カメラ接続なし**で既存の `.bin` を解析できるCLIを追加してください。コマンドの細部は既存のCLIに合わせて調整可。

```bash
# 保存済みの全データを解析
yarn parse

# カメラで絞り込む
yarn parse --camera island

# 特定ファイルを単独解析
yarn parse --file runtime/goal1/island/<run-id>/heatmap_mov_info_latest_comp.bin
```

- 対応する `.meta.json` からカメラID・取得日時・リクエスト種別等を引き継ぐ（実際のメタ構造を確認）。
- 出力は `runtime/goal2/` 配下のJSON/JPEG。Git管理から除外し、Goal1の原本は変更しない。
- 1ファイルに複数CSVがある場合、各区間を独立レコードにする。
- 再解析時に同一の計測区間を不必要に増殖させない。異なる結果で上書きが必要な場合は規則を明示し、原本は保持する。
- CLIはカメラ別の成功/No Data/解析失敗、件数、計測期間、最大値等を表示する。秘密情報・画像の内容はログに出さない。

### 3.5. 期間指定の履歴取得（小さな追加機能）

夜間の `latest_comp` では全ゼロだったため、Goal2のパーサー検証用にGoal1の取得CLIへ `mode=multi` を追加してください。ただし、**解析が主目的なので既存通信部分の大規模な改修は不要**です。

- 既存のCGIリクエスト生成器を拡張する。`year` / `month` / `date` / `hour` / `days` の必須値を仕様書どおり生成・検証する。
- 仕様書では `days` は1～6、`hour` は0～23。日付指定はUTC基準で取り扱い、JST入力の場合は明示的に変換する。
- 取得時間範囲に関するカメラ固有の丸め・拡張を考慮し、**返却されたCSV自体の開始・終了UTCで厳密にフィルタ・識別**する。リクエスト範囲だけで計測日時を捏造しない。
- デフォルトでは画像なしの `*_info` を取得。画像付きは既存の明示フラグを利用する。
- 最初はカメラ1台・1日以内の範囲を検証し、過大応答やタイムアウトを避ける。Goal1のレスポンスサイズ上限・タイムアウトを維持し、必要なら明示的な設定で調整する。
- 過去データがカメラ内に存在しない場合は `no_data` として報告する。
- 期間指定リクエストの実機確認が難しい場合は未検証と報告する。**既存の `probe` / `fetch` の挙動を壊さない**。

## 4. テスト

Node.js組み込みテストなど既存方式を継続し、以下を追加してください。

1. CSVのみのMultipart、複数CSVのMultipart、CSV+JPEGのMultipartを解析できる。
2. 抽出JPEGが元のバイト列と一致する。
3. 64×64全ゼロ、非ゼロ、末尾改行、Content-Length有無、boundary表記差を処理できる。
4. ラインクロス1～8、未設定ライン、余剰列を処理できる。
5. `00:15` と `01:00`、UTC↔JST、日付・月・年跨ぎを検証する。
6. `No Data.` / `No Data(1).` などと `range` を区別する。
7. 壊れたCSV、列数不足、JSON欠落、未知のパート、危険なファイル名で安全に失敗する。
8. 既存Goal1テストを含め `yarn test` / `yarn lint` / `yarn tsc --noEmit` が通る。
9. 実機の `.bin` がローカルに存在すればそれを使った解析を行う。共有・コミットするテストフィクスチャは機密・画像を含まない合成データを使用する。

## 5. Goal2では実装しないこと

- D1/R2への保存、クラウド認証やAPIトークン管理（Goal3）
- Next.jsのデータ収集管理画面や収集ボタン（Goal4）
- `sample_dashboard` のAPI・グラフ・表示仕様変更（Goal5）
- 現在の店内人数や日別/月別の業務集計（Goal5）
- カメラ側の設定変更、保存間隔の変更、常駐/定期収集

## 6. 受け入れ基準・完了報告

- オフラインで既存 `.bin` → 正規化JSONへ変換できる。
- 画像付き応答からJPEGをバイナリ完全一致で抽出できる。
- 15分・1時間の区間を分単位で正しく扱える。実機は現状1時間保存であり、15分は合成フィクスチャでもよい。
- 全ゼロのヒートマップは正常データとして保持する。
- 可能なら `mode=multi` で営業時間帯の非ゼロデータを取得して正規化する。未取得なら理由と次の確認手順を残す。
- テスト・lint・型検査が通り、既存Goal1 CLIが引き続き動く。
- 変更ファイル一覧、コマンド例、正規化JSONの例、実機検証の有無、未解決事項、Goal3への引き継ぎ事項を報告する。

**Goal2が完了したら作業を止め、Goal3以降を勝手に実装しないでください。**

## 参考

- i-PRO WV-XAE300WUX 外部インターフェース仕様書：<https://i-pro.com/products_and_solutions/sites/default/files/2024-02/WV-XAE300WUX_IF_document_V1.02.pdf>（特に2.6.2～2.6.3）
- より新しい仕様書が公式サイトにある場合は機種・アプリバージョンとの適合を確認し、相違点を明記する：<https://i-pro.com/products_and_solutions/ja/surveillance/learning-and-support/device-integration/ai-people-counting-app>
- 表示側参考実装：<https://github.com/watanabe-tsubasa/sample_dashboard/blob/main/scripts/parse-cgi.js>
