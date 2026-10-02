# Document Processing

**Turn any document into a canonical, validated record — in under a minute, through one API call.**

Drop in a PDF, a photo of a form, or a text file. Document Processing uploads it to a
Progress Agentic RAG (ARAG) Knowledge Box, runs a multi-agent pipeline over it
(process → classify → extract → entities → summary → validate → standardize) and gives you
back a structured record: typed fields with confidence, named entities, a summary, topic
tags and validation issues — exportable as JSON, XML or CSV, and queryable in natural
language.

Built on the [shared ARAG platform](../arag-platform). API-first, zero runtime
dependencies, Apache-2.0.

> **This checkout is set up for Mitsubishi Electric.** Branding (name, three-diamond mark,
> red) comes from the `BRAND_*` values in `.env.example` and `fly.toml`, with the mark in
> `public/brand/`. Six purchase orders are bundled as PDF samples in `public/samples/pdf/`
> (catalogue: `src/services/samples.ts`) and lead the welcome screen. `.env` points at the
> `mitsubishi-electric-orders` Knowledge Box in `aws-ap-southeast-2-1` and at its
> `orders-visual-llm-v2` extract strategy, which is what reads the handwritten order.
> The sample PDFs are customer documents: keep them out of the public repository.

```bash
make install        # bun installs dev tooling only (no npm, ever)
make dev            # http://localhost:8080 — uses the mock ARAG unless .env has credentials
```

Then open:

| Surface | URL | What it is |
|---|---|---|
| Operator app | <http://localhost:8080/> | A signed-in workspace — Documents, Configs, Ask, Jobs, Settings — hash-routed, with a guided first-run sample |
| Admin app | <http://localhost:8080/admin/> | Operations — Overview, Connection, Configs, Jobs, Logs, Usage, Branding, Security |
| API docs | <http://localhost:8080/api/v1/docs> | Redoc (and `/api/v1/swagger` to try it out) |
| OpenAPI | <http://localhost:8080/api/v1/openapi.json> | The spec every route is validated against |

## Sixty-second tour

```bash
# 1. Upload a document; you get the record and the job that is processing it.
curl -sS -X POST 'http://localhost:8080/api/v1/documents?config=auto' \
     -H 'Content-Type: text/plain' -H 'X-Filename: invoice.txt' \
     --data-binary @public/samples/invoice.txt | tee /tmp/up.json

ID=$(jq -r .document.id /tmp/up.json); JOB=$(jq -r .job.id /tmp/up.json)

# 2. Watch the pipeline live (or poll GET /api/v1/jobs/$JOB).
curl -sN "http://localhost:8080/api/v1/jobs/$JOB/events"

# 3. Read the canonical record, or export it.
curl -sS "http://localhost:8080/api/v1/documents/$ID" | jq .
curl -sS "http://localhost:8080/api/v1/documents/$ID/export?format=csv"

# 4. Ask the document a question.
curl -sS -X POST "http://localhost:8080/api/v1/documents/$ID/ask" \
     -H 'Content-Type: application/json' -d '{"question":"What is the total due?"}' | jq .

# 5. Clean up — deletes the record and the KB resource. Destructive verbs always need a
#    credential, so pick one up first (an API key or the admin token work too).
curl -sS -c /tmp/dip.jar -X POST http://localhost:8080/api/v1/session > /dev/null
curl -sS -b /tmp/dip.jar -X DELETE "http://localhost:8080/api/v1/documents/$ID"
```

## What it extracts

Eleven built-in document types, each with its own extraction schema:
`invoice`, `receipt`, `purchase_order`, `contract`, `resume`, `medical_claim`,
`preauthorisation`, `bank_statement`, `form`, `report`, `generic`.

Not enough? `POST /api/v1/extraction-configs` with a list of field labels creates a custom
config, persists it, and provisions a stored ARAG search configuration so the model is
forced to return exactly those fields, grounded in the document. `GET /api/v1/schemas`
lists every built-in type and the fields it captures.

Three ways to decide what gets extracted, chosen with `?config=`:

- `auto` — an agent classifies the document, then the matching schema is used.
- `<config id>` — force a built-in or custom config (classification is skipped).
- `agent` — read fields an ARAG **Data Augmentation agent** already persisted on the
  resource, instead of extracting live.

## API

