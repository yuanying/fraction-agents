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

## Pi パッケージ

`pi-package/` は、エージェントが共通で使う Pi の拡張をまとめた Pi パッケージである（ADR 0008）。
image の `/opt/fraction-agents/pi-package` に入り、エージェントは settings.json の `packages` にこのパスを書いて読む。
パッケージの版は image の版と同じになる。

| 拡張 | 中身 |
|---|---|
| `github-gate` | GitHub への書き込みの門番（ADR 0009）。agentDir に `github-gate.json` があるときだけ働く |
| `ask-caller` | 呼び出し元に質問するツール `ask_caller`。汎用ホストの「聞き返し」で `INPUT_REQUIRED` になる |

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
