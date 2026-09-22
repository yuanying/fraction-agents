---
name: fraction-agents
description: >-
  fraction-agents の特化エージェント（Wiki 管理人など、Kubernetes で動く A2A のエージェント）に
  仕事を頼み、結果を受け取り、エージェントからの聞き返しに答える。a2a-cli を、エージェントの名前だけで、
  token を表に出さずに使う。
  Use when asked to delegate work to a fraction-agents agent (e.g. "Wiki 管理人に頼んで",
  "wiki-keeper に取り込ませて"), to list those agents, or to check, answer, continue or cancel
  a task sent to one of them.
compatibility: >-
  Requires the a2a command (a2a-cli v0.2.0) and node on PATH, and the caller's local config
  ~/.config/fraction-agents/agents.json with a token file. See the fraction-agents README.
license: MIT
metadata:
  source: https://github.com/yuanying/fraction-agents
  a2a-cli: "0.2.0"
---

# fraction-agents のエージェントを呼ぶ

fraction-agents のエージェントは、それぞれが A2A 1.0 で依頼を受ける独立したサービスである。
呼ぶには `a2a`（公式の a2a-cli）を使う。このスキルでは、`a2a` を直接は叩かず、
このスキルのディレクトリにある `scripts/agent.mjs` を通して呼ぶ。

```bash
node <このスキルのディレクトリ>/scripts/agent.mjs <エージェント名> <a2a の引数...>
```

以下では、これを `agent <エージェント名> ...` と略す。

`agent.mjs` は、呼び出し元の手元の設定（既定は `~/.config/fraction-agents/agents.json`）から、
名前に対応する URL と token を引く。どちらも環境変数（`A2ACLI_AGENT_CARD` と `A2ACLI_AUTH`）で `a2a` に渡すので、
`-a <URL>` も `--auth` も書かない。`a2a` の終了コードと出力は、そのまま返る。

## token の扱い（必ず守る）

token は、クラスタの外からエージェントを呼ぶための資格である。漏れると期限まで使える。

- `--auth`、`--svc-param Authorization=...`、`A2ACLI_AUTH=... a2a ...` のように、token をコマンド行に書かない。
- token のファイルを `cat` しない。`A2ACLI_AUTH` を `echo` しない。token を会話・ファイル・コミットに書き写さない。
- `agent.mjs` が token のファイルの権限を理由に断ったら、自分で直さず、ユーザーに伝える。
- 認証の失敗（`unauthenticated`、401、403）が続くときは、token の期限切れか、そのエージェントが自分を受け付けていない。
  ユーザーに token の発行し直しを頼む。自分で `kubectl create token` を実行しない。

## エージェントの一覧を見る

```bash
node <このスキルのディレクトリ>/scripts/agent.mjs --list   # 設定にある名前と URL
agent wiki-keeper card get                                # Agent Card（説明とスキル）
```

- 呼べるのは、設定に書いてあるエージェントだけである。無い名前は、一覧の名前と一緒に断られる。
- 何を頼めるかは Agent Card の説明とスキルを読んで決める。Agent Card は認証なしでも見える公開の情報である。

## 送る（すぐ戻る形）

```bash
agent wiki-keeper send --async "この記事を取り込んで: <URL や本文>"
```

- 必ず `--async` を付ける。エージェントの仕事は数分以上かかることがある。`--async` なしの `send` は既定 30 秒で時間切れになる。
- 出力の `Task:`（taskId）と `Context:`（contextId）を控える。`a2a` は何も覚えていないので、控えなければ後で取りに行けない。
- 依頼文だけで仕事が分かるように書く。エージェントは、あなたの会話もファイルも見えない。
  必要な URL・本文・条件は依頼文に入れる。
- 送れるのはテキストだけである。ファイルの部品（`--file-part`）やデータの部品（`--data-part`）は断られる。

## 結果を待って取る

```bash
agent wiki-keeper task get <taskId> --wait --timeout 5m
```

- 終わった（`completed`・`failed`・`canceled`・`rejected`）ところか、エージェントが聞き返してきた（`input-required`）ところで戻る。
- 5 分で終わらなければ、終了コード 5（`A2ACLI_ERR_TIMEOUT`）で戻る。Task は動き続けているので、同じコマンドをもう一度実行する。
  Bash の呼び出しに時間の上限がある環境では、`--timeout` をその上限より短くする。
- 待たずに今の状態だけを見るなら `--wait` を外す。

## 状態と結果の読み方

`a2a` の終了コードは「コマンドがちゃんと動いたか」だけを表す。エージェントの仕事が失敗しても、終了コードは 0 である。
仕事の結果は、出力の `Status:` で判断する。

| `Status:` | 意味 | すること |
|---|---|---|
| `submitted`・`working` | まだ動いている | `task get --wait` で待つ |
| `input-required` | エージェントが聞き返している。答えるまで止まっている | 次の行の質問を読み、「聞き返しに答える」に従う |
| `completed` | 終わった | `Artifacts:` の `response` がエージェントの返事（最後の発言）である |
| `failed` | 失敗した | 次の行に理由がある。モデルの呼び出しの失敗や、エージェントのプロセスの異常終了 |
| `canceled` | `task cancel` で止めた | |
| `rejected` | 受け付けられなかった | 次の行の理由を読む。多いのは「busy」と、答えを待っている Task がある場合（「busy のとき」） |

