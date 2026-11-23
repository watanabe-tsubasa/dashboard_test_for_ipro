# Goal3-A：i-PRO計測履歴のCloudflare D1への保存

## 1. 目的と今回の完了条件

`dashboard_test_for_ipro` の既存Goal1（CGI取得・生データ保存）とGoal2（Multipart/CSV解析・日時正規化・`mode=multi`）を再利用し、**各カメラが現時点で保持する計測履歴を遡って取り込み、Cloudflare D1へ重複なく保存する**。

今回扱うのは、**ラインクロス人数・通過ヒートマップ・滞留ヒートマップの1時間単位の履歴**である。ダッシュボードの表示に必要な元データを失わず保存し、日別・時間帯別・曜日別・月別の集計は後続Goalで実装する。

受け入れ条件：

- `food` と `island` に対し、現行の保存設定に応じた履歴をVPN経由で取得できる。
- `food` のラインクロス、`island` のラインクロス・通過ヒートマップ・滞留ヒートマップをD1へ保存できる。
- 取得と保存の実装は**両カメラ・全3種別に共通**とし、後日`food`側でヒートマップ保存を有効化しても設定変更で対応できる。
- 過去履歴の初回取り込み、2回目以降の差分同期、同じ計測区間の再取得・再実行が可能で、重複集計されない。
- 計測途中のラインクロスを取得しても、確定値を古い途中経過で上書きしない。
- D1の実データをSQLで照合できる。既存Goal1/Goal2のテストを壊さない。

## 2. 対象リポジトリと前提

**実装対象**：`https://github.com/watanabe-tsubasa/dashboard_test_for_ipro`

**参照のみ**：`https://github.com/watanabe-tsubasa/sample_dashboard`（表示用ダッシュボード。Goal3-Aでは改修しない）

- Node.js 22 / TypeScript / Yarn v1 / devcontainer / Biome。既存の`yarn`コマンド体系を維持する。
- 現在のローカル作業環境にあるGoal1/Goal2実装が正。GitHubのリモートブランチに未反映の可能性があるため、**既存の`src/collector/`を必ず確認**し、現在の変更を失わない。技術検証時点の`testing`タグを変更しない。
- VPN経由でプライベートIPに接続。カメラ認証はBasic。IPアドレス・認証情報・CloudflareトークンはローカルのGit管理外設定のみで扱う。
- デモ時に手動起動する。常駐サーバー、cron、Cloudflare側からカメラへ接続する仕組みは不要。
- 既存の`runtime/goal1/`（原本）および`runtime/goal2/`（正規化結果）を保持する。

### 2.1. 実機の保存設定（AIアプリVer.1.7）

| カメラID | 計測間隔 | 現行の保存対象 | Goal3-AでD1へ保存 |
|---|---|---|---|
| `food` | 1時間 | ラインクロス＋エリア内カウント | ラインクロスのみ |
| `island` | 1時間 | ラインクロス＋エリア内カウント＋ヒートマップ | ラインクロス、通過・滞留ヒートマップ |

- 保存設定の選択肢は「ラインクロス＋エリア内カウント」「ラインクロス＋エリア内カウント＋ヒートマップ」など。**「2年保存対応フォーマット＋ヒートマップ」の同時選択はできない**。選択肢や保存期間を推測で変更しない。
- 実機では`food`のヒートマップ`range`が`No Data`だが`latest_comp`が返ることを確認済み。これは履歴保存が可能という意味ではない。**Goal3-Aの通常保存対象には含めない**。
- `island`では営業時間中の`mode=multi`で通過・滞留ヒートマップの非ゼログリッドを取得済み。
- ラインクロスは`food`で約3か月分、`island`で短期間の履歴が観測されているが、**取得可能期間は実行時の`range`結果を正として決める**。固定日数をコードに埋め込まない。
- エリア内カウントの保存・集計は現段階では対象外。元のレスポンスに含まれる場合も勝手にラインクロスに加算しない。

### 2.2. 既存実装

