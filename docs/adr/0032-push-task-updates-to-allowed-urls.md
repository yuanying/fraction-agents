# 0032. 係は Task の状態の変化を A2A の push で送り、送り先は設定で許した URL に限る

- Date: 2026-11-04
- Status: Accepted

## Context

呼び出し元は、係に依頼を `returnImmediately` で送り、GetTask を繰り返して返事を取りに行く（README の「汎用ホスト」）。
なつみは、頼んだ係の Task を一定の間隔で poll している。間隔を詰めれば返事は早く届くが、そのぶん GetTask が増える。
間隔を広げれば、係が終わってからなつみが気づくまでが延びる。

本人となつみの側で、係から A2A の push を受け、それを「呼び鈴」として使うと決めた。なつみの側の取り決めは次のとおりである。

- なつみは、自分の公開の受け口の URL を設定に持ち、相手の Agent Card が `capabilities.pushNotifications: true` のときだけ、依頼に push の設定を付ける。
- push の設定は、SendMessage の `configuration.taskPushNotificationConfig` に入れる。
  - `url` は、なつみの受け口の固定の URL である。Task の ID は送る時点で分からないので、URL に入れない。
  - `authentication` は `{ scheme: "Bearer", credentials: <依頼ごとのランダムな token> }` である。
  - 古い形の `token`（`X-A2A-Notification-Token` で送られる）は使わない。
- なつみは push の本文を読まない。`Authorization` の token で待っている Task を引き、その Task の GetTask を 1 回すぐ走らせる。知らない token は 401 を返す。
- poll は保険として残し、push を付けた Task では poll の間隔を広げる。push が来なくても、poll で拾う。Task が終われば、その token は捨てる。

係の側の今の状態は次のとおりである。

- Agent Card は `capabilities.pushNotifications: false` である（`src/agent-card.ts` の `buildAgentCard`）。
- 依頼の口の前に立つ `ContextGuardHandler`（`src/handler.ts`）は、push の設定の API（作る・取る・並べる・消す）を、SDK の `DefaultRequestHandler` に素通ししている。
  SDK は Card が `pushNotifications: false` のとき、SendMessage に付いた push の設定を黙って捨て、push の設定の API は `PushNotificationNotSupportedError` で断る。
- 依頼の口は、Agent Card と `/healthz` を除き、`allowedCallers` に挙げた呼び出し元しか通さない（ADR 0003・0030）。
- Task は SQLite に持ち、再起動しても GetTask で取れる。再起動の時点で終わっていなかった Task は、起動時に `FAILED` にする（`src/store.ts` の `SqliteTaskStore.failUnfinished`）。

`@a2a-js/sdk` 1.3.0 の push の送り手（`DefaultPushNotificationSender`）を読んで分かったことは次のとおりである。

- Card が `pushNotifications: true` なら、`DefaultRequestHandler` は送り手と、push の設定の保存先（既定はメモリの `InMemoryPushNotificationStore`）を自分で作る。
- SendMessage に push の設定があれば、executor を動かす前に、その Task の設定として保存する。保存先は呼び出し元ごとに分かれ、ほかの呼び出し元の設定は見えない。
- 要求の処理の中で起きた出来事（Task・状態の変化・artifact）ごとに、その Task の保存された設定のすべてへ POST する。
  本文は v1.0 の `StreamResponse` の JSON で、`Content-Type` は `application/a2a+json` である。
  - `authentication` があれば `Authorization: <scheme> <credentials>` を付ける。無く `token` だけがあれば `X-A2A-Notification-Token` に入れる。
  - 既定の timeout は 5 秒である。送り直さない。失敗は log に出し、依頼の処理には返さない。
  - 送り先の URL を確かめない。リダイレクトも辿る（`fetch` の既定）。
- 送り先の URL は呼び出し元が決める。何も制限しなければ、呼び出し元は係に、係の Pod から届く任意の URL（クラスタの中の Service、メタデータの口など）へ POST させられる（SSRF）。
- input-required の Task に答える SendMessage に push の設定が付いていれば、既にある設定に足される（ID が空なら新しい ID が振られる）。古い設定は残り、古い token にも送り続ける。
- 終わった Task の設定は、保存先から消えない。

この係の executor は、1 つの依頼で、`SUBMITTED` の Task、`WORKING`、返事の artifact（画像があればその数だけ）、`COMPLETED` の順に出来事を出す（`src/executor.ts`）。

## Decision

### 適用範囲

