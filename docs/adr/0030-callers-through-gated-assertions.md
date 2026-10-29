# 0030. 呼び出し元は gated 経由でも呼べるようにし、A2A の口でも gated のアサーションを確かめる

- Date: 2026-10-29
- Status: Accepted（ADR 0003 の呼び出し元の認証に、gated を通る 2 つ目の入口を足す。ADR 0003 の TokenReview の入口は残す）

## Context

本人は、クラスタの中の機械（なつみ、fraction-agents の呼び出し元など）の認証を gated に任せると決めた。
gated v0.5.0（gated ADR 0039）は、ServiceAccount の token を受け付けるようになった。

- gated は、起動フラグ `--serviceaccount-audience` で決めた gated の audience の token を、TokenReview で確かめる。
  主体は `system:serviceaccount:<namespace>:<name>` で、NetworkRoleBinding の `subjects[].name` に書く。
- 受け付けた token は `Authorization` ごと落とし、代わりに `Gated-Assertion`（gated ADR 0034。`sub` が主体）を付けて転送する。
- 受け付けなかった token（audience `a2a` のものなど）は、そのまま転送する。主体は決まらず、未ログインとして判定する。
- gated は、クライアントが付けた `Gated-` で始まるヘッダをすべての要求から消す。gated の後ろの `Gated-Assertion` は gated が付けたものだけである。

本人は、エージェントの自前の TokenReview（audience `a2a`。ADR 0003）の入口も残すと決めた。
Service を直接呼ぶ道と、gated の audience の token に移る途中の呼び出し元のためである。

A2A の口は、今は Bearer の token しか確かめない。エージェントの Ingress を gated の NetworkRole で守る側に移すと、
gated の audience の token で gated を通った要求は、Bearer を落とされてアサーションだけで届き、エージェントで 401 になる。

人用のページ（ADR 0021）は、gated のアサーションを 8 段で確かめる仕組みを既に持っている（`src/gated-assertion.ts`）。
2 つの入口が同じ要求に来るのは、次のような場合である。

- gated が ServiceAccount の token を受け付けたときは `Authorization` を落とすので、両方は来ない。
- `a2a` の token は gated が受け付けずに転送するので、アサーションは付かない。
- 人が gated にログインしたまま（セッションの Cookie や `AccessToken`）Bearer を付けた場合は、両方が来うる。この主体は `github:<login>` などである。
- gated を通らない道（Service へ直接）では、アサーションは誰でも付けられる。ただし署名が検証できないので 1〜7 段で落ちる。期限内のアサーションを、それを受け取った別の backend が持ち込む場合だけが、署名を通る。

## Decision

### A2A の口に、gated のアサーションの入口を足す

- 設定のトップレベルに `gated`（`issuer`・`jwksUrl`）を足す。書けば、A2A の口（依頼・Task の取得・画像の成果物・機械のレポートの口。Agent Card と `/healthz` を除くすべて）で、`Gated-Assertion` を確かめる入口を開く。
  書かなければ、今までどおり Bearer の入口だけである。どの係でも任意とする。
- 確かめ方は、人用のページ（ADR 0021）と同じ 8 段で、同じ実装を使う。
  - 2: `alg` は `EdDSA`、`typ` は `gated-assertion+jwt` に固定する。
  - 3: 鍵は設定の `gated.jwksUrl` の JWKS から取り、アサーションからは読まない。知らない `kid` は、前に取ってから 1 分以上空いていれば一度だけ取り直す。
  - 5: `iss` は設定の `gated.issuer` と比べる。
  - 6: `aud` は設定の `publicUrl` のホスト名（小文字、ポートなし）と比べる。要求の `Host` とは比べない。
  - 7: 時計のずれは 30 秒まで許す。
  - 8: `sub` は `allowedCallers` と比べる。人用のページの `allowedSubjects` とは別である。
- 通った `sub` は、TokenReview の username と同じ形（`system:serviceaccount:<namespace>:<name>`）なので、そのまま呼び出し元の名前にする。
  context と Task の持ち主、画像の成果物、レポートの持ち主と `reports.readAllCallers` の判定は、どちらの入口から来ても同じ呼び出し元として扱う。
