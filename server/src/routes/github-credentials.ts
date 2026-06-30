import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  GITHUB_CREDENTIAL_SECRET_TYPE,
  GITHUB_CREDENTIAL_SECRET_NAME,
  type GithubCredentialMetadata,
  type GithubCredentialStatus,
} from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, secretService } from "../services/index.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import {
  findGithubCredentialRow,
  resolveCompanyAllowedRepos,
} from "../services/github-credentials.js";

/**
 * Per-company GitHub credential management.
 *
 * One credential per company, stored as a `company_secrets` row named
 * GITHUB_CREDENTIAL_SECRET_NAME and marked
 * `providerMetadata.secretType === GITHUB_CREDENTIAL_SECRET_TYPE`. The token
 * itself is never returned by GET. Agents receive only their own company's token
 * at run time (the global GITHUB_TOKEN is stripped from agent env), and managed
 * clones are restricted to the company's allowed repos.
 */
export function githubCredentialRoutes(db: Db) {
  const router = Router();
  const svc = secretService(db);
  const defaultProvider = getConfiguredSecretProvider();

  function requireCompanyId(req: Parameters<Parameters<typeof router.get>[1]>[0]): string {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  function readMetadata(metadata: unknown): GithubCredentialMetadata | null {
    if (!metadata || typeof metadata !== "object") return null;
    if ((metadata as Record<string, unknown>).secretType !== GITHUB_CREDENTIAL_SECRET_TYPE) return null;
    return metadata as GithubCredentialMetadata;
  }

  function sanitizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }

  async function buildStatus(companyId: string): Promise<GithubCredentialStatus> {
    const [row, allow] = await Promise.all([
      findGithubCredentialRow(db, companyId),
      resolveCompanyAllowedRepos(db, companyId),
    ]);
    const meta = row ? readMetadata(row.providerMetadata) : null;
    return {
      configured: Boolean(row),
      allowedOwners: meta?.allowedOwners ?? [],
      allowedRepos: meta?.allowedRepos ?? [],
      derivedRepos: Array.from(allow.repos).sort(),
    };
  }

  // GET — never returns the token, only configuration status + effective allowlist.
  router.get("/companies/:companyId/github-credential", async (req, res) => {
    const companyId = requireCompanyId(req);
    res.json(await buildStatus(companyId));
  });

  // PUT — set/replace the company's GitHub token + optional explicit allowlist.
  router.put("/companies/:companyId/github-credential", async (req, res) => {
    const companyId = requireCompanyId(req);
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token) {
      res.status(400).json({ error: "token is required" });
      return;
    }
    const providerMetadata: GithubCredentialMetadata = {
      secretType: GITHUB_CREDENTIAL_SECRET_TYPE,
      allowedOwners: sanitizeStringList(req.body?.allowedOwners),
      allowedRepos: sanitizeStringList(req.body?.allowedRepos),
    };

    const existing = await findGithubCredentialRow(db, companyId);
    const actor = { userId: req.actor.userId ?? "board", agentId: null };
    if (existing) {
      await svc.rotate(existing.id, { value: token }, actor);
      await svc.update(existing.id, { providerMetadata });
    } else {
      await svc.create(
        companyId,
        {
          name: GITHUB_CREDENTIAL_SECRET_NAME,
          provider: defaultProvider,
          managedMode: "paperclip_managed",
          value: token,
          description: "Per-company GitHub credential (token + repo allowlist)",
          providerMetadata,
        },
        actor,
      );
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: existing ? "github_credential.rotated" : "github_credential.created",
      entityType: "company",
      entityId: companyId,
      details: {
        allowedOwners: providerMetadata.allowedOwners,
        allowedRepos: providerMetadata.allowedRepos,
      },
    });

    res.json(await buildStatus(companyId));
  });

  // DELETE — remove the company's GitHub credential (agents lose GitHub access).
  router.delete("/companies/:companyId/github-credential", async (req, res) => {
    const companyId = requireCompanyId(req);
    const existing = await findGithubCredentialRow(db, companyId);
    if (existing) {
      await svc.remove(existing.id);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "github_credential.deleted",
        entityType: "company",
        entityId: companyId,
        details: {},
      });
    }
    res.json(await buildStatus(companyId));
  });

  return router;
}