汎用ホストで動くすべての係に当てる。係ごとの差は設定だけで付ける。
streaming（`sendMessageStream`・`resubscribe`）は出していないので、この ADR は SendMessage と push の設定の API だけを扱う。

既存の ADR との関係は次のとおりである。

- ADR-0007 の Decision「結果の受け取り方」（最初は、ポーリングだけを出す）に、push を足す。poll で取る道はそのまま残り、push は poll の代わりではない。
- ADR-0003 の Decision「なつみの受け口」（送り手ごとの ServiceAccount で分ける）は、係が自分から送り手としてなつみに送る口の決定である。
  この ADR の push は、呼び出し元が依頼ごとに渡した token で、その依頼の Task について返すものなので、ServiceAccount の token を使わず、その決定には当たらない。

### push は、送り先を設定で許した係だけが受ける

- 設定に、push の送り先として許す URL の接頭辞の並びを足す。どの係でも任意とする。
- 書いた係は、Agent Card を `capabilities.pushNotifications: true` にし、push の設定を受ける。
- 書かない係は、今までどおり `pushNotifications: false` のままで、push の設定を受けない。SDK の振る舞い（SendMessage の設定は捨てる、設定の API は断る）もそのままにする。
- 本人の環境では、すべての係にこの設定を書く。どの値を書くかは環境の overlay で決める（ADR 0010）。

Card の値を設定から決めるのは、Card が `true` なのに送り先を何も許していない係を作らないためである。
そうした係では、push を付けた依頼はすべて push を外されて受けられる（下の「許していない送り先の扱い」）。Card が、係の実際の受け方と食い違う。

### 送り先の確かめ方

- 許す接頭辞は、それぞれが scheme・ホスト名・ポート・パスを持つ絶対 URL である。設定を読むときに、次のどれかに当たれば起動しない。
  - URL として読めない。
  - scheme が `https` でない。`Authorization` に依頼ごとの token を載せて送るので、平文の道に出さない。
  - ユーザー名・パスワード・クエリ・フラグメントを含む。
- push の設定の `url` は、次をすべて満たすときだけ許す。
  - URL として読め、ユーザー名・パスワードを含まない。
  - scheme・ホスト名・ポートが、いずれかの接頭辞と一致する。ホスト名は文字列の前方一致で比べない（`https://a.example` が `https://a.example.evil.test` を許さないようにする）。
  - パスが、その接頭辞のパスと同じか、その下にある（区切りの `/` の単位で比べる）。
- 名前の解決の結果（IP アドレス）は確かめない。許したホスト名が何を指すかは、環境の DNS と設定を書く人に任せる。
- push を送るときは、リダイレクトを辿らない。3xx の応答は送り損ねとして扱う。許したホストが別の URL へ転送しても、係はそこへ送らない。

### 許していない送り先の扱い

push の設定を受ける係は、次の push の設定を受けない。

- `url` が許した送り先に当たらない。
- `authentication` が無い、`scheme` が `Bearer`（大文字・小文字は問わない）でない、または `credentials` が空である。

受けないときの扱いは次のとおりである。

- SendMessage に付いていれば、push の設定だけを外して依頼を受ける。依頼は push の無い依頼として進み、呼び出し元は poll で返事を拾う。
  外したことは、Task の ID・呼び出し元・外した理由（送り先が許されていない、認証が無い）を log に出す。`credentials` と、許している接頭辞は log に出さない。
- push の設定の API（作る）で来たら、その呼び出しを断る。この呼び出しは push の設定を付けることだけが目的なので、外して受ける中身が残らない。依頼そのものには触れない。

理由は次のとおりである。

- なつみは、自分の設定（公開の URL）と相手の Card だけを見て push を付ける。断ると、なつみの公開の URL と係の許す接頭辞の食い違いのような設定の誤りだけで、なつみの依頼がすべて失敗する。
  push は呼び鈴であり、無くても poll で返事は届く。push の設定が誤って有効になっても依頼を壊さない側に倒す。
- 外しても、許していない送り先へは何も送らない。守る対象（係の Pod から届くクラスタの中の口）は、断る場合と同じく守られる。
- `authentication` の無い設定を受けると、係は呼び出し元の受け口へ認証なしの POST を送る。なつみは 401 で捨てるだけなので、送っても意味が無い。

### 認証は `authentication` の Bearer だけを使う

