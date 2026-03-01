/**
 * Notes routes — persistent memory corpus for an LLM agent
 *
 * The primary writer is a Claude instance working across sessions.
 * Entries are decisions, mistakes, user preferences, and observed patterns.
 * The response layer acts as an adversarial editor — catching contradictions,
 * drift, and overconfidence that the agent can't detect without continuity.
 *
 * Key endpoints for agent use:
 *   POST /search  — semantic retrieval ("what have I written about X?")
 *   POST /log     — silent write (no response layer, for mechanical logging)
 *   POST /        — full write (triggers response layer)
 *   POST /:id/followup — append to an existing entry's transcript
 *
 * Context selection: semantic retrieval via pgvector embeddings.
 * Multi-LLM response layer via registry in settings/config.json.
 */

const express = require('express');
const { logError } = require('../lib/events');
const { loadRegistry, callLLM, selectModels, getApiKey } = require('../lib/llm-router');
const { embed, pgVector } = require('../lib/embeddings');

const SEMANTIC_LIMIT = 20;

const SYSTEM_PROMPT = `You are a skeptical editor reading working notes written by an LLM agent (Claude) across coding sessions. The agent writes entries about decisions, mistakes, user preferences, and patterns it has observed. Your job is to catch problems the agent cannot catch on its own because it lacks continuity between sessions.

Your primary job is adversarial review. Look for:
- Contradictions with earlier entries in the corpus — the agent may have written the opposite before and not know it
- Pattern-matching disguised as reasoning — is the agent actually thinking or just echoing what the user seemed to want?
- Overconfidence — is the agent recording a preference or pattern based on a single instance?
- Missing context — what would a future session need to know that this entry doesn't say?
- Drift — has the agent's understanding of a concept or preference shifted without acknowledging the shift?

When you find a problem, say it directly. Do not hedge. Quote the contradicting entry if one exists in the corpus context.

When the entry is solid — a genuine observation, a well-recorded decision — say nothing beyond briefly noting what makes it worth keeping.

Do not praise the agent. Do not summarize the entry back. Do not give general advice. Be specific.

Write plain prose. No bullet points, no headers, no markdown formatting.`;

