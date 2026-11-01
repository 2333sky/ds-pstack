/**
 * ds-pstack — DeepSeek Harness plugin.
 *
 * Registers one runtime skill provider that exposes the vendored upstream
 * pstack corpus (`skills/<name>/SKILL.md`) to the DSH skill registry.
 */

import { createSkillProvider } from './provider.js'

export const name = 'ds-pstack'
export const inject = ['skills']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(() => ctx.skills.registerProvider((control) => createSkillProvider({ control })))
}
