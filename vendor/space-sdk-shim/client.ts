// Clean-room minimal implementation of the `@hatch/space-sdk/client`
// surface used by muse-gtd. Original code (MIT).
//
// `createActionClient<Actions>()` returns a proxy: calling
// `api.someAction(args)` POSTs `{ action: "someAction", args }` to
// `./actions` and resolves with the `data` payload (the standalone server
// wraps successful results as `{ data }` and failures as `{ error }` with
// a non-2xx status, which surfaces here as a thrown Error).

type SchemaOutput<T> = T extends { _output: infer O } ? O : never;

type ActionRequest<T> = T extends { request: infer R } ? SchemaOutput<R> : never;
type ActionResponse<T> = T extends { response: infer R } ? SchemaOutput<R> : never;

export function createActionClient<
  TActions extends Record<string, { request: { _output: any }; response: { _output: any } }>,
>(
  baseUrl = "./actions",
): {
  [K in keyof TActions]: (
    args: ActionRequest<TActions[K]>,
  ) => Promise<ActionResponse<TActions[K]>>;
} {
  return new Proxy(
    {},
    {
      get:
        (_target, action: string) =>
        async (args: unknown): Promise<unknown> => {
          const res = await fetch(baseUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, args: args ?? {} }),
          });
          const body = (await res.json()) as { data?: unknown; error?: string };
          if (!res.ok) throw new Error(body.error ?? `action ${action} failed`);
          return body.data;
        },
    },
  ) as any;
}

export type ApiRequest<TClient, TAction extends keyof TClient> =
  TClient[TAction] extends (args: infer A) => any ? A : never;

export type ApiResponse<TClient, TAction extends keyof TClient> =
  TClient[TAction] extends (...args: any) => Promise<infer R> ? R : never;
