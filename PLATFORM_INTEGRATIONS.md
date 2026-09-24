# OpenCode platform integrations

GitHub, GitLab, and Render connect through their official MCP servers for provider-native tools. GitLab's instance-hosted MCP exposes all toolsets, including optional toolsets supported by the configured GitLab instance. Vercel's hosted MCP may restrict client access; the Vercel plugin also provides typed tools and a bounded REST API request as a fallback. GitLab has a token-based REST tool for API endpoints or environments where its MCP tools are unavailable. Provider permissions remain the final access boundary.

## Configure credentials and endpoints

The Render Blueprint supplies the official GitLab.com and Vercel MCP URLs by default. Set these variables on the Render OpenCode service, then redeploy if you use a different endpoint:

- `GITLAB_MCP_URL` — GitLab MCP endpoint; defaults to `https://gitlab.com/api/v4/mcp`. For GitLab Self-Managed, use `https://your-gitlab-host/api/v4/mcp`.
- `VERCEL_MCP_URL` — Vercel MCP endpoint; defaults to `https://mcp.vercel.com`. Override only when connecting to a different compatible MCP server.
- `GITLAB_URL` — GitLab instance base URL for the token-based REST tools; defaults to `https://gitlab.com`.
- `GITLAB_TOKEN` — optional GitLab access token for the REST fallback tools. Use a project or group token where possible; API writes require the corresponding token scope.
- `GITHUB_PERSONAL_ACCESS_TOKEN` — a GitHub personal access token scoped to the repositories and operations OpenCode should use.
- `VERCEL_TOKEN` — a Vercel access token for the account or team.
- `RENDER_API_KEY` — a Render API key scoped to the workspace OpenCode should manage.

Never place token values in this repository, `opencode.jsonc`, or prompts.

## GitHub, GitLab, and Render MCP servers

The project-root `opencode.jsonc` configures GitHub's `all` remote toolset, GitLab's MCP endpoint with `X-Gitlab-Enabled-Mcp-Server-Toolsets: all`, and Render's hosted MCP. GitLab's `all` value requests every toolset supported by the instance, including opt-in repository, issues/work items, merge requests, CI, wiki, code security, and Duo Agent Platform tools. Some tools still depend on the GitLab version, plan, feature availability, and account permissions. GitLab uses OAuth; on first use OpenCode should prompt for authorization, or you can run `opencode mcp auth gitlab_mcp` in a terminal. GitLab.com may require an Owner to allow MCP access for the top-level group.

GitHub tools cover repository changes, issues, pull requests, workflows, and upstream toolsets. Render tools cover workspaces, services, deployments, environment variables, logs, metrics, and supported database operations.

These servers can perform consequential actions with your token's permissions. Keep token scopes and Render API key workspace scope as narrow as possible. OpenCode's tool permission rules can require approval for selected write tools.

## GitLab REST tools

The `gitlab_api` namespace adds `list_projects`, `get_project`, `list_issues`, `list_merge_requests`, `list_pipelines`, and `api_request`. The generic request supports GET, POST, PUT, PATCH, and DELETE under the configured instance's `/api/v4` endpoint, so it can reach other REST API operations allowed by the token. The token-based tools are optional when the official GitLab MCP OAuth connection is working.

Set `GITLAB_URL` only for GitLab Self-Managed or a non-default GitLab base URL. It must be an HTTPS base URL. The request tool keeps calls within that configured instance's REST API; it does not accept arbitrary hostnames. Write and delete requests can change GitLab resources, subject to token scopes and the authenticated user's permissions.

## Vercel namespace

The Vercel namespace keeps typed tools for common read operations and has an `api_request` tool for other documented REST endpoints. Provide an HTTP `method`, path, and optional `query` and JSON `body`. It can manage teams, domains, project environment variables and deployments within the token's access.

Typed tools: `list_projects`, `get_project`, `list_deployments`, `get_deployment`, and `get_deployment_events`.

The Vercel hosted MCP uses OpenCode's remote MCP OAuth flow. Its endpoint can be overridden with `VERCEL_MCP_URL`; if Vercel does not authorize OpenCode as an OAuth client, the REST tools remain available as a fallback.

## Proxy URLs

The Render `/port/{port}/...` proxy routes to processes listening on ports inside this Render container. GitLab and Vercel's hosted MCP endpoints are external services and should keep their official URLs; use endpoint overrides only for a compatible MCP server you host yourself. The REST tools call the provider APIs directly and do not use the port proxy.

## Verification and limits

- REST tool calls use configured provider API origins, bearer authentication, a 30-second timeout, and bounded response sizes. GitLab REST requests stay under the configured GitLab instance API path.
- The request tool validates paths to keep them on the provider API host; it does not proxy arbitrary URLs.
- GitHub's remote `all` toolset and GitLab's all-toolset mode expose many tools. OpenCode lets you turn off individual MCP tools or groups using its `tools` configuration if the model context gets crowded.
- Provider APIs may not expose every feature available in a web dashboard or separate product UI. Tool availability also depends on provider account permissions and instance configuration.
- No credentials are committed to the repository.

## References

- OpenCode MCP server configuration: <https://opencode.ai/v2/docs/mcp-servers>
- GitHub REST API: <https://docs.github.com/en/rest>
- GitLab MCP server: <https://docs.gitlab.com/user/model_context_protocol/mcp_server/>
- GitLab REST API authentication: <https://docs.gitlab.com/api/rest/authentication/>
- Vercel MCP: <https://vercel.com/docs/agent-resources/vercel-mcp>
- Vercel REST API: <https://vercel.com/docs/rest-api>
- Render REST API: <https://render.com/docs/api>
- OpenCode plugin API: <https://opencode.ai/docs/plugins/>
