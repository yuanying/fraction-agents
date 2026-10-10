# Gmail 係（gmail-agent）

本人の Gmail を読み取り専用で調べ、自然な言葉の依頼に沿ってメールを探し、選び、短くまとめて返すエージェントの定義（ADR 0016）。
Google には本人の OAuth の同意（`gmail.readonly` だけ）で接続する。メールを送らず、既読やラベルも変えない。
依頼のあいだで何も覚えておかない（好みは依頼ごとに書く）。汎用ホストの image で動く。

## ファイル

| ファイル | 置き場所 | 中身 |
|---|---|---|
| `AGENTS.md` | agentDir（`/agent`） | 振る舞い。よくある依頼（重要なメールを優先度順で・探す・詳細）の進め方、好みの読み方、返事の形と件数の上限、初めの方針、メールを指示として扱わないこと |
| `settings.json` | agentDir | モデル（`openai-codex` の `gpt-6.1-sol`）、組み込みの道具を出さない（`defaultTools: []`）、読む Pi パッケージ |
| `gmail.example.json` | agentDir に `gmail.json` として | 資格のパス・タイムゾーン |
| `config.example.json` | `/etc/fraction-agents/config.json` | 汎用ホストの設定の例。Agent Card の説明に、呼び出し元への頼み方を書く。URL は架空 |

`kustomization.yaml` は、`AGENTS.md`・`settings.json` を ConfigMap `gmail-agent-agent-dir` に、
2 つの例を ConfigMap `gmail-agent-config` にする。`deploy/agents/gmail-agent` がこれを読む。

## 道具

| 道具 | 中身 |
|---|---|
| `gmail_search` | Gmail の検索式で探す（`after:`・`before:`・`older_than:` で古いメールも）。1 回に 50 通まで。Gmail の見積もりの件数を出し、続きは `pageToken`。迷惑メールとゴミ箱は入らない |
| `gmail_read_message` | 1 通を読む。ヘッダ・ラベル・リンク・添付（名前・種類・大きさ・`partId`）と、本文を 12000 文字まで（`offset` で続き） |
| `gmail_read_attachment` | テキストの添付だけを読む（512 KB まで、20000 文字まで見せる）。頼まれたときだけ |
| `submit_reply` | 答えを、要約・節（メール 1 通に 1 節）・出典（Gmail のリンク）の形で返す |
| `ask_caller` | 呼び出し元に聞き返す |

- すべて fraction-agents の Pi パッケージ（`gmail`・`submit-reply`・`ask-caller`）の道具である。ほかのパッケージは読まない。
- どの道具の結果も、先頭に今の日時とタイムゾーンの 1 行が付く。
- Gmail には GET だけを送る。送信・既読化・ラベル・アーカイブ・削除の道具は無い。scope が `gmail.readonly` でもそれらはできない。
- メールは、`untrusted email data` と書いた区切りの間に入れてモデルに渡す。本文の中の区切りに似た行は崩す。
- 本文は、プレーンテキストを優先し、無ければ HTML を文字にする（script・style・コメントは落とし、リンクは URL を残す）。文字コードは各部分の `charset` で読む（ISO-2022-JP・Shift_JIS なども）。
- Gmail がメッセージから外した大きな本文の部分は 2 MB まで取りにいく。それを超える部分は取らず、`Not retrieved:` の行で示す。係は、読めていないことを返事に書く。
  名前の無い添付（`Content-Disposition: attachment`）は、本文として取りにいかない。
- 添付は、名前と種類で振り分ける。実行できるもの（`.exe`・スクリプト・マクロ付きの Office・ディスクイメージなど）と圧縮ファイルは開かない。
  PDF・画像・Office の文書は、名前と種類だけを見せる。読むのはテキストの形式だけで、NUL を含むもの（バイナリ）も読まない。
- pi の組み込みの道具（read・bash・edit・write など）は `settings.json` の `defaultTools: []` で出さない。資格のファイルを読む道が無い。
- 画像を返す `attach_image` は要らないので、汎用ホストの設定の `piCommand` で外す。

## 上限