- 1〜7 のどれかで落ちれば 401（本文は `invalid assertion`）、8 で落ちれば 403（本文は `caller not allowed`）を返す。どの段で落ちたかは本文に書かず、ホストのログに残す（ADR 0021 と同じ）。

### 設定の置き場

- `gated` はトップレベルに 1 つ置き、人用のページの `reports.web.gated` と兼ねる。同じ gated が両方の口の前に立つからである。
  - `reports.web.gated` は省けるようにし、省けば `gated` を使う。
  - 両方を書くなら、値が同じでなければ設定の誤りとして起動しない。2 か所が食い違ったまま動くことを避ける。
  - `reports.web.gated` だけを書いた今の設定は、そのまま動く（A2A の口は Bearer だけのまま）。
- `aud` に比べるホスト名は、新しい項目を足さず `publicUrl` から取る。Agent Card に載せる URL と、gated を通って届くホスト名は同じだからである。人用のページが `reports.web.publicUrl` から取るのと同じ形にした。

### 2 つの入口の優先順位

- `gated` を設定していて、要求に `Gated-Assertion` があれば、アサーションだけで決める。`Authorization` は見ない。
- アサーションが 1〜8 のどれかで落ちたら、Bearer に落ちずにそのまま断る。
- `Gated-Assertion` が無ければ、今までどおり Bearer の token を TokenReview で確かめる。
- `gated` を設定していなければ、`Gated-Assertion` は無視する（今までどおり）。

理由は次のとおりである。

- 1 つの要求の呼び出し元は 1 つに決まるべきである。どちらか通った方、とすると、2 つの入口が別々の主体を指したときに、どちらが呼び出し元かが入口の順番の都合で決まる。
- gated の後ろでは、アサーションは gated が付けたものしかない。それが確かめられないのは、gated の鍵の交換の途中、`aud` と `publicUrl` の食い違い、gated を通らずに来た偽物のどれかである。どれも黙って Bearer で通すより、断ってログに残す方が気づける（ADR 0003・0006 の「認証を通らない依頼を一切処理しない」）。
- gated を通った要求は、TokenReview を問い合わせずに済む。apiserver の負荷（ADR 0006 の Consequences）が増えない。

### 呼び出し元が使う token

本人と決めたこと（2026-10-29）:

- gated を通って係のホスト名で呼ぶ呼び出し元（クラスタの外の `owner`・`claude`・なつみなど）は、gated の audience（gated の `--serviceaccount-audience` の値）の token だけを使う。
- Service を直接呼ぶ呼び出し元（クラスタの中の Pod。vuln-tracker など）は、今までどおり audience `a2a` の token を使う。
- 1 つの token に 2 つの audience を持たせて両方に使う形は作らない。
- 係の Ingress は、後で gated の NetworkRole で守る。通すのは各係の `allowedCallers` の主体で、Agent Card と `/healthz` は未ログインでも `GET`・`HEAD` を許す。
  守ったあとは、gated を通る URL に `a2a` の token を送っても、gated が未ログインとして断る。

理由は次のとおりである。

- gated の audience の token は、gated が確かめて `Authorization` ごと落とし、アサーションに置き換える。係は token を一度も受け取らない。
  ADR 0003 で audience を分けた狙い（係が受け取った token を別の相手に使い回せない）は、gated を通る道でも保たれる。
- 両用の token は、gated を通る道でも `a2a` の audience を持ったまま流れる。gated の設定を誤って素通しになった係は、その token を受け取り、Service を直接呼ぶ道で使い回せる。
- 切り替えは、呼ぶ係すべてに `gated` の設定が入ってからにする。`gated` の無い係では、gated が `Authorization` を落とすので、gated の audience の token は 401 になる。
  NetworkRole で守るのは、gated を通る呼び出し元を切り替えたあとにする。

