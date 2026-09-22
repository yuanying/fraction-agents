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
