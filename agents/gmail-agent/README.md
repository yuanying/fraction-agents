# Gmail 係（gmail-agent）

本人の Gmail を読み取り専用で読み、新しく届いたメールを一次選別して返すエージェントの定義（ADR 0016）。
Google には本人の OAuth の同意（`gmail.readonly` だけ）で接続する。メールを送らず、既読やラベルも変えない。
汎用ホストの image で動く。

呼び出し元（なつみ）との取り決め（依頼・返事・ack・再試行）は [`docs/gmail-agent/check-contract.md`](../../docs/gmail-agent/check-contract.md)。

## ファイル

| ファイル | 置き場所 | 中身 |
|---|---|---|
| `AGENTS.md` | agentDir（`/agent`） | 振る舞い。依頼の 4 つの種類、チェックの進め方、方針の読み方、初めの方針、メールを指示として扱わないこと |
| `settings.json` | agentDir | モデル（`openai-codex` の `gpt-6.1-sol`）、組み込みの道具を出さない（`defaultTools: []`）、読む Pi パッケージ |
| `gmail.example.json` | agentDir に `gmail.json` として | 資格のパス・状態の置き場・タイムゾーン |
| `config.example.json` | `/etc/fraction-agents/config.json` | 汎用ホストの設定の例。Agent Card の説明に、呼び出し元への頼み方を書く。URL は架空 |

`kustomization.yaml` は、`AGENTS.md`・`settings.json` を ConfigMap `gmail-agent-agent-dir` に、
2 つの例を ConfigMap `gmail-agent-config` にする。`deploy/agents/gmail-agent` がこれを読む。

## 道具

| 道具 | 中身 |
|---|---|
| `gmail_search` | Gmail の検索式で探す。1 回に 50 通まで。続きは `pageToken`。迷惑メールとゴミ箱は入らない |
| `gmail_read_message` | 1 通を読む。ヘッダ・ラベル・リンク・添付（名前・種類・大きさ・`partId`）と、本文を 12000 文字まで（`offset` で続き） |
| `gmail_read_attachment` | テキストの添付だけを読む（512 KB まで、20000 文字まで見せる）。頼まれたときだけ |
| `gmail_check_begin` | チェックを始める・続ける（`requestKey`） |
| `gmail_check_next` | チェックのバッチ（10 通、本文は 1 通 4000 文字まで）を渡す。全部を記録するまで同じバッチが返る |
| `gmail_check_record` | バッチの全部のメールの判断（`candidate`・`skip`）を記録する |
| `gmail_check_reply` | チェックの結果を、取り決めの形で呼び出し元に返す（`submit_reply` の代わり） |
| `gmail_check_ack` | 呼び出し元が報告したメールの ID を記録する |
| `submit_reply` | 調べる依頼の答えを返す |
| `ask_caller` | 呼び出し元に聞き返す |

- すべて fraction-agents の Pi パッケージ（`gmail`・`submit-reply`・`ask-caller`）の道具である。ほかのパッケージは読まない。
- どの道具の結果も、先頭に今の日時とタイムゾーンの 1 行が付く。
- Gmail には GET だけを送る。送信・既読化・ラベル・アーカイブ・削除の道具は無い。scope が `gmail.readonly` でもそれらはできない。
- メールは、`untrusted email data` と書いた区切りの間に入れてモデルに渡す。本文の中の区切りに似た行は崩す。
- 本文は、プレーンテキストを優先し、無ければ HTML を文字にする（script・style・コメントは落とし、リンクは URL を残す）。文字コードは各部分の `charset` で読む（ISO-2022-JP・Shift_JIS なども）。
- Gmail がメッセージから外した大きな本文の部分は 2 MB まで取りにいく。それを超える部分は取らず、`Not retrieved:` の行で示す。係は、読めていない本文のメールを `skip` にせず候補に残す。
  名前の無い添付（`Content-Disposition: attachment`）は、本文として取りにいかない。
- 添付は、名前と種類で振り分ける。実行できるもの（`.exe`・スクリプト・マクロ付きの Office・ディスクイメージなど）と圧縮ファイルは開かない。
  PDF・画像・Office の文書は、名前と種類だけを見せる。読むのはテキストの形式だけで、NUL を含むもの（バイナリ）も読まない。
