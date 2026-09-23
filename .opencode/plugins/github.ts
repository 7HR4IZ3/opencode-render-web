import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import { boundedLimit, getJson, jsonContent, pathSegment, queryUrl, requiredToken } from "./platform-api";

const repositoryInput = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
});

const repositoryListInput = Schema.Struct({
  visibility: Schema.optional(Schema.String),
  affiliation: Schema.optional(Schema.String),
  perPage: Schema.optional(Schema.Number),
});

const fileInput = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  path: Schema.String,
  ref: Schema.optional(Schema.String),
});

const listInput = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  state: Schema.optional(Schema.String),
  perPage: Schema.optional(Schema.Number),
});

const searchInput = Schema.Struct({
  query: Schema.String,
  perPage: Schema.optional(Schema.Number),
});

function githubUrl(path: string, params: Record<string, string | number | undefined> = {}) {
  return queryUrl(`https://api.github.com${path}`, params);
}

function githubHeaders() {
  return { "X-GitHub-Api-Version": "2022-11-28" };
}

async function githubGet<T>(url: string) {
  return getJson<T>("GitHub", url, requiredToken("GITHUB_PERSONAL_ACCESS_TOKEN"), githubHeaders());
}

function repositoryPath(owner: string, repo: string) {
  return `/repos/${pathSegment(owner)}/${pathSegment(repo)}`;
}

export default Plugin.define({
  id: "opencode.github-readonly",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "github",
        description: "Read-only GitHub repository, code, issue, pull request, and Actions tools.",
      });

      editor.add({
        name: "list_repositories",
        description: "List GitHub repositories visible to the configured account.",
        input: repositoryListInput,
        options: { namespace: "github" },
        execute: async ({ visibility, affiliation, perPage }) => jsonContent(githubGet(
          githubUrl("/user/repos", {
            visibility,
            affiliation,
            sort: "updated",
            per_page: boundedLimit(perPage, 30, 100),
          }),
        )),
      });

      editor.add({
        name: "get_repository",
        description: "Get repository metadata, default branch, and permissions.",
        input: repositoryInput,
        options: { namespace: "github" },
        execute: async ({ owner, repo }) => jsonContent(githubGet(
          `https://api.github.com${repositoryPath(owner, repo)}`,
        )),
      });

      editor.add({
        name: "get_file",
        description: "Read a text file from a GitHub repository and return its decoded contents.",
        input: fileInput,
        options: { namespace: "github" },
        execute: async ({ owner, repo, path, ref }) => {
          const safePath = path.split("/").map(pathSegment).join("/");
          const result = await githubGet<{
            type?: string;
            name?: string;
            path?: string;
            sha?: string;
            size?: number;
            encoding?: string;
            content?: string;
            download_url?: string | null;
          }>(githubUrl(`${repositoryPath(owner, repo)}/contents/${safePath}`, { ref }));

          if (result.type !== "file") return jsonContent(result);
          if (result.encoding !== "base64" || !result.content) {
            return jsonContent({ path: result.path, sha: result.sha, size: result.size, content: null, note: "GitHub did not return inline text content for this file." });
          }

          const binary = atob(result.content.replace(/\s/g, ""));
          const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
          try {
            return jsonContent({
              path: result.path,
              sha: result.sha,
              size: result.size,
              content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            });
          } catch {
            return jsonContent({ path: result.path, sha: result.sha, size: result.size, content: null, note: "This file is not valid UTF-8 text." });
          }
        },
      });

      editor.add({
        name: "search_code",
        description: "Search code in repositories accessible to the configured GitHub account.",
        input: searchInput,
        options: { namespace: "github" },
        execute: async ({ query, perPage }) => jsonContent(githubGet(
          githubUrl("/search/code", {
            q: query,
            per_page: boundedLimit(perPage, 20, 100),
          }),
        )),
      });

      editor.add({
        name: "list_issues",
        description: "List issues in a repository. Pull requests are excluded from this result.",
        input: listInput,
        options: { namespace: "github" },
        execute: async ({ owner, repo, state, perPage }) => {
          const issues = await githubGet<Array<Record<string, unknown>>>(
            githubUrl(`${repositoryPath(owner, repo)}/issues`, {
              state: state ?? "open",
              per_page: boundedLimit(perPage, 30, 100),
            }),
          );
          return jsonContent(issues.filter((item) => !item.pull_request));
        },
      });

      editor.add({
        name: "list_pull_requests",
        description: "List pull requests in a repository.",
        input: listInput,
        options: { namespace: "github" },
        execute: async ({ owner, repo, state, perPage }) => jsonContent(githubGet(
          githubUrl(`${repositoryPath(owner, repo)}/pulls`, {
            state: state ?? "open",
            per_page: boundedLimit(perPage, 30, 100),
          }),
        )),
      });

      editor.add({
        name: "list_workflow_runs",
        description: "List recent GitHub Actions workflow runs for a repository.",
        input: Schema.Struct({
          owner: Schema.String,
          repo: Schema.String,
          perPage: Schema.optional(Schema.Number),
        }),
        options: { namespace: "github" },
        execute: async ({ owner, repo, perPage }) => jsonContent(githubGet(
          githubUrl(`${repositoryPath(owner, repo)}/actions/runs`, {
            per_page: boundedLimit(perPage, 20, 100),
          }),
        )),
      });
    });
  },
});
