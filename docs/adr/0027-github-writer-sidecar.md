# 0027. GitHub への書き込みを、App の鍵を持つ sidecar に代行させる

- Date: 2026-10-27
- Status: Accepted（ADR 0009 の「残る穴を受け入れる」で先送りした、鍵を隔てる共通の部品を作る）

## Context

ADR 0009 では、Wiki 管理人の GitHub App の鍵をエージェントと同じコンテナに置いた。
エージェントがその鍵を読んで自分で token を作れば、門番を迂回できる。
呼び出し元が本人と本人の身内に限られることを理由に、この穴を受け入れた。
そのうえで「GitHub に書くエージェントが増えたら、鍵を sidecar に隔てる部品を共通に作る」と決めた。

次に GitHub に書く係は、脆弱性への対応をする係（vuln-responder）である。この係には次の事情がある。

- CVE の説明や changelog のような、信用できない外の文章を読む。prompt injection を受けうる。
- 書く先の一つは private の fleet-infra である。無料プランなので、ブランチ保護もルールセットも使えない。
  PR を作れる資格は、既定のブランチへの push も兼ねる（2026-10-27 に API で確かめた）。
- 書く先のリポジトリは一つではない。fleet-infra と、自作のイメージのソースのリポジトリに書く。

この係では、鍵が読める穴を受け入れられない。

Pod の中の隔離について、分かっていることは次のとおりである。

- 同じ Pod のコンテナは、network の名前空間を共有し、ファイルシステムは共有しない。
  ボリュームは、mount したコンテナにだけ見える。
- `shareProcessNamespace` を有効にしなければ、他のコンテナのプロセスとその `/proc` は見えない。
- git の設定（リポジトリの config、hooks、`core.fsmonitor` など）は、git を走らせたプロセスにコマンドを実行させられる。
  エージェントが書けるリポジトリで、token を持つプロセスが git を走らせると、token が漏れうる。
- git の bundle は、ただのデータである。取り込むときの検査は、ネットワーク越しに受け取るときと同じである。
- installation token の権限が contents と pull requests だけなら、GitHub は `.github/workflows/` の変更の push を拒む。
  ワークフローの変更には workflows の権限が要る。

## Decision

### sidecar がすることは、既定のブランチ以外への push と、PR の作成だけ

鍵を持つのは、エージェントと同じ Pod の別のコンテナ（github-writer）である。
エージェントは github-writer に頼み、github-writer が GitHub に書く。

github-writer がすることは次のとおりである。

- 許されたリポジトリの、許されたブランチへの push。早送りだけで、force push はしない。
- PR の作成。同じブランチから開いている PR があれば、その題と本文を更新する。
- 読み取り専用の mirror を GitHub に合わせる。エージェントは mirror から clone と fetch をする。
- ブランチの最新の PR の状態（開いている・マージ済み・閉じた）を返す。

次のことはしない。API にも出さない。

- マージ
- 既定のブランチへの push
- ブランチとタグの削除、タグの push
- リポジトリの設定の変更

### 境界: 鍵と token はエージェントのコンテナから読めない

- App の鍵の Secret は、github-writer のコンテナにだけ mount する。エージェントのコンテナには mount しない。
- installation token は github-writer のメモリにだけ持つ。ファイル、環境変数、git の設定、remote の URL には置かない。
  git には、1 回の git のプロセスの環境変数で Authorization のヘッダを渡す（ADR 0009 の実装での注記と同じ）。
- token と鍵は、レスポンスにもログにも出さない。
- Pod の `shareProcessNamespace` は有効にしない。
- github-writer は `127.0.0.1` で listen する。Pod の外からは届かない。
  Pod の中のプロセス（エージェントの bash も含む）からは呼べるが、それでよい。何を許すかは github-writer が決める。

### 許すことは、Pod の設定で github-writer が絞る

github-writer の設定は JSON のファイル 1 つで、秘密を置かない。設定に書いたことだけを許す。

- 書いてよいリポジトリの一覧。それぞれに既定のブランチと、ブランチ名の接頭辞を持つ。
  push と PR は、その接頭辞で始まり、既定のブランチではないブランチにだけ許す。
- path の規則。リポジトリごとに次の 3 つを持つ。
  - 書いてよい path（`writablePaths`）。書けば、変更はすべてこの下でなければならない。書かなければ、どこでもよい。
  - 追加だけ（`appendOnlyPaths`）。新しいファイルの追加だけを許す（ADR 0009 の `raw/`）。
  - 読み取り専用（`readOnlyPaths`）。追加・変更・削除のすべてを拒む（ADR 0009 の `Permanent-Notes/`）。
- 規則は、既定のブランチとの merge base からの差分（PR に出る差分）のすべてのファイルに当てる。
  一つでも外れれば push しない。
- token は、push か PR の対象のリポジトリ 1 つだけに絞って発行し、権限は contents の write と pull requests の write だけにする。
  これで、ワークフローの変更は GitHub が拒む。

エージェントのコンテナにも同じ設定のファイルを置く。秘密を含まないので見えてよい。
Pi の拡張は、そこから github-writer のポートと mirror の場所を読む。

### git の中身は bundle で渡し、github-writer は自分のリポジトリでだけ git を走らせる

エージェントと github-writer の間で git の中身を渡す形として、次の 2 つを比べた。

- 同じ PVC を mount し、github-writer がエージェントの clone を読んで push する。
- エージェントが bundle を作り、github-writer に渡す。

bundle にする。理由は次のとおり。

- エージェントの clone の設定と hooks はエージェントが書ける。github-writer がそこで token を持って git を走らせると、
  token を漏らす経路になる。危ない設定を一つずつ打ち消す形は、漏れが出やすい。
