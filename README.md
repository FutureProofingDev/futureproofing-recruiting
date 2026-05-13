# Futureproofing — AI Engineer Pipeline Dashboard

Live recruiting analytics dashboard powered by Ashby ATS + Cloudflare Pages + Workers.

## Architecture

```
Browser → Cloudflare Pages (public/index.html)
              ↓  /api/report
          Pages Function (functions/api/report.js)
              ↓  POST /hiring/job.list, /application.list
          Ashby ATS API
```

The Ashby API key lives **only** on the server side (Pages Function / Worker). It is never exposed to the browser.

---

## Quick Start (Pages Functions — recommended)

### 1. Install Wrangler

```bash
npm install -g wrangler
```

### 2. Login to Cloudflare

```bash
wrangler login
```

### 3. Set the Ashby API key

From the project root:

```bash
wrangler pages secret put ASHBY_API_KEY
```

Paste your Ashby API key when prompted. The key is used as HTTP Basic Auth username with an empty password.

### 4. Deploy to Cloudflare Pages

```bash
wrangler pages deploy public --project-name futureproofing-recruiting
```

On first run, Wrangler will create the Pages project. Subsequent deploys update it.

The Pages Function in `functions/api/report.js` is automatically deployed alongside the static files — no separate Worker deploy needed.

### 5. Open the dashboard

Visit the URL shown after deploy (e.g. `https://futureproofing-recruiting.pages.dev`).

Click **Analyze Now** to fetch live data from Ashby.

---

## Alternative: Standalone Worker Deployment

If you prefer to deploy the Worker separately (e.g. to use a custom Worker route):

### 1. Deploy the Worker

```bash
cd worker
wrangler secret put ASHBY_API_KEY   # paste key when prompted
wrangler deploy
```

The Worker deploys to `https://futureproofing-worker.YOUR-SUBDOMAIN.workers.dev`.

### 2. Update the API URL in the frontend

Open `public/index.html` and update line ~330:

```js
// Change this:
const API_URL = '/api/report';

// To your Worker URL:
const API_URL = 'https://futureproofing-worker.YOUR-SUBDOMAIN.workers.dev/api/report';
```

### 3. Deploy the frontend

```bash
wrangler pages deploy public --project-name futureproofing-recruiting
```

---

## Custom Domain (Cloudflare Pages)

1. Go to **Cloudflare Dashboard → Pages → futureproofing-recruiting → Custom domains**
2. Click **Set up a custom domain**
3. Enter your domain (e.g. `pipeline.futureproofing.ai`)
4. Follow the DNS instructions (add a CNAME record pointing to `futureproofing-recruiting.pages.dev`)
5. Cloudflare auto-provisions an SSL certificate

---

## Local Development

```bash
# Install dependencies (none — pure JS, no npm packages needed)
# Run Pages dev server (serves static files + runs Functions locally)
wrangler pages dev public --binding ASHBY_API_KEY=your_key_here
```

Visit `http://localhost:8788`.

For the standalone Worker:

```bash
cd worker
wrangler dev --var ASHBY_API_KEY:your_key_here
```

---

## Environment Variables

| Variable        | Where to set                     | Description                     |
|-----------------|----------------------------------|---------------------------------|
| `ASHBY_API_KEY` | `wrangler pages secret put`      | Ashby API key (Basic Auth user) |

---

## Metrics Computed

| Metric | Description |
|--------|-------------|
| Funnel conversion | Stage-to-stage pass rate across 8 pipeline stages |
| Source quality | Interview 1 pass rate and hires per source |
| Weekly velocity | Interviews conducted and hires per week (rolling 4 weeks) |
| Overall conversion | Total hired ÷ total applicants |
| Pipeline health | Active, archived, hired, pending offer counts |

### Benchmarks

```js
overallConversion:    good ≥ 5%,  warn ≥ 2%
shortlistPassRate:    good ≥ 20%, warn ≥ 10%
interview1PassRate:   good ≥ 40%, warn ≥ 25%
techAssessmentPassRate: good ≥ 40%, warn ≥ 25%
gobPassRateToInterview1: good ≥ 45%, warn ≥ 30%
referralShareOfHires: good ≥ 30%, warn ≥ 15%
hiringTarget: 18 hires by 2026-06-29
```

---

## Caching

The Worker/Function caches Ashby responses for **5 minutes** using the Cloudflare Cache API. Repeated "Analyze Now" clicks within 5 minutes serve the cached response instantly. Cache is invalidated automatically after 5 minutes, or immediately on Worker redeploy.

---

## Troubleshooting

**"No AI Engineer job found"** — The dashboard lists available jobs in the error response. Check that your Ashby API key has access to the job and that the job title contains "AI Engineer".

**"ASHBY_API_KEY not configured"** — Run `wrangler pages secret put ASHBY_API_KEY` and redeploy.

**Rate limit errors** — The Worker retries with exponential backoff (up to 4 attempts). If Ashby is consistently rate-limiting, consider increasing the cache TTL in the Function code (`max-age=300`).

**Stage names not matching** — Ashby stage names are matched by partial string (case-insensitive). If your pipeline uses different names, update `FUNNEL_STAGES[i].match` in `functions/api/report.js`.
