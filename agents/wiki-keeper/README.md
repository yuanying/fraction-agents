# Wiki 管理人（wiki-keeper）

LLM Wiki を読み、変更を PR で出すエージェントの定義（ADR 0004・0008・0009）。汎用ホストの image で動く。

## ファイル

| ファイル | 置き場所 | 中身 |
|---|---|---|
| `AGENTS.md` | agentDir（`/agent`） | headless での振る舞い。確認せずに進め、確認の代わりに PR を出す。迷ったら `ask_caller` |
| `settings.json` | agentDir | モデル（ChatGPT Plus の経路、`openai-codex`）と、image に入った Pi パッケージの読み込み |
| `github-gate.example.json` | agentDir に `github-gate.json` として | GitHub の門番の設定の例。値は架空 |
| `config.example.json` | `/etc/fraction-agents/config.json` | 汎用ホストの設定の例。URL は架空 |

agentDir には、このほかにログインで作られる `auth.json` が置かれる（ADR 0008）。
`auth.json` は Pod の中でログインして作るので、ここには置かない。
agentDir は書き込める PVC にし、`AGENTS.md`・`settings.json`・`github-gate.json` はファイルごとに ConfigMap から差し込む。
pi は agentDir に設定のロックのファイル（`settings.json.lock`）も作るので、agentDir は書き込めなければならない。

`kustomization.yaml` は、`AGENTS.md`・`settings.json` を ConfigMap `wiki-keeper-agent-dir` に、
2 つの例を ConfigMap `wiki-keeper-config` にする。`deploy/agents/wiki-keeper` がこれを読む（README の「Kubernetes に置く」）。
kustomize は kustomization のディレクトリの下のファイルしか読めないので、ConfigMap はここで作る。

## 環境ごとの値

次の値は環境ごとに違い、public なこのリポジトリには書かない。private の overlay（ADR 0010）で渡す。

- `github-gate.json` の全体。とくに Wiki のリポジトリ（`repository`）、GitHub App の ID（`app.appId`・`app.installationId`）、
  bot の名前とメール（`commitIdentity`）
- GitHub App の秘密鍵。Secret にし、`app.privateKeyFile` のパスにマウントする
- 汎用ホストの設定の `publicUrl`

## 動き

- 汎用ホストは context ごとに `/data/work/<contextId>` で pi を動かす。その前に `contextWorkspace.prepare` が、
  PVC の永続 clone（`/data/wiki.git`）から、その context のブランチの worktree を作る。context を消すときは `remove` が片付ける。
- pi は Pi パッケージの拡張を読む。GitHub への書き込みは、拡張の出す `github_push`・`github_pull_request`・`github_merge` だけで行う。
  `github_merge` は、呼び出し元が `mergeCallers` にあるときだけ出る。
- GitHub App の token は、拡張が鍵から発行して、pi のプロセスのメモリにだけ持つ。bash の環境やファイルには置かない。
- スキルは、worktree の中の `.claude/skills`（Wiki のリポジトリのもの）を読む（`skillPaths`）。
- モデルの ID は Pi 0.87 の `openai-codex` の一覧から選んだ。Plus で使えるかは、ログインしてから確かめる。
