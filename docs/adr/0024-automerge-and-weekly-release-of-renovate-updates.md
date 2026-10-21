# 0024. Renovate のパッチ等は CI が通れば自動でマージし、Renovate の変更だけなら週に一度リリースする

- Date: 2026-10-21
- Status: Accepted

## Context

依存の更新は Renovate が PR にする（ADR 0018）。PR は届くが、マージもリリースも人の手に残っていた。
パッチ版やダイジェストの更新は数が多く、どれも test と image のワークフローが確かめる以上の見方をしていない。
マージしても、tag を打つまでは image に入らず、環境にも届かない。

一方で、機能の変更を含むリリースは、何を入れたかを tag のメッセージに書いて人が出している。
依存の更新のためにリリースを自動にしても、人の変更を勝手に出してはいけない。

リポジトリの設定（auto-merge の許可、branch protection）は使っておらず、変えない。

## Decision

### パッチ・ダイジェスト・pin は Renovate が自分でマージする

`matchUpdateTypes` が `patch`・`digest`・`pin`・`pinDigest` の PR は `automerge` にする。minor と major は PR が開くだけで、人がマージする。

`platformAutomerge` は切る。GitHub の auto-merge に任せず、Renovate が PR の検査の結果を見て、通っていればマージする。
検査が一つも無いブランチを Renovate は「待ち」とみなしてマージしないので、CI の無い PR は自動でマージされない。`ignoreTests` は使わない。

検査は test のワークフロー（型検査・テスト・build・manifest の展開）と image のワークフロー（4 つの image の build）である。
どちらも `paths` で絞っておらず、Renovate が書き換えうるどのファイルの PR でも走る。

### Renovate の変更だけなら、週に一度パッチ版を出す

`release` のワークフローが月曜 09:00 JST（と手での起動）に、既定ブランチの HEAD で次の 2 つを確かめる。

1. HEAD から届く最新の `vX.Y.Z` のタグ（3 つの数字の形のものだけを版として比べる）から HEAD までの、マージ以外のコミットの作者がすべて `renovate[bot]` である。
2. その間に `.github/` と `renovate.json` 以外のファイルの変更がある。

両方を満たすときだけ `vX.Y.(Z+1)` を出す。満たさなければ理由をログに出して、何もせずに成功で終わる。
人のコミットが一つでも入っていれば、そのリリースは人が中身を書いて出すものなので、自動では出さない。
Workflow と Renovate の設定だけの変更は image にも manifest にも入らないので、出さない。

判定は `.github/release/plan.ts` にあり、`test/release-plan.test.ts` が一時的な git のリポジトリで確かめる。

### tag は注釈つきで、image を push してから打つ

自動の tag も、手の tag と同じく注釈つきにする。メッセージは `vX.Y.Z: 依存の更新（Renovate）` と、含まれるコミットの subject の一覧である。

`GITHUB_TOKEN` で push した tag では、ほかのワークフローが動かない。そこで `release` のワークフローは、image のワークフローを `workflow_call` で呼んで、
同じ run の中で image を build して push し、それが済んでから tag を打つ。push に失敗すれば tag は残らない。
手で tag を push したときは、これまでどおり image のワークフローが動く。

image のワークフローは、PR で build だけするジョブと、push するジョブに分けた。`packages: write` は push するジョブだけが持つ。

## Consequences

パッチ版の依存の更新は、人が何もしなくても、遅くとも次の月曜には image の新しい版になる。
環境で使う版は overlay が決める（ADR 0010）ので、新しい版を環境に入れるのは overlay を持つリポジトリの役目のままである。

人のコミットが入った後は、人がリリースするまで自動のリリースは出ない。この ADR を入れたコミット自身も人のものなので、入れた直後も同じである。
自動のリリースを止めたいときは、`release` のワークフローを無効にすればよい。

自動でマージされる PR を確かめるのは CI だけになる。CI が確かめないこと（image の中で実際に係が動くか）は、リリースの後で環境に入れるときに確かめる。

## 関連 ADR

- [[0018-dependency-updates-with-renovate]] — Renovate に依存の更新を追わせること
- [[0010-manifest-base-and-private-overlay]] — 環境で使う版を overlay が決めること
