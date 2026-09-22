# fraction-agents

Kubernetes クラスタで飼う、特化した AI エージェントの置き場。

各エージェントは独立したサービスとして立ち、A2A プロトコルで依頼を受ける。
設計の決定は `docs/adr/` に置く。

## ADR

- [0001. エージェントを独立したサービスとして飼い、A2A で話す](docs/adr/0001-agents-as-services-over-a2a.md)
- [0002. エージェントの中身の作り方](docs/adr/0002-generic-host-and-dedicated-agents.md)
- [0003. 呼び出し元の認証は ServiceAccount と TokenReview で行う](docs/adr/0003-caller-auth-with-serviceaccounts.md)
- [0004. Wiki 管理人は PR で書き込み、マージは本人の指示でだけ行う](docs/adr/0004-wiki-keeper-writes-through-pull-requests.md)
- [0005. Claude・Codex・Pi からは公式の a2a-cli と共通のスキルで呼ぶ](docs/adr/0005-call-agents-with-a2a-cli-and-shared-skill.md)