- Goal1：`yarn probe`、`yarn fetch`、生レスポンスの`*.bin`＋`*.meta.json`保存、カメラ単位のエラー分離。
- Goal2：`yarn parse`、Multipart・CSV・JPEGの抽出、UTC日時・間隔の正規化、`mode=multi`の期間指定と実取得範囲へのフィルタリング。
- Goal2では`2026-11-21T09:00+09:00`〜`21:00+09:00`の12時間を指定すると、24区間応答から対象の12区間を採用できた。**CGIの返却件数をそのまま保存せず、正規化レコードごとに要求範囲を検証する**。
- 直近の`movcnt_info:latest`には1時間の途中経過（例：UTC 14:00〜14:51）が含まれた。**区間終了時刻を一意キーに使わない**。

## 3. 取得対象・保存設定

3種別は次のように扱う。新しい種類を増やす設計までは不要。

| 正規化種別 | CGI kind | 用途 |
|---|---|---|
| `linecross` | `movcnt_info` | ライン別のIN/OUT |
| `heatmap_mov` | `heatmap_mov_info` | 通過ヒートマップ64×64 |
| `heatmap_loi` | `heatmap_loi_info` | 滞留ヒートマップ64×64 |

- 通常の収集は**画像なしの`*_info`のみ**。JPEG付きCGI・R2アップロードはGoal3-Bへ持ち越す。
- カメラ別の取得有効種別は**設定で定義**し、コード側は種別ごとにif文を複製しない。初期値は`food: [linecross]`、`island: [linecross, heatmap_mov, heatmap_loi]`。
- カメラ別の取得・解析・保存処理を共通化する。将来foodのヒートマップを有効化する際は、`range`と実機保存状態を確認したうえで設定で切り替える。
- **1時間単位のデータをそのまま保存**する。CSVの`p_hhmm`で間隔を判定し、時刻を勝手に丸めない。将来15分へ変更された場合も壊れないよう`interval_minutes`列は保持する。現行の60分以外が観測された場合はログに明示し、勝手な時間別集約はしない。
- `OUT`などのサマータイム記号は既存Goal2の解釈に従う。CSVの開始・終了日時はUTC、表示用JSTは必要な箇所で変換する。D1の時刻キーはUTCとする。

## 4. D1スキーマ

**4テーブルに限定**し、実際に使う列に絞る。名前は既存コード規約に合わせ微調整してもよいが、以下の一意性と意味は厳守する。

### 4.1. `cameras`

- `id TEXT PRIMARY KEY`（`food`、`island`）
- `display_name TEXT NOT NULL`
- `created_at_utc TEXT NOT NULL`、`updated_at_utc TEXT NOT NULL`

カメラIP・ユーザー名・パスワードをD1に保存しない。初期データは安全な固定IDと表示名のみ。

### 4.2. `camera_lines`

- `camera_id TEXT NOT NULL`（`cameras.id`を参照）
- `line_no INTEGER NOT NULL`（1〜8）
- `display_name TEXT`（未設定時は`Line N`等）
- `include_in_visitors INTEGER NOT NULL DEFAULT 0`（0/1）
- `updated_at_utc TEXT NOT NULL`
- `PRIMARY KEY(camera_id, line_no)`

`island`は2本の設定ラインが観測されているが、どちらが店舗入口・出口の集計対象かは未確定。**両方の生カウントを保存し、店内人数や来店人数への加算対象を自動確定しない**。`include_in_visitors`はユーザーの確認前には0のままでもよい。

### 4.3. `linecross_hourly`

1レコード＝カメラ×ライン×計測区間。主な列：

- `camera_id TEXT NOT NULL`
- `line_no INTEGER NOT NULL`
- `start_utc TEXT NOT NULL`（正規化された区間開始。ISO 8601 UTC）
- `interval_minutes INTEGER NOT NULL`（現行60）
- `expected_end_utc TEXT NOT NULL`（`start_utc + interval_minutes`）
- `measured_until_utc TEXT NOT NULL`（元のCSVに記録された実際の終了時刻）
- `is_complete INTEGER NOT NULL`（0/1）
- `count_in INTEGER NOT NULL`、`count_out INTEGER NOT NULL`
- `source_captured_at_utc TEXT`（取得日時。取得元の履歴追跡用）
- `updated_at_utc TEXT NOT NULL`
- **`PRIMARY KEY(camera_id, line_no, start_utc, interval_minutes)`**

