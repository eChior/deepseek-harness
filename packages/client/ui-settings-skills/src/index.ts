/**
 * Skill upload page, node half. The empty apply exists so the plugin appears in
 * the host cordis.yml / Loader; the browser half owns the tab through
 * exports["./client"], discovered from the package.json dsh.client declaration.
 * The `skillRepo` namespace the tab reads is registered by the Host controller,
 * so this package registers no namespace of its own.
 */

/** Host plugin body — the tab is a Remote view over the skill repository. */
export function apply(): void {}
