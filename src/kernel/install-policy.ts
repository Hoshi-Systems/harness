/**
 * ── May this daemon install a plugin's dependencies while it runs? ───────────
 *
 * Two values and a variable, in a module of their own, because the code that
 * SETS this and the code that ASKS are on opposite sides of a cycle otherwise:
 * `runtime.ts` held it, `routes/plugins.name.install.post.ts` read it, and
 * `runtime.ts` imports the route table that route is registered in.
 *
 * That cycle was recorded as debt rather than fixed, and it is the shape the
 * cycle gate's own header describes: two modules sharing a piece that belongs
 * to neither. It belongs here.
 *
 * `build-only` is the default and the safe one: a machine image installs what
 * its plugins need at build time, and a daemon that could apt-get at runtime is
 * a daemon whose behaviour depends on when it was started.
 *
 **/

export type InstallPolicy = 'build-only' | 'owner'

let policy: InstallPolicy = 'build-only'

export function installPolicy(): InstallPolicy {
  return policy
}

export function setInstallPolicy(next: InstallPolicy): void {
  policy = next
}
