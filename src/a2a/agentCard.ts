import { z } from 'zod';

export const AgentCardSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  url: z.string().url(),
  documentationUrl: z.string().url().optional(),
  provider: z.object({
    organization: z.string(),
    url: z.string().url().optional(),
  }),
  capabilities: z.object({
    streaming: z.boolean().default(false),
    pushNotifications: z.boolean().default(false),
    stateTransitionHistory: z.boolean().default(false),
  }),
  authentication: z.object({
    schemes: z.array(z.enum(['Bearer', 'ApiKey', 'None'])),
  }),
  skills: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      tags: z.array(z.string()).optional(),
    })
  ),
});

export type AgentCard = z.infer<typeof AgentCardSchema>;

export function buildAgentCard(config: {
  name: string;
  description: string;
  version: string;
  publicUrl: string;
  skills: Array<{ id: string; name: string; description: string; tags?: string[] }>;
}): AgentCard {
  return {
    name: config.name,
    description: config.description,
    version: config.version,
    url: config.publicUrl,
    documentationUrl: `${config.publicUrl}/docs`,
    provider: {
      organization: 'Helix Gateway',
      url: config.publicUrl,
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    authentication: {
      schemes: ['Bearer', 'ApiKey'],
    },
    skills: config.skills,
  };
}