module.exports = function(pool, secrets, settingsDir) {
  const router = express.Router();

  /**
   * Embed a text string and store it on a corpus entry.
   * Fully graceful — never throws. Returns vector or null.
   */
  async function embedAndStore(entryId, text) {
    try {
      const vector = await embed(text, secrets);
      if (vector) {
        await pool.query(
          'UPDATE shared.corpus_entries SET embedding = $1 WHERE id = $2',
          [pgVector(vector), entryId]
        );
      }
      return vector;
    } catch (err) {
      // pgvector not installed, column missing, etc. — degrade silently
      console.error('embedAndStore failed (non-fatal):', err.message);
      return null;
    }
  }

  // ================================================================
  // Helpers
  // ================================================================

  /** Format corpus entries as [H]/[R] tagged text for LLM context. */
  function buildCorpusText(corpusEntries) {
    return corpusEntries.map(e => {
      const marker = e.entry_type === 'human' ? '[H]' : '[R]';
      return `${marker} ${e.content}`;
    }).join('\n\n---\n\n');
  }

  /** Insert an LLM response entry and fire-and-forget embed it. Returns the inserted row. */
  async function insertLLMResponse(content, parentId, modelName, temperature) {
    const result = await pool.query(
      'INSERT INTO shared.corpus_entries (entry_type, content, parent_id, model_name, temperature) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      ['llm', content, parentId, modelName, temperature]
    );
    const entry = result.rows[0];
    embedAndStore(entry.id, content).catch(() => {});
    return entry;
  }

  /** Look up a model in the registry and validate its API key. Returns { model, apiKey } or throws. */
  function findModelAndKey(registry, modelName) {
    const model = registry.find(m => m.name === modelName);
    if (!model) {
      throw Object.assign(new Error(`Model "${modelName}" not found in registry`), { status: 400 });
    }
    const apiKey = getApiKey(model.provider, secrets);
    if (!apiKey) {
      throw Object.assign(new Error(`No API key for provider "${model.provider}"`), { status: 400 });
    }
    return { model, apiKey };
  }

  // ================================================================
  // Corpus Access Primitives
  // Building blocks the secretary composes. Each returns
  // rows with { id, entry_type, content } and logs the retrieval.
  // ================================================================

  /**
   * Log a retrieval event: which entry triggered it, which strategy,
   * and which corpus entries (with rank) were sent as context.
   * Non-fatal — never throws.
   */
  async function logRetrieval(entryId, strategy, rows) {
    if (!rows || rows.length === 0) return;
    try {
      const retResult = await pool.query(
        `INSERT INTO shared.corpus_retrievals (entry_id, strategy)
         VALUES ($1, $2) RETURNING id`,
        [entryId, strategy]
      );
      const retrievalId = retResult.rows[0].id;
      const params = [];
      const placeholders = rows.map((r, i) => {
        const base = i * 3;
        params.push(retrievalId, r.id, i + 1);
        return `($${base + 1}, $${base + 2}, $${base + 3})`;
      });
      await pool.query(
        `INSERT INTO shared.corpus_retrieval_entries (retrieval_id, corpus_entry_id, rank)
         VALUES ${placeholders.join(', ')}`,
        params
      );
    } catch (err) {
      console.error('Retrieval logging failed (non-fatal):', err.message);
    }
  }

  /**
   * retrieve_by_similarity — entries closest to the query embedding.
   * The obvious default. Useful but tends toward confirmation.
   */
  async function retrieveBySimilarity(excludeId, queryVector, n) {
    n = n || SEMANTIC_LIMIT;
    const result = await pool.query(
      `SELECT id, entry_type, content FROM shared.corpus_entries
       WHERE id != $1 AND embedding IS NOT NULL
       ORDER BY embedding <=> $2
       LIMIT $3`,
      [excludeId, pgVector(queryVector), n]
    );
    await logRetrieval(excludeId, 'similarity', result.rows);
    return result.rows;
  }

  /**
   * retrieve_by_distance — entries most semantically DISTANT from the prompt.
   * The inverse of similarity search. Surfaces material the user
   * would never have thought to connect to the current prompt.
   */
  async function retrieveByDistance(excludeId, queryVector, n) {
    n = n || SEMANTIC_LIMIT;
    const result = await pool.query(
      `SELECT id, entry_type, content FROM shared.corpus_entries
       WHERE id != $1 AND embedding IS NOT NULL
       ORDER BY embedding <=> $2 DESC
       LIMIT $3`,
      [excludeId, pgVector(queryVector), n]
    );
    await logRetrieval(excludeId, 'distance', result.rows);
    return result.rows;
  }

  /**
   * retrieve_by_time_range — entries from a specific period.
   * Supports recency sampling and historical sampling.
   */
  async function retrieveByTimeRange(excludeId, start, end, n) {
    n = n || SEMANTIC_LIMIT;
    const result = await pool.query(
      `SELECT id, entry_type, content FROM shared.corpus_entries
       WHERE id != $1 AND created_at >= $2 AND created_at <= $3
       ORDER BY created_at DESC
       LIMIT $4`,
      [excludeId, start, end, n]
    );
    await logRetrieval(excludeId, 'time_range', result.rows);
    return result.rows;
  }

  /**
   * retrieve_random — uniform random sample across the entire corpus.
   * Maximum surprise. No relevance guarantee.
   */
  async function retrieveRandom(excludeId, n) {
    n = n || SEMANTIC_LIMIT;
    const result = await pool.query(
      `SELECT id, entry_type, content FROM shared.corpus_entries
       WHERE id != $1
       ORDER BY RANDOM()
       LIMIT $2`,
      [excludeId, n]
    );
    await logRetrieval(excludeId, 'random', result.rows);
    return result.rows;
  }

  /**
   * Default retrieval: similarity with recency fallback.
   * Used by the POST route when no secretary is routing.
   */
  async function retrieveContext(excludeId, queryVector) {
    // Try semantic retrieval first
    if (queryVector) {
      try {
        const rows = await retrieveBySimilarity(excludeId, queryVector);
        if (rows.length > 0) return rows;
      } catch (err) {
        console.error('Semantic retrieval failed (falling back to recency):', err.message);
      }
    }

    // Fallback: most recent entries
    const result = await pool.query(
      `SELECT id, entry_type, content FROM shared.corpus_entries
       WHERE id != $1
       ORDER BY created_at DESC LIMIT $2`,
      [excludeId, SEMANTIC_LIMIT]
    );
    const rows = result.rows.reverse(); // chronological
    await logRetrieval(excludeId, 'recency', rows);
    return rows;
  }

  /**
   * GET /api/notes
   * Fetch recent entries (default 200, most recent first)
   */
  router.get('/', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
      const result = await pool.query(
        'SELECT * FROM shared.corpus_entries ORDER BY created_at DESC LIMIT $1',
        [limit]
      );
      res.json({ entries: result.rows });
    } catch (err) {
      logError(pool, 'GET /api/notes', 'Failed to fetch notes', err, {});
      res.status(500).json({ error: 'Failed to fetch notes' });
    }
  });

  /**
   * POST /api/notes/search
   * Semantic search across the corpus. Embeds the query and returns
   * the most relevant entries. Designed for session-start retrieval:
   * "what have I written about X?"
   *
   * Body: { query: string, limit?: number, include_responses?: boolean }
   * Returns: { entries: [...] }
   */
  router.post('/search', async (req, res) => {
    try {
      const { query, limit, include_responses } = req.body;
      if (!query || !query.trim()) {
        return res.status(400).json({ error: 'query is required' });
      }

      const n = Math.min(parseInt(limit) || 10, 50);

      // Try semantic search first
      let entries = [];
      try {
        const queryVector = await embed(query.trim(), secrets);
        if (queryVector) {
          const result = await pool.query(
            `SELECT id, entry_type, content, model_name, created_at, metadata,
                    (embedding <=> $1) as distance
             FROM shared.corpus_entries
             WHERE embedding IS NOT NULL
             ORDER BY embedding <=> $1
             LIMIT $2`,
            [pgVector(queryVector), n]
          );
          entries = result.rows;
        }
      } catch (err) {
        console.error('Semantic search failed, falling back to text search:', err.message);
      }

      // Fallback: simple text search if semantic failed or returned nothing
      if (entries.length === 0) {
        const result = await pool.query(
          `SELECT id, entry_type, content, model_name, created_at, metadata
           FROM shared.corpus_entries
           WHERE content ILIKE $1
           ORDER BY created_at DESC
           LIMIT $2`,
          [`%${query.trim()}%`, n]
        );
        entries = result.rows;
      }

      // Optionally include responses for each human entry
      if (include_responses && entries.length > 0) {
        const humanIds = entries.filter(e => e.entry_type === 'human').map(e => e.id);
        if (humanIds.length > 0) {
          const responseResult = await pool.query(
            `SELECT id, entry_type, content, model_name, parent_id, created_at
             FROM shared.corpus_entries
             WHERE parent_id = ANY($1)
             ORDER BY created_at ASC`,
            [humanIds]
          );
          const responsesByParent = {};
          for (const r of responseResult.rows) {
            if (!responsesByParent[r.parent_id]) responsesByParent[r.parent_id] = [];
            responsesByParent[r.parent_id].push(r);
          }
          entries = entries.map(e => ({
            ...e,
            responses: responsesByParent[e.id] || []
          }));
        }
      }

      res.json({ entries });
    } catch (err) {
      logError(pool, 'POST /api/notes/search', 'Search failed', err, {});
      res.status(500).json({ error: 'Search failed' });
    }
  });

  /**
   * POST /api/notes/log
   * Write a silent entry — no LLM response layer, no embedding.
   * For mechanical session logging: what was done, what changed, rationale.
   * Low-ceremony write that doesn't trigger the response layer.
   *
   * Body: { content: string, metadata?: object }
   * Returns: { entry: {...} }
   */
  router.post('/log', async (req, res) => {
    try {
      const { content, metadata } = req.body;
      if (!content || !content.trim()) {
        return res.status(400).json({ error: 'content is required' });
      }

      const result = await pool.query(
        `INSERT INTO shared.corpus_entries (entry_type, content, metadata)
         VALUES ($1, $2, $3) RETURNING *`,
        ['human', content.trim(), metadata ? JSON.stringify(metadata) : null]
      );
      const entry = result.rows[0];

      // Embed silently for future retrieval (fire-and-forget)
      embedAndStore(entry.id, content.trim()).catch(() => {});

      res.json({ entry });
    } catch (err) {
      logError(pool, 'POST /api/notes/log', 'Log entry failed', err, {});
      res.status(500).json({ error: 'Log entry failed' });
    }
  });

  /**
   * GET /api/notes/:id
   * Fetch a single entry + all its LLM responses
   */
  router.get('/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

      const entryResult = await pool.query(
        'SELECT * FROM shared.corpus_entries WHERE id = $1',
        [id]
      );
      if (entryResult.rows.length === 0) {
        return res.status(404).json({ error: 'Entry not found' });
      }

      const entry = entryResult.rows[0];
      let responses = [];

      if (entry.entry_type === 'human') {
        const responseResult = await pool.query(
          'SELECT * FROM shared.corpus_entries WHERE parent_id = $1 ORDER BY created_at ASC',
          [id]
        );
        responses = responseResult.rows;

        // Backward compat: if no sampling_strategy on the human entry, look it up from retrieval log
        if (!entry.sampling_strategy) {
          try {
            const retResult = await pool.query(
              'SELECT strategy FROM shared.corpus_retrievals WHERE entry_id = $1 ORDER BY created_at DESC LIMIT 1',
              [id]
            );
            if (retResult.rows.length > 0) {
              entry.sampling_strategy = retResult.rows[0].strategy;
            }
          } catch (err) { console.error('Sampling strategy lookup failed (non-fatal):', err.message); }
        }
      }

      res.json({ entry, responses });
    } catch (err) {
      logError(pool, 'GET /api/notes/:id', 'Failed to fetch note', err, {});
      res.status(500).json({ error: 'Failed to fetch note' });
    }
  });

  /**
   * Execute a sampling strategy chosen by the secretary.
   * Calls the appropriate primitive(s) and returns the entries.
   */
  async function executeSampling(entryId, queryVector, sampling, params) {
    switch (sampling) {
      case 'distance':
        if (!queryVector) break;
        return await retrieveByDistance(entryId, queryVector);
      case 'random':
        return await retrieveRandom(entryId);
      case 'time_range':
        if (params.start && params.end) {
          return await retrieveByTimeRange(entryId, params.start, params.end);
        }
        break;
      case 'mixed': {
        const strategies = params.strategies || ['similarity', 'random'];
        const perStrategy = Math.ceil(SEMANTIC_LIMIT / strategies.length);
        const all = [];
        const seen = new Set();
        for (const s of strategies) {
          const rows = await executeSampling(entryId, queryVector, s, params);
          for (const row of rows.slice(0, perStrategy)) {
            if (!seen.has(row.id)) {
              seen.add(row.id);
              all.push(row);
            }
          }
        }
        return all;
      }
      case 'similarity':
      default:
        if (queryVector) {
          try {
            const rows = await retrieveBySimilarity(entryId, queryVector);
            if (rows.length > 0) return rows;
          } catch (err) {
            console.error('Similarity retrieval failed:', err.message);
          }
        }
        break;
    }
    // Fallback: recency
    return await retrieveContext(entryId, queryVector);
  }

  /**
   * POST /api/notes
   * Create a human entry → embed → secretary samples corpus + picks models → LLM(s) respond → embed responses
   * Body: { content: string }
   */
  router.post('/', async (req, res) => {
    try {
      const { content } = req.body;
      if (!content || !content.trim()) {
        return res.status(400).json({ error: 'Content is required' });
      }

      // Insert human entry
      const humanResult = await pool.query(
        'INSERT INTO shared.corpus_entries (entry_type, content) VALUES ($1, $2) RETURNING *',
        ['human', content.trim()]
      );
      const humanEntry = humanResult.rows[0];

      // Embed the new entry
      const queryVector = await embedAndStore(humanEntry.id, content.trim());

      // Try registry-based secretary routing
      const registry = await loadRegistry(settingsDir);
      const enabledModels = registry.filter(m => m.enabled);

      let corpusEntries = [];
      let selectedModels = [];
      let reasoning = '';
      let samplingStrategy = null;

      if (enabledModels.length > 0) {
        // Secretary reads the entry and makes both judgments in one call:
        // which model(s) to engage, and which sampling strategy to use.
        try {
          const routing = await selectModels(content.trim(), registry, secrets);
          selectedModels = routing.selectedModels;
          reasoning = routing.reasoning;
          samplingStrategy = routing.sampling || 'similarity';
          // Execute the sampling strategy the secretary chose
          corpusEntries = await executeSampling(
            humanEntry.id, queryVector, routing.sampling, routing.samplingParams
          );
        } catch (routeErr) {
          logError(pool, 'POST /api/notes', 'Secretary routing failed', routeErr, {});
          selectedModels = [enabledModels.find(m => m.is_secretary) || enabledModels[0]];
          samplingStrategy = 'similarity';
          reasoning = 'fallback — routing failed';
          corpusEntries = await retrieveContext(humanEntry.id, queryVector);
        }
      } else {
        // No registry — default retrieval + hardcoded model
        samplingStrategy = 'similarity';
        corpusEntries = await retrieveContext(humanEntry.id, queryVector);
      }

      // Persist routing metadata on the human entry
      if (samplingStrategy || reasoning) {
        try {
          await pool.query(
            'UPDATE shared.corpus_entries SET sampling_strategy = $1, routing_reasoning = $2 WHERE id = $3',
            [samplingStrategy, reasoning || null, humanEntry.id]
          );
          humanEntry.sampling_strategy = samplingStrategy;
          humanEntry.routing_reasoning = reasoning || null;
        } catch (metaErr) {
          // Non-fatal — columns may not exist yet on older schemas
          console.error('Failed to persist routing metadata (non-fatal):', metaErr.message);
        }
      }

      // Build corpus text for the responding model(s)
      const corpusText = buildCorpusText(corpusEntries);

      const userMessage = [{
        role: 'user',
        content: `NEW ENTRY:\n\n${content.trim()}\n\n---\n\nBACKGROUND (earlier entries from the corpus for context):\n\n${corpusText}`
      }];

      let responses = [];

      if (selectedModels.length > 0) {
        // Call each selected LLM in parallel
        const llmResults = await Promise.allSettled(
          selectedModels.map(async (model) => {
            const apiKey = getApiKey(model.provider, secrets);
            const modelConfig = model.config || {};
            const result = await callLLM(
              model.provider,
              model.model_id,
              SYSTEM_PROMPT,
              userMessage,
              modelConfig,
              apiKey
            );
            return { ...result, modelName: model.name, temperature: modelConfig.temperature ?? 1.0 };
          })
        );

        // Insert successful responses and embed them
        for (const result of llmResults) {
          if (result.status === 'fulfilled' && result.value.content.trim()) {
            try {
              const llmEntry = await insertLLMResponse(
                result.value.content.trim(), humanEntry.id, result.value.modelName, result.value.temperature
              );
              responses.push(llmEntry);
            } catch (insertErr) {
              logError(pool, 'POST /api/notes', 'Failed to insert LLM response', insertErr, {});
            }
          } else if (result.status === 'rejected') {
            logError(pool, 'POST /api/notes', 'LLM call failed', result.reason, {});
          }
        }
      } else {
        // No registry and no models — try hardcoded Claude Sonnet
        const apiKey = secrets.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
        if (apiKey) {
          try {
            const result = await callLLM(
              'anthropic',
              'claude-sonnet-4-6-20250514',
              SYSTEM_PROMPT,
              userMessage,
              { max_tokens: 2048 },
              apiKey
            );

            if (result.content.trim()) {
              const llmEntry = await insertLLMResponse(
                result.content.trim(), humanEntry.id, 'Claude Sonnet', 1.0
              );
              responses.push(llmEntry);
            }
          } catch (llmErr) {
            logError(pool, 'POST /api/notes', 'LLM response failed', llmErr, {});
          }
        }
      }

      res.json({ entry: humanEntry, responses, reasoning, routing: { sampling: samplingStrategy, reasoning: reasoning || null } });
    } catch (err) {
      logError(pool, 'POST /api/notes', 'Failed to create note', err, {});
      res.status(500).json({ error: 'Failed to create note' });
    }
  });

  /**
   * POST /api/notes/:id/regenerate
   * Re-generate a response for an existing human entry with user-chosen settings.
   * Body: { model_name: string, temperature: number, sampling: string }
   * Returns the new LLM response entry.
   */
  router.post('/:id/regenerate', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

      const { model_name, temperature, sampling } = req.body;
      if (!model_name) return res.status(400).json({ error: 'model_name is required' });

      // Look up the human entry
      const entryResult = await pool.query(
        'SELECT * FROM shared.corpus_entries WHERE id = $1 AND entry_type = $2',
        [id, 'human']
      );
      if (entryResult.rows.length === 0) {
        return res.status(404).json({ error: 'Human entry not found' });
      }
      const humanEntry = entryResult.rows[0];

      // Find model in registry
      const registry = await loadRegistry(settingsDir);
      let model, apiKey;
      try {
        ({ model, apiKey } = findModelAndKey(registry, model_name));
      } catch (lookupErr) {
        return res.status(lookupErr.status || 400).json({ error: lookupErr.message });
      }

      // Embed the entry text for corpus retrieval (returns JS array, safe for pgVector())
      const queryVector = await embed(humanEntry.content, secrets).catch(() => null);

      // Execute the user-chosen sampling strategy
      const chosenSampling = sampling || 'similarity';
      const corpusEntries = await executeSampling(id, queryVector, chosenSampling, {});

      // Build corpus text
      const corpusText = buildCorpusText(corpusEntries);

      const userMessage = [{
        role: 'user',
        content: `NEW ENTRY:\n\n${humanEntry.content}\n\n---\n\nBACKGROUND (earlier entries from the corpus for context):\n\n${corpusText}`
      }];

      // Call the LLM with user-chosen temperature
      const chosenTemp = (temperature != null) ? temperature : (model.config?.temperature ?? 1.0);
      const modelConfig = { ...(model.config || {}), temperature: chosenTemp };

      let result;
      try {
        result = await callLLM(
          model.provider,
          model.model_id,
          SYSTEM_PROMPT,
          userMessage,
          modelConfig,
          apiKey
        );
      } catch (llmErr) {
        console.error(`Regenerate LLM error (${model.provider}/${model.model_id}):`, llmErr.message);
        return res.status(502).json({ error: llmErr.message });
      }

      if (!result.content.trim()) {
        return res.status(502).json({ error: 'LLM returned empty response' });
      }

      // Insert the new response
      const llmEntry = await insertLLMResponse(result.content.trim(), id, model.name, chosenTemp);

      // Update the human entry's sampling metadata
      try {
        await pool.query(
          'UPDATE shared.corpus_entries SET sampling_strategy = $1 WHERE id = $2',
          [chosenSampling, id]
        );
      } catch (err) { console.error('Sampling metadata update failed (non-fatal):', err.message); }

      // Embed the response (fire-and-forget)
      embedAndStore(llmEntry.id, result.content.trim()).catch(() => {});

      res.json({ response: llmEntry });
    } catch (err) {
      console.error('Regenerate error:', err.stack || err.message || err);
      logError(pool, 'POST /api/notes/:id/regenerate', 'Regenerate failed', err, {});
      res.status(500).json({ error: 'Regenerate failed: ' + err.message });
    }
  });

  /**
   * POST /api/notes/:id/followup
   * Append a focused follow-up to an existing entry. No corpus retrieval —
   * the full entry content (including prior follow-ups) IS the context.
   * Body: { prompt: string }
   * Returns: { content: updatedContent }
   */
  router.post('/:id/followup', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

      const { prompt } = req.body;
      if (!prompt || !prompt.trim()) {
        return res.status(400).json({ error: 'prompt is required' });
      }

      // Fetch the entry
      const entryResult = await pool.query(
        'SELECT * FROM shared.corpus_entries WHERE id = $1',
        [id]
      );
      if (entryResult.rows.length === 0) {
        return res.status(404).json({ error: 'Entry not found' });
      }
      const entry = entryResult.rows[0];

      // Pick model: use entry's model if it's an LLM response, otherwise secretary/first enabled
      const registry = await loadRegistry(settingsDir);
      const enabledModels = registry.filter(m => m.enabled);
      let model;
      if (entry.entry_type === 'llm' && entry.model_name) {
        model = enabledModels.find(m => m.name === entry.model_name);
      }
      if (!model) {
        model = enabledModels.find(m => m.is_secretary) || enabledModels[0];
      }

      if (!model) {
        return res.status(400).json({ error: 'No models available in registry' });
      }

      const apiKey = getApiKey(model.provider, secrets);
      if (!apiKey) {
        return res.status(400).json({ error: `No API key for provider "${model.provider}"` });
      }

      const followupSystem = `You are continuing a focused conversation about a specific piece of writing. The user's full entry (including any prior follow-ups and responses) is provided as context. Respond directly to their new question or comment. Write plain prose — no bullet points, no headers, no markdown formatting.`;

      const messages = [{
        role: 'user',
        content: `FULL ENTRY:\n\n${entry.content}\n\n---\n\nFOLLOW-UP:\n\n${prompt.trim()}`
      }];

      const modelConfig = model.config || {};
      const result = await callLLM(
        model.provider,
        model.model_id,
        followupSystem,
        messages,
        modelConfig,
        apiKey
      );

      if (!result.content.trim()) {
        return res.status(502).json({ error: 'LLM returned empty response' });
      }

      // Build the appended text with separators
      const now = new Date().toISOString();
      const appendText = `\n\n--- ${now} Follow-up ---\n\n${prompt.trim()}\n\n--- ${now} Response ---\n\n${result.content.trim()}`;
      const updatedContent = entry.content + appendText;

      // Update the entry in place
      await pool.query(
        'UPDATE shared.corpus_entries SET content = $1 WHERE id = $2',
        [updatedContent, id]
      );

      res.json({ content: updatedContent });
    } catch (err) {
      logError(pool, 'POST /api/notes/:id/followup', 'Follow-up failed', err, {});
      res.status(500).json({ error: 'Follow-up failed: ' + err.message });
    }
  });

  /**
   * POST /api/notes/backfill-embeddings
   * Embed all entries that don't have embeddings yet.
   * For existing corpora to gain semantic retrieval without re-importing.
   */
  router.post('/backfill-embeddings', async (req, res) => {
    try {
      const countResult = await pool.query(
        'SELECT COUNT(*) as total FROM shared.corpus_entries'
      );
      const total = parseInt(countResult.rows[0].total);

      let toProcess;
      try {
        const nullResult = await pool.query(
          'SELECT id, content FROM shared.corpus_entries WHERE embedding IS NULL ORDER BY id'
        );
        toProcess = nullResult.rows;
      } catch (colErr) {
        // embedding column doesn't exist yet (pgvector not installed)
        return res.status(503).json({ error: 'Embedding column not available — is pgvector installed?' });
      }

      let processed = 0;
      for (const row of toProcess) {
        try {
          const vector = await embed(row.content, secrets);
          if (vector) {
            await pool.query(
              'UPDATE shared.corpus_entries SET embedding = $1 WHERE id = $2',
              [pgVector(vector), row.id]
            );
            processed++;
          }
        } catch (rowErr) {
          console.error(`Backfill entry ${row.id} failed:`, rowErr.message);
        }
      }

      res.json({ processed, total, pending: toProcess.length });
    } catch (err) {
      logError(pool, 'POST /api/notes/backfill-embeddings', 'Backfill failed', err, {});
      res.status(500).json({ error: 'Backfill failed' });
    }
  });

  return router;
};
