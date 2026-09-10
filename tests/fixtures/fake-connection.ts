/**
 * Test double for the host 'connection' service (dsh-client-connection in the
 * real web profile). Records fetch.register routes so boot tests can both
 * mount dsh-memory-lite (which injects 'connection') and drive the recorded
 * route handlers directly — no webserver/transport needed.
 * @module dsh-memory-lite/tests/fixtures/fake-connection
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'fake-connection'

export interface FakeFetchRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody?: string
  readonly fetch: (request: Request) => Promise<Response>
}

export class FakeConnectionService extends Service {
  /** Registered exact Fetch routes by absolute path. */
  readonly fetchRoutes = new Map<string, FakeFetchRoute>()

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  get rpc(): { handle: () => void; intercept: () => void } {
    return { handle: () => {}, intercept: () => {} }
  }

  get fetch(): { register: (route: FakeFetchRoute) => () => Promise<void> } {
    return {
      register: (route) => {
        this.fetchRoutes.set(route.path, route)
        return async () => { this.fetchRoutes.delete(route.path) }
      },
    }
  }
}

export function apply(ctx: Context): void {
  new FakeConnectionService(ctx)
}
