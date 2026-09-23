import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import { boundedLimit, getJson, jsonContent, pathSegment, queryUrl, requiredToken } from "./platform-api";

const serviceInput = Schema.Struct({ serviceId: Schema.String });

function renderUrl(path: string, params: Record<string, string | number | undefined> = {}) {
  return queryUrl(`https://api.render.com/v1${path}`, params);
}

async function renderGet<T>(url: string) {
  return getJson<T>("Render", url, requiredToken("RENDER_API_KEY"));
}

export default Plugin.define({
  id: "opencode.render-readonly",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "render",
        description: "Read-only Render service, deployment, logs, and metrics tools.",
      });

      editor.add({
        name: "list_services",
        description: "List Render services, optionally filtered to a workspace owner ID.",
        input: Schema.Struct({
          ownerId: Schema.optional(Schema.String),
          name: Schema.optional(Schema.String),
          type: Schema.optional(Schema.String),
          limit: Schema.optional(Schema.Number),
        }),
        options: { namespace: "render" },
        execute: async ({ ownerId, name, type, limit }) => jsonContent(renderGet(
          renderUrl("/services", {
            ownerId,
            name,
            type,
            limit: boundedLimit(limit, 20, 100),
          }),
        )),
      });

      editor.add({
        name: "get_service",
        description: "Get the configuration and current state of a Render service.",
        input: serviceInput,
        options: { namespace: "render" },
        execute: async ({ serviceId }) => jsonContent(renderGet(
          `https://api.render.com/v1/services/${pathSegment(serviceId)}`,
        )),
      });

      editor.add({
        name: "list_deploys",
        description: "List recent deploys for a Render service.",
        input: Schema.Struct({
          serviceId: Schema.String,
          limit: Schema.optional(Schema.Number),
          status: Schema.optional(Schema.String),
        }),
        options: { namespace: "render" },
        execute: async ({ serviceId, limit, status }) => jsonContent(renderGet(
          renderUrl(`/services/${pathSegment(serviceId)}/deploys`, {
            limit: boundedLimit(limit, 20, 100),
            status,
          }),
        )),
      });

      editor.add({
        name: "list_logs",
        description: "Query Render logs. Supply the workspace owner ID and at least one resource ID.",
        input: Schema.Struct({
          ownerId: Schema.String,
          resourceIds: Schema.Array(Schema.String),
          startTime: Schema.optional(Schema.String),
          endTime: Schema.optional(Schema.String),
          direction: Schema.optional(Schema.String),
          level: Schema.optional(Schema.String),
          type: Schema.optional(Schema.String),
          text: Schema.optional(Schema.String),
          path: Schema.optional(Schema.String),
          statusCode: Schema.optional(Schema.String),
          limit: Schema.optional(Schema.Number),
        }),
        options: { namespace: "render" },
        execute: async ({ ownerId, resourceIds, startTime, endTime, direction, level, type, text, path, statusCode, limit }) => {
          if (resourceIds.length === 0 || resourceIds.length > 20) {
            throw new Error("Provide between 1 and 20 Render resource IDs.");
          }
          return jsonContent(renderGet(
            renderUrl("/logs", {
              ownerId,
              resource: resourceIds,
              startTime,
              endTime,
              direction: direction ?? "backward",
              level,
              type,
              text,
              path,
              statusCode,
              limit: boundedLimit(limit, 100, 100),
            }),
          ));
        },
      });

      editor.add({
        name: "get_metrics",
        description: "Read CPU, memory, HTTP request, latency, or instance-count metrics for a Render resource.",
        input: Schema.Struct({
          resourceId: Schema.String,
          metricTypes: Schema.Array(Schema.String),
          startTime: Schema.optional(Schema.String),
          endTime: Schema.optional(Schema.String),
          resolutionSeconds: Schema.optional(Schema.Number),
          quantile: Schema.optional(Schema.Number),
        }),
        options: { namespace: "render" },
        execute: async ({ resourceId, metricTypes, startTime, endTime, resolutionSeconds, quantile }) => {
          const paths: Record<string, string> = {
            cpu_usage: "/metrics/cpu",
            memory_usage: "/metrics/memory",
            http_request_count: "/metrics/http-requests",
            http_latency: "/metrics/http-latency",
            instance_count: "/metrics/instance-count",
          };
          const uniqueTypes = [...new Set(metricTypes)];
          if (uniqueTypes.length === 0 || uniqueTypes.some((type) => !paths[type])) {
            throw new Error("metricTypes must contain cpu_usage, memory_usage, http_request_count, http_latency, or instance_count.");
          }
          const results = await Promise.all(uniqueTypes.map(async (type) => ({
            type,
            data: await renderGet(
              renderUrl(paths[type]!, {
                resource: resourceId,
                startTime,
                endTime,
                resolutionSeconds: resolutionSeconds === undefined
                  ? undefined
                  : Math.max(30, Math.min(3600, Math.floor(resolutionSeconds))),
                ...(type === "http_latency" ? { quantile: quantile ?? 0.95 } : {}),
              }),
            ),
          })));
          return jsonContent({ resourceId, metrics: results });
        },
      });
    });
  },
});
