import type { RouteTable } from '../http/router.js'
import route_secrets_key_delete from './secrets.key.delete.js'
import route_secrets_key_patch from './secrets.key.patch.js'
import route_secrets_index_get from './secrets.index.get.js'
import route_secrets_index_post from './secrets.index.post.js'
import route_system_get from './system.get.js'
import route_workspace_delete from './workspace.delete.js'

import plugins_index_get from './plugins.index.get.js'
import capabilities_get from './capabilities.get.js'
import plugins_name_install_post from './plugins.name.install.post.js'
import route_agents_name_delete from './agents.name.delete.js'
import route_agents_name_patch from './agents.name.patch.js'
import route_agents_index_get from './agents.index.get.js'
import route_commands_name_delete from './commands.name.delete.js'
import route_commands_name_patch from './commands.name.patch.js'
import route_commands_index_get from './commands.index.get.js'
import route_starters_get from './starters.get.js'
import route_profile_get from './profile.get.js'
import route_setup_complete_post from './setup.complete.post.js'
import route_integrations_get from './integrations.get.js'
import route_skills_name_delete from './skills.name.delete.js'
import route_skills_index_get from './skills.index.get.js'
import route_skills_index_post from './skills.index.post.js'
import route_skills_name_get from './skills.name.get.js'
import route_skills_name_duplicate_post from './skills.name.duplicate.post.js'
import route_providers_id_check_post from './providers.id.check.post.js'
import route_providers_id_refresh_post from './providers.id.refresh.post.js'
import route_skill_sources_index_get from './skill-sources.index.get.js'
import route_skill_sources_index_post from './skill-sources.index.post.js'
import route_skill_sources_id_delete from './skill-sources.id.delete.js'
import route_skill_sources_id_skills_get from './skill-sources.id.skills.get.js'
import route_skill_sources_id_install_post from './skill-sources.id.install.post.js'
import route_usage_summary_get from './usage.summary.get.js'
import route_activity_get from './activity.get.js'

import sessions_id_delete from './sessions.id.delete.js'
import sessions_id_get from './sessions.id.get.js'
import sessions_id_patch from './sessions.id.patch.js'
import sessions_id_abort_post from './sessions.id.abort.post.js'
import sessions_id_commands_post from './sessions.id.commands.post.js'
import sessions_id_compact_post from './sessions.id.compact.post.js'
import sessions_id_context_post from './sessions.id.context.post.js'
import sessions_id_fork_post from './sessions.id.fork.post.js'
import sessions_id_messages_get from './sessions.id.messages.get.js'
import sessions_id_messages_post from './sessions.id.messages.post.js'
import sessions_id_rewind_post from './sessions.id.rewind.post.js'
import sessions_id_shell_post from './sessions.id.shell.post.js'
import sessions_id_stream_get from './sessions.id.stream.get.js'
import sessions_index_get from './sessions.index.get.js'
import sessions_index_post from './sessions.index.post.js'
import sessions_status_get from './sessions.status.get.js'
import providers_id_delete from './providers.id.delete.js'
import providers_id_auth_delete from './providers.id.auth.delete.js'
import providers_id_key_put from './providers.id.key.put.js'
import providers_id_login_post from './providers.id.login.post.js'
import providers_id_login_delete from './providers.id.login.delete.js'
import providers_catalogue_post from './providers.catalogue.post.js'
import providers_importable_get from './providers.importable.get.js'
import providers_index_get from './providers.index.get.js'
import providers_index_post from './providers.index.post.js'
import permissions_id_post from './permissions.id.post.js'
import permissions_index_get from './permissions.index.get.js'
import tools_id_delete from './tools.id.delete.js'
import tools_id_patch from './tools.id.patch.js'
import tools_index_delete from './tools.index.delete.js'
import tools_index_get from './tools.index.get.js'
import tools_index_patch from './tools.index.patch.js'
import models_get from './models.get.js'
import events_get from './events.get.js'
import health_get from './health.get.js'
import ready_get from './ready.get.js'
import complete_post from './complete.post.js'
import preferences_get from './preferences.get.js'
import preferences_patch from './preferences.patch.js'

/**
 * ── The kernel's routes ──────────────────────────────────────────────────────
 *
 * The machine wire's own surface (docs/MACHINE_WIRE.md), registered by CODE
 * rather than discovered from filenames. The table below IS the contract: one
 * line per endpoint, method and path spelled out, in an order somebody can
 * read top to bottom — which a directory tree never was.
 *
 * Everything here is `kernel`: sessions, the turns they run, the models and
 * providers behind them, the permissions consulted mid-turn, the tools a turn
 * can call, and the event stream all of it is watched through. A plugin's
 * routes carry the plugin's name instead, so `hoshi-harness routes` answers
 * "who owns this endpoint" without a search.
 *
 **/
