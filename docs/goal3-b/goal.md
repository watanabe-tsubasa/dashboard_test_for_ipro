# Goal3-B：i-PROカメラのJPEGインデックス画像をCloudflare R2へ保存

## 1. 目的と完了条件

収集アプリ `dashboard_test_for_ipro` に、**ユーザーが明示的に実行した場合だけ**i-PROカメラからJPEG画像を取得してCloudflare R2に保存・更新する処理を追加する。Goal4のローカル管理GUIに「画像更新」ボタンを設けるためのUI非依存サービスを完成させ、Goal5の別リポジトリ `sample_dashboard` が参照する画像キーを確定する。

**このGoalの完成条件**：

- `food` と `island` の両方で、対応する読み取り専用CGIからJPEGを取り出し、R2のカメラ別固定キーに保存できる。
- 通常の `yarn backfill` / `yarn sync` / `yarn d1:import` / `yarn parse` は**画像の取得・アップロードを一切行わない**。画像更新は独立した明示コマンドのみ。
- 既存Goal1の通信、Goal2のMultipart/JPEG抽出、Goal3-AのD1保存を再利用し、重複実装しない。
- 同じJPEGを再アップロードする場合はSHA-256を比較してスキップできる。異なるJPEGをアップロードしたら同じキーを上書きし、新しい画像が取得できる。
- R2の実環境で2台のアップロード、HEAD/GETとバイト単位の照合、再実行・失敗時の挙動を確認する。資格情報が未設定なら実環境未検証として報告し、偽の成功を出さない。
- 既存26件のテスト、lint、型チェックを通過し、READMEに手順を記載する。

**重要**：今回保存するのは、i-PROのカウントデータに付随する**JPEGインデックス画像**である。取得瞬間のライブスナップショットとは限らず、過去に保存された画像や動体除去画像の可能性がある。UIでは「最新ライブ映像」と誤表示せず、「カメラ画像／最終更新日時」として扱う。ヒートマップの64×64グリッドは引き続きD1にあり、JPEG自体をヒートマップ画像だと決めつけない。

## 2. 対象リポジトリ・既存実装・非対象

- **実装対象**：`https://github.com/watanabe-tsubasa/dashboard_test_for_ipro`。ローカルの最新作業ツリーにあるGoal1〜3-Aが正。リモートに未pushのコードがあれば現地コードを優先。
- **参照のみ**：`https://github.com/watanabe-tsubasa/sample_dashboard`。Goal5まで変更しない。
- 開発環境：Node.js 22、TypeScript、Yarn v1、Biome、devcontainer、VPN経由でカメラへBasic認証。
- `testing`タグを変更しない。既存の `src/collector/`、`runtime/goal1/`、`runtime/goal2/`、D1の4テーブルを保持する。
- Goal2でi-PROのMultipartからJPEGを抽出でき、islandのJPEG 2枚は生バイナリからの抽出が完全一致した。再利用すること。
- Goal3-AはCloudflare D1実書き込み、冪等な再インポート、実機syncまで完了済み。D1スキーマをGoal3-Bで変更しない。
- Goal4のNext.js管理画面、Goal5のR2画像表示、公開URL・認証付き画像配信API、スケジューラー、Rust/Android移植、動画保存、過去画像の大量収集、画像加工・リサイズ・人物認識は**対象外**。
- 2026-11-11のfood欠測は別実験で魚眼から1画PTZに変更しAI-VMDを無効にした期間に由来すると考えられる。画像取得成否やヒストリーデータ補完と混同しない。

## 3. 画像取得元の設計（最重要）

### 3.1. CGI kindの違い

i-PRO WV-XAE300WUX 外部I/F仕様では、`*_info` はCSVのみ、対応する画像付きkindはCSVとJPEGインデックス画像を返す。

| CGI kind | mode | 想定する内容 | Goal3-Bでの役割 |
|---|---|---|---|
| `movcnt_info` | `latest` | ラインクロスCSVのみ | 既存Goal3-A用。画像取得には使わない |
| `movcnt` | `latest` | ラインクロスCSV＋インデックスJPEG | **両カメラの標準候補** |
| `heatmap_mov` | `latest_comp` | 完成済み通過マップCSV＋インデックスJPEG | island等での明示的な代替候補 |
| `heatmap_loi` | `latest_comp` | 完成済み滞留マップCSV＋インデックスJPEG | 必要時の検証候補。自動的な2枚保存はしない |

