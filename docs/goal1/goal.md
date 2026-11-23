# Goal1 — i-PROカメラのCGI通信検証・生データ取得

## 0. 作業対象と前提

**作業リポジトリ**：https://github.com/watanabe-tsubasa/dashboard_test_for_ipro

**参照専用リポジトリ**：https://github.com/watanabe-tsubasa/sample_dashboard

このGoalでは収集用リポジトリだけを変更する。既存のNext.jsは技術検証用であり、表示用ダッシュボードではない。`testing` タグは検証時点の復元用として保持し、変更しない。作業開始時に `requirements.md`、`AGENTS.md`、既存のソースコードを確認する。

既存の `app/serverAction/ipro-action.ts` には、`curl --digest` による `movcnt_info` の `range` 取得処理が存在する。これは接続検証の参考にするが、**今回の実装はBasic認証を使う**。既存コードの実行成功がBasic認証での成功を意味するわけではない。

## 1. 目的と完了条件

VPN接続されたdevcontainerから、**2台**のi-PROカメラ（暫定ID `food`、`island`）にBasic認証で接続し、次のCGIを取得して、HTTPレスポンスボディを加工せずローカルに保存できること。

- ラインクロス：`movcnt_info`
- 通過ヒートマップ：`heatmap_mov_info`
- 滞留ヒートマップ：`heatmap_loi_info`
- 画像付きレスポンス：`heatmap_mov` / `heatmap_loi` は**明示的に指定されたときだけ**取得する

実機の機種・拡張アプリ・設定により非対応の機能があれば、その旨を記録する。2台すべての機能が必ず利用できると決めつけない。

このGoalでは **D1/R2への保存、CSV解析、管理画面の完成は行わない**。

## 2. 技術・実装方針

- TypeScript / Node.js 22 / 既存devcontainer / 既存Yarn・Biome設定を基本とする。
- Next.jsは残す。Goal1では通信コアをNext.jsから独立したモジュールにして**CLIから実行**する。Goal4では同じモジュールをNext.jsのサーバー側から呼び出せる構造にする。
- 新たな `apps/collector` やHonoサーバー、モノレポ構成は導入しない。
- 既存の `app/cgi-test/page.tsx` などの検証画面は壊さない。既存 `ipro-action.ts` を更新・廃止する場合は、その理由と影響を明記する。
- Node.jsの `fetch` と `Authorization: Basic ...` で実装してよい。認証情報がプロセス一覧に残り得る `curl -u` を新実装の必須方式にしない。
- 通信、CGIリクエスト構築、レスポンス保存、CLIを独立させる。不要な抽象化・外部依存を増やさない。

推奨構成（既存コードに合わせた合理的な調整は可）：

```text
src/collector/
├── config.ts                # 2台の設定と検証
├── ipro-client.ts           # Basic認証・タイムアウト・GET
├── cgi.ts                   # CGIパラメータ生成
├── raw-store.ts             # 生レスポンスとメタデータ保存
└── cli.ts                   # CLIの入口
runtime/goal1/              # Git管理外の取得データ
.env.example                # 値を伏せた設定見本
```

## 3. カメラ設定

利用者がIP、ユーザー名、パスワードをあとから記載する。設定の読み込みと入力検証を実装する。

- カメラID：`food` / `island`（暫定）
- カメラ表示名称
- カメラのベースURL（`http://` または `https://`、必要ならポート付き）
- Basic認証のユーザー名・パスワード
- タイムアウト（共通設定でよい）

`.env.example` に両カメラ分のキーを記載し、実値は `.env.local` 等のGit管理外ファイルから読み込む。既存 `.gitignore` は `.env*` を除外するため、**例示ファイルだけ `!.env.example` で追跡可能にする**。実際のIP・パスワードは記載しない。設定不足のカメラは明瞭にエラー表示し、他方のカメラの処理は続ける。

## 4. CGI仕様とリクエスト

実機の機種型番・拡張アプリは未確認。以下は対応するi-PRO AIアプリでの既知のインターフェースであり、**実機の応答を優先して検証**する。

