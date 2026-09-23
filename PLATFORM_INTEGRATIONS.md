# OpenCode platform integrations

This deployment adds read-only native OpenCode tools for GitHub, Vercel, and Render. The tools call each provider's HTTPS API from the OpenCode server; credentials never go to the browser and the tools do not expose arbitrary HTTP requests or write operations.

## Configure credentials

Add these environment variables to the Render web service, then redeploy:

- `GITHUB_PERSONAL_ACCESS_TOKEN` — a fine-grained GitHub token with read access to repository metadata, contents, issues, pull requests, and Actions for the repositories OpenCode should inspect.
- `VERCEL_TOKEN` — a Vercel access token with access to the projects and deployments OpenCode should inspect.
- `RENDER_API_KEY` — a Render API key. The bundled Render tools issue GET requests only.

Do not put token values in this repository, `opencode.jsonc`, or prompts. If a Render log query is needed, pass the workspace owner ID explicitly to `render_list_logs`; this avoids silently querying the wrong workspace.

## Tool groups

### GitHub

- `github_list_repositories`
- `github_get_repository`
- `github_get_file`
- `github_search_code`
- `github_list_issues`
- `github_list_pull_requests`
- `github_list_workflow_runs`

### Vercel

- `vercel_list_projects`
- `vercel_get_project`
- `vercel_list_deployments`
- `vercel_get_deployment`
- `vercel_get_deployment_events`

Pass `teamId` when inspecting team-owned Vercel projects. The deployment-events tool requests a bounded page and does not open a live stream.

### Render

- `render_list_services`
- `render_get_service`
- `render_list_deploys`
- `render_list_logs`
- `render_get_metrics`

## API sources

- GitHub REST API: <https://docs.github.com/en/rest>
- Vercel REST API: <https://vercel.com/docs/rest-api>
- Render REST API: <https://render.com/docs/api>
- OpenCode plugin API: <https://opencode.ai/docs/plugins/>

The official Vercel MCP currently documents a reviewed-client allow-list that does not list OpenCode. This deployment therefore uses Vercel's documented REST API for the Vercel group rather than depending on an unsupported OAuth client.