`count_in/count_out`には**その区間のカウント値**をそのまま格納する。日次累計やカメラ横断合計をここに格納しない。

### 4.4. `heatmaps_hourly`

1レコード＝カメラ×種別×計測区間。主な列：

- `camera_id TEXT NOT NULL`
- `kind TEXT NOT NULL`（`heatmap_mov` または `heatmap_loi`）
- `start_utc TEXT NOT NULL`
- `interval_minutes INTEGER NOT NULL`
- `expected_end_utc TEXT NOT NULL`
- `measured_until_utc TEXT NOT NULL`
- `is_complete INTEGER NOT NULL`
- `grid_json TEXT NOT NULL`（64×64の数値配列、JSONとして保存）
- `max_value INTEGER NOT NULL`、`nonzero_cells INTEGER NOT NULL`
- `source_captured_at_utc TEXT`
- `updated_at_utc TEXT NOT NULL`
- **`PRIMARY KEY(camera_id, kind, start_utc, interval_minutes)`**

- グリッドは64×64を維持する。`0`ばかりでも有効なデータとして保存し、勝手に省略・圧縮・画像化しない。
- 通過と滞留は**意味と単位が異なる**。合算したり、滞留値を人数と解釈したりしない。
- 長期集計・合成ヒートマップは後続Goalの表示側で検討し、Goal3-Aでは**生の区間グリッドを保存**する。
- `camera_id`＋時間範囲で検索しやすいインデックスを付ける。
- スキーマは`db/migrations/0001_init.sql`等のGit管理下のSQLで再現可能にする。テーブル作成の実行方法（ローカル/リモート）をREADMEに記載する。

※将来15分へ設定変更された場合でも`interval_minutes`の値で元の区間を識別できる。テーブル名の`hourly`は今回の1時間保存の呼称であり、**区間の単位を勝手に60分へ上書きしない**。

## 5. UPSERTとデータの優先順位（最重要）

**開始時刻＋計測間隔を区間の識別子にする**。`measured_until_utc`や取得run-idは一意キーに含めない。

1. 新規区間はINSERT。
2. 同じ区間の再取得はUPSERTし、行を増やさない。
3. 未確定区間には、より新しい`measured_until_utc`の途中経過を反映できる。
4. `is_complete=1`の確定済みレコードを`is_complete=0`の途中経過で上書きしない。
5. 両方確定済みで後日再取得した場合は、内容が同じなら無駄に書き換えない。値が異なったときの扱いは、取得日時・検証済みデータに基づいて安全に更新し、ログに記録する。
6. 取り込み途中で通信やD1書き込みに失敗しても、**同じ日・同じ区間を再実行すれば復旧**できる。

確定判定は、Goal2の`expected_end_utc`/実終了日時と実際のCSVの意味に基づいて行う。`latest`は無条件に未確定、`multi`は無条件に確定、といった**mode名だけの判定は禁止**。未来日時・負のカウント・異常な区間長・不正なグリッドは保存前に検証する。

画像付きと画像なしの同一区間ヒートマップが将来重複しても、**同じ時間・同じkindとして扱えるキー**にする。

## 6. 収集・同期の処理

### 6.1. 初回の履歴取得：`yarn backfill`