- `food`は現在、ラインクロス＋エリア内カウントの保存設定。**ヒートマップ履歴が無効でも利用できる見込みの `movcnt:latest` を最初に実機検証**する。画像が返る前から「取得成功」と決めつけない。
- `island`でも標準候補は `movcnt:latest` とし、実機で `heatmap_mov:latest_comp` のJPEG抽出実績があることを代替手段として活かす。
- **画像取得元を設定または小さな戦略モジュールとして分離**する。初期候補は両方 `movcnt/latest`。代替に切り替える場合はカメラ別の明示設定とする。勝手なフォールバックで異なる意味・時刻の画像を混ぜない。
- 受信したCSVは既存パーサーで検査してよいが、Goal3-Bは**D1への人数・ヒートマップのUPSERTをしない**。JPEGだけを保存する。
- `mode=latest`のインデックス画像は計測中区間の可能性、`latest_comp`は完成済み計測区間の画像である。JPEGが撮影された正確な瞬間は別途保証されない。メタデータの`source_start_utc` / `source_end_utc` / `retrieved_at_utc`を区別し、元データから確定できるフィールドだけを設定する。
- ヒートマップ用の背景画像とカメラのサムネイルを将来同一視しない。Goal5で64×64グリッドと画像の位置合わせに必要な撮像条件・向きについては、実機で別途検証する。

### 3.2. 実行フロー

1. ユーザーが画像更新コマンドを明示実行。
2. 既存カメラ設定とVPN・Basic認証を用い、選択したCGIを**読み取り専用で**呼び出す。
3. Goal1と同様に必要なら生レスポンス `*.bin` / `*.meta.json` をGit管理外の `runtime/` に保存。既存の保存関数を再利用。
4. Goal2のMultipartパーサーからJPEG部分の**元バイト列**を取り出す。CSVとJPEGのパートの順序に依存しない。
5. JPEGが1枚であること、正しいContent-Type、最低限のJPEGマーカー、想定内のサイズを検証。**画像がない・複数あり選べない・No Data・HTTP失敗の場合はアップロードしない**。無効な画像でR2既存オブジェクトを破壊しない。
6. JPEG全バイトのSHA-256を計算し、R2上の同キーの `HeadObject` メタデータと照合。ハッシュが同じなら`unchanged`としてPUTしない。
7. 相違または未保存なら `PutObject` で上書き。`ContentType: image/jpeg` を設定し、SHA-256・取得元kind/mode・取得日時などをuser metadataに付与する。既存の原本バイトをそのままアップロードし、JPEGを再エンコードしない。
8. 成功後にHEAD、代表ケースでGETを実行し、保存されたオブジェクトの存在・メタデータ・**取り出した実バイト列のSHA-256**を確認する。ETagがSHA-256と等しいと仮定しない。
9. 成功、更新、スキップ、No Data、失敗をカメラごとに集計する。片方が失敗してももう片方は可能な限り継続。

## 4. R2オブジェクト設計

**バケット例**：`ipro-camera-thumbnails`（実名はR2で作成し環境変数に設定。ソースへ固定しない）。**バケットは非公開のまま**運用する。

| カメラID | オブジェクトキー | Content-Type |
|---|---|---|
| `food` | `cameras/food/thumbnail.jpg` | `image/jpeg` |
| `island` | `cameras/island/thumbnail.jpg` | `image/jpeg` |

- **固定キーで最新1枚のみ保持**。run-id、日時、計測期間をキーに含めて画像を増やさない。履歴管理・R2 Versioningは今回は導入しない。
- `camera_id` は既存D1 `cameras.id` と同一の安全な固定IDを使う（`food`, `island`）。外部入力で任意のR2キーを組み立てない。
- 既存ファイルが存在しない場合はINSERT相当、存在して異なる場合は上書き、同じ場合は変更なし。
- R2オブジェクトのメタデータ例：`camera-id`、`sha256`、`retrieved-at-utc`、`source-kind`、`source-mode`、必要に応じて`source-start-utc`・`source-end-utc`。メタデータにパスワード、カメラIP、認証ヘッダー、原本のURLを保存しない。
- 画像更新日時は「R2にアップロードした日時」と「カメラから取得した日時」を区別する。取得区間は画像の厳密な撮影時刻と混同しない。
- `CacheControl`は私的用途に合う保守的な設定（例：`private, no-cache`）とし、Goal5で配信経路に応じて最終決定する。固定URLのキャッシュによる古い画像表示はGoal5の課題として明記する。
- R2は非公開とする。`r2.dev`の公開URL有効化や公開バケット化、カスタムドメイン公開を**Goal3-B実装が勝手に行わない**。Goal5では認証済みサーバー経由のGETや短寿命の署名付きGETを別途検討する。
- D1にJPEGや認証秘密情報を書き込まない。新テーブルも不要。オブジェクトの有無・更新情報はS3 APIのHEADから確認可能とする。

## 5. R2接続・認証

ローカルNode.jsからCloudflare R2の**S3互換API**を利用する。公式の `@aws-sdk/client-s3`（v3、`S3Client` / `PutObjectCommand` / `HeadObjectCommand` / `GetObjectCommand`）を優先する。

