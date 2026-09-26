# fraction-agents

Kubernetes クラスタで飼う、特化した AI エージェントの置き場。

各エージェントは独立したサービスとして立ち、A2A プロトコルで依頼を受ける。
設計の決定は `docs/adr/` に置く。

## ADR

- [0001. エージェントを独立したサービスとして飼い、A2A で話す](docs/adr/0001-agents-as-services-over-a2a.md)
- [0002. エージェントの中身の作り方](docs/adr/0002-generic-host-and-dedicated-agents.md)
- [0003. 呼び出し元の認証は ServiceAccount と TokenReview で行う](docs/adr/0003-caller-auth-with-serviceaccounts.md)
- [0004. Wiki 管理人は PR で書き込み、マージは本人の指示でだけ行う](docs/adr/0004-wiki-keeper-writes-through-pull-requests.md)
- [0005. Claude・Codex・Pi からは公式の a2a-cli と共通のスキルで呼ぶ](docs/adr/0005-call-agents-with-a2a-cli-and-shared-skill.md)
- [0006. エージェントは既存の Ingress でインターネットに出し、守りは認証に任せる](docs/adr/0006-expose-agents-through-ingress.md)
- [0007. 汎用ホストは A2A のアダプタが context ごとに Pi を子プロセスで動かす](docs/adr/0007-generic-host-runs-pi-per-context.md)
- [0008. エージェントの定義は Pi の agentDir で持ち、ログインはエージェントごとに分ける](docs/adr/0008-agent-definition-as-pi-agent-dir.md)
- [0009. Wiki 管理人の置き方と、GitHub への書き込みの門番](docs/adr/0009-wiki-keeper-placement-and-gatekeeping.md)
- [0010. manifest は汎用の base をこのリポジトリに、環境固有の overlay を private のリポジトリに置く](docs/adr/0010-manifest-base-and-private-overlay.md)
- [0011. エージェントは StatefulSet で動かし、ボリュームは volumeClaimTemplates で作る](docs/adr/0011-agent-as-statefulset.md)
- [0012. 画像の成果物は汎用ホストが保存し、URI の artifact で返す](docs/adr/0012-return-images-as-artifacts-by-uri.md)

## 汎用ホスト

汎用ホストは、Pi を headless で動かして A2A で包む共通の image である（ADR 0002、0007）。
1 プロセスが 1 エージェントを受け持つ。

