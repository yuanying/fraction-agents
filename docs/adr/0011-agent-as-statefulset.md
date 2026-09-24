# 0011. エージェントは StatefulSet で動かし、ボリュームは volumeClaimTemplates で作る

- Date: 2026-09-24
- Status: Accepted（ADR 0010 の base の Deployment と PVC を置き換える）

## Context

ADR 0010 で、`deploy/base` に 1 エージェント分の雛形を置いた。雛形は Deployment（replicas 1、strategy Recreate）と、
別の resource の PVC からなり、エージェントの kustomization が両方の名前をエージェントの名前に付け替えていた。

エージェントの Pod は、1 つのボリュームに agentDir（ログインの `auth.json`）とホストのデータ（SQLite、セッション、clone）を持つ。
ボリュームは ReadWriteOnce で、同じボリュームを 2 つの Pod が同時に使ってはいけない。
エージェントとボリュームは 1 対 1 で、エージェントを足すたびにボリュームも 1 つ増える。

## Decision

### StatefulSet と volumeClaimTemplates

- エージェントの既定の置き方を、Deployment から StatefulSet（replicas 1）にする。
- ボリュームは、別の PVC の resource ではなく、StatefulSet の `volumeClaimTemplates` で作る。
  テンプレートの名前は `data` で、PVC の名前は `data-<エージェント>-0` になる。
- エージェントの kustomization は StatefulSet の名前を付け替える。PVC の名前の付け替えは要らなくなる。
- Pod のテンプレートは Deployment のときと変えない。subPath のマウント（`/agent`・`/data` と ConfigMap のファイル）、
  ボリュームを用意する init container、securityContext はそのまま移す。

### serviceName は既存の Service を指す

- StatefulSet の `serviceName` には、エージェントの Service（ClusterIP、port 80）をそのまま使う。headless の Service は足さない。
- Pod ごとの DNS 名で Pod を呼ぶものは無い。呼び出し元も Ingress も Service を通る。Service を 1 つに保てば、名前の付け替えも 1 つで済む。
- kustomize は、Service の名前を付け替えると `serviceName` も合わせて付け替える。

### StorageClass は環境の overlay が StatefulSet のテンプレートに当てる

- base はテンプレートに StorageClass を書かない（ADR 0010 の注記と同じ）。
- 環境の overlay は、StatefulSet の `/spec/volumeClaimTemplates/0/spec/storageClassName` にパッチを当てて決める。

## Consequences

- ボリュームが StatefulSet に付いてくるので、エージェントを足すときに PVC の resource と名前の付け替えを書かなくてよい。
- StatefulSet は同じ名前の Pod を 2 つ同時に作らない。ノードが応答しなくなっても、古い Pod の終了が確かめられるまで次の Pod を作らないので、
  ReadWriteOnce のボリュームと SQLite を 2 つの Pod が同時に掴むことがない。代わりに、その間はエージェントが止まる。
- `volumeClaimTemplates` は、StatefulSet を作った後には変えられない。StorageClass と容量は、最初の apply の前に overlay で決めておく。
  後から変えるときは、StatefulSet を消して作り直す（PVC は残るので、中身を移すか PVC ごと作り直す）。
- StatefulSet を消しても PVC は消えない。エージェントをやめるときは、PVC を手で消す。
- 更新で Pod が Ready にならないと、StatefulSet はそこで止まる。manifest を直して apply した後、壊れた Pod を手で消す必要がある。
- Deployment から移る環境では、apply しても古い Deployment と PVC（`<エージェント>-data`）は消えない。
  Deployment は apply の前に手で消す。残すと、同じ Service の後ろに 2 つの Pod が並ぶ。
  新しい PVC は空で始まるので、ログインはやり直しになる。古い PVC は、要らなくなったら手で消す。
