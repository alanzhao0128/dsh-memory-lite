/**
 * Test double for the host 'settings' service (@deepseek-ai/dsh-settings +
 * a file provider in the real web profile). Backs every namespace section
 * with an in-memory map, so boot tests can mount dsh-memory-lite (whose
 * installSettingsSection injects 'settings'), then simulate a user edit via
 * the public update()/replace() surface and observe the live config change.
 * @module dsh-memory-lite/tests/fixtures/fake-settings
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'fake-settings'

/** In-memory settings provider: every namespace section lives in a map. */
export class FakeSettingsProvider extends SettingsProvider {
  /** Raw document: namespace -> user section. Tests read this to assert persistence. */
  readonly sections = new Map<string, Record<string, unknown>>()

  constructor(ctx: Context) {
    super(ctx)
  }

  get writable(): boolean {
    return true
  }

  /** Seed a section as if the document already carried it (pre-boot state). */
  seed(ns: string, section: Record<string, unknown>): void {
    this.sections.set(ns, section)
  }

  /**
   * Publish the current document through the base provider, mirroring what
   * the real file provider's Service.init does on boot. The Loader does not
   * drive this double's init inside apply, so the seed would otherwise never
   * reach the resolution layer.
   */
  publishNow(): void {
    this.publish(Object.fromEntries(this.sections))
  }

  protected async load(): Promise<Record<string, unknown>> {
    return Object.fromEntries(this.sections)
  }

  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.sections.set(String(ns), section)
  }
}

/** Plugin config: an optional pre-seeded document (namespace -> section),
 *  simulating a settings.yaml that already carries values before boot. */
export interface FakeSettingsConfig {
  seed?: Record<string, Record<string, unknown>>
}

export function apply(ctx: Context, config: FakeSettingsConfig = {}): void {
  const provider = new FakeSettingsProvider(ctx)
  if (config.seed !== undefined) {
    for (const [ns, section] of Object.entries(config.seed)) {
      provider.seed(ns, section)
    }
  }
  // Mirror the real provider's post-init published state so a namespace
  // registered afterwards resolves the seeded section.
  provider.publishNow()
}