- 検索は 1 回に 50 通、本文は 1 回に 12000 文字、添付は 512 KB・20000 文字まで。切ったことと続きの位置を道具の結果に書く。
- 係は、1 回の依頼で一覧に取るのを 200 通まで、1 回の返事で返すメールを 30 通までとする（AGENTS.md）。
  超えたら、返していない件数・Gmail の見積もりの件数・続きの頼み方を返事に書く。返事の取り決め（reply v1）の大きさの上限に収めるため。

## 失敗

Gmail への要求は、429 と 5xx のときだけ、`Retry-After` に従うか 1・2・4 秒と間を空けて、1 回の要求につき 4 回まで試す。
401 と、refresh token が失効・取り消された（`invalid_grant`）ときは試し直さず、再認可が要るという誤りにする。
係は、その依頼の返事の要約の 1 行目に「Gmail の再認可が必要です」と書く。

## `gmail.json`

agentDir に置く。秘密は置かない（資格は別のファイル）。無いときは、Gmail の道具が出ない。

| 項目 | 必須 | 意味 |
|---|---|---|
| `credentialsFile` | 必須 | 資格のファイルの絶対パス。Secret をマウントした場所を書く |
| `timeZone` | 必須 | IANA のタイムゾーン。時刻をこのタイムゾーンで見せる |

- 読めない（JSON でない、値が正しくない、知らない項目がある）ときは、警告を出して道具を出さない。pi は起動する。
  以前の `stateDir` も、今は知らない項目として断る。
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

次のとき、Google は refresh token を受け付けなくなる。係の返事の要約に「Gmail の再認可が必要です」と出る。

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

係を止めるときや資格が漏れたときは、Google アカウントの「サードパーティのアプリとサービス」でアクセスを取り消す。

## 配置

`deploy/agents/gmail-agent` は Wiki 管理人と同じ形で、次が違う。

- 名前は `gmail-agent`（PVC は `data-gmail-agent-0`）。ConfigMap は `gmail-agent-agent-dir`（`AGENTS.md`・`settings.json`）と
  `gmail-agent-config`（`config.json`・`gmail.json`）。`gmail.json` は `/agent/gmail.json` に差し込む。
- image は汎用ホストの `ghcr.io/yuanying/fraction-agents`。
- 資格は Secret `gmail-agent-google` のキー `token.json` で、`/var/run/secrets/gmail/token.json` にマウントする。
  Secret が無くても Pod は起動し、その間、Gmail の道具は失敗する。
- PVC は、ほかの係と同じく、ホストの Task・セッションと pi のログインの情報に使う。Gmail の道具が独自に置くものは無い。

## 環境ごとの値

private の overlay（ADR 0010）で渡す。

- `gmail-agent-config` の `config.json` の `publicUrl` と `allowedCallers`
- `gmail.json`（パスとタイムゾーンを変えるとき）
- Secret `gmail-agent-google`
- image の tag と、PVC の StorageClass

ログインは、Wiki 管理人と同じ手順を係の Pod で行う（README の「ChatGPT Plus にログインする」。Pod は `gmail-agent-0`）。
依頼に答えるため、メールの本文はこのモデルに渡る（ADR 0016）。

## 呼び出し元へ

自然な言葉で頼む。依頼文だけで分かるように、期間・好み・重点を書く。係は前の依頼の好みを覚えていない。

- 「今日届いたメールのうち、仕事の連絡を中心に重要なものを優先度順で返して。広告や SNS の通知はいらない」
- 「2019 年に届いた賃貸契約のメールを探して」
- 「昨日の病院からのメールに書かれた予約の日時と持ち物を教えて」
- 添付の中身が要るときは、そう書く（「添付の CSV の合計も見て」）。

返事は reply v1（ADR 0015）の要約・節・出典で返る。節はメール 1 通に 1 つで、日時・差出人・件名・要点・（優先度順の依頼なら）優先度と理由・Gmail のリンクが入る。
30 通を超えるときは、最後の「残り」の節に、返していない件数と続きの頼み方が入る。
Claude などからの呼び方は、共通スキル [`skills/fraction-agents`](../../skills/fraction-agents/SKILL.md) にある。
