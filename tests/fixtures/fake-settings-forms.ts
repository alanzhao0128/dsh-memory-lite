/**
 * Test double for the dsh >= 0.1.7 host 'settings' service (@deepseek-ai/dsh-settings
 * SettingsForms class).
 *
 * In 0.1.7:
 * - Does NOT provide installSection.
 * - Provides configure(presentation, owner) to allow plugins to opt-out of auto-generated forms.
 * - Settings are persisted in cordis.patch.yml; config reloads fire app-boot/config-reload.
 * @module dsh-memory-lite/tests/fixtures/fake-settings-forms
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'fake-settings-forms'

export class FakeSettingsForms extends Service {
  readonly configured: Array<{ auto?: boolean; owner: unknown }> = []

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  get writable(): boolean {
    return true
  }

  configure(presentation: { auto?: boolean }, owner?: unknown): () => void {
    this.configured.push({ auto: presentation.auto, owner })
    return () => {}
  }
}

export function apply(ctx: Context): void {
  ctx.plugin(FakeSettingsForms)
}