- github-writer がエージェントのファイルを読まずに済む。github-writer に mount するのは、自分の mirror と設定と鍵だけになる。
- bundle の取り込みは、GitHub から fetch するときと同じ検査を通る。object の検査（fsck）も有効にする。

形は次のとおりである。

- github-writer は、リポジトリごとに bare の mirror を持つ。mirror は GitHub のブランチをそのまま写す。
  起動したときと、一定の間隔と、頼まれたときに、GitHub から fetch する。
- mirror は Pod の emptyDir に置く。github-writer は書き込みで、エージェントは読み取り専用で mount する。
  Pod が作り直されれば、github-writer が GitHub から取り直す。
- エージェントは mirror を `file://` の URL で clone し、fetch する。資格は要らない。読み取り専用なので、mirror は書き換えられない。
- push を頼むとき、エージェントの Pi の拡張は、mirror に無い commit だけの bundle を作り、HTTP の本文で送る。
  bundle が持つブランチは、push するブランチの 1 つだけでなければならない。
- github-writer は bundle を自分の mirror に取り込み、規則を確かめてから、mirror から GitHub へ push する。
- bundle の大きさには上限を置く。

### エージェントの道具は Pi の拡張にする

- fraction-agents の Pi パッケージに拡張を足す。設定のファイル（`github-writer.json`）がエージェントのディレクトリにあるときだけ動く。
- 道具は、push（`github_push`）、PR の作成と更新（`github_pull_request`）、mirror を GitHub に合わせる（`github_sync`）の 3 つである。
  どれも作業ディレクトリの clone の `origin` が mirror であることから、対象のリポジトリを決める。
- 道具の名前は門番（ADR 0009）と同じにする。同じエージェントに門番の設定もあるときは、この拡張は動かない。
- bash には GitHub の資格が無い（ADR 0009 と同じ）。mirror も読み取り専用なので、bash の `git push` はどこにも届かない。

### イメージは汎用ホストのものを使う

- github-writer は、汎用ホストのイメージ（`ghcr.io/yuanying/fraction-agents`）に入っている Pi パッケージのコマンドとして動かす。
  ニュース係の collector（ADR 0017）と同じ形である。
- 要るのは Node と git だけで、どちらも汎用ホストのイメージにある。新しいイメージは作らない。
  ビルドと `:main` の push と掃除（ADR 0026）は、今のイメージのまま変わらない。

### manifest は、どの係にも付けられる kustomize の Component にする

- `deploy/components/github-writer` に置く。係の kustomization が components に足すと、
  github-writer のコンテナ、mirror の emptyDir、鍵の Secret の volume が足される。
- 鍵の Secret と設定の ConfigMap は環境の overlay が作る。Secret は手で作り、git に置かない。

### GitHub App

- vuln-responder には、Wiki 管理人とは別の App を作る。理由は次のとおり。
  - インストールするリポジトリが違う。App が入っているリポジトリにしか token は発行できない。
    同じ App を使い回すと、どちらの係の鍵も、両方のリポジトリに書ける。
  - PR の名義で、どちらの係が書いたかが分かる。
- App の権限は Contents（Read and write）、Pull requests（Read and write）、Metadata（Read）だけにする。
  Workflows と Administration は与えない。
- App の作成とインストールは本人が行う。

### Wiki 管理人の載せ替えの道筋

Wiki 管理人はこの作業では載せ替えない。後で載せ替えるときの道筋は次のとおりである。

- github-writer の設定の path の規則は、門番の `appendOnlyPaths` と `readOnlyPaths` と同じ意味と同じ検査である。
  門番の設定をそのまま移せる。
- 門番の道具と同じ名前の道具を出すので、Wiki 管理人の AGENTS.md の push と PR の手順は変えずに済む。
- context ごとの worktree（ADR 0009）は、remote を GitHub から mirror に替えれば、資格なしで作れる。
- 門番がしていた、マージ済みの PR の後に新しいブランチへ移る処理は、PR の状態を返す API を使って Pi の拡張の側で行う。
- マージは github-writer に入れない。Wiki 管理人はいま、本人と本人の Claude の依頼でマージする。
  マージを残すなら、呼び出し元が誰かを github-writer が確かめる手段が要る。
  エージェントの bash からも github-writer を呼べるので、呼び出し元の名前を申告させるだけでは足りない。
  載せ替えのときに別の ADR で決める。それまで Wiki 管理人は門番のままにする。

## Consequences

- エージェントが prompt injection を受けても、GitHub にできることは、許したリポジトリの許したブランチへの push と、PR までになる。
  既定のブランチへの push、マージ、ワークフローの変更はできない。
- 規則の外の push は、エージェントの道具の都合ではなく github-writer の検査で止まる。bash からの迂回も同じ検査を通る。
- 規則の範囲の中で何を書くか（commit の中身）は検査しない。それを見て止めるのは PR のレビューである。
- エージェントは mirror を通して読むので、private のリポジトリも資格なしで clone できる。
  mirror は GitHub より最大で同期の間隔だけ古い。新しさが要るときは `github_sync` で合わせる。
- Pod の emptyDir に mirror を持つので、Pod を作り直すたびに clone し直す。大きなリポジトリでは起動の後しばらく待つことになる。
- force push ができないので、push 済みの commit を書き換えたいときは新しいブランチにする。
- 汎用ホストのイメージに、github-writer が使わない pi なども入っている。イメージを一つで済ませる代わりに受け入れる。
- Wiki 管理人は、載せ替えるまで ADR 0009 の穴を持ったままである。
