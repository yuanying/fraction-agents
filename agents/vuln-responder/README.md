# 脆弱性への対応の係（vuln-responder）

本番のイメージの脆弱性を分析し、fleet-infra に OpenVEX の注釈の PR を出すエージェントの定義（ADR 0028）。
汎用ホストの image で動き、GitHub への書き込みは github-writer の sidecar（ADR 0027）に頼む。

## ファイル

| ファイル | 置き場所 | 中身 |
|---|---|---|
| `AGENTS.md` | agentDir（`/agent`） | 依頼の形、分析の手順、状態の選び方、VEX の書き方、PR の本文、外の文章の扱い |
| `settings.json` | agentDir | モデルと、image に入った Pi パッケージの読み込み |
| `github-writer.example.json` | agentDir に `github-writer.json` として（sidecar にも同じもの） | 書いてよいのは fleet-infra の `security/vex/` だけ。ブランチは `vuln-responder/`。context ごとの worktree の置き場と commit の名義 |
| `config.example.json` | `/etc/fraction-agents/config.json` | 汎用ホストの設定の例。呼び出し元、同時 1 件、60 分、worktree の command |

`kustomization.yaml` は、`AGENTS.md`・`settings.json` を ConfigMap `vuln-responder-agent-dir` に、
2 つの例を ConfigMap `vuln-responder-config` にする。`deploy/agents/vuln-responder` がこれを読む。

## 環境ごとの値

private の overlay（ADR 0010）で渡す。

- `config.json` の `publicUrl`
- `github-writer.json` の `workspace.commitIdentity`。App の bot の名前とメール（`<slug>[bot]`、`<bot の user ID>+<slug>[bot]@users.noreply.github.com`）にする
- GitHub App の秘密鍵。Secret `vuln-responder-github-app`（キー `private-key.pem`）を手で作る。git に置かない

App の ID（5493557）と installation の ID（175776468）は秘密ではないので、例にそのまま書いている。
App は fleet-infra だけにインストールされ、権限は Contents と Pull requests の write、Metadata の read だけである。

## 動き

- 汎用ホストは context ごとに `/data/work/<contextId>` で pi を動かす。その前に workspace の command が、
  github-writer の mirror を追う永続の clone（`/data/repos/yuanying/fleet-infra.git`）から、
  `/data/work/<contextId>/yuanying/fleet-infra` に context のブランチ（`vuln-responder/<contextId>`）の worktree を作る。
- ソースのリポジトリは、エージェントが作業ディレクトリに public の GitHub から clone する。
  context は対象ごとに 1 つなので、同じ対象の次の依頼は同じ clone を使う。
- 聞き返しの道具（`ask_caller`）は外している。呼び出し元はプログラムで、答えられない。
- 同時に走るのは 1 件まで（`maxConcurrentTasks`）、1 件は最長 60 分（`taskTimeLimitSeconds`）。

## 直す PR を有効にするとき

ADR 0028 の「直す PR を有効にするとき」に書いた。github-writer の設定にリポジトリと path の規則を足し、
App のインストール先を広げ、AGENTS.md の「まだ出さない」を改める。
