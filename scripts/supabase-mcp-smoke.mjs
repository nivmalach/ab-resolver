import { execFileSync } from "node:child_process";

const endpoint =
  process.env.SUPABASE_MCP_URL ||
  "https://mcp.supabase.com/mcp?project_ref=tbkrcihxjjorwlpwbdxw&features=database,docs";

let nextId = 1;
let sessionId = "";

function getToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN) {
    return process.env.SUPABASE_ACCESS_TOKEN;
  }

  try {
    return execFileSync("launchctl", ["getenv", "SUPABASE_ACCESS_TOKEN"], {
      encoding: "utf8"
    }).trim();
  } catch {
    return "";
  }
}

function parseMcpResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) {
    return JSON.parse(trimmed);
  }

  const payloads = [];
  let current = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      current.push(line.slice("data:".length).trimStart());
    } else if (line === "" && current.length) {
      payloads.push(current.join("\n"));
      current = [];
    }
  }
  if (current.length) payloads.push(current.join("\n"));

  const jsonPayload = payloads.reverse().find((payload) => payload && payload !== "[DONE]");
  return jsonPayload ? JSON.parse(jsonPayload) : null;
}

async function postJson(payload) {
  const token = getToken();
  if (!token) {
    throw new Error("SUPABASE_ACCESS_TOKEN is not available in env or launchctl");
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json"
  };

  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  const nextSessionId = response.headers.get("mcp-session-id");
  if (nextSessionId) {
    sessionId = nextSessionId;
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  return parseMcpResponse(text);
}

async function rpc(method, params = {}) {
  const result = await postJson({
    jsonrpc: "2.0",
    id: nextId++,
    method,
    params
  });

  if (result?.error) {
    throw new Error(`${method} failed: ${JSON.stringify(result.error)}`);
  }
  return result?.result;
}

async function notify(method, params = {}) {
  await postJson({
    jsonrpc: "2.0",
    method,
    params
  });
}

await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: {
    name: "ab-resolver-mcp-smoke",
    version: "0.1.0"
  }
});
await notify("notifications/initialized");

const tools = await rpc("tools/list");
const names = (tools.tools || []).map((tool) => tool.name).sort();
console.log(names.join("\n"));