例：

```ts
const client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});
```

- R2では**R2用S3 APIクレデンシャル**（Access Key ID と Secret Access Key）が必要。Goal3-Aの `CLOUDFLARE_API_TOKEN` はD1 REST API用であり、R2のS3 Secret Access Keyとして再利用しない。
- R2の `Storage & databases > R2 > Overview > Manage API Tokens` からR2専用トークンを作成。対象バケットに限った `Object Read & Write` 権限でよい。トークンのAccess Key IDとSecret Access Keyを一度だけ表示される画面で安全に保管する。
- 環境変数は既存 `.env.local` に以下を追記：

```dotenv
CLOUDFLARE_R2_BUCKET=ipro-camera-thumbnails
CLOUDFLARE_R2_ACCESS_KEY_ID=YOUR_R2_ACCESS_KEY_ID
CLOUDFLARE_R2_SECRET_ACCESS_KEY=YOUR_R2_SECRET_ACCESS_KEY
# 既存のCLOUDFLARE_ACCOUNT_IDは共用する
# 標準以外のjurisdictionを選ぶ場合は接続endpointを別途設定できるようにする
```

- バケット例は実際に作成するまで存在しない。`R2_ACCESS_KEY_ID`等の既存命名がリポジトリにあれば、その規約を尊重して命名を統一する。
- バケットのjurisdictionがEU/US/FedRAMP等である場合は対応する専用endpointを使用する。必要なら `CLOUDFLARE_R2_ENDPOINT` の任意指定を提供する。環境が通常のR2ならアカウントIDから標準endpointを生成する。
- `.env.example` はダミーのみ。`.env.local`、資格情報、画像、生バイナリはGitにコミットしない。標準出力・例外・HTTPデバッグにも秘密値を出さない。
- Basic認証のカメラ通信はVPN前提。TLS証明書検証を無効化しない。
- バケットは事前作成・認可が必要。コマンド実行時に**勝手に新しいバケットを作成しない**。権限不足（403）、バケット未作成（404）、ネットワークエラーを明示的に区別する。

## 6. CLIとサービス設計

UIに依存しない `src/collector/r2/` などのモジュールを設け、Goal4から直接呼べる非対話的なサービス関数（例：`refreshCameraThumbnail(cameraId)`）を公開する。インターフェイスの型は実コードに合わせる。

**CLI案**（既存Yarn v1スタイルに合わせて微調整可）：

```bash
# food 1台分を明示的に取得してR2へアップロード
yarn r2:thumbnail --camera food

# island 1台分を明示的に取得してR2へアップロード
yarn r2:thumbnail --camera island

# 2台を順に処理（意図的に指定したときだけ）
yarn r2:thumbnail --camera all

# 転送をせず取得元・保存先・想定操作を確認（No PUT）
yarn r2:thumbnail --camera island --dry-run

# Goal1で保存済みのmultipart応答を再利用したオフライン検証（任意）
yarn r2:thumbnail --camera island --source-file runtime/goal1/island/<run-id>/heatmap_mov_latest_comp.bin
```

- `--dry-run`はR2にPUTせず、既存R2オブジェクトと取得予定の情報を表示できる。カメラへの読み取りCGIを発行するか否かはREADMEに明記する。
- `--source-file`を実装する場合、指定JPEGのkindとカメラが一致することを確認する。サンプル用の架空の `<run-id>` をそのまま実行しない。
- 更新結果は `camera`, `key`, `source`, `bytes`, `sha256`（必要なら短縮表示）、`uploaded|unchanged|no_data|failed`, `retrieved_at_utc` を返す。接続情報を表示しない。
- 将来のGUIからの呼び出しで重複実装にならないようCLIは薄いラッパーにする。カメラ通信・Multipart解析・R2操作を一つの巨大関数にしない。
- D1に依存させない。D1が一時的に利用できなくても画像更新は可能な構成とする。
- コマンド失敗時は0以外の終了コードを返す。2台のうち1台だけ失敗した場合の部分成功を明示する。

## 7. 失敗・冪等性・セキュリティの要求

- HTTP成功だけでJPEG取得成功と判断しない。Multipartが壊れている、JPEGなし、型違い、空、サイズ超過の場合は失敗扱いとし、R2既存画像を残す。
- `No Data`を通信エラー扱いにしない。No Data／画像欠落／認証失敗／R2の権限不足／一時的な5xxを分類。
- リトライは429や一時的な5xxなどに限定し、指数バックオフ＋上限を設ける。401/403、設定ミス、画像形式不正は自動再試行し続けない。
- アップロードの成功をPUT前に報告しない。Put後のHEAD検証に失敗した場合は、ステータスを不確定として表示し、再確認可能にする。
- SHA-256はJPEGの元バイト列で計算し、同一画像の再取得時に画像を再エンコードしない。`unchanged`ならオブジェクトのLastModifiedも不要に変わらない。
- JPEGに店舗内の人物が映る可能性があるため、公開バケット・画像URLのログ出力・権限のないクライアントへの直配信を避ける。
- クラウド操作を伴う自動テストはモックで行い、実バケットの削除・初期化や全件一覧取得など危険な操作は行わない。

