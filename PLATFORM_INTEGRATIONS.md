# OpenCode platform integrations

GitHub and Render connect through their official hosted MCP servers, so their upstream toolsets stay current and provide broad read/write operations. Vercel's hosted MCP currently only accepts Vercel-approved clients, and OpenCode is not on its published client list; the Vercel plugin therefore uses its REST API with practical typed tools and a bounded, general REST request. The Vercel request tool reaches documented API features including operations that create, edit, deploy, or delete resources. It uses a fixed HTTPS API origin; prompts cannot supply a hostname or change the HTTP method beyond GET, POST, PUT, PATCH, and DELETE. Provider token permissions remain the final access boundary.

## Configure credentials

Set these variables on the Render OpenCode service, then redeploy:

- `GITHUB_PERSONAL_ACCESS_TOKEN` — a GitHub personal access token scoped to the repositories and operations OpenCode should use. Read and write actions require the corresponding token permissions.
- `VERCEL_TOKEN` — a Vercel access token for the account or team. Keep it limited to the projects and operations needed.
- `RENDER_API_KEY` — a Render API key scoped to the workspace OpenCode should manage.

Never place token values in this repository, `opencode.jsonc`, or prompts.

## GitHub and Render MCP servers

The project-root `opencode.jsonc` configures GitHub's `all` remote toolset and Render's hosted MCP. GitHub tools can read and change repositories, issues, pull requests, workflows, and the other toolsets exposed by the official server. Render tools can manage services, deployments, environment variables, workspaces, logs, metrics, and supported database operations. The live upstream servers can add capabilities without rebuilding these plugin files.

These servers can perform consequential actions with your token's permissions. Keep token scopes and Render API key workspace scope as narrow as possible. OpenCode's tool permission rules can require approval for selected write tools.

## Vercel namespace

The Vercel namespace keeps typed tools for common read operations and has an `api_request` tool for other documented REST endpoints. Provide an HTTP `method`, path, and optional `query` and JSON `body`. It can manage teams, domains, project environment variables and deployments within the token's access.

Typed tools: `list_projects`, `get_project`, `list_deployments`, `get_deployment`, and `get_deployment_events`.

The Vercel hosted MCP is enabled in the default OpenCode configuration alongside the REST tools. It uses OpenCode's remote MCP OAuth flow; Vercel's current approved-client list does not yet include OpenCode, so authentication may be rejected. The REST tools remain available as a fallback.

## Verification and limits

- Calls use fixed provider API origins, bearer authentication, a 30-second timeout, a 100,000-character cap for JSON responses, and a 50,000-character cap for non-JSON/text responses.
- The request tool validates paths to keep them on the provider API host; it does not proxy arbitrary URLs.
- GitHub's remote `all` toolset is large. OpenCode lets you turn off individual MCP tools or groups using its `tools` configuration if the model context gets crowded.
- Provider APIs may not expose every feature available in a web dashboard or separate product UI. Use the official MCP client integration where a provider requires an approved OAuth client.
- No credentials are committed to the repository.

## References

- OpenCode MCP server configuration: <https://opencode.ai/v2/docs/mcp-servers>
- GitHub REST API: <https://docs.github.com/en/rest>
- Vercel REST API: <https://vercel.com/docs/rest-api>
- Render REST API: <https://render.com/docs/api>
- OpenCode plugin API: <https://opencode.ai/docs/plugins/>
