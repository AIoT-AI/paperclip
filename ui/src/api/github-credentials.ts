import type { GithubCredentialStatus } from "@paperclipai/shared";
import { api } from "./client";

/**
 * Per-company GitHub credential API client. The token is write-only — GET never
 * returns it, only configuration status + the effective repo allowlist.
 */
export const githubCredentialApi = {
  get: (companyId: string) =>
    api.get<GithubCredentialStatus>(`/companies/${encodeURIComponent(companyId)}/github-credential`),
  set: (companyId: string, input: { token: string; allowedOwners?: string[]; allowedRepos?: string[] }) =>
    api.put<GithubCredentialStatus>(`/companies/${encodeURIComponent(companyId)}/github-credential`, input),
  remove: (companyId: string) =>
    api.delete<GithubCredentialStatus>(`/companies/${encodeURIComponent(companyId)}/github-credential`),
};