## 8. テスト・受け入れ手順

### 8.1. 自動テスト（既存26件を維持）

1. 実機サンプルmultipartからJPEGをバイト一致で抽出する。`heatmap_mov:latest_comp`の既存保存ファイルを利用可能な場合は再利用する。
2. CSVのみ、JPEGなし、JPEG複数・順序違い、No Data、壊れたboundary、Content-Type不一致、画像マーカー不正、空・巨大ファイルを検出する。
3. 同じカメラIDは同じR2キーになり、異なるカメラは別キーになる。未登録cameraIdや任意のキー注入を拒否する。
4. `HeadObject`: 404ならPUT、同じSHA-256ならスキップ、異なるSHA-256なら上書き。HEADが403/5xxなら安易に404扱いしない。
5. PutObjectに `ContentType=image/jpeg` と安全なメタデータが含まれ、SHA-256の一致を検証する。
6. R2 PUT失敗、再試行できる一時エラー、片カメラ失敗時の部分成功、D1未設定でも画像操作可能なことを確認。
7. `yarn sync` / `yarn backfill` / `yarn d1:import` / `yarn parse` を実行しても画像取得・R2書き込みが起きないことを回帰テスト。
8. `--dry-run`と `--source-file`（採用した場合）の動作をテスト。

### 8.2. 実機・R2検証

1. Cloudflare R2で**非公開バケットを手動作成**。R2専用のS3クレデンシャルを作成して`.env.local`へ設定する。
2. VPN接続後、まず `food` で `movcnt:latest` の実機レスポンスを観察し、JPEGが得られること、必要な表示画像であることを確認する。`island`も同様に確認。取得元を変更した場合はその判断理由を記録する。
3. dry-run後にfood/islandそれぞれを明示的に更新し、R2上で2つの固定キーが存在することを確認する。
4. GETでダウンロードしたJPEGのSHA-256とアップロード元を比較する。R2でのメタデータとContent-Typeを確認する。
5. 保存済みの同じ原本を再度使い、`unchanged`・PUTなしを確認する。別の正常なJPEGへ切り替えた場合は**同じキー**に上書きされることを確認する。
6. 画像が取得できなかった場合、R2の既存サムネイルが削除・破損されないことを確認する。
7. D1の4テーブルと件数に意図しない変更がないことを確認する。`yarn test`、`yarn lint`、`yarn tsc --noEmit`を実行する。

※R2クレデンシャル・VPNがない環境ではモックによる実装検証までを完了範囲とし、実機／R2実通信を未検証と明記する。

## 9. 報告内容・Goal4/5への引き継ぎ

- 実装箇所、使用CGI kind/modeと理由、カメラごとの実機画像取得結果、R2 bucket/key、Bytes/SHA-256比較、アップロード／スキップ件数、未検証事項。
- 使用する環境変数と設定手順、CLI実行例、失敗時の診断手順、テスト件数、lint・型検査の結果。
- Goal4へ：`refreshCameraThumbnail(cameraId)`に相当するUI非依存サービスと、ステータス・最終更新時刻・R2キー。GUIの「サムネイル更新」操作から呼び出せること。
- Goal5へ：D1の`cameras.id`とR2キーを対応させる契約。**非公開の画像を安全に配信する仕組みはGoal5で実装**。現在のリポジトリから直接R2の資格情報をブラウザへ渡してはいけない。
- **このGoal3-B以外の機能に着手しない。** 既存Goal1〜3-Aの挙動を壊さない。独立したバックグラウンドポーリングやcronは作らない。

## 10. 公式参考情報

- i-PRO WV-XAE300WUX 外部I/F仕様書 v1.05（第2.6節、`kind:movcnt`と`mode:latest`、画像付きのヒートマップ応答、JPEGインデックス画像）:
  https://i-pro.com/products_and_solutions/sites/default/files/2025-02/WV-XAE300WUX_IF_document_V1.05.pdf
- Cloudflare R2 S3 APIとバケット作成:
  https://developers.cloudflare.com/r2/get-started/s3/
- Cloudflare R2 S3 API資格情報:
  https://developers.cloudflare.com/r2/api/tokens/
- Cloudflare R2 AWS SDK for JavaScript v3:
  https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/
- Cloudflare R2公開バケット（既定は非公開）:
  https://developers.cloudflare.com/r2/buckets/public-buckets/
