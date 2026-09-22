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
- 1 つの Task は、pi への 1 回の prompt である。
  - 最後の assistant の文を、`response` という名前の artifact として返す。
  - モデルの呼び出しが失敗したら `FAILED`、pi が途中で終了したら `FAILED`、CancelTask で止めたら `CANCELED` になる。
  - Task は追加の入力を待たない。続きは、同じ contextId で新しいメッセージを送る。taskId を指定したメッセージは受け付けない。
- 結果は、`returnImmediately` ですぐ返してから GetTask で取りに行く使い方を基本とする。ストリーミングと push 通知は出していない。
- Task と context の記録は SQLite に持つので、ホストを再起動しても GetTask と ListTasks で取れる。
  再起動の時点で走っていた Task は `FAILED` にする。ListTasks は呼び出し元の Task だけを返す。

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

ホストが pi に渡すもの（ホスト自身の環境変数に加えて渡す）:

| 変数 | 意味 |
|---|---|
| `PI_CODING_AGENT_DIR` | 設定の `agentDir` |
| `FRACTION_AGENTS_CALLER` | その context の呼び出し元の名前（`system:serviceaccount:<namespace>:<name>`）。Pi の拡張は、これを見て呼び出し元ごとに振る舞いを変えられる |

ホストの環境変数はそのまま pi に引き継がれる。pi が使うモデルの資格を環境変数で与えると、pi はそれを使う。
エージェントに渡さない資格は、ホストの環境にも置かない。

### 起動

ビルドして起動する:

```bash
npm ci
npm run build
node dist/src/main.js --config /path/to/config.json
```

TokenReview を呼ぶので、Kubernetes の Pod の中で動かす前提である。

image は `Dockerfile` で作る。Node 24 の slim に、このホストと `@earendil-works/pi-coding-agent` 0.87.0（`pi` のコマンド）を入れる。
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
