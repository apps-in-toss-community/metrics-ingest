import { z } from 'zod';

// New sources are added by extending this set + a privacy-doc PR.
export const SOURCES = ['devtools', 'console-cli', 'agent-plugin'] as const;
export type Source = (typeof SOURCES)[number];

// Per-source event allowlist. Keep events scoped: tab labels go in `meta`,
// not as new event names. Adding events is cheaper than adding sources.
export const EVENTS_BY_SOURCE: Record<Source, ReadonlyArray<string>> = {
  devtools: ['panel_mount', 'panel_open', 'tab_view', 'session_duration'],
  'console-cli': ['cli_invoked', 'cli_install'],
  'agent-plugin': ['skill_invoked'],
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const META_MAX_BYTES = 256;

// ---------------------------------------------------------------------------
// Tier 0 — anonymous daily ping (opt-out, no client identity)
// anon_id, event, meta are NOT sent by the client; the server fills them.
// .strict() rejects any unknown keys, including anon_id/event/meta.
// ---------------------------------------------------------------------------
export const tier0Schema = z
  .object({
    tier: z.literal(0),
    source: z.enum(SOURCES),
    version: z.string().min(1).max(32),
    ts: z.number().int().nonnegative(),
    platform: z.string().min(1).max(64).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Tier 1 — detailed opt-in event stream (client UUID, explicit consent)
// ---------------------------------------------------------------------------
export const tier1Schema = z
  .object({
    tier: z.literal(1),
    source: z.enum(SOURCES),
    event: z.string().min(1).max(64),
    anon_id: z.string().regex(UUID_V4),
    version: z.string().min(1).max(32),
    ts: z.number().int().nonnegative(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((payload, ctx) => {
    const allowed = EVENTS_BY_SOURCE[payload.source];
    if (!allowed.includes(payload.event)) {
      ctx.addIssue({
        code: 'custom',
        path: ['event'],
        message: `event '${payload.event}' is not in the allowlist for source '${payload.source}'`,
      });
    }
    if (payload.meta !== undefined) {
      const serialized = JSON.stringify(payload.meta);
      if (serialized.length > META_MAX_BYTES) {
        ctx.addIssue({
          code: 'custom',
          path: ['meta'],
          message: `meta exceeds ${META_MAX_BYTES} bytes`,
        });
      }
    }
  });

// ---------------------------------------------------------------------------
// Combined schema — discriminated union on `tier`.
// Legacy payloads (no `tier` field) are treated as Tier 1 by the route
// handler before parsing: `body.tier ??= 1`.
// ---------------------------------------------------------------------------
export const eventSchema = z.discriminatedUnion('tier', [tier0Schema, tier1Schema]);

export type Tier0Payload = z.infer<typeof tier0Schema>;
export type Tier1Payload = z.infer<typeof tier1Schema>;
export type EventPayload = z.infer<typeof eventSchema>;
