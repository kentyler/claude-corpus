# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Corpus is a persistent memory system for LLM agents across sessions. Agents write entries (decisions, observations, mistakes, preferences) and the system retrieves relevant prior notes by semantic similarity using pgvector. An adversarial response layer has multiple LLMs review each entry against prior context, surfacing contradictions, drift, and overconfidence.

## Architecture

- **Backend**: Node.js/Express on port **3003**, PostgreSQL (`claude-corpus` database) with pgvector
- **Frontend**: ClojureScript/Reagent (optional human browsing UI)
- **MCP Server**: `mcp/server.js` — exposes corpus tools to Claude Code

```
server/
├── index.js              # Entry point (loads secrets, initializes DB, starts Express)
├── config.js             # DB/server config (port 3003)
├── app.js                # Express app factory
├── schema.js             # PostgreSQL schema initialization
├── routes/
│   ├── notes.js          # Core API: entries, responses, search, sampling, follow-up
│   ├── config.js         # Settings read/write
│   └── events.js         # Event log
└── lib/
    ├── llm-router.js     # Multi-provider LLM caller + secretary routing
    ├── embeddings.js     # OpenAI/Google embedding APIs
    └── events.js         # Event logging
mcp/
└── server.js             # MCP protocol adapter (3 tools)
ui/
└── src/                  # ClojureScript/Reagent frontend
settings/
└── config.json           # LLM registry (models, secretary designation)
```

## Commands

```bash
# Server
cd server && npm install
cd server && npm start          # Production
cd server && npm run dev        # Watch mode (node --watch)
npm test                        # Jest tests from root

# UI (requires Java for ClojureScript)
cd ui && npm install
cd ui && npx shadow-cljs compile app    # Build once
cd ui && npm run dev                    # Watch mode
cd ui && npm run release                # Production build
```

Start script: `start-server.ps1` loads `secrets.json`, sets PGPASSWORD, kills any process on port 3003, starts server.

## MCP Tools

The MCP server (`mcp/server.js`) exposes three tools at `http://localhost:3003` (override with `CORPUS_API_BASE` env var):

| Tool | Purpose | Response layer? |
|------|---------|----------------|
| `corpus-search` | Semantic search across entries (query, limit, include_responses) | N/A |
| `corpus-write` | Write entry WITH adversarial multi-LLM responses | Yes |
| `corpus-log` | Silent write for mechanical logging (session logs, file tracking) | No |

## Secretary Routing

The secretary model (Claude Opus 4.6 by default, `is_secretary: true` in `settings/config.json`) makes two decisions on each new entry:

1. **Model selection** — which models should respond (based on complexity, need for multiple perspectives)
2. **Corpus sampling strategy** — how to select context for responders:
   - `similarity` (default): semantically closest entries
   - `distance`: most distant (surface contradictions)
   - `random`: maximum surprise
   - `time_range`: entries from specific period
   - `mixed`: combine strategies

## API Routes (server/routes/notes.js)

| Method | Route | Purpose |
|--------|-------|---------|
| `POST /api/notes` | Create entry + embed + secretary routing + LLM responses |
| `POST /api/notes/log` | Silent log (no response layer) |
| `POST /api/notes/search` | Semantic search with text fallback |
| `GET /api/notes` | Recent entries (default 200) |
| `GET /api/notes/:id` | Single entry + all responses |
| `POST /api/notes/:id/regenerate` | Re-generate response with different model/temperature/sampling |
| `POST /api/notes/:id/followup` | Append follow-up Q&A |
| `POST /api/notes/backfill-embeddings` | Embed entries missing vectors |

## LLM Registry (settings/config.json)

Four models configured with provider, model ID, max_tokens, temperature, and description:
- **Claude Opus 4.6** — secretary + responder (Anthropic)
- **Claude Sonnet 4.6** — responder (Anthropic)
- **GPT-5.2** — responder (OpenAI, temperature 1.0)
- **Gemini 3.1 Pro** — responder (Google, temperature 1.0)

## Configuration

`secrets.json` (required at project root):
```json
{
  "database": { "password": "..." },
  "anthropic": { "api_key": "..." },
  "openai": { "api_key": "..." },
  "gemini": { "api_key": "..." }
}
```
Only database password is required. LLM API keys are optional — add only the providers you want.

## Key Files

| File | When to read |
|------|-------------|
| `server/routes/notes.js` | Entry creation, embedding, response orchestration |
| `server/lib/llm-router.js` | Secretary routing, multi-provider LLM calls |
| `settings/config.json` | Model registry, secretary designation |
| `mcp/server.js` | MCP tool definitions and API bridging |
| `server/schema.js` | Database schema (corpus_entries, corpus_retrievals) |
