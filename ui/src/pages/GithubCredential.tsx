import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Github, Loader2, Trash2 } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { githubCredentialApi } from "../api/github-credentials";
import { ApiError } from "../api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function GithubCredential() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();

  const [token, setToken] = useState("");
  const [allowedOwners, setAllowedOwners] = useState("");
  const [allowedRepos, setAllowedRepos] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "GitHub Access" }]);
  }, [setBreadcrumbs]);

  const queryKey = ["github-credential", selectedCompanyId ?? "__none__"] as const;
  const statusQuery = useQuery({
    queryKey,
    queryFn: () => githubCredentialApi.get(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  // Seed the explicit-allowlist inputs from the loaded status (once per load).
  useEffect(() => {
    if (statusQuery.data) {
      setAllowedOwners(statusQuery.data.allowedOwners.join(", "));
      setAllowedRepos(statusQuery.data.allowedRepos.join(", "));
    }
  }, [statusQuery.data]);

  const setMutation = useMutation({
    mutationFn: () =>
      githubCredentialApi.set(selectedCompanyId!, {
        token: token.trim(),
        allowedOwners: splitList(allowedOwners),
        allowedRepos: splitList(allowedRepos),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      setToken("");
      pushToast({ title: "GitHub credential saved", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to save credential",
        body: error instanceof ApiError ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const removeMutation = useMutation({
    mutationFn: () => githubCredentialApi.remove(selectedCompanyId!),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      setToken("");
      pushToast({ title: "GitHub credential removed", tone: "info" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to remove credential",
        body: error instanceof ApiError ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const status = statusQuery.data;
  const configured = status?.configured ?? false;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Github className="h-5 w-5" />
          <h1 className="text-lg font-bold text-foreground">GitHub Access</h1>
          {configured ? (
            <Badge className="bg-green-600 text-white hover:bg-green-600">Configured</Badge>
          ) : (
            <Badge variant="outline">Not configured</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          This company&apos;s GitHub token. Agents in this company use ONLY this token — never another
          company&apos;s. Use a fine-grained token scoped to just this company&apos;s repos. Managed clones are
          restricted to the repos below. When unset, this company&apos;s agents have no GitHub access.
        </p>
      </header>

      <div className="flex flex-col gap-4 rounded-md border border-border bg-background p-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-foreground" htmlFor="gh-token">
            Token {configured ? "(leave blank to keep current)" : ""}
          </label>
          <Textarea
            id="gh-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="github_pat_… or ghs_…"
            rows={3}
            className="font-mono text-xs"
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-foreground" htmlFor="gh-owners">
              Allowed owners/orgs (extra)
            </label>
            <Input
              id="gh-owners"
              value={allowedOwners}
              onChange={(e) => setAllowedOwners(e.target.value)}
              placeholder="AIOT-EC1"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-foreground" htmlFor="gh-repos">
              Allowed repos (extra)
            </label>
            <Input
              id="gh-repos"
              value={allowedRepos}
              onChange={(e) => setAllowedRepos(e.target.value)}
              placeholder="owner/repo, owner/other"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => setMutation.mutate()}
            disabled={!selectedCompanyId || setMutation.isPending || (!configured && !token.trim())}
          >
            {setMutation.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-1.5 h-4 w-4" />
            )}
            Save
          </Button>
          {configured ? (
            <Button
              variant="outline"
              onClick={() => removeMutation.mutate()}
              disabled={removeMutation.isPending}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              Remove
            </Button>
          ) : null}
        </div>
      </div>

      {/* Effective allowlist (token-scope is the primary boundary; this is the clone guard) */}
      <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-4">
        <p className="text-sm font-medium text-foreground">Repos agents may clone</p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          Derived from this company&apos;s registered project workspaces, plus the extras above.
        </p>
        {status && status.derivedRepos.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {status.derivedRepos.map((repo) => (
              <Badge key={repo} variant="outline" className="font-mono text-[11px]">
                {repo}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No repos registered yet.</p>
        )}
      </div>
    </div>
  );
}
