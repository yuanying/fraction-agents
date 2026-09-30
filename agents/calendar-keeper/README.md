# カレンダー係（calendar-keeper）

本人の Google Calendar の予定を調べ、本人に頼まれた予定を登録するエージェントの定義（ADR 0014）。
Google には、本人がカレンダーを共有したサービスアカウントで接続する。自分で登録した予定だけを変更・削除でき、招待は送らない。
汎用ホストの image で動く。

## ファイル

| ファイル | 置き場所 | 中身 |
|---|---|---|
| `AGENTS.md` | agentDir（`/agent`） | 振る舞い。日付の決め方、登録してよいとき（本人の依頼があるときだけ）、自分の予定だけ変えること、返事の形 |
| `settings.json` | agentDir | モデル（`openai-codex` の `gpt-6-sol`）、組み込みの道具を出さない（`defaultTools: []`）、読む Pi パッケージ |
| `calendar.example.json` | agentDir に `calendar.json` として | 鍵のパス・タイムゾーン・カレンダーの例。カレンダー ID は架空 |
| `config.example.json` | `/etc/fraction-agents/config.json` | 汎用ホストの設定の例。Agent Card の説明に、呼び出し元への頼み方を書く。URL は架空 |

`kustomization.yaml` は、`AGENTS.md`・`settings.json` を ConfigMap `calendar-keeper-agent-dir` に、
2 つの例を ConfigMap `calendar-keeper-config` にする。`deploy/agents/calendar-keeper` がこれを読む。

## 道具

| 道具 | 中身 |
|---|---|
| `calendar_now` | 今の日付・曜日・時刻とタイムゾーン。Google には問い合わせない |
| `calendar_list_calendars` | 使えるカレンダーの ID と名前、既定の登録先。共有されていないカレンダーはそう出る |
| `calendar_list_events` | 期間の予定を、カレンダーをまたいで開始順に並べる。予定ごとに、係が登録したもの（変えられる）かどうかを添える |
| `calendar_create_event` | 予定を登録する。係の印を付ける |
| `calendar_update_event` | 係の印のある予定だけを変える。渡した項目だけを変える |
| `calendar_delete_event` | 係の印のある予定だけを消す |
| `ask_caller` | 呼び出し元に聞き返す |

- すべて fraction-agents の Pi パッケージ（`calendar` と `ask-caller`）の道具である。ほかのパッケージは読まない。
- どの道具の結果も、先頭に今の日時とタイムゾーンの 1 行（`Now: 2026-09-30 (Wed) 14:03, time zone Asia/Tokyo (UTC+09:00)`）が付く。
  係の LLM は、これを基準に「明日」「来週の火曜」を決める。
- 日時は `YYYY-MM-DD`（終日）か `YYYY-MM-DDTHH:MM`（`calendar.json` のタイムゾーンの時刻）で渡す。`+09:00` のような時差も付けられる。
  終日の予定の `end` は最後の日で、Google に渡すときに翌日（Google の終わりは含まない日）に直す。
- 登録・変更・削除は、いつも `sendUpdates=none` で送り、`attendees` を渡さない。誰も招待せず、誰にも通知しない。
- 変更・削除の前に予定を取り、印（`extendedProperties.private` の `fractionAgentsCreatedBy: calendar-keeper`）が無ければ断る。
  AGENTS.md の指示だけに頼らず、道具の側で止める。
- `calendar.json` に書かれていないカレンダーは、ID を渡されても使わない。
- 繰り返しの予定は、回ごとに展開して並べる（`singleEvents`）。繰り返しの予定の登録はしない。
- pi の組み込みの道具（read・bash・edit・write など）は `settings.json` の `defaultTools: []` で出さない。鍵のファイルを読む道が無い。
- 画像を返す `attach_image` は要らないので、汎用ホストの設定の `piCommand` で `--exclude-tools` を付けて外す。

## `calendar.json`

agentDir に置く。秘密は置かない（鍵は別のファイル）。無いときは、カレンダーの道具が出ない。

