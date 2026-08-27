/**
 * Test double for the host 'connection' service (dsh-client-connection in the
 * real web profile). Records rpc.handle registrations so boot tests can both
 * mount dsh-memory-lite (which injects 'connection') and drive the recorded
 * channel handlers directly — no webserver/transport needed.
 * @module dsh-memory-lite/tests/fixtures/fake-connection
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'fake-connection'

export class FakeConnectionService extends Service {
  /** Registered channel handlers by channel name. */
  readonly handlers = new Map<string, (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>>()

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  get rpc(): { handle: (channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) => void; intercept: () => void } {
    return {
      handle: (channel, handler) => { this.handlers.set(channel, handler) },
      intercept: () => {},
    }
  }
}

export function apply(ctx: Context): void {
  new FakeConnectionService(ctx)
}