1. カメラ・データ種別ごとにGoal1の`range`を実行し、**その時点のカメラ実機の保存可能期間**を取得する。
2. `range`が`No Data`なら、そのkindの履歴取得はスキップし、理由を報告する。通信失敗や認証失敗は`No Data`として扱わない。
3. 取得可能期間をUTCベースの日付・区間に分割し、`mode=multi`で順番に取得する。まずは**1日単位**を基本とし、既存Goal2の`days=1〜6`の実装を活用する。大容量レスポンスの上限を超える場合は既存のサイズ制限に従い、安全に分割・失敗を記録する。
4. Goal1の生データ保存 → Goal2の既存正規化 → 取得した計測期間の再検証 → D1へのUPSERT、という既存パイプラインを再利用する。**既存のCGI解析処理を複製しない**。
5. `--camera food|island`、`--from`、`--to`（必要に応じた範囲限定）、`--dry-run`を提供する。dry-runは対象カメラ・kind・期間・想定リクエスト数を表示し、D1への書き込みは行わない。
6. `--from`/`--to`の指定がなければ`range`の結果で取得可能な履歴をすべて対象にする。**存在しない過去期間を取得しようとしない**。
7. 取得できた日ごと・種類ごとに処理結果を記録する。片方のカメラで失敗しても、他方は可能な限り継続する。
8. 再実行で同一区間を重複させず、欠落・失敗区間を取り直せるようにする。

`range`の結果は計測範囲・最新完成期間との境界で1区間ずれることがあるため、**取得APIが返したレコードの開始・終了時刻でフィルタリングし、境界の過不足をテスト**する。

### 6.2. 2回目以降の手動同期：`yarn sync`

- デモ時などに明示的に実行する。定期実行は作らない。
- カメラ・kindごとに`range`とD1の最新保存区間を確認し、**未取得期間と直近の重複区間**を取得する。数日実行しなかった場合も、実機で保持されている範囲の欠落を可能な限り補完する。
- 最新のラインクロスの途中経過は必要に応じて`latest`から取得し、同一区間にUPSERTする。確定済みの時間帯を途中経過で上書きしない。
- ヒートマップは`latest_comp`等の**完成済みデータ**を基本にし、保存可能な履歴は`multi`で回収する。
- `range`が`No Data`のkindは、通常は履歴同期しない。設定で有効化されており、`latest_comp`が実際に取得できる場合の単一区間の保存は拡張可能にするが、現時点の`food`ヒートマップを勝手に有効化しない。
- D1に保存済みの取得期間を頼りにできない初回は`backfill`の案内を出すか、同じバックフィル処理へ安全にフォールバックする。

### 6.3. オフライン保存（デバッグ・再実行）

- `runtime/goal2/`にある既存の正規化結果をD1へ流し込める実行経路（例：`yarn d1:import --camera island --dry-run`）を設ける。Goal1/2の実機再取得を必要としない検証手段にする。
- リモートD1への書き込みは明示的なコマンドでのみ行う。`yarn parse`を実行するだけでクラウドへ書き込まない。
- 同じ元データを別runで取得していても一意キーで重複しない。

## 7. Cloudflare D1通信・セキュリティ

- ローカルNode.jsからCloudflare D1のREST APIを利用する。**D1 APIの`query`エンドポイントはパラメータ付きSQL・バッチに対応**する。
- 環境変数は`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_D1_DATABASE_ID`、`CLOUDFLARE_API_TOKEN`等を`.env.local`に設定し、`.env.example`に**ダミー値**のみ記載。既存のカメラ設定を維持。
- トークンは対象D1への必要最小限の権限とし、実カメラの認証情報もCloudflareに送らない。HTTPログ・エラー・標準出力にトークン、Basic認証ヘッダー、カメラのパスワード、生データ本文を出さない。
- SQLはバインド変数を使い、値をSQL文字列へ連結しない。D1は**1クエリあたりバインドパラメータ100個**、SQL文長100KB、1行の最大2MBに制限がある。小さなチャンクに分割して書き込む。
- HTTP 200だけで成功扱いせず、Cloudflare APIレスポンスの`success`、個別`result[].success`、`errors`を確認する。
- 429・一時的な5xxなど再試行可能な失敗だけを回数制限付きでバックオフ再試行する。権限不足・SQL構文エラー・バリデーションエラーは無限に再試行しない。
- DB作成・マイグレーションは明示的な操作とし、確認なく既存D1を削除・初期化しない。
- 計測位置の画像や店舗内の個人情報をD1へ保存しない。原本・JSON・画像は既存Git管理外ディレクトリに残す。

Cloudflare公式参考：

