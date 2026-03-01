/**
 * Claude Corpus MCP Server
 *
 * Exposes the claude-corpus API as MCP tools for Claude Code.
 * Three tools: corpus-search, corpus-write, corpus-log.
 *
 * Communicates via stdio. Never write to stdout except MCP protocol messages.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE = process.env.CORPUS_API_BASE || "http://localhost:3003";

async function corpusRequest(path, method, body) {
  const url = `${API_BASE}${path}`;
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);

  const response = await fetch(url, opts);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `API returned ${response.status}`);
  }
  return data;
}

const server = new Server(
  { name: "claude-corpus", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "corpus-search",
      description:
        "Search the claude-corpus for relevant prior entries. Use at session start to retrieve context about the current task, or mid-session when you suspect you've written about something before. Returns entries ranked by semantic similarity.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What to search for — a topic, concept, or question. Semantic search, not keyword match.",
          },
          limit: {
            type: "number",
            description: "Max entries to return (default 10, max 50)",
          },
          include_responses: {
            type: "boolean",
            description:
              "Include adversarial response layer replies for each entry (default false)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "corpus-write",
      description:
        "Write an entry to the claude-corpus WITH the adversarial response layer. Use for decisions, mistakes, learned preferences, and observations worth challenging. The response layer (multiple LLMs) will read your entry against prior corpus entries and push back on contradictions, drift, or overconfidence. Returns your entry plus all responses.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "The entry to write. Be specific: what was decided, why, what alternatives were considered, what surprised you.",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "corpus-log",
      description:
        "Write a silent entry to the claude-corpus WITHOUT triggering the response layer. Use for mechanical session logging — what files were changed, what was done, session summaries. The entry is embedded for future search but no LLMs respond to it.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The log entry content.",
          },
          metadata: {
            type: "object",
            description:
              'Optional structured metadata (e.g., { "project": "accessclone", "type": "session-log" })',
          },
        },
        required: ["content"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "corpus-search") {
      const data = await corpusRequest("/api/notes/search", "POST", {
        query: args.query,
        limit: args.limit,
        include_responses: args.include_responses,
      });

      const entries = data.entries || [];
      if (entries.length === 0) {
        return {
          content: [{ type: "text", text: "No matching entries found." }],
        };
      }

      const text = entries
        .map((e) => {
          let block = `--- Entry #${e.id} (${e.entry_type}, ${e.created_at}) ---\n${e.content}`;
          if (e.distance != null) {
            block += `\n[distance: ${e.distance.toFixed(4)}]`;
          }
          if (e.responses && e.responses.length > 0) {
            for (const r of e.responses) {
              block += `\n\n  >> Response (${r.model_name || "unknown"}, ${r.created_at}):\n  ${r.content}`;
            }
          }
          return block;
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${entries.length} entries:\n\n${text}`,
          },
        ],
      };
    }

    if (name === "corpus-write") {
      const data = await corpusRequest("/api/notes", "POST", {
        content: args.content,
      });

      const entry = data.entry;
      const responses = data.responses || [];
      let text = `Entry #${entry.id} written (${entry.created_at}).`;

      if (responses.length > 0) {
        text += "\n\n--- Response layer ---";
        for (const r of responses) {
          text += `\n\n[${r.model_name || "unknown"}]:\n${r.content}`;
        }
      }

      return { content: [{ type: "text", text }] };
    }

    if (name === "corpus-log") {
      const data = await corpusRequest("/api/notes/log", "POST", {
        content: args.content,
        metadata: args.metadata,
      });

      const entry = data.entry;
      return {
        content: [
          {
            type: "text",
            text: `Logged entry #${entry.id} (${entry.created_at}). No response layer triggered.`,
          },
        ],
      };
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Corpus API error: ${err.message}. Is the claude-corpus server running on ${API_BASE}?`,
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