機械で読むときは `-o json` を付ける（`send` は `task` の下に、`task get` は Task そのものが出る。
状態は `status.state` の `TASK_STATE_COMPLETED` など、返事は `artifacts[].parts[].text`、
聞き返しの質問は `status.message.parts[].text`）。

`a2a` 自体が失敗したときの終了コード:

| 終了コード | 意味 |
|---|---|
| 1 | エージェントがエラーを返した（`TASK_NOT_FOUND`、知らない contextId、答えを待っていない Task への `--task-id` など）。認証の失敗もここに出る |
| 2 | 引数の誤り |
| 3 | 届かない（DNS、接続、TLS）。URL が正しいか、エージェントが動いているかを確かめる |
| 4 | Agent Card が取れない、または壊れている |
| 5 | `--timeout` の時間切れ |
| 127 | `a2a` が入っていない（`agent.mjs` が出す） |

## 同じ context で続ける

```bash
agent wiki-keeper send --async --context-id <contextId> "続けて、関連ページも直して"
```

- 同じ contextId で送ると、エージェントは前の会話を覚えたまま続ける。新しい Task が作られるので、その taskId を待つ。
- `--task-id` は続きの依頼には使わない。`--task-id` で送れるのは、`input-required` で答えを待っている Task への答えだけである
  （「聞き返しに答える」）。それ以外の Task に送るとエラーになる。
- contextId はエージェントが採番する。続けられるのは、自分が前に受け取った contextId だけである。
- しばらく（既定で 7 日）使わなかった context は消える。知らない contextId として断られたら、`--context-id` を外して新しく送る。
  前の文脈は残っていないので、要点を依頼文に書き直す。

## 聞き返しに答える

エージェントは、判断に迷うと依頼の途中で聞き返すことがある。そのとき Task は `input-required` になり、
`Status:` の次の行に質問が出る。`task get --wait` もここで戻る。Task はエージェントの側で止まったまま、答えを待っている。

1. 質問を読む。依頼の内容や手元の情報から自分で答えられるなら、答える。
2. 自分では決められないこと（ユーザーの好み、公開してよいか、どちらの案にするかなど）は、推測で答えず、ユーザーに聞いてから答える。
3. 同じ Task に答えを送る。新しい Task は作られず、エージェントは同じ会話の続きとして仕事を再開する。
4. 送ったら、同じ taskId を `task get --wait` で待つ。また聞き返されたら、1 から繰り返す。

```bash
agent wiki-keeper send --async --task-id <taskId> "ページ名は「A2A」にして"
agent wiki-keeper task get <taskId> --wait --timeout 5m
```

- 答えは、質問への返事だけでなく、それだけ読めば分かる文にする。
- 答えるのをやめるなら `task cancel <taskId>` で止める。放っておくと、既定で 1 日後に `failed` になる。
- 答えを待っている間、同じ context に新しい依頼は送れない（次の「busy のとき」）。

## busy のとき

1 つの context で同時に動く Task は 1 つだけである。前の Task が動いている間に同じ context へ送ると、
`Status: rejected` と「This context is busy with another task」で断られる。

1. 動いている Task を探す: `agent wiki-keeper task list --context <contextId> --status working`
2. それを `task get <taskId> --wait` で待つ。
3. 終わったら、同じ依頼をもう一度送る。

同じ context の Task が答えを待っている（`input-required`）ときは、`rejected` の理由に
「This context is waiting for an answer to task <taskId>」と、待っている taskId が出る。
その Task に `--task-id` で答えるか、`task cancel` で止めてから、依頼を送り直す。

文脈が要らない別の依頼なら、`--context-id` を外して新しい context で送ってよい。
続きの依頼を、busy を避けるために新しい context へ送ってはいけない（前の文脈が無いまま動いてしまう）。

## 止める

```bash
agent wiki-keeper task cancel <taskId>
```

ユーザーに頼まれたとき、または自分が誤った依頼を送ったときに使う。

## 成果物の URI

- いまのエージェントは、結果をテキスト（`response`）で返す。ファイルの URI は返さない。
- 将来、結果に URI が入ってきたら、その取得にも同じ token が要る。token をコマンド行に書いて取りに行かず、ユーザーに伝える。
- URI に token や署名が付いている（クエリに `token=` などがある）ときは、その URI を会話・ファイル・コミットに書き写さない。

## 公式の a2a-cli スキルとの関係

a2a-cli は、汎用の Claude Code 向けスキル（`a2a-cli`）を配っている。このスキルは、それを参考にして、
fraction-agents を呼ぶ場合に置き換えるものである。違いは次のとおり。

- URL と token を名前から引く。token をコマンド行に出さない。
- 送信は必ず `--async` にし、`task get --wait` で取りに行く。
- 続きの依頼は `--context-id` で送る。`--task-id` は、聞き返し（`input-required`）への答えにだけ使う。busy の扱いがある。
