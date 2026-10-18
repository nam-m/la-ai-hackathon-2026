// D: Creao API calls (contract 6). Used by ./index.ts.
// Base URL https://developer.creao.ai, key in env (never in the app).
//   POST /v1/workspaces/{workspace_id}/files   upload the WAV clip
//   POST /v1/runs                              agent_id, input, workspace_id, webhook_url -> run_id
//   GET  /v1/runs/{run_id}                     status, if a webhook is late
// Confirm details at the Creao table.
export {}
