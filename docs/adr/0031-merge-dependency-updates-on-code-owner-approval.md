# 0031. 依存の更新は、コードオーナーの承認で GitHub がマージする

- Date: 2026-11-04
- Status: Accepted

## Context

ADR 0024 は、パッチ・ダイジェスト・pin の更新を、PR の検査が通ったら Renovate が自分でマージすると決めた。minor と major は、人がマージする。

Renovate が自分でマージするのは、次にこのリポジトリを走査したときだけである。Renovate は Mend がホストする GitHub App で動いており、走査の間隔はこちらでは決められない。検査が PR を開いた数分後に通っても、マージは次の走査まで待つ。同じ App で動く持ち主の別のリポジトリでは、検査が通ってから半日以上マージされない PR があった。

届いた更新は、持ち主のオペレーターの agent（GitHub のアカウント `penelope-the-operator`）が差分と検査を確かめ、承認している。minor と major では、その承認のあとに人がマージを押すまで main に入らない。マージしてよいかの判断は承認で済んでいて、その後の手作業は判断を伴わない。

ADR 0024 は、リポジトリの設定（auto-merge の許可、branch protection）を使わず、変えないとしていた。

## Decision

### 更新には GitHub の auto-merge を予約し、main のルールセットで止める

Renovate は、PR を開いたときに、すべての更新に GitHub の auto-merge を予約する。minor と major も含む。マージを止めるのは Renovate ではなく、main のルールセットである。ルールセットは、マージに次のすべてを求める。

- main への変更は PR を経る
- コードオーナーの承認が 1 つある。コードオーナーは持ち主とオペレーターの agent で、`.github/CODEOWNERS` に書く
- 承認のあとにコミットが push されたら、その承認は取り消される
- test のワークフローと、image のワークフローの 4 つの image の build が通っている

これらが揃った時点で GitHub がマージする。Renovate の走査は待たない。

検査をルールセットで求めるのは、GitHub の auto-merge が、求められていない検査を待たずにマージするからである。どちらのワークフローも `paths` で絞っておらず（ADR 0024）、どの PR にも求めた検査が付く。係の image を足したり外したりしたときは、ルールセットが求める build もそれに合わせる。

### 迂回できるのは持ち主だけにする

ルールセットを迂回できるのは持ち主だけとする。持ち主の変更を、承認を待たずに入れられるようにするためである。Renovate の GitHub App と、vuln-responder の bot は迂回できない。どちらの PR も承認を経てマージされる。

### 個別の依存は、automerge を切れば人のマージに残せる

依存によっては、承認のあとも人がマージを決めたい場合がある。そうした依存は `renovate.json` の packageRules で automerge を切る。その PR には auto-merge が予約されず、従来どおり人がマージする。

### ADR 0024 の Decision「パッチ・ダイジェスト・pin は Renovate が自分でマージする」を置き換える

更新のマージは、本 ADR の決定に従う。ADR 0024 のそれ以外の Decision（週に一度のパッチ版、tag の打ち方）は変えない。

### 本 ADR で決定しないこと

- オペレーターの agent が、承認の前に何を確かめるか（委譲先: オペレーターの agent の運用）
- 共有の Renovate の設定の中身（委譲先: yuanying/renovate-config の README）

## Consequences

承認された更新は、Renovate の走査を待たずに main に入る。

minor と major も、承認されれば人がマージを押さずに main に入る。ADR 0024 の週に一度のリリースは作者が `renovate[bot]` かどうかだけを見るので、依存の major の上げだけの週も、パッチ版として出る。

オペレーターの agent が承認しなければ、どの更新もマージされない。パッチ版も止まる。ADR 0024 のもとでは、検査が通れば誰も見なくてもマージされていた。人の目を通すことを、マージの速さより優先した。

承認は push のたびに取り消されるので、Renovate がブランチを rebase すると承認をやり直すことになる。古いコミットへの承認でマージされることは無い。

持ち主以外の人の変更も、承認を要するようになる。持ち主は迂回できるので、持ち主の手順は変わらない。

マージを押すのが GitHub になっても、マージされたコミットの作者は `renovate[bot]` のままであることを前提にしている。作者が変われば、ADR 0024 の判定はそれを人のコミットとして数え、週に一度のリリースは出ない側に倒れる。

## 関連 ADR

- [[0024-automerge-and-weekly-release-of-renovate-updates]] — 本 ADR は、その Decision「パッチ・ダイジェスト・pin は Renovate が自分でマージする」を置き換えた。それ以外の Decision は残る
- [[0018-dependency-updates-with-renovate]] — Renovate に依存の更新を追わせること
- [[0029-release-vulnerability-fixes-on-merge]] — vuln-responder の PR も、このルールセットの承認を経てマージされる

## References

- Renovate Docs「Configuration Options」の `platformAutomerge`（https://docs.renovatebot.com/configuration-options/#platformautomerge 、2026-11-04 確認）。GitHub の auto-merge を使う場合は、マージ前に求める検査を設定しないと、テストが通る前でもマージされうる。auto-merge を使えないときは、Renovate 自身のマージに戻る
- yuanying/fraction-agents のリポジトリ設定とルールセット `main: code owner approval`（2026-11-04 確認）
