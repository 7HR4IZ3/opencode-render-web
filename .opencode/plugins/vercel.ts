import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import { boundedLimit, envValue, getJson, pathSegment, queryUrl, requiredToken } from "./platform-api";

const projectInput = Schema.Struct({
  project: Schema.String,
  teamId: Schema.optional(Schema.String),
});

const deploymentInput = Schema.Struct({
  deployment: Schema.String,
  teamId: Schema.optional(Schema.String),
});

function vercelUrl(path: string, params: Record<string, string | number | undefined> = {}) {
  return queryUrl(`https://api.vercel.com${path}`, params);
}

async function vercelGet<T>(url: string) {
  return getJson<T>("Vercel", url, requiredToken("VERCEL_TOKEN"));
}

function selectedTeam(teamId?: string) {
  return teamId ?? envValue("VERCEL_TEAM_ID");
}

export default Plugin.define({
  id: "opencode.vercel-readonly",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "vercel",
        description: "Read-only Vercel project, deployment, and build log tools.",
      });

      editor.add({
        name: "list_projects",
        description: "List projects available to the configured Vercel account or team.",
        input: Schema.Struct({
          teamId: Schema.optional(Schema.String),
          limit: Schema.optional(Schema.Number),
        }),
        options: { namespace: "vercel" },
        execute: async ({ teamId, limit }) => vercelGet(
          vercelUrl("/v9/projects", {
            teamId: selectedTeam(teamId),
            limit: boundedLimit(limit, 20, 100),
          }),
        ),
      });

      editor.add({
        name: "get_project",
        description: "Get project configuration and deployment metadata by project name or ID.",
        input: projectInput,
        options: { namespace: "vercel" },
        execute: async ({ project, teamId }) => vercelGet(
          vercelUrl(`/v9/projects/${pathSegment(project)}`, { teamId: selectedTeam(teamId) }),
        ),
      });

      editor.add({
        name: "list_deployments",
        description: "List deployments, optionally filtered by project, target, or state.",
        input: Schema.Struct({
          projectId: Schema.optional(Schema.String),
          teamId: Schema.optional(Schema.String),
          target: Schema.optional(Schema.String),
          state: Schema.optional(Schema.String),
          limit: Schema.optional(Schema.Number),
        }),
        options: { namespace: "vercel" },
        execute: async ({ projectId, teamId, target, state, limit }) => vercelGet(
          vercelUrl("/v6/deployments", {
            projectId,
            teamId: selectedTeam(teamId),
            target,
            state,
            limit: boundedLimit(limit, 20, 100),
          }),
        ),
      });

      editor.add({
        name: "get_deployment",
        description: "Get deployment state, target, project, and deployment URL.",
        input: deploymentInput,
        options: { namespace: "vercel" },
        execute: async ({ deployment, teamId }) => vercelGet(
          vercelUrl(`/v13/deployments/${pathSegment(deployment)}`, { teamId: selectedTeam(teamId) }),
        ),
      });

      editor.add({
        name: "get_deployment_events",
        description: "Read a bounded page of build events for a deployment. Live streaming is disabled.",
        input: Schema.Struct({
          deployment: Schema.String,
          teamId: Schema.optional(Schema.String),
          buildId: Schema.optional(Schema.String),
          since: Schema.optional(Schema.Number),
          until: Schema.optional(Schema.Number),
          limit: Schema.optional(Schema.Number),
        }),
        options: { namespace: "vercel" },
        execute: async ({ deployment, teamId, buildId, since, until, limit }) => vercelGet(
          vercelUrl(`/v3/deployments/${pathSegment(deployment)}/events`, {
            teamId: selectedTeam(teamId),
            name: buildId,
            since,
            until,
            direction: "backward",
            follow: 0,
            limit: boundedLimit(limit, 100, 250),
          }),
        ),
      });
    });
  },
});