| 項目 | 必須 | 既定 | 意味 |
|---|---|---|---|
| `serviceAccountKeyFile` | 必須 | | サービスアカウントの鍵（Google の出す JSON）のパス。Secret をマウントした場所を書く |
| `timeZone` | 必須 | | IANA のタイムゾーン（`Asia/Tokyo` など）。時差の無い時刻をこのタイムゾーンで読み、予定もこのタイムゾーンで見せる |
| `calendars` | 必須 | | 使うカレンダーの一覧。`id`（カレンダー ID）と `name`（係と呼び出し元に見せる名前。省けば ID）。1 つ以上 |
| `defaultCalendar` | | `calendars` の最初 | 登録先を言われなかったときのカレンダー ID。`calendars` のどれか |

- 読めない（JSON でない、値が正しくない）ときは、警告を出して道具を出さない。pi は起動する。
- 鍵のファイルは、token を取るたびに読む。Secret を差し替えれば、pi を起動し直さずに新しい鍵を使う。
  鍵が無い・読めないときは、道具が失敗する（鍵の中身はメッセージに出さない）。

## 認証

- 鍵で JWT（RS256）を作って Google の token のエンドポイントに出し、access token（1 時間）を取る。`node:crypto` で署名し、Google のライブラリは使わない。
  token は pi のプロセスのメモリにだけ持ち、切れる 1 分前に取り直す。
- scope は `calendar.events`（予定の読み書き）と `calendar.readonly`（カレンダーの名前を読む）。カレンダーの共有や設定は変えられない。
- ユーザーへのなりすまし（domain-wide delegation）はしない。サービスアカウントが触れるのは、本人が共有したカレンダーだけである。

## 本人がする準備（GCP と Google Calendar）

1. GCP のプロジェクトで Google Calendar API を有効にする。
2. サービスアカウントを作り、JSON の鍵を作ってダウンロードする。サービスアカウントにプロジェクトのロールは要らない。
3. Google Calendar の各カレンダーの「設定と共有」→「特定のユーザーまたはグループと共有する」に、サービスアカウントのメールアドレスを
   「予定の変更」の権限で加える。
4. 各カレンダーの「カレンダーの統合」にあるカレンダー ID を、`calendar.json` の `calendars` に書く。
5. 鍵を Secret にする（下の「配置」）。手元の鍵のファイルは消す。

## 配置

`deploy/agents/calendar-keeper` は Wiki 管理人と同じ形で、次が違う。

- 名前は `calendar-keeper`（PVC は `data-calendar-keeper-0`）。ConfigMap は `calendar-keeper-agent-dir`（`AGENTS.md`・`settings.json`）と
  `calendar-keeper-config`（`config.json`・`calendar.json`）。`calendar.json` は `/agent/calendar.json` に差し込む。
- image は汎用ホストの `ghcr.io/yuanying/fraction-agents`。
- 鍵は Secret `calendar-keeper-google` のキー `service-account.json` で、`/var/run/secrets/google/service-account.json` にマウントする。
  Secret が無くても Pod は起動し、その間、カレンダーの道具は失敗する。

```bash
kubectl create secret generic calendar-keeper-google -n fraction-agents \
  --from-file=service-account.json=/path/to/service-account-key.json
```

鍵を差し替えたときは、kubelet が Secret を Pod に同期した後（1 分ほど）、次の token から新しい鍵を使う。待てなければ Pod を作り直す。

## 環境ごとの値

private の overlay（ADR 0010）で渡す。

- `calendar-keeper-config` の `config.json` の `publicUrl` と `allowedCallers`
- `calendar.json` の全体。とくにカレンダー ID と、既定の登録先
- Secret `calendar-keeper-google`
- image の tag と、PVC の StorageClass

ログインは、Wiki 管理人と同じ手順を係の Pod で行う（README の「ChatGPT Plus にログインする」。Pod は `calendar-keeper-0`）。

## 呼び出し元へ

- 予定を登録・変更・削除してほしいときは、本人の依頼であることと、中身（日時・題名）を依頼文に書く（例「本人の依頼: 明日の 10 時から歯医者を入れて」）。
  書かれていない依頼や、会話から見つけた予定らしいものの登録は、係が `ask_caller` で聞き返す。
- 「明日」「来週の火曜」のような言い方は、そのまま渡してよい。係が今の日時から決める。
