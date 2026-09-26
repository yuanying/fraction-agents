# 調べもの係（web-researcher）

頼まれたことをウェブで調べ、出典の URL を付けて短く答えるエージェントの定義（ADR 0013）。
検索は SearXNG、ページの取得は `@kvidzibo/pi-web-access`、読めないときと操作・スクリーンショットだけ headless の Chromium を使う。
汎用ホストに Chromium を足した image（Dockerfile の target `web-researcher`）で動く。

## ファイル

| ファイル | 置き場所 | 中身 |
|---|---|---|
| `AGENTS.md` | agentDir（`/agent`） | 振る舞い。道具の使い分け、ページの指示に従わないこと、読めなかったページの扱い、返事の形 |
| `settings.json` | agentDir | モデル（`openai-codex` の `gpt-6-sol`）、組み込みの道具を出さない（`defaultTools: []`）、読む Pi パッケージ |
| `web-research.example.json` | agentDir に `web-research.json` として | SearXNG の URL の例 |
| `config.example.json` | `/etc/fraction-agents/config.json` | 汎用ホストの設定の例。URL は架空 |

`kustomization.yaml` は、`AGENTS.md`・`settings.json` を ConfigMap `web-researcher-agent-dir` に、
2 つの例を ConfigMap `web-researcher-config` にする。`deploy/agents/web-researcher` がこれを読む。

## 道具

| 道具 | 出どころ | 中身 |
|---|---|---|
| `searxng_search` | fraction-agents の Pi パッケージ（`web-research`） | SearXNG の JSON の API で検索する |
| `report_unreadable` | 同上 | 読めなかったページを記録する |
| `fetch_content`・`get_search_content` | `@kvidzibo/pi-web-access` 0.1.1 | ページを取って Markdown にし、キャッシュから部分を引く |
| `agent_browser` など | `pi-agent-browser-native` 0.7.1（`agent-browser` 0.38.1） | headless の Chromium を操作する。スクリーンショットも撮る |
| `attach_image` | fraction-agents の Pi パッケージ | 画像を返事に添える（ADR 0012） |
| `ask_caller` | 同上 | 呼び出し元に聞き返す |

- 外の検索サービスに出る道具（`@kvidzibo/pi-web-access` の `web_search`、`pi-agent-browser-native` の `agent_browser_web_search`）は出さない。
  汎用ホストの設定の `piCommand` で pi に `--exclude-tools` を付けて外し、`web-research` の拡張も呼び出しを止める。
  デスクトップのアプリ用の `agent_browser_electron` も外す。
- pi の組み込みの道具（read・bash・edit・write など）は `settings.json` の `defaultTools: []` で出さない。

## `web-research.json`

agentDir に置く。秘密は置かない。無いときは `searxng_search` と `report_unreadable` が出ず、ほかの検索の道具の遮断もしない。

| 項目 | 必須 | 既定 | 意味 |
|---|---|---|---|
| `searxng.url` | 必須 | | SearXNG の検索の URL（`/search`）。`q` と `format=json` は道具が付ける。SearXNG の設定で JSON の形式を有効にしておく |
| `searxng.timeoutSeconds` | | `20` | 1 回の検索の時間の上限 |
| `searxng.maxResults` | | `10` | 1 回の検索で係に見せる結果の数の上限 |

読めない（JSON でない、値が正しくない）ときは、警告を出して道具を出さない。pi は起動する。

## 読めなかったページの数

タスクごとに、pi の標準エラーに次の形の 1 行を出す。汎用ホストのログに `[pi <contextId の先頭 8 文字>]` を付けて残る。

```
web-research: {"event":"unreadable-pages","contextId":"…","count":2,"pages":[{"url":"https://…","via":"fetch_content","reasons":["HTTP 403 Forbidden"]}]}
```

- `via` は、最後に読めないと分かった経路。`fetch_content`（取得の失敗）か `report`（係の記録）。
- 同じ URL は 1 つと数え、理由を並べる。

## image

`docker build --target web-researcher` で作る。汎用ホストの image に次を足す。

- Debian の Chromium と CJK のフォント
- `/opt/fraction-agents/web-researcher` に、上の 2 つの Pi パッケージと `agent-browser`。版は `images/web-researcher/package-lock.json` で固定する
- `agent-browser` の設定（`/home/node/.agent-browser/config.json`）: Chromium のパス、`--no-sandbox`、ページの文を境界の印で囲む
- `pi-agent-browser-native` の設定: 付属の web 検索を切る
- Chromium の管理ポリシー: `file://` と、分かりやすいクラスタの内部の名前を拒否する

Chromium は `node` ユーザーで動き、自分の sandbox は使わない（ADR 0013）。

## 環境ごとの値

private の overlay（ADR 0010）で渡す。

- `web-researcher-config` の `config.json` の `publicUrl` と `allowedCallers`
- `web-research.json` の `searxng.url`
- image の tag（`ghcr.io/yuanying/fraction-agents-web-researcher`）と、PVC の StorageClass

ログインは、Wiki 管理人と同じ手順を係の Pod で行う（README の「ChatGPT Plus にログインする」。Pod は `web-researcher-0`）。
