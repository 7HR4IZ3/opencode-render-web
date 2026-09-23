# OpenCode platform integrations

GitHub, GitLab, and Render connect through their official MCP servers for provider-native tools. GitLab's instance-hosted MCP uses OAuth and exposes its default repository, issue/work item, merge request, and CI toolsets. Vercel's hosted MCP requires an approved client and does not currently list OpenCode, so the Vercel plugin retains typed tools and a bounded REST API request as its fallback. GitLab also has a token-based REST tool for API endpoints or environments where its MCP tools are unavailable. Provider permissions remain the final access boundary.

## Configure credentials

Set these variables on the Render OpenCode service, then redeploy:

- `GITHUB_PERSONAL_ACCESS_TOKEN` — a GitHub personal access token scoped to the repositories and operations OpenCode should use. Read and write actions require the corresponding token permissions.
- `VERCEL_TOKEN` — a Vercel access token for the account or team. Keep it limited to the projects and operations needed.
- `RENDER_API_KEY` — a Render API key scoped to the workspace OpenCode should manage.
- `GITLAB_TOKEN` — optional GitLab access token for the REST fallback tools. Use a project or group token where possible; API writes require the corresponding token scope.
- `GITLAB_URL` — optional HTTPS GitLab instance base URL for the REST fallback. Defaults to `https://gitlab.com`.

Never place token values in this repository, `opencode.jsonc`, or prompts.

## GitHub, GitLab, and Render MCP servers

The project-root `opencode.jsonc` configures GitHub's `all` remote toolset, GitLab's instance-hosted MCP at `https://gitlab.com/api/v4/mcp`, and Render's hosted MCP. GitLab uses OAuth; on first use OpenCode should prompt for authorization, or you can run `opencode mcp auth gitlab_mcp` in a terminal. GitLab.com may require an Owner to allow MCP access for the top-level group. Its default toolsets cover core project operations, repository files, issues/work items, merge requests, and CI. GitHub tools cover repository changes, issues, pull requests, workflows, and upstream toolsets. Render tools cover workspaces, services, deployments, environment variables, logs, metrics, and supported database operations.

These servers can perform consequential actions with your token's permissions. Keep token scopes and Render API key workspace scope as narrow as possible. OpenCode's tool permission rules can require approval for selected write tools.

## GitLab REST tools

The `gitlab_api` namespace adds `list_projects`, `get_project`, `list_issues`, `list_merge_requests`, `list_pipelines`, and `api_request`. These use `GITLAB_TOKEN`; the generic request supports GET, POST, PUT, PATCH, and DELETE under the configured instance's `/api/v4` endpoint. The token-based tools are optional when the official GitLab MCP OAuth connection is working.

Set `GITLAB_URL` only for GitLab Self-Managed or a non-default GitLab base URL. It must be an HTTPS base URL. The request tool keeps calls within that configured instance's REST API; it does not accept arbitrary hostnames. Write and delete requests can change GitLab resources, subject to token scopes and the authenticated user's permissions.

## Vercel namespace

The Vercel namespace keeps typed tools for common read operations and has an `api_request` tool for other documented REST endpoints. Provide an HTTP `method`, path, and optional `query` and JSON `body`. It can manage teams, domains, project environment variables and deployments within the token's access.

Typed tools: `list_projects`, `get_project`, `list_deployments`, `get_deployment`, and `get_deployment_events`.

The Vercel hosted MCP is enabled in the default OpenCode configuration alongside the REST tools. It uses OpenCode's remote MCP OAuth flow; Vercel's current approved-client list does not yet include OpenCode, so authentication may be rejected. The REST tools remain available as a fallback.

## Verification and limits

- REST tool calls use configured provider API origins, bearer authentication, a 30-second timeout, and bounded response sizes. GitLab REST requests stay under the configured GitLab instance API path.
- The request tool validates paths to keep them on the provider API host; it does not proxy arbitrary URLs.
- GitHub's remote `all` toolset is large. GitLab MCP's default tool groups are enabled; GitLab offers additional opt-in toolsets depending on instance support. OpenCode lets you turn off individual MCP tools or groups using its `tools` configuration if the model context gets crowded.
- Provider APIs may not expose every feature available in a web dashboard or separate product UI. Use the official MCP client integration where a provider requires an approved OAuth client.
- No credentials are committed to the repository.

## References

- OpenCode MCP server configuration: <https://opencode.ai/v2/docs/mcp-servers>
- GitHub REST API: <https://docs.github.com/en/rest>
- GitLab MCP server: <https://docs.gitlab.com/user/model_context_protocol/mcp_server/>
- GitLab REST API authentication: <https://docs.gitlab.com/api/rest/authentication/>
- Vercel REST API: <https://vercel.com/docs/rest-api>
- Render REST API: <https://render.com/docs/api>
- OpenCode plugin API: <https://opencode.ai/docs/plugins/>
