/**
 * Per-company GitHub credential contract.
 *
 * A company's GitHub token (PAT or installation token) is stored as a normal
 * `company_secrets` row marked with `providerMetadata.secretType ===
 * GITHUB_CREDENTIAL_SECRET_TYPE` — the same marker pattern the account-pool feature
 * uses with `poolType`. The secret VALUE is the raw token; the marker + optional
 * allowlist live in `providerMetadata`. No dedicated table / migration.
 *
 * Why: the deployment used to inject ONE global `GITHUB_TOKEN` into every agent run
 * across all companies, so a company's agents could reach another company's repos.
 * Scoping the credential per company (plus an allowlist enforced at clone) closes
 * that cross-org leak.
 */

/** providerMetadata.secretType marker identifying a company's GitHub credential row */
export const GITHUB_CREDENTIAL_SECRET_TYPE = "github_credentials" as const;

/** stable secret name for a company's GitHub credential (one per company) */
export const GITHUB_CREDENTIAL_SECRET_NAME = "github-credentials" as const;

/**
 * providerMetadata shape for a github_credentials secret.
 * A `type` alias (not interface) so it carries an implicit index signature and is
 * assignable to the `Record<string, unknown>` that the secrets service expects.
 */
export type GithubCredentialMetadata = {
  secretType: typeof GITHUB_CREDENTIAL_SECRET_TYPE;
  /** extra GitHub owners/orgs this company may touch beyond its registered workspaces */
  allowedOwners?: string[];
  /** extra "owner/repo" entries this company may touch beyond its registered workspaces */
  allowedRepos?: string[];
};

/** GET /companies/:companyId/github-credential response — never includes the token */
export interface GithubCredentialStatus {
  /** whether a github_credentials secret exists for this company */
  configured: boolean;
  /** explicit owners from the credential metadata */
  allowedOwners: string[];
  /** explicit "owner/repo" entries from the credential metadata */
  allowedRepos: string[];
  /** "owner/repo" entries derived from the company's project_workspaces repo URLs */
  derivedRepos: string[];
}
