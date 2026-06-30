/**
 * Env hygiene helpers for agent execution.
 *
 * The server process may carry a global `GITHUB_TOKEN` (e.g. for server-side
 * GitHub API rate limits). That token must NOT leak into an agent's subprocess
 * env, or one company's agents could authenticate against another company's
 * repos. Per-company GitHub access is injected explicitly by the run-config
 * assembly instead. Call this when building any agent-facing / managed-clone env.
 */

/** GitHub credential env var names that must never be inherited from the server. */
export const INHERITED_GITHUB_TOKEN_ENV_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT"] as const;

/**
 * Delete inherited GitHub credential env vars from an env object IN PLACE and
 * return it. A per-company token (when configured) is set explicitly afterward,
 * so removing the inherited globals is safe and closes the cross-company leak.
 */
export function stripInheritedGithubTokens<T extends Record<string, unknown>>(env: T): T {
  for (const key of INHERITED_GITHUB_TOKEN_ENV_KEYS) {
    delete (env as Record<string, unknown>)[key];
  }
  return env;
}