Everything lives under `/api/v1` and is described by [`src/openapi.ts`](src/openapi.ts).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/documents` | Upload (multipart `file`, or raw body + `X-Filename`) → `202 {document, job}` |
| `GET` | `/documents` | List — search (`q`), filter (`status`, `doc_type`, `config`, `degraded`, `has_issues`, `min_grounding`, `date_from`/`date_to`), sort and page; response includes `facets` |
| `GET` | `/documents/{id}` | The canonical record |
| `GET` | `/documents/{id}/export` | `?format=json\|xml\|csv` |
| `GET` | `/documents/{id}/text` | The document's own extracted text — what `Evidence.start`/`end` index into |
| `GET` | `/documents/{id}/source` | The original uploaded file |
| `POST` | `/documents/{id}/ask` | Grounded Q&A over one document (`citations[]` in the response) |
| `POST` | `/documents/{id}/reprocess` | Re-run the pipeline over an already-uploaded document (needs a credential) |
| `POST` | `/documents/sample` | Process one of the bundled samples in one call |
| `POST` | `/documents/bulk-delete`, `/documents/bulk-export` | Act on a selection of ids at once (needs a credential for delete) |
| `DELETE` | `/documents/{id}` | Delete the record **and** the KB resource (needs a credential) |
| `GET` | `/stats` | Workspace counters behind the Documents stat strip |
| `GET` | `/settings` | Non-secret runtime settings: connection, extraction limits, branding |
| `GET` | `/samples` | The bundled sample-document catalogue |
| `GET` | `/jobs`, `/jobs/{id}` | Processing jobs (paged: `page`, `page_size`, `sort`, `order`, `q`) |
| `GET` | `/jobs/{id}/events` | Server-sent events for a running job |
| `DELETE` | `/jobs/{id}` | Cancel (needs a credential) |
| `GET`/`POST` | `/extraction-configs` | List / create |
| `GET`/`PUT`/`DELETE` | `/extraction-configs/{id}` | Read / replace / delete (write needs a credential; built-ins are not deletable or editable) |
| `POST` | `/extraction-configs/{id}/provision` | Re-provision one config's stored ARAG search configuration (needs a credential) |
| `GET` | `/schemas` | Document types and their fields |
| `POST` | `/session` | Same-origin session cookie for the operator app |
| `GET` | `/admin/health`, `/admin/config`, `/admin/usage`, `/admin/logs`, `/admin/security` | Operator views (security posture never returns a full key or token) |
| `POST` | `/admin/login`, `/admin/provision`, `/admin/purge` | Sign in, re-provision search configs, retention purge (`dryRun: true` previews without deleting) |

Errors are RFC 9457 `application/problem+json` with a `requestId` that ties back to the
logs. Uploads are limited by a MIME allowlist (pdf, png, jpeg, webp, tiff, txt, md, csv,
docx) and a size cap; filenames are sanitised.

Reads and uploads are open by default (rate-limited per IP) so the operator app and these
examples work with no setup. **Destructive verbs always require a credential** — an API key, the
admin token, or a same-origin session cookie from `POST /api/v1/session` — even when
`API_KEYS` is unset. Set `API_KEYS` for anything reachable from the internet.

## Configuration

Copy `.env.example` to `.env`. Without ARAG credentials, set `ARAG_MOCK=1` and everything
runs against the in-process mock Knowledge Box — no account, no LLM spend.

| Variable | Default | Notes |
|---|---|---|
| `ARAG_KB_ID`, `ARAG_API_KEY`, `ARAG_REGION` | — | Knowledge Box and service-account token. Required unless `ARAG_MOCK=1`. |
| `ARAG_GENERATIVE_MODEL` | `chatgpt-azure-4o` | Must be multimodal for visual extraction. |
| `DIP_EXTRACT_STRATEGY` | — | ARAG extract-strategy id applied to image/PDF uploads. |
| `DIP_MAX_UPLOAD_BYTES` | `26214400` | Upload cap (25 MB). |
| `ADMIN_TOKEN` | — | Required to open `/admin` and `/api/v1/admin/*`. |
| `API_KEYS` | — | When set, `/api/v1` requires `X-API-Key` (the operator app uses a session cookie). |
| `DATA_DIR` | `./data` | JSON stores: documents, jobs, extraction configs. |

Full list with comments: [`.env.example`](.env.example).

## Development

```bash
make check          # Biome + tsc --noEmit + tests with the 80 % coverage gate + dependency audit
make e2e            # Playwright: operator app + admin app against a mock-backed server
make docs           # regenerate docs/developer/api-reference.md and check every doc link
make showcase       # record the 2–3 minute walkthrough into showcase/out/
make smoke          # OPT-IN live run against the real KB (uploads, processes, deletes)
make docker         # build the container image
make fly-validate   # validate fly.toml
```

The platform is vendored in `vendor/arag-platform/` and must never be edited in place —
change the platform repo and re-run `make sync-platform`.

## Documentation

Start at [`docs/README.md`](docs/README.md): developer quickstart and API reference,
architecture and the ARAG mechanics that make this reliable, business walkthroughs,
product marketing, hands-on enablement labs, and the showcase script.

## Deploying

`Dockerfile` (node:22-slim, non-root, no build step) and `fly.toml` (app
`arag-doc-processing`, `data` volume mounted at `/data`) are ready to go:

```bash
fly secrets set ARAG_KB_ID=… ARAG_API_KEY=… ARAG_REGION=aws-us-east-2-1 \
                ADMIN_TOKEN=… DIP_EXTRACT_STRATEGY=… API_KEYS=…
fly deploy
```

See [`docs/architecture/deployment-topologies.md`](docs/architecture/deployment-topologies.md).

## Licence

Apache-2.0 — see [LICENSE](LICENSE). Contributions welcome: [CONTRIBUTING.md](CONTRIBUTING.md).