- 送る `Authorization` は、呼び出し元が `authentication` に入れた `scheme` と `credentials` をそのまま使う。係は自分の秘密を足さない。
- 古い形の `token` は扱わない。`authentication` があれば SDK は `token` を使わないので、`token` が付いていても無視される。`token` だけの設定は、上の「許していない送り先の扱い」で受けない。
- `credentials` は log に出さない。送り先の URL と Task の ID と、失敗の理由だけを出す。

### push の設定を付けられるのは、確かめた呼び出し元だけ

- push の設定は、依頼の口の認証（Bearer の TokenReview か gated のアサーション。ADR 0003・0030）と `allowedCallers` を通った要求でだけ受ける。新しい入口は作らない。
- 設定は呼び出し元ごとに分けて持ち、ほかの呼び出し元の Task には付けられず、ほかの呼び出し元の設定は取れない。Task の持ち主の判定（ADR-0007 の Decision「contextId と Task の持ち主」）と同じ呼び出し元の名前を使う。
- 許した送り先にも、呼び出し元が選んだ token しか載らない。呼び出し元が自分で選んだ送り先に、自分の Task の出来事を送らせることになる。

### 送るもの・送る時

- 送るのは、SDK の送り手の既定のとおり、要求の処理の中で起きた出来事ごとの `StreamResponse` である。なつみは本文を読まないので、係の側で本文を削らない。
- 次の 2 つは要求の処理の外で起きるので、push を送らない。呼び出し元は poll で拾う。
  - 再起動の時点で終わっていなかった Task を、起動時に `FAILED` にするとき。
  - 聞き返しの答えを待つ時間（`inputTimeoutSeconds`）が尽きて、Task を `FAILED` にするとき。
- 送り損ねても送り直さない。log に出すだけにする。timeout は SDK の既定の 5 秒のままにする。なつみは本文を待たずに応答を返すので、足りる。

### push の設定の保存先と寿命

- push の設定はメモリに持つ。SQLite に持たない。
  終わっていない Task は再起動で `FAILED` になり、続きが動かないので、再起動を越えて設定を持っても送る出来事が無い。再起動の後は、呼び出し元が poll で拾う。
- Task が終わったら（`COMPLETED`・`FAILED`・`CANCELED`・`REJECTED`）、最後の出来事を送ったあとで、その Task の設定を消す。終わった Task の `credentials` をメモリに持ち続けない。
- input-required の Task に答える SendMessage に push の設定が付いていれば、その Task の既にある設定を、新しい設定で置き換える。付いていなければ、既にある設定をそのまま使う。
  なつみは答えるときに新しい token で付け直し、古い token は捨てる。古い token に送り続けても 401 で捨てられるだけである。

### 係から送り先へ出る道

push は、係の Pod から許した送り先へ出られる環境でだけ届く。出られなければ送り損ねになり、呼び出し元は poll で拾う。
なつみの公開のホストへの egress を開けるのは、環境の側の設定の作業である（ADR 0010）。係の Card と許す接頭辞を入れる前に開けておく。開けずに入れても、壊れずに poll に戻るだけである。

### 本 ADR で決定しないこと

- 許す接頭辞の設定の項目名と形（委譲先: README の「設定」の表と `src/config.ts`）
- 設定の API を断るときの A2A のエラーの種類と本文、外したときの log の形（委譲先: 実装の PR の description）
- 送り手を SDK のものを包んで作るか、自前で書くか（委譲先: 実装の PR の description）
- 本人の環境で、どの係にどの接頭辞を書くか、egress をどう開けるか（委譲先: 環境の overlay と運用手順。ADR 0010）
- なつみが push を付けた Task の poll の間隔と、受け口の作り（委譲先: なつみの ADR）
- streaming を出すか（委譲先: 出すと決めるときの新しい ADR）

## Consequences

- なつみは、係の Task が変わるたびにすぐ GetTask を走らせられる。返事に気づくのが、poll の間隔に縛られなくなる。
- 係は、呼び出し元の決めた URL へ POST する機能を持つ。送り先を設定で許したものに限り、リダイレクトを辿らないので、クラスタの中の任意の口を叩かせることはできない。
  許したホストの名前が、環境の DNS で別の宛先を指すようにされれば、そこへは送る。名前の解決の結果までは確かめない。
- 送り先の接頭辞を設定に書くまで、係は push を受けない。書き忘れは、push が来ず poll に戻る側に倒れる。
- 許す接頭辞と、なつみの公開の URL が食い違っても、なつみの依頼は通る。push が来ないので、なつみは広げた poll の間隔で返事を拾い、気づくのが遅れる。
  食い違いは係の log にしか出ないので、log を見るまで気づかない。
