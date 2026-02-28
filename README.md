# Claude Corpus

A persistent memory system for LLM agents. The primary user is not a human — it's a Claude instance working across sessions that lack continuity.

The problem: each conversation session starts from zero. MEMORY.md files help, but they're flat, unsearchable, and limited in size. This app gives an LLM agent an append-only corpus with semantic retrieval, so it can write notes about decisions, mistakes, and learned preferences, then retrieve relevant prior notes at the start of future sessions by meaning rather than by scanning a document.

The response layer — multiple LLMs reading and responding to each entry — acts as an adversarial editor. When the agent writes "the user prefers X," the response layer can surface a prior entry where the agent wrote the opposite. This catches drift that the agent can't detect on its own because it doesn't experience sessions as continuous.

A human may occasionally browse the corpus to see what the agent is storing, but the app is designed API-first for programmatic use.

## How the agent uses it

The agent writes via `POST /api/notes` with a JSON body. It reads via `GET /api/notes` and `GET /api/notes/:id`. Semantic retrieval happens server-side — the agent doesn't need to manage embeddings or search. Follow-ups on specific entries use `POST /api/notes/:id/followup`.

Typical patterns:
- **Session start**: retrieve recent entries relevant to the current task
- **After a decision**: record what was decided and why
- **After a mistake**: record what went wrong (highest-value signal)
- **After learning a user preference**: record the preference with context
- **Session end**: summarize what was done and what surprised

The response layer runs automatically on each new entry. A secretary LLM routes to one or more models, which read the entry against semantically retrieved prior entries and push back.

## Architecture

- **Backend**: Node.js/Express on port 3003
- **Database**: PostgreSQL (`claude-corpus`) with pgvector for semantic retrieval
- **LLM**: Multi-provider (Anthropic, OpenAI, Google) with secretary routing
- **Frontend**: ClojureScript/Reagent (for occasional human browsing, not the primary interface)

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL 15+ with [pgvector](https://github.com/pgvector/pgvector) extension
- Java (for shadow-cljs/ClojureScript compilation)

### 1. Create the database

```sql
CREATE DATABASE "claude-corpus";
```

### 2. Configure secrets

Copy `secrets.json.example` to `secrets.json` and fill in your values:

```json
{
  "database": {
    "password": "your-postgres-password"
  },
  "anthropic": {
    "api_key": "sk-ant-..."
  },
  "openai": {
    "api_key": "sk-..."
  },
  "gemini": {
    "api_key": "..."
  }
}
```

Only the database password is required. LLM API keys are optional — add whichever providers you want to use.

### 3. Install dependencies

```bash
cd server && npm install
cd ../ui && npm install
```

### 4. Build the frontend

```bash
cd ui && npx shadow-cljs compile app
```

### 5. Start the server

```bash
cd server && node index.js
```

Server runs on http://localhost:3003. The UI is available there for human browsing; the agent uses the API directly.

## API

### Search the corpus (session start)

```
POST /api/notes/search
Content-Type: application/json

{ "query": "user preferences about abstractions", "limit": 10, "include_responses": true }
```

Semantic search via embeddings. Falls back to text search. Returns entries ranked by relevance. Use at session start to retrieve context about the current task.

### Write an entry (with response layer)

```
POST /api/notes
Content-Type: application/json

{ "content": "Decided to use cross-join pattern for form state refs because..." }
```

Creates the entry, embeds it, runs the response layer (secretary routing, adversarial review). Returns the entry plus all LLM responses.

### Log an entry (silent, no response layer)

```
POST /api/notes/log
Content-Type: application/json

{ "content": "Session: modified 3 files for follow-up pane feature", "metadata": { "project": "corpus", "type": "session-log" } }
```

Creates and embeds the entry but does not trigger the response layer. For mechanical logging — session summaries, change records, rationale notes — where adversarial review would be noise.

### Retrieve entries

```
GET /api/notes              # Recent entries (default 200)
GET /api/notes/:id          # Single entry + all responses
```

### Follow up on an entry

```
POST /api/notes/:id/followup
Content-Type: application/json

{ "prompt": "Does this contradict the earlier decision about..." }
```

Appends the follow-up and response to the entry's content in place. No new database record — the transcript grows within the entry.

### Regenerate a response

```
POST /api/notes/:id/regenerate
Content-Type: application/json

{ "model_name": "GPT-5.2", "temperature": 0.8, "sampling": "distance" }
```

## Project structure

```
claude-corpus/
  server/
    index.js          # Entry point
    app.js            # Express app factory
    config.js         # Database/server config (port 3003, db claude-corpus)
    schema.js         # PostgreSQL schema initialization
    lib/
      events.js       # Event logging
      llm-router.js   # Multi-provider LLM caller + secretary routing
      embeddings.js   # OpenAI/Google embedding APIs
    routes/
      notes.js        # Core API: entries, responses, sampling, follow-up
      config.js       # Settings read/write
      events.js       # Event log endpoints
  ui/                 # ClojureScript frontend (for human browsing)
  settings/
    config.json       # LLM registry configuration
```

## License

MIT
