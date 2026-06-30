import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, projectWorkspaces } from "@paperclipai/db";
import {
  GITHUB_CREDENTIAL_SECRET_TYPE,
  type GithubCredentialMetadata,
} from "@paperclipai/shared";
import { secretService } from "./secrets.js";

/**
 * Per-company GitHub credential resolution + repo allowlist.
 *
 * The credential is a `company_secrets` row marked with
 * `providerMetadata.secretType === GITHUB_CREDENTIAL_SECRET_TYPE` (same marker
 * pattern as account-pool's `poolType`). The secret value is the raw token.
 *
 * These helpers let the run path inject ONLY the company's own token into an
 * agent (the global GITHUB_TOKEN is stripped elsewhere) and validate that a
 * repo being cloned belongs to that company — closing the cross-org leak that
 * let one company's agents push into another company's repo.
 */

type CompanySecretRow = typeof companySecrets.$inferSelect;

function readGithubMetadata(metadata: unknown): GithubCredentialMetadata | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).secretType;
  if (value !== GITHUB_CREDENTIAL_SECRET_TYPE) return null;
  return metadata as GithubCredentialMetadata;
}

/** The active github_credentials secret row for a company, or null when none. */
export async function findGithubCredentialRow(db: Db, companyId: string): Promise<CompanySecretRow | null> {
  const rows = await db
    .select()
    .from(companySecrets)
    .where(and(eq(companySecrets.companyId, companyId), ne(companySecrets.status, "deleted")));
  return rows.find((row) => readGithubMetadata(row.providerMetadata) !== null) ?? null;
}

/**
 * The company's own GitHub token (decrypted), or null when no credential is
 * configured. Callers MUST treat null as "this company has no GitHub access"
 * (no global fallback) — that is the intended secure-by-default behavior.
 */
export async function resolveCompanyGithubToken(db: Db, companyId: string): Promise<string | null> {
  const row = await findGithubCredentialRow(db, companyId);
  if (!row) return null;
  try {
    const token = await secretService(db).resolveSecretValue(companyId, row.id, "latest", {
      consumerType: "run",
      consumerId: companyId,
      configPath: "github-credentials",
      actorType: "system",
    });
    const trimmed = typeof token === "string" ? token.trim() : "";
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** Parse a git/GitHub URL into { owner, repo } (lowercased), or null. */
export function parseRepoIdentity(repoUrl: string | null | undefined): { owner: string; repo: string } | null {
  const trimmed = repoUrl?.trim() ?? "";
  if (!trimmed) return null;
  // Support https URLs and scp-like git@host:owner/repo.git
  let pathPart: string;
  try {
    pathPart = new URL(trimmed).pathname;
  } catch {
    const scp = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
    if (!scp) return null;
    pathPart = scp[1];
  }
  const segments = pathPart.replace(/^\/+/, "").replace(/\/+$/, "").split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0].toLowerCase();
  const repo = segments[1].replace(/\.git$/i, "").toLowerCase();
  if (!owner || !repo) return null;
  return { owner, repo };
}

export interface CompanyRepoAllowlist {
  owners: Set<string>;
  repos: Set<string>;
}

/**
 * Repos a company's agents may touch: derived from the owner/repo of each of the
 * company's registered project_workspaces, UNION any explicit allowedOwners /
 * allowedRepos from the github credential metadata. All lowercased.
 */
export async function resolveCompanyAllowedRepos(db: Db, companyId: string): Promise<CompanyRepoAllowlist> {
  const owners = new Set<string>();
  const repos = new Set<string>();

  const workspaces = await db
    .select({ repoUrl: projectWorkspaces.repoUrl })
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.companyId, companyId));
  for (const ws of workspaces) {
    const id = parseRepoIdentity(ws.repoUrl);
    if (id) {
      owners.add(id.owner);
      repos.add(`${id.owner}/${id.repo}`);
    }
  }

  const row = await findGithubCredentialRow(db, companyId);
  const meta = row ? readGithubMetadata(row.providerMetadata) : null;
  for (const owner of meta?.allowedOwners ?? []) {
    if (typeof owner === "string" && owner.trim()) owners.add(owner.trim().toLowerCase());
  }
  for (const repo of meta?.allowedRepos ?? []) {
    if (typeof repo === "string" && repo.includes("/")) repos.add(repo.trim().toLowerCase());
  }

  return { owners, repos };
}

/**
 * Whether a repo URL is allowed for a company. A repo passes when its OWNER is
 * allowed (covers any repo within the company's org) or the exact owner/repo is
 * explicitly allowlisted. An unparseable URL is rejected.
 */
export function isRepoAllowed(repoUrl: string | null | undefined, allow: CompanyRepoAllowlist): boolean {
  const id = parseRepoIdentity(repoUrl);
  if (!id) return false;
  if (allow.owners.has(id.owner)) return true;
  return allow.repos.has(`${id.owner}/${id.repo}`);
}