README の「token を発行する」と共通のスキル（ADR 0005）は、この決定に合わせて書き分ける。スキルが `kubectl create token` を自分で実行しない決まりは変えない。

### 退けた案

- **Bearer を先に見る。** gated が ServiceAccount の token を受け付けたときは Bearer が落とされているので、gated を通った機械には差が無い。
  しかし、人が gated にログインしたまま `a2a` の token を付けた要求では、アサーションの主体が無視され、どちらが呼び出し元かの決まり方が入口の種類で変わる。
  アサーションを付けるのは gated だけで、gated を通った要求の主体は gated の判定の主体と一致させたい。
- **アサーションが落ちたら Bearer に落ちる。** 権限は広がらない（Bearer もそれだけで通る認証である）。
  しかし、アサーションが落ちる理由（鍵の交換の誤り、`publicUrl` の誤り、偽物）を Bearer が隠し、設定の誤りが静かに残る。
  また、人が gated にログインしたまま Bearer を付けた要求は、主体（`github:<login>`）が `allowedCallers` に無いので 403 になる。
  これは受け入れる。機械は gated のログインを持たず、人は機械の口を使わない（ADR 0021 で口を分けた）。
- **`aud` に比べるホスト名を、`gated.audience` のような新しい項目にする。** `publicUrl` と別に書くと、2 か所を揃える手間と食い違いの元が増える。`publicUrl` を変えるときは呼び出し元の URL も変わるので、同時に直ることになる。
- **人用のページと別の `gated` を A2A の口に持たせる（`a2a.gated` など）。** gated はクラスタに 1 つで、発行元と JWKS は同じである。2 か所に書く理由が無い。
- **呼び出し元に、`a2a` と gated の audience の両方を持つ token を 1 つ渡す。** 呼び出し元の手元の token が 1 つで済み、移行の途中にどちらの道でも通る。
  しかし、上の「呼び出し元が使う token」のとおり、`a2a` の audience の token が gated を通る道にも流れ、使い回せない性質が gated の設定の正しさに頼ることになる。
- **`allowedCallers` とは別に、アサーションで許す主体の一覧を持つ。** どちらの入口から来ても同じ呼び出し元として扱うので、一覧も 1 つにする。gated の NetworkRoleBinding と `allowedCallers` に同じ主体を書くのは、ADR 0021 と同じく意図した二重化である。

## Consequences

- 呼び出し元は、gated の audience の token を `Authorization: Bearer` で付けて、gated を通る URL（係のホスト名）で呼べる。`a2a` の token で呼ぶ道も残る。
- エージェントの Ingress を gated の NetworkRole で守る側に移せる。守ったあとも、gated の判定（NetworkRoleBinding）とエージェントの判定（`allowedCallers`）が別々に効く。片方の設定を誤っても、もう片方が残る。
- `gated` を書いた係は、gated の中央認証ホストの JWKS に依存する。取れなくても、キャッシュの鍵で確かめ続ける（ADR 0021）。人用のページと A2A の口は、それぞれ別にキャッシュを持つ。
- `aud` はホスト名で、パスを含まない（gated ADR 0034）。複数の係を 1 つのホスト名の下にパスで並べると、ある係が受け取ったアサーションを、期限（60 秒）内に同じホストの別の係へ持ち込めば通る。係ごとに別のホスト名で出す前提である。
- gated を通らない道（Service へ直接）では、偽のアサーションは署名で落ちる。gated を通った要求に付いたアサーションを、それを受け取った係が期限内に別のホスト名の係へ持ち込んでも、6 で落ちる。
- 人が gated にログインしたまま Bearer を付けて A2A の口を呼ぶと、403 になる。
- 呼び出し元の token は、呼ぶ道ごとに 1 つの audience になる。gated を通る呼び出し元と Service を直接呼ぶ呼び出し元が同じ ServiceAccount なら、token を 2 つ持つことになる。
- gated の audience の token に切り替える順番（係の `gated` の設定 → 呼び出し元の token → NetworkRole）を誤ると、呼び出し元が 401 で止まる。具体の手順は環境の側（ADR 0010）に書く。
