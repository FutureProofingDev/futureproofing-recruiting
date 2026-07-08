# AI Candidate Evaluation Engine — setup

This is a standalone Cloudflare Worker (separate deploy from the `futureproofing-recruiting`
Pages site, same git repo). It polls Ashby for AI Engineer candidates who've reached
**"Chat with Jess"**, generates one AI evaluation per completed stage, and synthesizes a
Final Candidate Summary for the interviewer.

None of the steps below have been run yet — they touch your live Cloudflare account, so
they're left for you to run (or ask me to run with you watching).

## 1. Create the D1 database

```
cd engine
npx wrangler d1 create eval-engine-db
```

Copy the returned `database_id` into `wrangler.toml` (replace `REPLACE_WITH_D1_DATABASE_ID`).

Apply the schema:

```
npm run db:migrate:remote     # production database
npm run db:migrate:local      # for local `wrangler dev` testing
```

## 2. Set secrets

```
npx wrangler secret put ASHBY_API_KEY        # same value already used by functions/api/*.js
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ENGINE_INTERNAL_KEY  # any long random string, e.g. `openssl rand -hex 32`
```

`ANTHROPIC_MODEL` and `POLL_LOOKBACK_DAYS` are plain vars already set in `wrangler.toml` —
edit them there if you want a different model or lookback window (no code change needed).

## 3. Deploy the Worker

```
npx wrangler deploy
```

Note the deployed URL (`https://futureproofing-eval-engine.<subdomain>.workers.dev` unless
you attach a custom domain).

**Workflows require the Cloudflare Workers Paid plan.** If the deploy fails because Workflows
aren't available on your account, that's what to check first.

## 4. Wire up the Pages site

On the `futureproofing-recruiting` Pages project (Cloudflare dashboard → Settings →
Environment variables, or via `wrangler pages secret put`):

- `EVAL_ENGINE_URL` (plain var) = the Worker URL from step 3
- `ENGINE_INTERNAL_KEY` (secret) = the **same value** you set in step 2

Then deploy the Pages site as usual:

```
cd ..
wrangler pages deploy public --project-name futureproofing-recruiting
```

Open `/candidates.html` — it should load (empty until the first poll finds someone at
"Chat with Jess").

## 5. Verify it's working

The cron trigger runs every 10 minutes in production. To test sooner without waiting:

```
cd engine
npx wrangler dev
# in another terminal:
curl "http://localhost:8787/__scheduled"     # manually fires the poller locally
```

Then hit the read API directly (replace `<key>` with `ENGINE_INTERNAL_KEY`):

```
curl -H "X-Engine-Key: <key>" http://localhost:8787/api/candidates
```

Watch `npx wrangler tail` (after a real deploy) to see poll/Workflow activity in production.

## Regenerating after a prompt change

Every prompt template in `src/llm/prompts/*.js` exports a `version` string. Edit the
template's wording, bump its `version`, and deploy — the next poll tick (or a manual
"Regenerate" click in `candidates.html`) will detect the version bump and re-run that
stage's evaluation. Nothing is ever overwritten; the old version stays in `stage_evaluations`
as history.

## Adding a future pipeline (e.g. Data Scientist)

1. Create `src/pipelines/data-scientist.js`, modeled on `ai-engineer.js`: job-title match,
   trigger stage, stage definitions, competencies.
2. Register it in `src/pipelines/index.js`.
3. If a stage needs a genuinely new evaluation shape, add a new `evalType` in
   `src/llm/schemas/stageEval.js` and a matching prompt in `src/llm/prompts/`.

Nothing in the poller, evaluation service, Workflow, or viewer needs to change — they all
iterate the pipeline registry generically.