export function registerKernelRoutes(table: RouteTable): void {
  table.add('DELETE', '/secrets/:key', 'kernel', route_secrets_key_delete)
  table.add('PATCH', '/secrets/:key', 'kernel', route_secrets_key_patch)
  table.add('GET', '/secrets', 'kernel', route_secrets_index_get)
  table.add('POST', '/secrets', 'kernel', route_secrets_index_post)
  table.add('GET', '/system', 'kernel', route_system_get)
  table.add('DELETE', '/workspace', 'kernel', route_workspace_delete)

  table.add('GET', '/plugins', 'kernel', plugins_index_get)
  table.add('GET', '/capabilities', 'kernel', capabilities_get)
  table.add('POST', '/plugins/:name/install', 'kernel', plugins_name_install_post)
  table.add('DELETE', '/sessions/:id', 'kernel', sessions_id_delete)
  table.add('GET', '/sessions/:id', 'kernel', sessions_id_get)
  table.add('PATCH', '/sessions/:id', 'kernel', sessions_id_patch)
  table.add('POST', '/sessions/:id/abort', 'kernel', sessions_id_abort_post)
  table.add('POST', '/sessions/:id/commands', 'kernel', sessions_id_commands_post)
  table.add('POST', '/sessions/:id/compact', 'kernel', sessions_id_compact_post)
  table.add('POST', '/sessions/:id/context', 'kernel', sessions_id_context_post)
  table.add('POST', '/sessions/:id/fork', 'kernel', sessions_id_fork_post)
  table.add('GET', '/sessions/:id/messages', 'kernel', sessions_id_messages_get)
  table.add('POST', '/sessions/:id/messages', 'kernel', sessions_id_messages_post)
  table.add('POST', '/sessions/:id/rewind', 'kernel', sessions_id_rewind_post)
  table.add('POST', '/sessions/:id/shell', 'kernel', sessions_id_shell_post)
  table.add('GET', '/sessions/:id/stream', 'kernel', sessions_id_stream_get)
  table.add('GET', '/sessions', 'kernel', sessions_index_get)
  table.add('POST', '/sessions', 'kernel', sessions_index_post)
  table.add('GET', '/sessions/status', 'kernel', sessions_status_get)
  table.add('DELETE', '/providers/:id', 'kernel', providers_id_delete)
  table.add('DELETE', '/providers/:id/auth', 'kernel', providers_id_auth_delete)
  table.add('PUT', '/providers/:id/key', 'kernel', providers_id_key_put)
  table.add('POST', '/providers/:id/login', 'kernel', providers_id_login_post)
  table.add('DELETE', '/providers/:id/login', 'kernel', providers_id_login_delete)
  table.add('POST', '/providers/catalogue', 'kernel', providers_catalogue_post)
  table.add('GET', '/providers/importable', 'kernel', providers_importable_get)
  table.add('GET', '/providers', 'kernel', providers_index_get)
  table.add('POST', '/providers', 'kernel', providers_index_post)
  table.add('POST', '/permissions/:id', 'kernel', permissions_id_post)
  table.add('GET', '/permissions', 'kernel', permissions_index_get)
  table.add('DELETE', '/tools/:id', 'kernel', tools_id_delete)
  table.add('PATCH', '/tools/:id', 'kernel', tools_id_patch)
  table.add('DELETE', '/tools', 'kernel', tools_index_delete)
  table.add('GET', '/tools', 'kernel', tools_index_get)
  table.add('PATCH', '/tools', 'kernel', tools_index_patch)
  table.add('GET', '/models', 'kernel', models_get)
  table.add('GET', '/events', 'kernel', events_get)
  table.add('GET', '/health', 'kernel', health_get)
  table.add('GET', '/ready', 'kernel', ready_get)
  table.add('POST', '/complete', 'kernel', complete_post)
  table.add('GET', '/preferences', 'kernel', preferences_get)
  table.add('PATCH', '/preferences', 'kernel', preferences_patch)
  table.add('DELETE', '/agents/:name', 'kernel', route_agents_name_delete)
  table.add('PATCH', '/agents/:name', 'kernel', route_agents_name_patch)
  table.add('GET', '/agents', 'kernel', route_agents_index_get)
  table.add('DELETE', '/commands/:name', 'kernel', route_commands_name_delete)
  table.add('PATCH', '/commands/:name', 'kernel', route_commands_name_patch)
  table.add('GET', '/commands', 'kernel', route_commands_index_get)
  table.add('GET', '/starters', 'kernel', route_starters_get)
  table.add('GET', '/profile', 'kernel', route_profile_get)
  table.add('POST', '/setup/complete', 'kernel', route_setup_complete_post)
  table.add('GET', '/integrations', 'kernel', route_integrations_get)
  table.add('DELETE', '/skills/:name', 'kernel', route_skills_name_delete)
  table.add('GET', '/skills', 'kernel', route_skills_index_get)
  table.add('POST', '/skills', 'kernel', route_skills_index_post)
  table.add('GET', '/skills/:name', 'kernel', route_skills_name_get)
  table.add('POST', '/skills/:name/duplicate', 'kernel', route_skills_name_duplicate_post)
  table.add('POST', '/providers/:id/check', 'kernel', route_providers_id_check_post)
  table.add('POST', '/providers/:id/refresh', 'kernel', route_providers_id_refresh_post)
  table.add('GET', '/skill-sources', 'kernel', route_skill_sources_index_get)
  table.add('POST', '/skill-sources', 'kernel', route_skill_sources_index_post)
  table.add('DELETE', '/skill-sources/:id', 'kernel', route_skill_sources_id_delete)
  table.add('GET', '/skill-sources/:id/skills', 'kernel', route_skill_sources_id_skills_get)
  table.add('POST', '/skill-sources/:id/install', 'kernel', route_skill_sources_id_install_post)
  table.add('GET', '/usage/summary', 'kernel', route_usage_summary_get)
  table.add('GET', '/activity', 'kernel', route_activity_get)
}
