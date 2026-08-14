#!/usr/bin/env node
// MCP stdio server — exposes the AI council (Gemini / OpenAI / DeepSeek / Kimi / MiniMax)
// as native Claude Code tools. Zero dependencies: raw JSON-RPC over stdio.
// Keys come from ~/.config/ai-council/keys.env (same file ~/bin/ask uses).

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEYS = path.join(os.homedir(), '.config/ai-council/keys.env');
const LOG = path.join(os.homedir(), '.cache/mcp-ai-council.log');

function loadKeys() {
  const env = {};
  try {
    for (const line of fs.readFileSync(KEYS, 'utf8').split('\n')) {
      if (/^\s*#/.test(line)) continue;
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      // strip inline "# comment" and surrounding quotes; blank value => key absent
      const val = m[2].replace(/(^|\s)#.*$/, '').trim().replace(/^["']|["']$/g, '');
      if (val) env[m[1]] = val;
    }
  } catch {}
  return env;
}

const AGENTS = {
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'GEMINI_API_KEY', model: 'gemini-3.6-flash' },
  openai: { base: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY', model: 'gpt-4o-mini' },
  codex: { base: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY', model: 'gpt-4o-mini' },
  deepseek: { base: 'https://api.deepseek.com', key: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' },
  kimi: { base: 'https://api.moonshot.ai/v1', key: 'MOONSHOT_API_KEY', model: 'kimi-k2-0711-preview' },
  minimax: { base: 'https://api.minimax.chat/v1', key: 'MINIMAX_API_KEY', model: 'abab6.5s-chat' },
};

const LOG_MAX_BYTES = 2 * 1024 * 1024; // 2MB

function log(msg) {
  try {
    const stat = fs.statSync(LOG);
    if (stat.size > LOG_MAX_BYTES) fs.truncateSync(LOG, 0);
  } catch {}
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

async function chat(agent, prompt, { system, timeoutMs = 120000 } = {}) {
  const cfg = AGENTS[agent];
  if (!cfg) throw new Error(`unknown agent: ${agent}`);
  const env = loadKeys();
  const key = env[cfg.key] || process.env[cfg.key];
  if (!key) throw new Error(`[${agent}] no API key — add ${cfg.key} to ${KEYS}`);

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env[`${agent.toUpperCase()}_MODEL`] || cfg.model, messages }),
      signal: ac.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`[${agent}] non-JSON reply: ${text.slice(0, 400)}`); }
    const out = data?.choices?.[0]?.message?.content;
    if (!out) throw new Error(`[${agent}] ${data?.error?.message || text.slice(0, 400)}`);
    return out;
  } finally {
    clearTimeout(t);
  }
}

const TOOLS = [
  {
    name: 'ask',
    description: 'Ask ONE other AI model a question and get its reply. Use for a second opinion, cross-checking code, or a capability another model is better at.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: Object.keys(AGENTS), description: 'Which model to ask' },
        prompt: { type: 'string', description: 'The question or task to send' },
        system: { type: 'string', description: 'Optional system prompt' },
      },
      required: ['agent', 'prompt'],
    },
  },
  {
    name: 'council',
    description: 'Ask EVERY configured AI the same question in parallel and return all answers side by side. Use for round-table debate, consensus, or comparing model opinions.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question put to the whole council' },
        system: { type: 'string', description: 'Optional system prompt sent to all' },
        agents: { type: 'array', items: { type: 'string' }, description: 'Optional subset of agents; defaults to all with keys' },
      },
      required: ['question'],
    },
  },
  {
    name: 'list_agents',
    description: 'List available council members, their models, and whether an API key is configured.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function configured() {
  const env = loadKeys();
  const seen = new Set();
  return Object.entries(AGENTS)
    .filter(([name, c]) => {
      if (!env[c.key]) return false;
      const id = `${c.base}|${c.key}`;
      if (seen.has(id)) return false; // codex duplicates openai
      seen.add(id);
      return true;
    })
    .map(([name]) => name);
}

async function callTool(name, args = {}) {
  if (name === 'list_agents') {
    const env = loadKeys();
    const rows = Object.entries(AGENTS).map(([a, c]) => `${env[c.key] ? '✔' : '✘'} ${a.padEnd(9)} ${c.model}`);
    return `Council members (✔ = key set):\n${rows.join('\n')}`;
  }
  if (name === 'ask') {
    return await chat(args.agent, args.prompt, { system: args.system });
  }
  if (name === 'council') {
    const list = (args.agents && args.agents.length ? args.agents : configured());
    if (!list.length) return 'No council members have API keys configured. Add keys to ' + KEYS;
    const results = await Promise.all(
      list.map((a) =>
        chat(a, args.question, { system: args.system })
          .then((r) => ({ a, r }))
          .catch((e) => ({ a, r: `[error] ${e.message}` }))
      )
    );
    return results.map(({ a, r }) => `## ${a}\n\n${r}`).join('\n\n---\n\n');
  }
  throw new Error(`unknown tool: ${name}`);
}

// ---- JSON-RPC over stdio ----
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line).catch((e) => log(`unhandled: ${e.message}`));
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  const reply = (result) => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
  const fail = (message) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32000, message } }); };

  try {
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'ai-council', version: '1.0.0' },
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const text = await callTool(params?.name, params?.arguments || {});
        return reply({ content: [{ type: 'text', text }] });
      }
      case 'resources/list':
        return reply({ resources: [] });
      case 'prompts/list':
        return reply({ prompts: [] });
      default:
        if (id !== undefined) return fail(`method not found: ${method}`);
    }
  } catch (e) {
    log(`error ${method}: ${e.message}`);
    if (id !== undefined) return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
  }
}

log('ai-council MCP server started');