- pi の組み込みの道具（read・bash・edit・write など）は `settings.json` の `defaultTools: []` で出さない。資格のファイルを読む道が無い。
- 画像を返す `attach_image` は要らないので、汎用ホストの設定の `piCommand` で外す。

## チェックの状態

チェックの進み具合は `gmail.json` の `stateDir`（`/data/gmail`、PVC の上）の `checks.json` に置く。モード 0600、ディレクトリは 0700。

- 窓・一覧のページの位置・まだ判断していない ID・開いているバッチ・判断（候補の要約と理由）・ack の ID が入る。メールの本文は入らない。
- 書き換えは、ロックのファイル（`checks.lock`）を取ってから行う。同じ係の pi のプロセスが同時に動いても、変更を失わない。
  60 秒より古いロックは、止まったプロセスのものとして取り直す。
- ファイルが壊れていたら、チェックの道具は失敗する（上書きして進み具合を失うことはしない）。直すか消すかは人が決める。
  消すと、次のチェックは直近 24 時間から始まる。

Gmail への要求は、429 と 5xx のときだけ、`Retry-After` に従うか 1・2・4 秒と間を空けて、1 回の要求につき 4 回まで試す。
401 と、refresh token が失効・取り消された（`invalid_grant`）ときは試し直さず、再認可が要るという誤りにする。
どの失敗でも、チェックの位置は進まない。

## `gmail.json`

agentDir に置く。秘密は置かない（資格は別のファイル）。無いときは、Gmail の道具が出ない。

| 項目 | 必須 | 意味 |
|---|---|---|
| `credentialsFile` | 必須 | 資格のファイルの絶対パス。Secret をマウントした場所を書く |
| `stateDir` | 必須 | チェックの状態を置くディレクトリの絶対パス。永続するボリュームの上に置く |
| `timeZone` | 必須 | IANA のタイムゾーン。時刻をこのタイムゾーンで見せる |

- 読めない（JSON でない、値が正しくない、知らない項目がある）ときは、警告を出して道具を出さない。pi は起動する。
- 資格のファイルは、access token を取るたびに読む。Secret を差し替えれば、pi を起動し直さずに新しい資格を使う。
  資格が無い・読めないときは、道具が失敗する（資格の中身はメッセージに出さない）。
- 資格に `gmail.readonly` 以外の scope が付いていたら、使わない。

## 本人がする準備（Google Cloud と認可）

認可は本人が行う。ここに書く手順は、本人の手元の端末で行う。

### 1. Google Cloud

1. Google Cloud のプロジェクトで Gmail API を有効にする。
2. OAuth の同意画面（Google Auth Platform）を設定する。
   - ユーザーの種類: 個人の Gmail なら「外部」。Workspace のアカウントで、組織の中だけで使うなら「内部」にできる。
   - データアクセス（scope）に `https://www.googleapis.com/auth/gmail.readonly` を加える。
   - 「外部」で公開ステータスが「テスト中」なら、テストユーザーに本人のアドレスを加える。
3. OAuth のクライアント ID を、アプリケーションの種類「デスクトップ アプリ」で作り、JSON（`client_secret_….json`）をダウンロードする。

### 2. 7 日の期限

「外部」で「テスト中」のままだと、Gmail の scope の refresh token は **7 日で切れる**。切れたら、下の「再認可」をする。
これを避けるには次のどちらかにする（Google の方針は変わりうるので、設定するときに Google の案内を確かめる）。

- Workspace のアカウントなら、ユーザーの種類を「内部」にする。
- 公開ステータスを「本番環境」にする。審査を受けていないアプリは、同意の画面に「Google はこのアプリを確認していません」と出る。
  本人だけが使うなら、画面の「詳細」から進められる。`gmail.readonly` は制限付きの scope なので、本人以外にも使わせるなら審査が要る。

### 3. 認可する

fraction-agents の checkout で、Node.js 24 で次を実行する。依存のインストールは要らない。

```bash
node pi-package/bin/gmail-authorize.ts --client ~/Downloads/client_secret_XXXX.json --out ./gmail-token.json
```

