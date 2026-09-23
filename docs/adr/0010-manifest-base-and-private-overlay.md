# 0010. manifest は汎用の base をこのリポジトリに、環境固有の overlay を private のリポジトリに置く

- Date: 2026-09-22
- Status: Accepted

## Context

エージェントは Kubernetes のクラスタに立てる（ADR 0001）。そのための manifest をどこに置き、どの名前空間に立てるかを決める。

このリポジトリは public である（ADR 0001）。一方、実際に動かすには、Ingress のホスト名（ADR 0006）、動かすエージェントの組、
エージェントごとの設定といった、本人の環境に固有の値が要る。これらを public のリポジトリに書きたくない。

本人のクラスタには、環境の manifest をまとめた private のリポジトリが既にある。
クラスタへの反映は、そのリポジトリから手で apply している。

## Decision

### base はこのリポジトリに置く

- このリポジトリの `deploy/base` に、汎用の雛形を置く。Deployment、Service、RBAC、PVC などである。
- base には、ホスト名・IP アドレス・秘密といった環境に固有の値を書かない。

### overlay は private のリポジトリに置く

- 環境に固有の overlay は、環境の manifest をまとめた private の別リポジトリに置く。
  - overlay が持つのは、Ingress のホスト名、動かすエージェント、エージェントごとの設定である。
- クラスタへの反映は、その private のリポジトリから手で apply する。
- overlay から base をどう参照するか（コピーするか、kustomize の remote base で参照するか）は、実装で決める。

### 名前空間は 1 つ

- エージェントは、名前空間 `fraction-agents` 1 つにまとめて立てる。エージェントごとに名前空間を分けない。
- 呼び出し元の ServiceAccount（`owner`・`claude`・`natsumi` など。ADR 0003）も、この名前空間に置く。

### まだ決めていないこと

- PVC の StorageClass と、既存の backup の仕組みに含めるか。実装の作業単位で決める。

## Consequences

- public のリポジトリに環境の値が載らない。base は他の環境でも使える形のまま保てる。
- エージェントの追加や設定の変更は、private のリポジトリの overlay の変更になる。このリポジトリだけでは動かす環境が完結しない。
- base と overlay が別のリポジトリにあるので、base を変えたときに overlay の追従を忘れると、反映した環境が古い base のまま残る。
- 名前空間が 1 つなので、RBAC と Secret の範囲を名前空間で分けられない。エージェントどうしの権限の分離は、ServiceAccount と RBAC の設定で行う。
- 呼び出し元の ServiceAccount がエージェントと同じ名前空間にあるので、呼び出し元の名前は `system:serviceaccount:fraction-agents:<name>` の形に揃う。

## 実装での注記（2026-09-23）

### overlay は remote base で参照し、版で固定する

- 「overlay から base をどう参照するか」を決める。overlay は、このリポジトリのエージェントの kustomization（`deploy/agents/<エージェント>`）を
  kustomize の remote base で参照し、`?ref=v<版>` で git の tag に固定する。コピーはしない。
- image の tag も同じ版にする。tag `v<版>` を打つと、GitHub Actions が `ghcr.io/yuanying/fraction-agents:<版>` を作る。
  manifest・AGENTS.md・設定と image の組み合わせが、1 つの版で決まる。
- 構成は 3 段にする。
  - `deploy/base`: 1 エージェント分の雛形。名前は仮の `agent` で、単体では動かさない。
  - `deploy/agents/<エージェント>`: base の名前をエージェントの名前に付け替え、エージェントのファイルと設定を載せる。
  - 環境の overlay: 名前空間、image の tag、StorageClass、設定の中身、Ingress。
- agentDir の `AGENTS.md`・`settings.json` は、`agents/<エージェント>/` の `kustomization.yaml` が ConfigMap にする。
  kustomize は kustomization のディレクトリの下のファイルしか読めないので、ファイルの隣で作る。

### StorageClass と backup は環境の overlay が決める

- 「まだ決めていないこと」の StorageClass と backup を決める。base は PVC に StorageClass を書かない。環境の overlay が決める。
- いまの環境では、PVC を backup に含めない。PVC の中身はどれも作り直せるためである。
  - ログインの認証情報（`auth.json`）は、ログインし直せば作れる。
  - Wiki の clone は、GitHub から取り直せる。Wiki の変更は PR として GitHub に残る。
  - Task の記録とセッションは、失うと過去の Task と context を続けられなくなるが、依頼し直せば済む。
- backup が要るようになったら、環境の overlay で足す。
