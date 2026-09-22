import { AgentCard } from "@a2a-js/sdk";

import type { Config } from "./config.ts";

/** The Agent Card: who the agent is from the config, JSON-RPC over HTTP, and a ServiceAccount token as bearer. */
export function buildAgentCard(config: Config): AgentCard {
  return {
    name: config.name,
    description: config.description,
    version: config.version,
    supportedInterfaces: [{ url: config.publicUrl, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" }],
    provider: undefined,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, extensions: [] },
    securitySchemes: {
      bearer: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: {
            scheme: "Bearer",
            bearerFormat: "JWT",
            description: "A Kubernetes ServiceAccount token issued for the a2a audience.",
          },
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: config.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      examples: skill.examples,
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    })),
    signatures: [],
  };
}

/**
 * The card as served at `/.well-known/agent-card.json`. The SDK's own agentCardHandler writes the in-memory form
 * (with `$case` unions), so the card is converted here. Scopes in `securityRequirements` are written as a plain
 * list: a2a-go, and so the official `a2a-cli`, reads them that way and rejects ProtoJSON's `{"list": [...]}`,
 * and the JS SDK accepts it (the list here is empty).
 */
export function agentCardJson(config: Config): Record<string, unknown> {
  const card = buildAgentCard(config);
  return {
    ...(AgentCard.toJSON(card) as Record<string, unknown>),
    securityRequirements: card.securityRequirements.map((requirement) => ({
      schemes: Object.fromEntries(Object.entries(requirement.schemes).map(([name, scopes]) => [name, scopes.list])),
    })),
  };
}
