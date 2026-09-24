import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import { apiRequest, boundedLimit, envValue, jsonContent, type ApiMethod } from "./platform-api";

type GitLabQuery = Record<string, string | number | boolean | undefined | Array<string>>;

function gitlabApiRoot() {
  const configured = (envValue("GITLAB_URL") || "https://gitlab.com").trim();
  let base: URL;
  try {
    base = new URL(configured);
  } catch {
    throw new Error("GITLAB_URL must be an HTTPS GitLab instance URL, such as https://gitlab.com.");
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("GITLAB_URL must be an HTTPS base URL without credentials, query, or fragment.");
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  return {
    origin: base.origin,
    apiPath: `${prefix}/api/v4`,
  };
}

function gitlabMethod(value: string): ApiMethod {
  const allowed: ApiMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  if (!allowed.includes(value as ApiMethod)) {
    throw new Error(`method must be one of: ${allowed.join(", ")}`);
  }
  return value as ApiMethod;
}

function projectRef(project: string) {
  const normalized = project.trim();
  if (!normalized || normalized.includes("\0") || normalized === "." || normalized === "..") {
    throw new Error("A GitLab project ID or path is required.");
  }
  return encodeURIComponent(normalized);
}

async function gitlabRequest(
  path: string,
  method: ApiMethod = "GET",
  query: GitLabQuery = {},
  body?: unknown,
) {
  const { origin, apiPath } = gitlabApiRoot();
  return apiRequest(
    "GitLab",
    origin,
    apiPath,
    path,
    method,
    (envValue("GITLAB_TOKEN") || "").trim() || missingToken(),
    query,
    body,
  );
}

function missingToken(): never {
  throw new Error("GITLAB_TOKEN is not configured on the OpenCode server. The GitLab MCP OAuth connection does not require this token.");
}

const querySchema = Schema.Record(
  Schema.String,
  Schema.Union([
    Schema.String,
    Schema.Number,
    Schema.Boolean,
    Schema.Array(Schema.String),
  ]),
);

export default Plugin.define({
  id: "opencode.gitlab",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "gitlab_api",
        description: "GitLab REST API tools for projects, issues, merge requests, pipelines, and other API resources.",
      });

      editor.add({
        name: "api_request",
        description: "Call any GitLab REST API v4 endpoint using GITLAB_TOKEN. Supports GET, POST, PUT, PATCH, and DELETE. Write methods can change or delete GitLab resources; access is limited by the token's scopes and user permissions.",
        input: Schema.Struct({
          method: Schema.String,
          path: Schema.String,
          query: Schema.optional(querySchema),
          body: Schema.optional(Schema.Unknown),
        }),
        options: { namespace: "gitlab_api" },
        execute: async ({ method, path, query, body }) => jsonContent(gitlabRequest(
          path,
          gitlabMethod(method),
          query,
          body,
        )),
      });

      editor.add({
        name: "list_projects",
        description: "List projects the authenticated GitLab user belongs to, optionally filtered by search text.",
        input: Schema.Struct({
          search: Schema.optional(Schema.String),
          limit: Schema.optional(Schema.Number),
        }),
        options: { namespace: "gitlab_api" },
        execute: async ({ search, limit }) => jsonContent(gitlabRequest("/projects", "GET", {
          membership: true,
          simple: true,
          search,
          per_page: boundedLimit(limit, 20, 100),
        })),
      });

      editor.add({
        name: "get_project",
        description: "Get project details by numeric ID or URL-encoded namespace/project path.",
        input: Schema.Struct({ project: Schema.String }),
        options: { namespace: "gitlab_api" },
        execute: async ({ project }) => jsonContent(gitlabRequest(
          `/projects/${projectRef(project)}`,
        )),
      });

      editor.add({
        name: "list_issues",
        description: "List issues for a project, optionally filtered by state and labels.",
        input: Schema.Struct({
          project: Schema.String,
          state: Schema.optional(Schema.String),
          labels: Schema.optional(Schema.String),
          limit: Schema.optional(Schema.Number),
        }),
        options: { namespace: "gitlab_api" },
        execute: async ({ project, state, labels, limit }) => jsonContent(gitlabRequest(
          `/projects/${projectRef(project)}/issues`,
          "GET",
          { state, labels, per_page: boundedLimit(limit, 20, 100) },
        )),
      });

      editor.add({
        name: "list_merge_requests",
        description: "List merge requests for a project, optionally filtered by state or source/target branch.",
        input: Schema.Struct({
          project: Schema.String,
          state: Schema.optional(Schema.String),
          sourceBranch: Schema.optional(Schema.String),
          targetBranch: Schema.optional(Schema.String),
          limit: Schema.optional(Schema.Number),
        }),
        options: { namespace: "gitlab_api" },
        execute: async ({ project, state, sourceBranch, targetBranch, limit }) => jsonContent(gitlabRequest(
          `/projects/${projectRef(project)}/merge_requests`,
          "GET",
          {
            state,
            source_branch: sourceBranch,
            target_branch: targetBranch,
            per_page: boundedLimit(limit, 20, 100),
          },
        )),
      });

      editor.add({
        name: "list_pipelines",
        description: "List CI/CD pipelines for a project, optionally filtered by ref and status.",
        input: Schema.Struct({
          project: Schema.String,
          ref: Schema.optional(Schema.String),
          status: Schema.optional(Schema.String),
          limit: Schema.optional(Schema.Number),
        }),
        options: { namespace: "gitlab_api" },
        execute: async ({ project, ref, status, limit }) => jsonContent(gitlabRequest(
          `/projects/${projectRef(project)}/pipelines`,
          "GET",
          { ref, status, per_page: boundedLimit(limit, 20, 100) },
        )),
      });
    }).catch((error) => {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error("[opencode.gitlab] tool.transform failed:", detail);
      throw error;
    });
  },
});