- 1 つの依頼で、出来事の数（少なくとも `SUBMITTED`・`WORKING`・返事の artifact・`COMPLETED` の 4 つ）だけ POST が飛び、なつみはそのたびに GetTask を走らせる。
  push が無いときの poll より要求は増えうる。出来事を絞らないのは、本文を読まない呼び鈴としての使い方では、絞る理由が係の側に無いからである。
- push の本文には、返事の artifact が入る。許した送り先にしか送らず、`https` に限るので、呼び出し元が GetTask で取れるものを、呼び出し元の受け口へ届けるだけである。
- 再起動と、聞き返しの答えを待つ時間切れでは push が来ない。呼び出し元は poll を残す前提である。
- push の設定はメモリにしか無いので、再起動の後は呼び出し元が付け直すまで送らない。続きの依頼は新しい Task になるので、付け直しは自然に起きる。
- 係から外への道が 1 つ増える。環境は egress を開けておく必要がある。

## Alternatives Considered

- **許していない送り先の push の設定を含む依頼は、依頼ごと断る。** 設定の誤りが、なつみの依頼の失敗としてすぐ見える。
  しかし、push の設定の誤りだけで、push が無くても届くはずの返事まで止まる。呼び鈴の誤りで依頼を壊さない方を取った。
- **Card を、設定にかかわらず常に `pushNotifications: true` にする。** なつみの側の判定は単純になる。
  しかし、接頭辞を書いていない係では push を付けた依頼がすべて push を外されて受けられ、Card が係の実際の受け方と食い違う。
- **送り先を確かめない。** 呼び出し元は `allowedCallers` に限られる。
  しかし、呼び出し元の手元の token が漏れれば、係を踏み台にクラスタの中の口を叩ける。呼び出し元を信じることと、その呼び出し元に係の Pod の網の位置を使わせることは別である。
- **送り先を接頭辞ではなく、URL の完全一致で許す。** 最も狭い。
  しかし、受け口のパスに版や名前を足すたびに係の設定を直すことになる。パスの区切りの単位で比べれば、許す範囲は接頭辞の下に限られる。
- **push の設定を SQLite に持つ。** 再起動を越えて残る。
  しかし、再起動の時点で終わっていない Task は `FAILED` になり、続きが動かないので、残しても送るものが無い。`credentials` をディスクに置くことになる。
- **送り損ねたら送り直す。** 届く見込みは上がる。
  しかし、呼び出し元は poll を残しており、本文を読まない呼び鈴なので、遅れて届く push に価値が無い。再送の状態と上限を係が持つことになる。
- **古い形の `token` も受ける。** SDK はそのまま送れる。
  しかし、なつみは `authentication` しか使わず、`X-A2A-Notification-Token` を受けない。受け口ごとに異なる 2 つの形を係で支える理由が無い。

## Related ADRs

- Related: ADR-0003 呼び出し元の認証は ServiceAccount と TokenReview で行う（push の設定を付けられる呼び出し元。Decision「なつみの受け口」には当たらない）
- Related: ADR-0007 汎用ホストは A2A のアダプタが context ごとに Pi を子プロセスで動かす（Decision「結果の受け取り方」に push を足す。Task の持ち主の決め方）
- Related: ADR-0010 manifest は汎用の base をこのリポジトリに、環境固有の overlay を private のリポジトリに置く（許す接頭辞と egress を書く場所）
- Related: ADR-0030 呼び出し元は gated 経由でも呼べるようにし、A2A の口でも gated のアサーションを確かめる（push の設定を付けられる呼び出し元の 2 つ目の入口）

## References

- `@a2a-js/sdk` 1.3.0 の `DefaultPushNotificationSender`・`InMemoryPushNotificationStore`・`DefaultRequestHandler`（`sendMessage`・`createTaskPushNotificationConfig`・`_processEvents`・`_sendPushNotificationIfNeeded`）（`node_modules/@a2a-js/sdk/dist/server/index.js` と `default_push_notification_sender-*.d.ts`・`push_notification_store-*.d.ts`、2026-11-04 確認）
- このリポジトリの `src/agent-card.ts` の `buildAgentCard`、`src/handler.ts` の `ContextGuardHandler`、`src/host.ts` の要求の処理の組み立て、`src/store.ts` の `SqliteTaskStore.failUnfinished`・`SqliteTaskStore.fail`、`src/executor.ts` の `PiAgentExecutor.execute`（2026-11-04 確認）
- このリポジトリの README の「汎用ホスト」と「設定」（2026-11-04 確認）
