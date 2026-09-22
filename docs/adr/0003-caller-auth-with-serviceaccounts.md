# 0003. 呼び出し元の認証は ServiceAccount と TokenReview で行う

- Date: 2026-09-22
- Status: Accepted（「公開の範囲」の「LAN の中だけに公開する」は ADR 0006 で置き換えた）

## Context

ADR 0001 で、エージェントは A2A で呼ばれる独立したサービスになった。
呼び出し元は、本人、本人が使う Claude、なつみである。エージェントは誰が呼んだかを知り、
呼び出し元ごとに許すことを変える必要がある（例えば Wiki 管理人のマージ。ADR 0004）。

呼び出し元には、クラスタの中にいるものと外にいるものがある。
なつみは当面クラスタの外のコンテナで動き、Claude は本人の開発機や Mac で動く。
なつみは将来クラスタに移る。

クラスタでは、NetworkPolicy がまだ効いていない。クラスタの中の他の Pod からエージェントに届く穴は、ネットワークでは塞げない。

呼び出し元ごとに固定の bearer token を発行し、表にして Secret で配る方式も考えた。
しかしこの方式では、token の発行・配布・失効をエージェントの側で持つことになり、エージェントを増やすたびに表を配り直す。
Kubernetes には、ServiceAccount の token を発行し、その正しさを API で確かめる仕組みが既にある。

## Decision

### 呼び出し元は ServiceAccount で表す

- 呼び出し元ごとに ServiceAccount を作る。例えば `owner`（本人）、`claude`、`natsumi`。
- 呼び出し元は、audience を `a2a` にした ServiceAccount の token を bearer token として送る。
- エージェントは、受け取った token を TokenReview（audience `a2a`）で確かめる。
  - 通れば、`system:serviceaccount:<namespace>:<name>` を呼び出し元の名前とし、ログに残す。
  - TokenReview を使うため、エージェントの ServiceAccount に `system:auth-delegator` を与える。
- どの ServiceAccount を受け付けるかは、エージェントごとの設定とする。
- Agent Card の securitySchemes に、bearer token で認証することを書く。
- 成果物の URI（ADR 0001）の取得にも、同じ認証を掛ける。

### audience を分ける

- エージェント向けの token の audience は `a2a` とし、Kubernetes の apiserver の audience とは分ける。
- apiserver は `a2a` の token を受け付けない。エージェントが受け取った token を使って apiserver を操作することはできない。

### クラスタの外の呼び出し元

- クラスタの外の呼び出し元（クラスタの外のなつみ、本人の開発機や Mac の `owner`・`claude`）には、
  `kubectl create token` で発行した期限つきの token（audience `a2a`、期限は 90 日を目安）をコピーして渡す。
- legacy の Secret 型の ServiceAccount token（期限の無いもの）は使わない。
- 期限が来たら発行し直す。
- なつみがクラスタに移れば、projected token に切り替える。コピーは要らなくなる。

### 公開の範囲

- エージェントは LAN の中だけに公開する。
- NetworkPolicy が効くまでの間、クラスタの中の他の Pod から届く穴は、この認証で塞ぐ。

### なつみの受け口

- なつみの受け口も同じ方式で、送り手ごとの ServiceAccount で分ける。細部はなつみの側で決める。

## Consequences

- token の発行と失効を Kubernetes に任せられる。エージェントは token の表を持たない。
- 呼び出し元の追加は、ServiceAccount を作り、受け付けるエージェントの設定に足すだけで済む。
- 呼び出し元の名前が認証から得られるので、依頼文の中の名乗りに頼らずに、呼び出し元ごとの許可を決められる。
- エージェントは、依頼のたびに apiserver に TokenReview を問い合わせる。apiserver が止まると、エージェントは依頼を受けられない。
- クラスタの外の呼び出し元の token は、コピーした先に期限まで残る。漏れれば期限まで使える。期限が来るたびに手で発行し直す必要がある。
- apiserver が `a2a` を自分の audience として受け付けない設定であることが前提になる。apiserver の設定を変えるときは、この前提を崩さないか確かめる。
