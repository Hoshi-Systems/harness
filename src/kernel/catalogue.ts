/**
 * ── The catalogue: agents, commands, skills ──────────────────────────────────
 *
 * What the machine can be asked to BE, and what it already knows how to do.
 *
 * This file was 656 lines holding three parallel CRUD implementations — agents,
 * commands and skills — that shared no abstraction, only a pair of ASCII
 * banners marking where one ended and the next began. The banners were right
 * about the seams; they are directories now (docs/STRUCTURE_REVIEW.md H-02).
 *
 * It stays as the barrel so every consumer keeps importing `kernel/catalogue.js`
 * and the kernel's own barrel is unchanged.
 *
 **/

export * from './catalogue/common.js'
export * from './catalogue/agents.js'
export * from './catalogue/commands.js'
export * from './catalogue/skills.js'