- D1 Query API: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- D1 migrations: https://developers.cloudflare.com/d1/reference/migrations/

## 8. CLI例（コマンド名は既存構成に合わせて調整可）

```bash
# 取得可能期間と処理計画を表示（D1へ書き込まない）
yarn backfill --dry-run

# 2台の保存可能履歴を遡ってD1に取り込む
yarn backfill

# islandだけ期間指定して取り込む
yarn backfill --camera island --from 2026-11-21T09:00+09:00 --to 2026-11-21T21:00+09:00

# 次回以降の手動同期（直近区間の更新＋未取得期間の補完）
yarn sync

# 保存済み正規化JSONだけを使ったD1検証
yarn d1:import --camera island --dry-run
```

`yarn probe`、`yarn fetch`、`yarn parse`、`yarn test`等の既存コマンドは維持する。オプションの細部はREADMEに実装どおり記載する。

## 9. テストと検証

### 自動テスト

既存Goal1/Goal2の**16件**を維持して、少なくとも以下のケースを追加する。

- カメラ別の保存対象設定（foodはlinecrossのみ、islandは3種別）と将来foodで3種別を有効化できること。
- `range`の`No Data`を正しくスキップし、通信エラーとは区別すること。
- 初回全履歴・複数日分割・UTC/JSTの境界・部分的な期間指定の処理。
- 同一区間の2回取り込みでレコード数が増えないこと。
- 未確定→より新しい未確定→確定の更新順、および確定→古い未確定の上書き防止。
- 異なるカメラ、複数ライン、2種類のヒートマップが衝突しないこと。
- 全ゼログリッドと非ゼログリッド、64×64のバリデーション。
- D1のAPIエラー・部分的失敗・再試行・同じ日の再実行。
- dry-runがD1を変更しないこと。オフラインJSONからのインポートが実カメラ通信を起こさないこと。
- 秘密情報がログに出ないこと。

### 実機・D1受け入れ

- `food`のラインクロス履歴を現在の保存可能期間までバックフィルできる。
- `island`のラインクロスと通過・滞留ヒートマップを保存可能期間までバックフィルできる。
- 取得件数・正規化レコード数・DBの一意区間数を照合できる。
- 同じbackfillとsyncを複数回実行し、DB行数が不要に増えない。
- D1の対象行をSELECTし、開始UTC・interval・IN/OUT・グリッドのセル数と最大値がGoal2のJSONと一致する。
- 1つのカメラまたは1日分を故意に失敗させても、残りの取得が進み、再実行で補完できる。
- API資格情報を入力できない環境ではモックとdry-runまで実行し、**実際のD1保存成功とは報告しない**。

## 10. Goal3-Aで実装しないこと

- JPEGの新規取得・R2アップロード・サムネイル更新（Goal3-B）。
- ローカルNext.js管理画面の新規実装・UI改修（Goal4）。
- `sample_dashboard`のAPI/UI改修・日別/時間帯別/曜日別/月別の本格集計・ヒートマップの期間合成（Goal5）。
- エリア内カウントのD1保存、追加の人物推定、来店人数の独自補正。
- カメラの保存設定変更、15分への変更、定期実行、Rust化、Android化。
- 生CGIレスポンスやJPEGをD1へ格納すること。

## 11. 完了報告で必ず示す内容

1. 追加・変更したファイル、スキーマとテーブルの一覧。
2. `.env.local`の設定項目（実際の秘密値は出さない）。
3. DB作成・マイグレーション・backfill・sync・dry-run・オフラインインポートの具体的な実行手順。
4. カメラ別・種別別の保存可能期間と、取得・保存・スキップ・失敗・重複更新の実績。
5. D1での件数および代表的な1区間のSQL照合結果（秘密情報・画像は伏せる）。
6. `yarn test`、`yarn lint`、`yarn tsc --noEmit`の結果。
7. 未検証事項、失敗・途中経過の再実行手順、既知の制約。
8. Goal3-B/R2へ引き継ぐこと。

**このGoal3-Aだけを実装すること。Goal3-B/Goal4/Goal5には着手しないこと。**