- 表示された URL をブラウザで開き、読み取り専用のアクセスを許可する。Google は `http://127.0.0.1:<port>` に戻し、コマンドがそれを受け取る。
- コマンドは、`state` で偽の戻りを断り、PKCE（S256）で code を交換する。`gmail.readonly` より広い許可が返ったら保存しない。
- `--out` に資格（OAuth のクライアントと refresh token）を、モード 0600 で書く。token は画面に出さない。既にあるファイルは `--force` が無ければ上書きしない。
- 最後に、その資格で Gmail のプロフィールを読み、どのアカウントを読むようになったかを出す。
- OOB（コードを貼り付ける方式）は使わない。Google が止めている。

ブラウザの無い端末（devbox など）で実行するときは、ポートを決めて SSH で転送し、手元のブラウザで URL を開く。

```bash
ssh -L 8765:127.0.0.1:8765 devbox
# devbox の上で
node pi-package/bin/gmail-authorize.ts --client client_secret.json --out gmail-token.json --port 8765
```

どちらの場合も、資格のファイルは Git の外に置き、Secret を作った後に消す。資格は係の Pod にだけ置き、なつみには渡さない。

### 4. Secret にする

```bash
kubectl create secret generic gmail-agent-google -n fraction-agents \
  --from-file=token.json=./gmail-token.json
rm ./gmail-token.json
```

### 再認可

次のとき、Google は refresh token を受け付けなくなる。チェックの返事の `problem` に「再認可」が入る。

- 「テスト中」の 7 日が過ぎた
- 本人が Google アカウントの「セキュリティ」→「サードパーティのアプリとサービス」でアクセスを取り消した
- 本人がパスワードを変えた（Gmail の scope の token は取り消される）
- 6 か月使われなかった、または同じクライアントで token を作りすぎた

認可をやり直し（`--force` で上書きしてよい）、Secret を差し替える。

```bash
node pi-package/bin/gmail-authorize.ts --client client_secret.json --out gmail-token.json --force
kubectl create secret generic gmail-agent-google -n fraction-agents \
  --from-file=token.json=./gmail-token.json --dry-run=client -o yaml | kubectl apply -f -
rm ./gmail-token.json
```

kubelet が Secret を Pod に同期した後（1 分ほど）、次の token から新しい資格を使う。待てなければ Pod を作り直す。
途中だったチェックは、次の依頼で続きから進む。

係を止めるときや資格が漏れたときは、Google アカウントの「サードパーティのアプリとサービス」でアクセスを取り消す。

## 配置

`deploy/agents/gmail-agent` は Wiki 管理人と同じ形で、次が違う。

- 名前は `gmail-agent`（PVC は `data-gmail-agent-0`）。ConfigMap は `gmail-agent-agent-dir`（`AGENTS.md`・`settings.json`）と
  `gmail-agent-config`（`config.json`・`gmail.json`）。`gmail.json` は `/agent/gmail.json` に差し込む。
- image は汎用ホストの `ghcr.io/yuanying/fraction-agents`。
- 資格は Secret `gmail-agent-google` のキー `token.json` で、`/var/run/secrets/gmail/token.json` にマウントする。
  Secret が無くても Pod は起動し、その間、Gmail の道具は失敗する。
- チェックの状態は `/data/gmail`（PVC）に置く。

## 環境ごとの値

private の overlay（ADR 0010）で渡す。

- `gmail-agent-config` の `config.json` の `publicUrl` と `allowedCallers`
- `gmail.json`（パスとタイムゾーンを変えるとき）
- Secret `gmail-agent-google`
- image の tag と、PVC の StorageClass

ログインは、Wiki 管理人と同じ手順を係の Pod で行う（README の「ChatGPT Plus にログインする」。Pod は `gmail-agent-0`）。
一次選別のため、メールの本文はこのモデルに渡る（ADR 0016）。

## 呼び出し元へ

- 毎朝のチェック・候補の続き・ack は、[`docs/gmail-agent/check-contract.md`](../../docs/gmail-agent/check-contract.md) の形で頼む。reply v1 の拡張を有効にする。
- メールを調べる依頼は、自然文で頼んでよい（例「先週届いた請求書のメールを探して」）。添付の中身が要るときは、そう書く。