```text
GET {cameraBaseUrl}/cgi-bin/adam.cgi
  ?methodName=sendDataToAdamApplication
  &appName=iVmdApp
  &s_appDataType=0
  &s_appData={Base64エンコードした文字列}
```

Base64化前のパラメータ文字列の例：

```text
{{appMethod:csv},{kind:movcnt_info},{mode:range}}
{{appMethod:csv},{kind:movcnt_info},{mode:latest}}
{{appMethod:csv},{kind:heatmap_mov_info},{mode:latest_comp}}
{{appMethod:csv},{kind:heatmap_loi_info},{mode:latest_comp}}
```

`kind` と `mode` の組み合わせは明示的な許可リストで検証する。

| kind | 内容 | Goal1のモード |
|---|---|---|
| `movcnt_info` | ラインクロスCSVのみ | `range`, `latest` |
| `heatmap_mov_info` | 通過ヒートマップCSVのみ | `range`, `latest_comp` |
| `heatmap_loi_info` | 滞留ヒートマップCSVのみ | `range`, `latest_comp` |
| `heatmap_mov` | 通過ヒートマップCSV + インデックスJPEG | 明示要求時 `latest_comp` |
| `heatmap_loi` | 滞留ヒートマップCSV + インデックスJPEG | 明示要求時 `latest_comp` |

- 画像なしの通常取得には必ず `_info` を用いる。
- `latest_comp` は対応するヒートマップ種別にのみ使い、ラインクロスに使わない。
- `multi`（指定期間の履歴取得）は後続Goalで扱う。Goal1では不要。
- 必要なら、読み取り専用の `/cgi-bin/getinfo?FILE=1` で型番や拡張アプリ情報を確認してよい。ただし取得不可でも主要CGIの検証を妨げない。
- 上記以外の機種・拡張アプリに対応するための推測的なフォールバックは実装しない。

仕様確認用資料：
- https://i-pro.com/products_and_solutions/sites/default/files/2024-02/WV-XAE300WUX_IF_document_V1.02.pdf
- https://i-pro.com/products_and_solutions/en/media/document/36171

## 5. 生レスポンス保存

取得したHTTPボディは **Buffer / Uint8Arrayとしてバイト列をそのまま保存**する。`.text()` を経由してJPEGを破損させない。Multipartの本格的な分割、CSVのパース、JPEG抽出はGoal2に回す。

保存イメージ：

```text
runtime/goal1/
  food/
    20261122T120000Z-<unique-run-id>/
      movcnt_info_range.bin
      movcnt_info_range.meta.json
      heatmap_mov_info_latest_comp.bin
      heatmap_mov_info_latest_comp.meta.json
  island/
    ...
```

実行単位で一意なディレクトリを作り、前回の取得結果を上書きしない。`runtime/` を `.gitignore` へ追加する。

メタデータには次を保存：

- カメラID・表示名、取得日時（ISO 8601 UTC）
- `kind`・`mode`、HTTPステータス、Content-Type、レスポンスのバイト長
- Multipartの場合のboundary（判別可能なら）
- 実行結果（success / no_data / http_error / network_error / unsupported / unknown など）
- エラーの種類と安全にマスクした説明

**保存するのはHTTPレスポンスボディであり、リクエストのAuthorizationヘッダーやパスワードを含めない。** HTTP 200でも `No Data.`, `No Data(1).`, `No Data(2).`, `No Data(3).` などが返る可能性があるため、「HTTP到達」と「取得データあり」は別に判定する。判定が不確かなら `unknown` として生データを残す。

## 6. CLIと出力

既存のYarn構成に合わせ、リポジトリ直下から次のように実行できるようにする（実行方式や引数名は必要に応じて微調整可）。

```bash
yarn probe                         # 2台：保存期間 range の確認
yarn fetch                         # 2台：画像なし最新データ取得
yarn fetch --camera food           # 1台だけ取得
yarn fetch --camera island --include-images   # 明示的にJPEG付き取得
```