- A2A 1.0 を JSON-RPC over HTTP で受ける。公式の [`a2a-cli`](https://github.com/a2aproject/a2a-cli) からそのまま呼べる。
- Agent Card は `/.well-known/agent-card.json` に出す。名前・説明・スキルは設定から取る。Agent Card と `/healthz` だけは認証なしで返す。
  Ingress でインターネットに出す（ADR 0006）ので、エージェントの名前・説明・スキルは外から見える。Agent Card に秘密や内部の情報を書かない。
- それ以外の呼び出しには、audience `a2a` の ServiceAccount token を `Authorization: Bearer` で付ける。
  ホストは TokenReview で確かめ、設定で許した ServiceAccount だけを受け付ける（ADR 0003）。
- context はホストだけが採番する。contextId を付けずに送ると新しい context になる。
  contextId を付けられるのは、自分が前に受け取った context だけである。他人の context や、存在しない contextId はエラーになる。
- context ごとに `pi --mode rpc --session <file>` を 1 つ立てる。セッションのファイル名はホストが決める。
  - 同じ context の次の Task は同じプロセスに送る。プロセスが落ちていれば、同じファイルで起動し直して続ける。
  - 1 つの context で同時に走る Task は 1 つだけである。走っている間に同じ context へ送った Task は `REJECTED` で返す。
  - 一定時間使われなかったプロセスは止める。一定期間使われなかった context は、セッションのファイルと Task の記録ごと消す。
  - 設定の `contextWorkspace` があれば、context ごとに `<workDir>/<contextId>` で pi を動かす（下の「context ごとの作業ディレクトリ」）。
- 1 つの Task は、pi への 1 回の prompt である。
  - 最後の assistant の文を、`response` という名前の artifact として返す。
  - エージェントが画像を添えたときは、その後に画像ごとの artifact を足す（下の「画像の成果物」）。
  - モデルの呼び出しが失敗したら `FAILED`、pi が途中で終了したら `FAILED`、CancelTask で止めたら `CANCELED` になる。
  - 続きの依頼は、同じ contextId で新しいメッセージを送る。
  - pi の中の拡張が呼び出し元に質問したとき（下の「聞き返し」）だけ、Task は `INPUT_REQUIRED` で止まる。
    その Task の taskId を付けたメッセージが答えになる。それ以外の Task に taskId を付けたメッセージは受け付けない。
- 結果は、`returnImmediately` ですぐ返してから GetTask で取りに行く使い方を基本とする。ストリーミングと push 通知は出していない。
- Task と context の記録は SQLite に持つので、ホストを再起動しても GetTask と ListTasks で取れる。
  再起動の時点で走っていた Task と答えを待っていた Task は `FAILED` にする。ListTasks は呼び出し元の Task だけを返す。

### 設定

設定は JSON のファイル 1 つである。秘密は置かない。

| 項目 | 必須 | 既定 | 意味 |
|---|---|---|---|
| `name` | 必須 | | Agent Card の名前 |
| `description` | 必須 | | Agent Card の説明 |
| `version` | | `0.0.0` | Agent Card の版 |
| `skills` | | `[]` | Agent Card のスキル。各要素は `id`・`name`・`description`（必須）と `tags`・`examples` |
| `publicUrl` | 必須 | | 呼び出し元から見たこのエージェントの URL。Agent Card に載せる |
| `port` | | `8080` | listen するポート |
| `allowedCallers` | 必須 | | 受け付ける ServiceAccount。`system:serviceaccount:<namespace>:<name>` の形で書く |
| `agentDir` | 必須 | | pi の agentDir（AGENTS.md、settings.json、auth.json の置き場）。絶対パス |
| `dataDir` | 必須 | | ホストのデータ領域。`state.db`（Task と context）と `sessions/`（セッションのファイル）を置く。絶対パス |
| `workDir` | | `<dataDir>/work` | pi を動かす作業ディレクトリ。絶対パス |
| `idleTimeoutSeconds` | | `1800`（30 分） | 使われなくなった pi のプロセスを止めるまでの秒数 |
| `sessionRetentionSeconds` | | `604800`（7 日） | 使われなくなった context を消すまでの秒数 |
| `piCommand` | | `["pi"]` | pi を起動するコマンド。後ろに `--mode rpc --session <file>` を足して起動する |
| `passEnv` | | `[]` | 既定の最小限に加えて pi に渡す環境変数の名前。名前だけを書き、値はホストの環境から取る |
| `inputTimeoutSeconds` | | `86400`（1 日） | 質問への答えを待つ秒数。過ぎたら質問を取り下げ、Task を `FAILED` にする |
| `artifactRetentionSeconds` | | `604800`（7 日） | 画像の成果物を返し続ける秒数。作ってから数え、過ぎたら 404 にして消す |
| `contextWorkspace` | | なし | context ごとの作業ディレクトリを用意するコマンド。`prepare`（必須）と `remove` の 2 つで、どちらもコマンドの配列 |

例:

```json
{
  "name": "wiki-keeper",
  "description": "Wiki を読み、PR で書き換える。",
  "skills": [{ "id": "ingest", "name": "取り込み", "description": "原文を Wiki に取り込む。" }],
  "publicUrl": "https://agents.example.test/wiki-keeper/",
  "allowedCallers": [
    "system:serviceaccount:fraction-agents:owner",
    "system:serviceaccount:fraction-agents:claude"
  ],
  "agentDir": "/agent",
  "dataDir": "/data"
}
```

### 環境変数

ホストが読むもの:

| 変数 | 意味 |
|---|---|
| `FRACTION_AGENTS_CONFIG` | 設定ファイルのパス。`--config` を付ければそちらが優先する。どちらも無ければ `/etc/fraction-agents/config.json` |
| `KUBERNETES_SERVICE_HOST`、`KUBERNETES_SERVICE_PORT` | TokenReview を送る apiserver。Pod には Kubernetes が入れる |

TokenReview には Pod の ServiceAccount の token（`/var/run/secrets/kubernetes.io/serviceaccount/token`）と CA を使う。
この ServiceAccount には `system:auth-delegator` を ClusterRoleBinding で与える。

ホストは、pi に自分の環境変数をそのまま渡さない。pi の子プロセスが受け取るのは次の 3 種類だけである。

1. ホストの環境にある次の変数（pi が動き、コマンドを探し、ロケールとタイムゾーンを知るのに要る最小限）:
   `PATH`、`HOME`、`USER`、`SHELL`、`TMPDIR`、`TZ`、`LANG`、`LANGUAGE`、`LC_ALL`、`LC_CTYPE`、`LC_MESSAGES`
2. 設定の `passEnv` に名前を書いた変数。値はホストの環境から取る。
3. ホストが決めて渡す次の変数:

| 変数 | 意味 |
|---|---|
| `PI_CODING_AGENT_DIR` | 設定の `agentDir` |
| `FRACTION_AGENTS_CALLER` | その context の呼び出し元の名前（`system:serviceaccount:<namespace>:<name>`）。Pi の拡張は、これを見て呼び出し元ごとに振る舞いを変えられる |
| `FRACTION_AGENTS_CONTEXT_ID` | その context の ID。ホストが採番したもの |
| `FRACTION_AGENTS_ARTIFACT_OUTBOX` | その context の画像の受け渡しの場所（`<dataDir>/artifacts/outbox/<contextId>`）。`attach_image` が使う（下の「画像の成果物」） |

ホストの環境に資格（`OPENAI_API_KEY`、`HF_TOKEN` など）があっても、`passEnv` に書かない限り pi には渡らない。
エージェントに資格を渡すときは、その名前を `passEnv` に書く。
モデルの資格は、環境変数ではなく agentDir の auth.json で持たせるのが基本である（ADR 0008）。

Pod の ServiceAccount の token（`/var/run/secrets/kubernetes.io/serviceaccount/`）は、pi の bash からも読める。
エージェントの ServiceAccount には TokenReview に要る権限（`system:auth-delegator`）だけを与え、ほかの権限を持たせない。

### context ごとの作業ディレクトリ

設定に `contextWorkspace` を書くと、pi は context ごとに `<workDir>/<contextId>` で動く。
Wiki 管理人のように、context ごとに git の worktree を持つエージェントのための仕組みである。

- pi を起動する前に毎回、`prepare` のコマンドに、そのディレクトリのパスを最後の引数として付けて実行する。
  コマンドは、そのディレクトリを pi が動ける状態にする。すでに用意されていれば、そのまま残す。
- コマンドの環境は pi と同じ（上の 3 種類）で、ホストの秘密は渡らない。
- コマンドが失敗したら、pi を起動せずに Task を `FAILED` にする。理由には、コマンドの標準エラーの最後の行を載せる。
- context を消すときに、`remove` のコマンドを同じ形で実行し、残ったディレクトリを消す。
  ホストの知らない context の名前のディレクトリ（途中で落ちて残ったもの）も、同じように片付ける。
- ディレクトリ名には、ホストが採番した context ID（UUID の形）だけを使う。

### 聞き返し

pi の拡張が `ctx.ui.input` か `ctx.ui.editor` で質問すると（RPC の `extension_ui_request`）、ホストは Task を `INPUT_REQUIRED` にし、
質問の文を状態のメッセージに載せる。

- 呼び出し元は、同じ taskId を付けたメッセージで答える。答えは同じ pi のプロセスの同じ prompt に渡り、作業が続く。
  1 つの Task で何度でも聞ける。
- 答えを待つ間、その context は塞がっている。新しい Task を送ると、待っている Task の ID を添えて `REJECTED` を返す。
- CancelTask で止めると `CANCELED` になる。`inputTimeoutSeconds` の間に答えが無ければ、質問を取り下げて `FAILED` にする。
- 選択（`select`）と確認（`confirm`）のダイアログは、A2A の文の答えに対応しないので、すぐに取り下げる。

`a2a-cli` で答える例:

```bash
a2a task get -a https://agents.example.test/wiki-keeper/ <task-id>      # 状態が INPUT_REQUIRED なら、メッセージが質問
a2a send -a https://agents.example.test/wiki-keeper/ --task-id <task-id> "index の方です"
```

### 画像の成果物

エージェントは、Task の返事に画像（スクリーンショットなど）を添えられる（ADR 0012）。

- Pi の中では、Pi パッケージのツール `attach_image` に画像のファイルと説明の 1 行を渡して添える（下の「Pi パッケージ」）。
- Task が完了すると、`response` の artifact の後に、画像ごとに artifact を 1 つ足す。
  - parts は URL の part 1 つで、`url` が取得先、`mediaType` が形式、`filename` が表示用の名前。artifact の `description` が説明。
  - 取得先は `publicUrl` と同じ origin の `/artifacts/<ID>`。ID はホストが乱数で振る。
- 形式は PNG・JPEG・WebP だけで、ファイルの中身で判定する。1 枚は 10 MiB まで、1 つの Task で 8 枚まで。超えたもの、形式の違うものは返さない。
- `FAILED` と `CANCELED` で終わった Task の画像は返さずに捨てる。
- `GET /artifacts/<ID>` は、A2A の呼び出しと同じ token を要る。token が無い・違うときは 401、許していない ServiceAccount は 403。
  画像を返すのは、その Task を送った呼び出し元にだけで、他の呼び出し元・知らない ID・期限を過ぎた ID には 404 を返す。
  本文は画像そのもので、`Content-Type` と `Content-Length` を付ける。
- 画像は `<dataDir>/artifacts/files/` に置き、記録は `state.db` に持つ。ホストを再起動しても取れる。
  `artifactRetentionSeconds` を過ぎたものは、定期の掃除でファイルと記録を消す。

`attach_image` を使わずに渡すこともできる。`FRACTION_AGENTS_ARTIFACT_OUTBOX` のディレクトリに、画像のファイルと、同じ名前の幹の JSON
（`file` に画像のファイル名、`name` に表示用の名前、`description` に説明）を置けば、Task の完了時にホストが名前の順に引き取る。
ホストはツールと同じ検査をする。

`a2a-cli` で取得する例:

```bash
a2a task get -a https://agents.example.test/web-researcher/ <task-id>   # artifact の url を見る
curl -fsS -H "Authorization: Bearer $(cat ~/.config/fraction-agents/tokens/claude)" -o shot.png <url>
```

### 起動

ビルドして起動する:

```bash
npm ci
npm run build
node dist/src/main.js --config /path/to/config.json
```

TokenReview を呼ぶので、Kubernetes の Pod の中で動かす前提である。

image は `Dockerfile` で作る。Node 24 の slim に、このホストと `@earendil-works/pi-coding-agent` 0.87.0（`pi` のコマンド）を入れる。
fraction-agents の Pi パッケージ（下の「Pi パッケージ」）も `/opt/fraction-agents/pi-package` に入る。
`node` ユーザーで動き、`/data` と `/agent` をマウント先として用意してある。設定は `/etc/fraction-agents/config.json` に置く。

```bash
docker build -t fraction-agents-generic-host .
```

### 呼び出し方

`a2a-cli` から呼ぶ例:

```bash
export A2ACLI_AUTH="Bearer $(kubectl create token claude -n fraction-agents --audience a2a)"
a2a send -a https://agents.example.test/wiki-keeper/ --async "この記事を取り込んで"
a2a task get -a https://agents.example.test/wiki-keeper/ <task-id> --wait
a2a send -a https://agents.example.test/wiki-keeper/ --context-id <context-id> "続けて、関連ページも直して"
```

### テスト

```bash
npm ci
npm run typecheck
npm test
npm run build
```

テストは本物の pi も Kubernetes も使わない。RPC の JSONL を話す偽の pi（`test/fixtures/fake-pi.ts`）と、偽の TokenReview で動かす。
Pi パッケージのテストは、ローカルの bare repository を GitHub の代わりにし、GitHub の API は偽物かローカルの HTTP サーバーで代える。

## エージェントを呼ぶ（呼び出し元の準備）

Claude・Codex・Pi からは、公式の `a2a-cli` と、このリポジトリの共通のスキル [`skills/fraction-agents`](skills/fraction-agents/SKILL.md) でエージェントを呼ぶ（ADR 0005）。
スキルの補助スクリプト `scripts/agent.mjs` が、エージェントの名前から URL と token を引いて `a2a` を起動する。
URL と token はこのリポジトリに書かず、呼び出し元の手元に置く。

### a2a-cli を入れる

版は v0.2.0 に固定する。スキルの手順と終了コードの読み方は、この版で確かめてある。

- リリースのバイナリ（推奨）: [v0.2.0 のリリース](https://github.com/a2aproject/a2a-cli/releases/tag/v0.2.0)から、OS と CPU に合う `a2a_0.2.0_<os>_<arch>.tar.gz` と `checksums.txt` を取る。
  `sha256sum -c`（macOS は `shasum -a 256 -c`）で確かめてから展開し、`a2a` を `PATH` の通った場所に置く。
- ソースから: `go install github.com/a2aproject/a2a-cli@v0.2.0`。コマンド名が `a2a-cli` になるので、`a2a` に名前を変える。

Homebrew は最新版を入れるので、版を固定できない。`a2a version` で `0.2.0` と出ることを確かめる。
補助スクリプトは `node` で動くので、`node`（22 以降）も要る。

### token を発行する

呼び出し元ごとに、名前空間 `fraction-agents` の ServiceAccount がある（例 `owner`、`claude`。ADR 0003）。
呼ぶエージェントの設定の `allowedCallers` に、その ServiceAccount が入っている必要がある。

クラスタに入れる人が、audience `a2a` の期限つきの token を発行し、呼び出し元の手元のファイルに書く。
期限は 90 日を目安にする（apiserver の設定によっては、それより短く切り詰められる）。

```bash
mkdir -p -m 0700 ~/.config/fraction-agents/tokens
(umask 077; kubectl create token claude -n fraction-agents --audience a2a --duration 2160h \
  > ~/.config/fraction-agents/tokens/claude)
```

- token は画面に出さず、そのままファイルに書く。ファイルの権限は 0600（ディレクトリは 0700）にする。
  補助スクリプトは、所有者以外が読める token のファイルを使わずに断る。
- token のファイルを Git の管理下や、同期されるフォルダに置かない。
- 期限が来たら、同じ手順で発行し直して上書きする。

### 設定ファイル

補助スクリプトは、次の順で最初に見つかった場所の JSON を読む。

1. 環境変数 `FRACTION_AGENTS_CLIENT_CONFIG` のパス
2. `$XDG_CONFIG_HOME/fraction-agents/agents.json`
3. `~/.config/fraction-agents/agents.json`

| 項目 | 必須 | 意味 |
|---|---|---|
| `agents` | 必須 | エージェントの名前から設定への対応。名前は呼び出し元が付ける呼び名で、スキルの `agent <名前>` に使う |
| `agents.<名前>.url` | 必須 | エージェントの URL（汎用ホストの設定の `publicUrl`）。Agent Card はこの下の `/.well-known/agent-card.json` から取る |
| `agents.<名前>.tokenFile` | | このエージェントにだけ使う token のファイル。無ければ上の階層の `tokenFile` を使う |
| `tokenFile` | | 既定の token のファイル。呼び出し元の token は 1 つなので、普通はここに 1 つ書く |

`tokenFile` は、`~/` で始まればホームディレクトリから、相対パスなら設定ファイルのあるディレクトリから辿る。
設定ファイル自体に秘密は無いが、token は必ず別のファイルに置く。

例:

```json
{
  "tokenFile": "~/.config/fraction-agents/tokens/claude",
  "agents": {
    "wiki-keeper": { "url": "https://agents.example.test/wiki-keeper/" }
  }
}
```

### スキルを置く

スキルは、呼び出し元がスキルを探す場所に、ディレクトリごとリンクする。

- Claude Code: `~/.claude/skills/fraction-agents`
- Codex・Pi: `~/.agents/skills/fraction-agents`

```bash
ln -s <このリポジトリ>/skills/fraction-agents ~/.claude/skills/fraction-agents
```

補助スクリプトは単独でも使える。

```bash
node skills/fraction-agents/scripts/agent.mjs --list
node skills/fraction-agents/scripts/agent.mjs wiki-keeper send --async "この記事を取り込んで"
node skills/fraction-agents/scripts/agent.mjs wiki-keeper task get <task-id> --wait --timeout 5m
```

- URL と token は、環境変数 `A2ACLI_AGENT_CARD` と `A2ACLI_AUTH` で `a2a` に渡す。コマンド行には出ないので、`ps` やトランスクリプトに token が残らない。
  ほかの引数は、そのまま `a2a` に渡る。`a2a` の出力と終了コードも、そのまま返る。
- 補助スクリプトのテスト（`test/skill-agent.test.ts`）は `npm test` で走る。本物の `a2a` の代わりに、起動のされ方を記録する偽の `a2a` を使う。

## Pi パッケージ

`pi-package/` は、エージェントが共通で使う Pi の拡張をまとめた Pi パッケージである（ADR 0008）。
image の `/opt/fraction-agents/pi-package` に入り、エージェントは settings.json の `packages` にこのパスを書いて読む。
パッケージの版は image の版と同じになる。

| 拡張 | 中身 |
|---|---|
| `github-gate` | GitHub への書き込みの門番（ADR 0009）。agentDir に `github-gate.json` があるときだけ働く |
| `ask-caller` | 呼び出し元に質問するツール `ask_caller`。汎用ホストの「聞き返し」で `INPUT_REQUIRED` になる |
| `attach-image` | 返事に画像を添えるツール `attach_image`。汎用ホストの「画像の成果物」になる。ホストの外（`FRACTION_AGENTS_ARTIFACT_OUTBOX` が無いとき）では出ない |

### 画像を添える

`attach_image` は、次の引数で呼ぶ。

| 引数 | 必須 | 意味 |
|---|---|---|
| `path` | 必須 | 画像のファイル。相対パスなら作業ディレクトリから辿る |
| `description` | 必須 | 何の画像かを 1 行で。artifact の `description` になる |
| `name` | | 呼び出し元に見せる短いファイル名。省けばファイル自身の名前 |

- ツールは、その場で形式（中身で PNG・JPEG・WebP を判定）、大きさ（10 MiB まで）、枚数（8 枚まで）を確かめ、だめなら理由をモデルに返す。
- 呼んだ時点のファイルの中身を写すので、後でファイルを変えても返る画像は変わらない。シンボリックリンクは受け付けない。
- スクリーンショットは、まずファイルに撮ってから添える。エージェントの AGENTS.md に、いつ添えるかを書いておく。

### GitHub の門番

- GitHub への書き込みは、拡張の出す 3 つのツールだけで行う。
  - `github_push`: いまのブランチを push する。既定のブランチと、`branchPrefix` で始まらないブランチは push しない。force push はしない。
  - `github_pull_request`: push して、そのブランチの PR を作る。PR があれば、同じ PR に積んでタイトルと本文を更新する。1 つの context に 1 つの PR になる。
  - `github_merge`: 最新の既定のブランチを取り込んでから、PR をマージする。
    呼び出し元（`FRACTION_AGENTS_CALLER`）が `mergeCallers` にあるときだけ、ツールが登録される。
- push の前に、既定のブランチから分かれた後のブランチ全体の差分を見て、次のものがあれば push しない。
  - `appendOnlyPaths` の下の、既存のファイルの変更・削除（追加は許す）。名前の変更は、削除と追加として扱う
  - `readOnlyPaths` の下の、追加・変更・削除
- マージで既定のブランチを取り込むときの衝突
  - 衝突が `mechanicalConflictPaths` のファイルだけなら、マージを途中で止めてその旨を返す。エージェントが解消して `git add` し、もう一度呼べばマージする。
  - それ以外のファイルが衝突したら、取り込みをやめてブランチを元に戻し、マージしないで返す。
- PR がマージされた後や閉じられた後に同じ context で書き込むと、`<branchPrefix><contextId>-2` のような新しいブランチを最新の既定のブランチから作り、
  前回の push の後の commit だけを移して、新しい PR にする。
- `tool_call` のフックで、pi の組み込みのツールを止める。止めるのは次のものである。
  - `write`・`edit` による `readOnlyPaths` の下への書き込みと、`appendOnlyPaths` の下の既存のファイルへの書き込み
  - bash の `git push`・`gh pr merge`・マージの API の呼び出し、`rm`・`mv`・`sed -i`・リダイレクトなどで保護したパスを変えるコマンド

  これは二重の守りである。bash には GitHub の資格が無いので、これを迂回しても push はできない。
  逆に、コマンドの書き方を変えればフックは迂回できる（ADR 0009 で受け入れている）。
- `skillPaths` に書いた作業ディレクトリの中のスキル（例: `.claude/skills`）を pi に読ませる。

### GitHub App の token

- 拡張が、App の秘密鍵（`app.privateKeyFile`）で JWT を作り、installation token を発行する。
  token の対象は設定の 1 つのリポジトリだけで、権限は contents と pull requests の書き込みに絞る。
- token は pi のプロセスのメモリにだけ持ち、切れる 5 分前に発行し直す。
- git には、その 1 回の git のプロセスの環境変数（`GIT_CONFIG_*`）で Authorization のヘッダを渡す。
  pi の環境変数、bash、ファイル、git の設定には token を置かない。remote の URL にも資格は入れない。
- 秘密鍵のファイルは、同じコンテナの bash からも読める。鍵で自前の token を作れば門番を迂回できる。この穴は ADR 0009 で受け入れている。

### `github-gate.json`

agentDir に置く。秘密は置かない。例は `agents/wiki-keeper/github-gate.example.json`。

| 項目 | 必須 | 既定 | 意味 |
|---|---|---|---|
| `repository.owner`・`repository.name` | 必須 | | 書き込むリポジトリ |
| `repository.defaultBranch` | | `main` | 既定のブランチ |
| `repository.remoteUrl` | | `https://github.com/<owner>/<name>.git` | git の remote |
| `apiUrl` | | `https://api.github.com` | REST API |
| `app.appId`・`app.installationId`・`app.privateKeyFile` | 必須 | | GitHub App の ID、installation の ID、秘密鍵のファイル |
| `clone` | 必須 | | 永続の clone（bare）のパス。PVC の上に置く |
| `branchPrefix` | 必須 | | エージェントのブランチの接頭辞 |
| `commitIdentity.name`・`commitIdentity.email` | 必須 | | エージェントの commit の名前とメール |
| `appendOnlyPaths` | | `[]` | 追加だけを許すパス |
| `readOnlyPaths` | | `[]` | すべての変更を拒否するパス |
| `mechanicalConflictPaths` | | `[]` | マージの衝突をエージェントが解消してよいファイル |
| `mergeCallers` | | `[]` | `github_merge` を出す呼び出し元 |
| `mergeMethod` | | `merge` | `merge`・`squash`・`rebase` |
| `skillPaths` | | `[]` | pi に読ませる、作業ディレクトリの中のスキルのディレクトリ |

パスは、名前が `/` で終わっていてもいなくても、そのパス自身とその下のすべてを指す。

`github-gate.json` はあるが読めない（JSON でない、値が正しくない）とき、拡張は警告を出すだけで、GitHub のツールもフックも出さない。
pi は起動するので、`ask_caller` とログインは使える。エージェントに GitHub のツールが無いときは、この設定を疑う。
警告は pi の標準エラーに出て、汎用ホストのログ（`kubectl logs`）に `[pi <contextId の先頭 8 文字>]` を付けて残る。

### context ごとの worktree

`pi-package/bin/workspace.ts` は、汎用ホストの `contextWorkspace` から呼ぶコマンドである。

- `prepare <dir>`: 永続の clone が無ければ作り、fetch する。`<dir>` にその context の worktree が無ければ、
  context のブランチ（初めてなら `<branchPrefix><contextId>` を最新の既定のブランチから）で作る。あれば、そのまま残す。
- `remove <dir>`: worktree と、その context のローカルのブランチを消す。push したものは GitHub に残る。

設定の例:

```json
"contextWorkspace": {
  "prepare": ["node", "/opt/fraction-agents/pi-package/bin/workspace.ts", "prepare"],
  "remove": ["node", "/opt/fraction-agents/pi-package/bin/workspace.ts", "remove"]
}
```

## Wiki 管理人

`agents/wiki-keeper/` に、Wiki 管理人の agentDir の中身の雛形と、汎用ホストの設定の例を置く。
リポジトリの URL や App の ID など環境ごとの値は、private の overlay で渡す（ADR 0010）。詳しくは `agents/wiki-keeper/README.md`。

## Kubernetes に置く

manifest は kustomize で組む。このリポジトリには、どの環境でも使える base と、エージェントごとの kustomization を置く。
ホスト名、動かすエージェントの組、エージェントごとの設定は、環境ごとの overlay に置く（ADR 0010）。

### 構成

| ディレクトリ | 中身 |
|---|---|
| `deploy/base` | 汎用ホストで 1 エージェントを動かす雛形。StatefulSet（ボリュームは `volumeClaimTemplates`）・Service・ServiceAccount と、`system:auth-delegator` の ClusterRoleBinding。名前は仮の `agent` で、単体では動かさない |
| `deploy/agents/<エージェント>` | base の名前をエージェントの名前に付け替え、そのエージェントの設定とファイルを載せる。overlay はここを参照する |
| `agents/<エージェント>` | agentDir の中身（`AGENTS.md`・`settings.json`）と設定の例。`kustomization.yaml` がこれらを ConfigMap にする |

Wiki 管理人（`deploy/agents/wiki-keeper`）が出すもの:

| 種類 | 名前 | 中身 |
|---|---|---|
| StatefulSet・Service・ServiceAccount | `wiki-keeper` | StatefulSet は replicas 1 で、`serviceName` はこの Service。Service は port 80 をコンテナの `http`（8080）へ |
| PVC | `data-wiki-keeper-0` | StatefulSet の `volumeClaimTemplates`（`data`）から作られる。ReadWriteOnce・1Gi。StorageClass は書かない |
| ConfigMap | `wiki-keeper-agent-dir` | `AGENTS.md`・`settings.json`。その版の `agents/wiki-keeper/` のもの |
| ConfigMap | `wiki-keeper-config` | `config.json`（汎用ホストの設定）・`github-gate.json`（GitHub の門番の設定）。値は架空の例 |
| Secret（参照だけ） | `wiki-keeper-github-app` | GitHub App の鍵。manifest には入れず、手で作る |
| ClusterRoleBinding | `wiki-keeper-auth-delegator` | TokenReview のため（ADR 0003） |

Pod の中のパス:

| パス | 中身 |
|---|---|
| `/agent` | pi の agentDir。PVC の `agent/` で、書き込める。ログインで作る `auth.json` がここに残る |
| `/agent/AGENTS.md`・`/agent/settings.json` | ConfigMap `wiki-keeper-agent-dir` のファイル。読み取り専用 |
| `/agent/github-gate.json` | ConfigMap `wiki-keeper-config` のファイル。読み取り専用 |
| `/data` | ホストのデータ。PVC の `data/`。Task の記録、セッション、Wiki の clone（`/data/wiki.git`） |
| `/etc/fraction-agents/config.json` | ConfigMap `wiki-keeper-config` のファイル。読み取り専用 |
| `/var/run/secrets/github-app/private-key.pem` | Secret `wiki-keeper-github-app`。Secret が無くても Pod は起動する |

- コンテナは image の `node` ユーザー（UID 1000）で動く。PVC は `fsGroup` で書けるようにする。
  PVC の `agent/` と `data/` は、init container が `node` ユーザーで作る。
- agentDir のファイルは ConfigMap からファイルごと（subPath）に差し込む。ディレクトリごと差し込むと、agentDir が読み取り専用になり、
  `auth.json` を書けない。subPath の差し込みは ConfigMap の変更を追わないが、ConfigMap の名前に中身の hash が付くので、
  変更を適用すると Pod が作り直される。
- probe は `/healthz` を見る。

### overlay で決めるもの

overlay は、エージェントの kustomization を remote base で参照し、`?ref=v<版>` で版を固定する。
image の tag も同じ版にする。例（値は架空）:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: fraction-agents
resources:
  - github.com/yuanying/fraction-agents//deploy/agents/wiki-keeper?ref=v0.1.2
  - ingress.yaml
images:
  - name: ghcr.io/yuanying/fraction-agents
    newTag: 0.1.2
configMapGenerator:
  - name: wiki-keeper-config
    behavior: replace
    files:
      - config.json
      - github-gate.json
patches:
  - target: {kind: StatefulSet, name: wiki-keeper}
    patch: |-
      - op: add
        path: /spec/volumeClaimTemplates/0/spec/storageClassName
        value: standard
```

- 名前空間（`fraction-agents`）。base とエージェントの kustomization は名前空間を書かない。
- image の tag。base は tag を書かないので、overlay が必ず指定する。
- PVC の StorageClass と、backup に含めるか。StorageClass は、上の例のように StatefulSet の `volumeClaimTemplates` にパッチを当てて決める。
  `volumeClaimTemplates` は StatefulSet を作った後には変えられないので、最初の apply の前に決めておく（ADR 0011）。
- `wiki-keeper-config` の中身。`config.json` の `publicUrl` と `allowedCallers`、`github-gate.json` の全体。
- Ingress。Service の port 80 に向ける。
- 呼び出し元の ServiceAccount（`owner`・`claude`・`natsumi` など）。

### Deployment から移る

v0.1.1 までの base は、Deployment と別の PVC（`<エージェント>-data`）でエージェントを動かしていた（ADR 0011）。

- overlay の PVC へのパッチを、上の例のように StatefulSet へのパッチに書き換える。
- apply の前に、古い Deployment を消す（`kubectl delete deployment/wiki-keeper -n fraction-agents`）。残すと、同じ Service の後ろに 2 つの Pod が並ぶ。
- 新しい PVC `data-wiki-keeper-0` は空で始まる。ChatGPT Plus のログインはやり直す。
- 古い PVC `wiki-keeper-data` は apply では消えない。要らなくなったら手で消す。

### Secret を作る

GitHub App の鍵は Git にも kustomize にも入れず、手で Secret にする。

```bash
kubectl create secret generic wiki-keeper-github-app -n fraction-agents \
  --from-file=private-key.pem=/path/to/app.private-key.pem
```

- 鍵のキーは `private-key.pem` にする。`github-gate.json` の `app.privateKeyFile` は `/var/run/secrets/github-app/private-key.pem` を指す。
- Secret が無くても Pod は起動する。その間、push と PR の作成は失敗する。
- Secret を作った後、または鍵を差し替えた後は Pod を作り直す（`kubectl rollout restart statefulset/wiki-keeper -n fraction-agents`）。

### ChatGPT Plus にログインする

ログインは、エージェントの Pod の中で pi を対話で起動し、device code の方式で行う（ADR 0008）。

```bash
kubectl exec -it -n fraction-agents wiki-keeper-0 -- env PI_CODING_AGENT_DIR=/agent pi -ne
```

`-ne` で拡張を読まずに起動する。ログインに拡張は要らないので、拡張の設定や読み込みの具合に左右されずにログインできる。

1. pi の中で `/login` を開き、ChatGPT Plus（`openai-codex`）を選ぶ。
2. 方式は device code（headless）を選ぶ。表示された URL を手元のブラウザで開き、コードを入れる。
3. ログインが済むと、`/agent/auth.json` ができる。pi を終える。

- `auth.json` は PVC にあるので、Pod を作り直しても残る。ログインが切れたら同じ手順でやり直す。
- 対話の pi は、呼び出し元の依頼で動く pi と同じ agentDir を使う。ログインのほかの作業はしない。

### image

tag `v<版>` を push すると、GitHub Actions が `ghcr.io/yuanying/fraction-agents:<版>`（`v` を除いた版）を build して push する。
PR では build だけを確かめる。初めて push した package は private で作られるので、GitHub の画面で public にする。
