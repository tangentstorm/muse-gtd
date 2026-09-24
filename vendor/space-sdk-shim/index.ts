// Clean-room minimal implementation of the `@hatch/space-sdk` server
// surface used by muse-gtd. Original code (MIT). It covers only what this
// repo needs for standalone mode:
//
// - `z`: zod, re-exported for schema definitions.
// - `defineAction({ request, response, handler })`: returns the definition
//   unchanged. `scripts/serve-standalone.ts` dispatches by name, calling
//   `def.request.parse(args)` then `def.handler(ctx, args)`.
// - `definePrivilegedContracts` / `definePrivilegedHandlers`: the
//   privileged calendar contracts. `definePrivilegedHandlers` returns an
//   `{ entries }` list pairing each contract object (by identity) with its
//   handler, which is what `serve-standalone.ts` uses to route
//   `ctx.executePrivileged(contract, args)`.
// - `Ctx` / `ActionsModule`: the structural types the server code uses.

import { z } from "zod";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

export { z };

export interface ActionDef<TRequestSchema = any, TResponseSchema = any> {
  // Zod schemas at runtime (serve-standalone.ts calls def.request.parse /
  // def.response.parse).
  request: TRequestSchema;
  response: TResponseSchema;
  handler: (
    ctx: Ctx,
    args: SchemaOutput<TRequestSchema>,
  ) => Promise<SchemaOutput<TResponseSchema>>;
}

type SchemaOutput<T> = T extends { _output: infer O } ? O : never;

export function defineAction<
  TRequestSchema extends { _output: any },
  TResponseSchema extends { _output: any },
>(def: {
  request: TRequestSchema;
  response: TResponseSchema;
  // Optional privileged-contract declarations (used by the Muse artifact
  // runtime; accepted and ignored in standalone mode, where
  // ctx.executePrivileged resolves against the registered handlers).
  privileged?: Array<PrivilegedContract<any, any>>;
  handler: (
    ctx: Ctx,
    args: SchemaOutput<TRequestSchema>,
  ) => Promise<SchemaOutput<TResponseSchema>>;
}): ActionDef<TRequestSchema, TResponseSchema> {
  return def as ActionDef<TRequestSchema, TResponseSchema>;
}

export interface Ctx {
  // Returns the drizzle database handle, typed with the schema module the
  // caller passes (e.g. `ctx.db<typeof schema>()`). The concrete driver is
  // provided by the host (see scripts/serve-standalone.ts).
  db: <TSchema extends Record<string, unknown> = Record<string, unknown>>() => BunSQLiteDatabase<TSchema>;
  executePrivileged: (contract: unknown, args: unknown) => Promise<any>;
  emit: (...args: any[]) => void;
  invalidateQueries: (...args: any[]) => void;
  slug: string;
  invocationId: string;
  spaceDir: string;
  blobs: Record<string, unknown>;
  [key: string]: unknown;
}

export type ActionsModule = Record<string, ActionDef<any, any>>;

export interface PrivilegedContract<TRequest = any, TResponse = any> {
  request: { parse: (args: unknown) => TRequest };
  response: { parse: (data: unknown) => TResponse };
  timeoutMs?: number;
}

export function definePrivilegedContracts<
  T extends Record<string, PrivilegedContract<any, any>>,
>(contracts: T): T {
  return contracts;
}

export function definePrivilegedHandlers<
  TContracts extends Record<string, PrivilegedContract<any, any>>,
>(
  contracts: TContracts,
  handlers: {
    [K in keyof TContracts]: (
      args: ReturnType<TContracts[K]["request"]["parse"]>,
    ) => Promise<ReturnType<TContracts[K]["response"]["parse"]>> | ReturnType<TContracts[K]["response"]["parse"]>;
  },
): {
  entries: Array<{ contract: PrivilegedContract<any, any>; handler: (args: any) => Promise<any> }>;
} {
  return {
    entries: (Object.keys(handlers) as Array<keyof TContracts>).map((name) => ({
      contract: contracts[name],
      handler: async (args: any) => (handlers[name] as (a: any) => any)(args),
    })),
  };
}