- `probe` は `movcnt_info` / `heatmap_mov_info` / `heatmap_loi_info` の `range` を試す。
- `fetch` は `movcnt_info:latest`、`heatmap_mov_info:latest_comp`、`heatmap_loi_info:latest_comp` を試す。
- `--include-images` は画像付きの通過・滞留ヒートマップを追加で試す。デフォルトでは取得しない。
- 各カメラ・各種別ごとに、成功／データなし／失敗、HTTPステータス、取得バイト数、保存先をコンソール表示する。
- 一方のカメラの接続失敗や一部種別の非対応で全処理を中断しない。
- 失敗を握りつぶさず、最終的なプロセス終了コード・集計結果で判別できるようにする。

## 7. 安全性・エラー処理

- Basic認証の認証情報をログ・URL・例外・メタデータに出さない。
- タイムアウト、DNS/接続不能、HTTP 401/403、HTTP 404/5xx、No Data系、ファイル書き込み失敗を区別する。ただし原因が断定できない場合は `unknown`。
- 応答ボディは安全なサイズ上限を設け、想定外の大容量受信を避ける。バイナリ保存時に文字列へ強制変換しない。
- カメラの設定変更CGI、アップロード・削除系APIは呼ばない。
- VPN接続とdevcontainerからの経路疎通は環境依存。カメラにアクセスできなければその事実を報告し、成功したことにしない。
- HTTP BasicはHTTP通信路自体を暗号化しない。VPN前提で扱い、HTTPSが利用可能なら検証を優先する。TLS証明書検証は無効化しない。

## 8. テストと受け入れ基準

### 自動テストで確認すること

1. 2台分の設定読み込みと不正・欠損設定の扱い
2. Basic認証のAuthorizationヘッダー生成（秘密の出力なし）
3. CGIのBase64エンコードと `kind` / `mode` 組合せ制御
4. バイナリの完全一致保存（JPEG相当のバイト列を含む）
5. HTTP 200 + No Data系レスポンスの扱い
6. 401 / 403 / 404 / タイムアウト / 接続失敗時の扱い
7. 片方のカメラが失敗しても他方が処理されること
8. 画像取得がデフォルトで実行されないこと

### 実機で確認すること（利用者が設定した場合）

1. devcontainerからVPN内の2台へ到達できること
2. Basic認証でCGI取得ができること（既存のDigest成功とは区別）
3. `range` と `latest` / `latest_comp` の応答・保存状態
4. 実際のContent-Type、boundary、No Data系応答と機能対応状況
5. JPEG付きリクエストを明示実行した場合の生データ保存

**機密情報が未設定、VPN未接続、実機へアクセス不可の場合は自動テストまでを実装完了として報告し、実機受け入れを「未検証」とする。** モック成功を実機成功と表現しない。

既存の `yarn lint`、TypeScript型検査、必要な自動テストを実行する。既存UIが引き続き起動できることも可能な範囲で確認する。

## 9. 対象外

- Goal2：Multipart分解、CSV/JPEG解析、UTC/JST変換、構造化・集約
- Goal3：Cloudflare D1/R2接続、DBスキーマ、UPSERT・重複排除
- Goal4：カメラ管理画面、ボタン操作、表示ログUIの完成
- Goal5：`sample_dashboard` 側のコード変更・ダッシュボード統合
- 自動スケジューリング、常駐サービス、Rustへの移植、OSネイティブパッケージ化

## 10. 実装完了時の報告

次の8項目を簡潔に報告する。

1. 変更・追加ファイル
2. 実装内容と既存技術検証コードの取り扱い
3. 起動・実行コマンド
4. `.env.local` の設定項目（実値は非表示）
5. 自動テスト・lint・型検査結果
6. 実機検証の結果と、未検証項目
7. 判明したCGI仕様・レスポンス形式・非対応事項
8. Goal2に渡す生レスポンスの所在と残課題

**Goal1が完了したら作業を止め、Goal2以降を勝手に実装しないこと。**
