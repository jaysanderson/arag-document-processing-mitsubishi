# API reference — Document Processing API v1.0.0

Turn any document into a canonical, validated record. Upload a PDF, image, or text file; a job runs the pipeline on Progress Agentic RAG (process → classify → extract → entities → summary → validate → standardize) and returns structured fields, entities, a summary and validation issues, exportable as JSON, XML or CSV.

Generated from `openapi.json` — do not edit by hand. Interactive docs: `/api/v1/docs` (Redoc) and `/api/v1/swagger` (try it out).

## Authentication

- **ApiKey** — apiKey header X-API-Key: Required only when API_KEYS is configured.
- **Bearer** — http bearer : API key or admin token as a bearer token.
- **AdminToken** — http bearer : ADMIN_TOKEN; required for /admin routes.

## documents

### `GET /api/v1/documents`

**List documents (newest first) with search, filters and sorting** — Every parameter is optional and they combine with AND. `q` is a case-insensitive substring match across the filename, the summary, the tags and the extracted field labels and values — so a user can find a document by the supplier on it, not only by the name it was uploaded under.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `page` | query | integer |  |  |
| `page_size` | query | integer |  |  |
| `status` | query | string |  |  |
| `doc_type` | query | array of string |  | Document type. Repeat the parameter to select several (`?doc_type=invoice&doc_type=receipt`). |
| `q` | query | string |  | Free-text search over filename, summary, tags and extracted field values |
| `sort` | query | string |  | Field to order by (default `created_at`) |
| `order` | query | string |  |  |
| `date_from` | query | string |  | Only documents created at or after this instant (ISO 8601 or YYYY-MM-DD) |
| `date_to` | query | string |  | Only documents created at or before this instant (ISO 8601 or YYYY-MM-DD) |
| `config` | query | string |  | Only documents extracted with this extraction configuration id |
| `degraded` | query | boolean |  | `true` returns only records that finished with a failed stage (`meta.stageErrors`); `false` excludes them. |
| `has_issues` | query | boolean |  | `true` returns only records carrying at least one validation issue |
| `min_grounding` | query | number |  | Only records whose `meta.groundingScore` is at least this. Records with no score are excluded — an unmeasured record is not a well-grounded one. |
| `kv` | query | array of string |  | Filter by an **extracted value**, through the Knowledge Box rather than this workspace's store. Shape: `kv=<schemaId>:<field>:<op>:<value>` — for example `kv=dip_invoice_extraction:total:gte:10000`. Repeat the parameter to narrow further; several `kv` filters are ANDed.

`schemaId` is an extraction configuration's `kvSchemaId` and `field` is one of its `kvFields`. Only the first three colons separate, so a value may contain them — which an RFC 3339 instant does.

Operators are per field kind and are checked before the call, because ARAG enforces them with a 412 that says nothing useful:
- `eq` — any scalar field (text, integer, float, boolean, date)
- `gte` / `lte` — integer, float and date scalars only
- `contains` — `repeated` fields (is this a member?) and `range` fields (is this point inside the interval?)

A filter naming an unknown schema or field, or using an operator that field does not accept, answers **400** with the operators it does accept. Resolved as a `/find` with an empty query (key-value filter expressions are rejected by `/catalog`), whose matching resource ids are intersected with the local list; the response's `filters` block says which filters ran where. |

Responses:

- `200` OK — `application/json` [DocumentPage](#documentpage)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `POST /api/v1/documents`

**Upload a document and start the processing job** — Accepts `multipart/form-data` with a `file` part, or a raw body with an `X-Filename` header. `config` selects the extraction configuration: `auto` classifies the document, `agent` reads fields persisted by an ARAG Data Augmentation agent, or pass an extraction-config id. Returns 202 with the document record and the job to watch.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `config` | query | string |  | auto | agent | <extraction config id> |
| `X-Filename` | header | string |  | Filename for raw-body uploads (ignored for multipart) |

Request body (`multipart/form-data`): object

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | string |  |  |
| `config` | string |  |  |

Request body (`application/pdf`): string

_string_

Request body (`image/png`): string

_string_

Request body (`image/jpeg`): string

_string_

Request body (`text/plain`): string

_string_

Request body (`application/octet-stream`): string

_string_

Responses:

- `202` Accepted — `application/json` [DocumentAccepted](#documentaccepted)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `413` Upload too large — `application/problem+json` [Problem](#problem)
- `415` Unsupported media type — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `GET /api/v1/documents/{id}`

**Get the canonical record for one document** — The full record: classification, extracted fields with their confidence, the quotes supporting them and how each was verified, entities, summary, tags, validation issues and the pipeline metadata (schema, model, per-stage timings, grounding score).

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Responses:

- `200` OK — `application/json` [Document](#document)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `DELETE /api/v1/documents/{id}`

**Delete a document and its ARAG resource** — Requires a credential even when `API_KEYS` is unset: an API key, the admin token, or a same-origin session cookie from `POST /api/v1/session`.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Responses:

- `204` Deleted
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `GET /api/v1/documents/{id}/export`

**Download the record as JSON, XML or CSV** — Serialises the same record `GET /documents/{id}` returns into the requested format and sends it as an attachment. CSV flattens the extracted fields to one row per field.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `format` | query | string |  |  |

Responses:

- `200` Standardised export — `application/json` [Document](#document)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `POST /api/v1/documents/{id}/ask`

**Ask a grounded question about one document** — Answers from this document's own text. Every call is a generative model call against the Knowledge Box, so this route has its own, tighter rate-limit bucket than the shared public one — an anonymous caller can still try the product without a credential, but cannot use it as an unbounded model proxy.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Request body (`application/json`): [AskRequest](#askrequest)


Responses:

- `200` OK — `application/json` [AskResponse](#askresponse)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `GET /api/v1/documents/{id}/text`

**The document's own extracted text** — The text Progress Agentic RAG read from the file at ingestion — what every extraction stage saw, and what `Evidence.start`/`Evidence.end` index into. Without it a client can show an evidence quote but cannot show it *in the document*.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `max_chars` | query | integer |  |  |

Responses:

- `200` OK — `application/json` [DocumentText](#documenttext)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `GET /api/v1/documents/{id}/source`

**The original uploaded file** — Streams the bytes back from the ARAG resource, `Content-Disposition: inline`, so a reviewer can see the page the values came from. Answers 404 when the resource no longer holds the file; a client should then fall back to the extracted text.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Responses:

- `200` The original file — `application/octet-stream` string
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `POST /api/v1/documents/sample`

**Process one of the bundled sample documents** — Reads the sample from disk server-side and runs it through the ordinary upload path, so the first-run flow is one call rather than a fetch followed by an upload. The sample ids come from `GET /api/v1/samples`.

Request body (`application/json`): [SampleRequest](#samplerequest)


Responses:

- `202` Accepted — `application/json` [DocumentAccepted](#documentaccepted)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `POST /api/v1/documents/{id}/reprocess`

**Re-run the pipeline over a document already in the Knowledge Box** — The recovery action for a failed or degraded record: the resource is already uploaded, so this queues a fresh job over it rather than asking the user to upload the file again. Returns 202 with the reset record and the new job to watch. Requires a credential even when `API_KEYS` is unset (it spends model calls): an API key, the admin token, or a same-origin session cookie from `POST /api/v1/session`.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `config` | query | string |  | Extraction configuration to use for the re-run (default: the original one) |

Responses:

- `202` Accepted — `application/json` [DocumentAccepted](#documentaccepted)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `409` The document is already queued or processing — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `POST /api/v1/documents/bulk-delete`

**Delete several documents and their ARAG resources** — Best-effort: each id is attempted and reported separately, so one missing document does not abandon the rest of the selection. Requires the same credential as a single delete.

Request body (`application/json`): [BulkDeleteRequest](#bulkdeleterequest)


Responses:

- `200` OK — `application/json` [BulkDeleteResult](#bulkdeleteresult)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `POST /api/v1/documents/bulk-export`

**Download several records as one JSON, XML or CSV file** — JSON returns an array of records; XML wraps them in a `<documents>` root; CSV emits one header and one row per extracted field across every selected record, so a spreadsheet can reconcile a whole batch in one pass. Ids that do not exist are skipped and named in the `X-Skipped-Ids` response header.

Request body (`application/json`): [BulkExportRequest](#bulkexportrequest)


Responses:

- `200` Standardised export of the selected records — `application/json` array of [Document](#document)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `GET /api/v1/stats`

**Workspace counters: documents by status and type, grounding, jobs** — What the documents overview strip shows. Cheap and credential-free, so a list screen can poll it while a pipeline runs without an admin token.

Responses:

- `200` OK — `application/json` [Stats](#stats)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer

## system

### `GET /api/v1/settings`

**Effective, non-secret runtime settings for the workspace** — Connection state, extraction configuration, upload limits and branding — everything the Settings screen shows a signed-in user. Secrets (the extract-strategy id, tokens, keys) stay behind `ADMIN_TOKEN` on `/api/v1/admin/config`.

Responses:

- `200` OK — `application/json` [Settings](#settings)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `GET /api/v1/samples`

**Bundled sample documents for the first-run flow** — The catalogue behind “Try with a sample”: each entry names a file served from `/samples/`, which the client uploads to `POST /api/v1/documents` like any other document. Nothing here is special-cased in the pipeline.

Responses:

- `200` OK — `application/json` object
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `GET /api/v1/branding`

**Effective white-label branding for this deployment** — Public and secret-free — it contains only what a visitor already sees. Both UIs fetch it before they paint; a partner's own front end can too. Configured with `BRAND_*` environment variables; assets live in `DATA_DIR/branding/` and are served from `/branding/`. See `docs/developer/white-label.md`.

Responses:

- `200` OK — `application/json` [Branding](#branding)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: public


### `POST /api/v1/session`

**Issue a same-origin session cookie for the demo UI** — Sets a signed, SameSite=Lax `arag_session` cookie so a same-origin front end can call the API when API keys are enforced, and can satisfy the writer guard DP-12 applies to deletes and config creation. It is not a login: it carries no identity and grants no admin access.

Responses:

- `200` OK — `application/json` object
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: public

## jobs

### `GET /api/v1/jobs`

**List processing jobs** — Newest first, with paging, a status filter and a search over the job's document and config. Each job carries its stage events, so a client can render a pipeline history without opening the stream.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `status` | query | string |  |  |
| `ref` | query | string |  | Filter by document id |
| `limit` | query | integer |  |  |
| `page` | query | integer |  |  |
| `page_size` | query | integer |  | Preferred over `limit`, which stays for compatibility |
| `sort` | query | string |  |  |
| `order` | query | string |  |  |
| `q` | query | string |  | Match the job id, its kind, or the document id it refers to |

Responses:

- `200` OK — `application/json` object
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `GET /api/v1/jobs/{id}`

**Get a job** — One job with its full event list: every stage start, progress, success, skip or error, with per-stage durations. This is what the pipeline view replays after a reload.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Responses:

- `200` OK — `application/json` [Job](#job)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `DELETE /api/v1/jobs/{id}`

**Cancel a queued or running job** — Requires a credential even when `API_KEYS` is unset: an API key, the admin token, or a same-origin session cookie from `POST /api/v1/session`. A job that has already finished cannot be cancelled and answers 409.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Responses:

- `204` Cancelled
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `409` The job already finished (succeeded, failed or cancelled) — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `GET /api/v1/jobs/{id}/events`

**Server-sent events for a job (event names: event, job)** — Replays the job's events so far, then streams new ones. `event` carries a JobEvent (stage, status, ms, message); `job` carries the job itself on each status change and closes the stream when the job finishes.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Responses:

- `200` text/event-stream — `text/event-stream` string
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer

## extraction-configs

### `GET /api/v1/extraction-configs`

**List built-in and custom extraction configurations** — Every configuration an upload can be processed with, built-in and custom, each with the fields it extracts, whether it is provisioned in the Knowledge Box, and how many stored documents were processed with it (the question that decides whether it can be deleted).

Responses:

- `200` OK — `application/json` object
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `POST /api/v1/extraction-configs`

**Create a custom extraction configuration** — Persists the config and provisions a stored ARAG search configuration (kind `ask`) that pins the model, the full_resource RAG strategy, the grounding prompt and the answer_json_schema built from these fields. Because it writes into the Knowledge Box, it requires a credential even when `API_KEYS` is unset: an API key, the admin token, or a same-origin session cookie from `POST /api/v1/session`.

Request body (`application/json`): [ExtractionConfigCreate](#extractionconfigcreate)


Responses:

- `201` Created — `application/json` [ExtractionConfig](#extractionconfig)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `GET /api/v1/extraction-configs/{id}`

**Get one extraction configuration** — The configuration's fields, its ARAG search-configuration name, its provisioning state and the number of documents processed with it.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Responses:

- `200` OK — `application/json` [ExtractionConfig](#extractionconfig)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `PUT /api/v1/extraction-configs/{id}`

**Replace a custom extraction configuration** — Replaces the name, description and fields, and re-provisions the stored ARAG search configuration. The id is kept, so `meta.config` on every document already processed with this configuration stays meaningful — which delete-and-recreate would break. Built-in configurations answer 409. Requires a writer credential.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Request body (`application/json`): [ExtractionConfigCreate](#extractionconfigcreate)


Responses:

- `200` OK — `application/json` [ExtractionConfig](#extractionconfig)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `409` Built-in configuration cannot be edited — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `DELETE /api/v1/extraction-configs/{id}`

**Delete a custom extraction configuration (built-ins are not deletable)** — Requires a credential even when `API_KEYS` is unset: an API key, the admin token, or a same-origin session cookie from `POST /api/v1/session`.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Responses:

- `204` Deleted
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `409` Built-in configuration cannot be deleted — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `POST /api/v1/extraction-configs/{id}/provision`

**Re-provision one configuration's Knowledge Box objects** — Re-provisions both the stored ARAG search configuration and the key-value schema this configuration writes into, and reports each separately. Idempotent. `POST /api/v1/admin/provision` re-provisions all of them and needs the admin token; this is the granularity an operator needs to fix the one config that did not take. Requires a writer credential.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Responses:

- `200` OK — `application/json` [ProvisionResult](#provisionresult)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer

## schemas

### `GET /api/v1/schemas`

**List document types and the fields each extraction schema captures** — The read-only catalogue behind auto-classification: every document type this product recognises and the fields its built-in schema extracts, with types and required flags. Use it to see what a document of a given type will yield before uploading one.

Responses:

- `200` OK — `application/json` object
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer

## admin

### `POST /api/v1/admin/login`

**Exchange the admin token for an HttpOnly cookie** — Verifies ADMIN_TOKEN in constant time and sets the HttpOnly `arag_admin` cookie the admin panel uses, so the token itself is not held in browser storage. Returns 403 when no admin token is configured (admin is disabled) and 401 when the token is wrong.

Request body (`application/json`): object

| Field | Type | Required | Description |
|---|---|---|---|
| `token` | string | yes |  |

Responses:

- `200` OK — `application/json` object
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: public


### `POST /api/v1/admin/logout`

**End the operator session** — Clears the `arag_admin` cookie. The other half of `adminLogin`: an operator who can sign in on a shared machine has to be able to sign out of it, and waiting twelve hours for the cookie to expire is not a control. Always answers 200 — signing out when you were not signed in is not an error, and reporting one would tell an unauthenticated caller whether a session existed.

Responses:

- `200` OK — `application/json` object
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: public


### `GET /api/v1/admin/health`

**Service health, KB connection test, extract strategy and model** — A live round trip to the Knowledge Box plus the operator's view of this process: uptime, the effective extract strategy and generative model, document counts by status (including `degraded`, records that finished but lost a stage) and the mean grounding score across stored records.

Responses:

- `200` OK — `application/json` object
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: AdminToken


### `GET /api/v1/admin/config`

**Effective configuration (secrets redacted)** — What this process is running with: the environment with every secret redacted, the effective branding and how to change it, the extraction configurations and their provisioning state, the JSON stores on disk, and the registered route table. For the editable view of the same configuration, use `GET /api/v1/admin/settings`.

Responses:

- `200` OK — `application/json` object
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: AdminToken


### `GET /api/v1/admin/usage`

**Usage counters (requests, ARAG calls, jobs, documents)** — Counters since boot: HTTP requests, calls to ARAG split into failures, expected provisioning conflicts and other client errors, total ARAG time, plus document and job counts. Intended for an operator's dashboard, not for billing.

Responses:

- `200` OK — `application/json` object
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: AdminToken


### `GET /api/v1/admin/logs`

**Page the runtime log ring buffer** — Records are returned oldest first. Without a cursor you get the newest `limit` records (the tail, as before). With `cursor` and `direction` you walk the buffer in either direction on a stable sequence number, so records arriving while an operator reads cannot duplicate or hide a row. Follow `prevCursor` with `direction=older` to read back, and `nextCursor` with `direction=newer` to tail.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `level` | query | string |  | Minimum level to include. |
| `contains` | query | string |  | Case-insensitive substring match over the whole record. |
| `limit` | query | integer |  |  |
| `cursor` | query | string |  | Opaque cursor from a previous page's `nextCursor`/`prevCursor`. |
| `direction` | query | string |  | Which way to walk from the cursor. Ignored when no cursor is given. |

Responses:

- `200` OK — `application/json` [LogPage](#logpage)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: AdminToken


### `GET /api/v1/admin/search-configurations`

**Read the stored ARAG search configurations this product provisions** — Fetches the `dip_*` search configurations straight from the Knowledge Box, so an operator can confirm which model, RAG strategy, prompt and answer_json_schema the extraction agents are actually running against — without opening the ARAG dashboard.

Responses:

- `200` OK — `application/json` object
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: AdminToken


### `GET /api/v1/admin/security`

**What is protecting this deployment** — Credentials in force, rate limits, CORS, upload ceiling and retention default, in one shape. Key values are never returned — only how many there are and the last four characters of each, which is what an operator needs to tell two keys apart.

Responses:

- `200` OK — `application/json` [SecurityPosture](#securityposture)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: AdminToken


### `POST /api/v1/admin/provision`

**Re-provision every extraction configuration's Knowledge Box objects** — Idempotent: safe to re-run after a Knowledge Box reset, a model change or an upgrade. Each configuration is POSTed and, when it already exists, PATCHed — so the stored search configurations end up carrying the current model, reranker, prompt and JSON schema whatever state they were in. Each configuration's key-value schema is ensured in the same pass and reported as `keyValueSchema`; the 20-schemas-per-Knowledge-Box ceiling is checked once for the whole run rather than per config.

Responses:

- `200` OK — `application/json` object
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: AdminToken


### `POST /api/v1/admin/purge`

**Delete documents older than N days from the store and the Knowledge Box** — With `dryRun: true` nothing is deleted: the response reports how many documents would go and the date range they span, so a confirmation dialog can state the blast radius instead of guessing at it.

Request body (`application/json`): object

| Field | Type | Required | Description |
|---|---|---|---|
| `olderThanDays` | number |  |  |
| `dryRun` | boolean |  |  |

Responses:

- `200` OK — `application/json` object
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: AdminToken


### `GET /api/v1/admin/settings`

**Every setting, with its effective value, source and secret state** — The settings screen reads this. For each field it reports the effective value, whether that value came from an in-product edit (`store`), the deployment's environment (`env`) or the built-in default, and whether the field is a secret — secrets report `{ set, hint }` and never their value. `applied` reports what the running process is actually using (the ARAG client's KB and timeout, the live rate limiter, the upload ceiling, the retention scheduler), which is how the UI shows that an edit took effect without a restart.

Responses:

- `200` OK — `application/json` [SettingsDocument](#settingsdocument)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: AdminToken


### `PATCH /api/v1/admin/settings`

**Change settings; they take effect immediately, with no restart** — Validates every field before writing anything: a colour outside the platform's strict grammar, a Knowledge Box id that is not a UUID or a number outside its range fails the whole patch with an RFC 9457 problem naming each offending key. Applied changes are persisted in the product's store (so they survive a restart and override the environment), pushed into the live objects — the ARAG client is rebuilt when a connection field changes — and written to the audit log with who, what and when. Secrets are accepted here and never returned anywhere.

Request body (`application/json`): [SettingsPatch](#settingspatch)


Responses:

- `200` OK — `application/json` [SettingsPatchResult](#settingspatchresult)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: AdminToken


### `POST /api/v1/admin/settings/reset`

**Drop in-product overrides and fall back to the environment default** — The other half of “environment variables are defaults that the store overrides”: this removes the stored override for the named keys, so each field's `source` returns to `env` (or `default`). Audited like any other settings change.

Request body (`application/json`): [SettingsResetRequest](#settingsresetrequest)


Responses:

- `200` OK — `application/json` [SettingsPatchResult](#settingspatchresult)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: AdminToken


### `POST /api/v1/admin/branding/logo`

**Upload a logo and point branding at it** — Accepts a `multipart/form-data` body with a `file` part (SVG, PNG, JPEG, WebP or GIF, up to 2 MB), writes it into `DATA_DIR/branding/` — a mounted volume in production, so rebranding never needs a rebuild — and sets `branding.logoUrl` to the `/branding/…` path it is served from. Returns the new asset and the updated settings document.

Request body (`multipart/form-data`): object

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | string | yes |  |

Responses:

- `201` Created — `application/json` [BrandingAsset](#brandingasset)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `413` The file is larger than the 2 MB brand-asset ceiling — `application/problem+json` [Problem](#problem)
- `415` Not an image type this product will serve — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: AdminToken


### `GET /api/v1/admin/api-keys`

**List API keys with their last use** — Never returns a key or its digest: an operator identifies a key by its name and prefix. `lastUsedAt` is updated on successful authentication (in memory, folded into the store at most once a minute per key, so authentication never costs a write). Revoked keys stay listed so the history is readable.

Responses:

- `200` OK — `application/json` object
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: AdminToken


### `POST /api/v1/admin/api-keys`

**Create an API key (the plaintext is returned once)** — Mints `dip_<id>_<secret>` and stores only a salted SHA-256 digest of the secret. The response is the one and only place the key appears — it cannot be recovered afterwards, only revoked and replaced. The key authenticates exactly like an `API_KEYS` entry: as `X-API-Key`, as a bearer token, and as a writer credential for the operations DP-12 protects.

Request body (`application/json`): [ApiKeyCreateRequest](#apikeycreaterequest)


Responses:

- `201` Created — `application/json` [ApiKeyCreated](#apikeycreated)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: AdminToken


### `DELETE /api/v1/admin/api-keys/{id}`

**Revoke an API key** — The key stops authenticating on the next request. The record is kept (with `revokedAt`) so the audit trail still explains what that key did.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Responses:

- `200` OK — `application/json` [ApiKey](#apikey)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: AdminToken


### `GET /api/v1/admin/audit`

**Page the audited-change log** — Who changed what, and when — every settings edit, API-key creation and revocation, extraction-config create/edit/delete/provision, field corrections, purge and document delete, newest first. Secret values are redacted to `***` before the entry is written. Paging is by a stable sequence number: follow `nextCursor` with `direction=older` to read back through history and `prevCursor` with `direction=newer` to return, with no duplicates or gaps however many entries arrive in between.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `action` | query | string |  | Exact action, or a prefix such as `settings` to match `settings.update` and `settings.reset`. |
| `actor` | query | string |  | Actor name or type (`admin`, `api-key`, `session`, `anonymous`, `system`). |
| `target` | query | string |  | Exact target: a setting key, key id, config id or document id. |
| `limit` | query | integer |  |  |
| `cursor` | query | string |  | Opaque cursor from a previous page. |
| `direction` | query | string |  | Walk older (further back) or newer (back towards the top) from the cursor. |

Responses:

- `200` OK — `application/json` [AuditPage](#auditpage)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: AdminToken

## review

### `PUT /api/v1/documents/{id}/fields/{key}`

**Correct one extracted field** — Records a correction rather than overwriting the model's output: the original value, the original quote and who changed it are all kept. The corrected value is re-checked against the document's own text with the same evidence contract the pipeline uses — a human typing a value does not make it grounded, but if the value they typed *is* in the document that is worth knowing, so the correction earns a new quote and the field's model confidence is dropped (the model did not produce this value and claiming its confidence would be a lie on the most-read number in the record view).

The corrected record is also written back into the resource's key-value field. Because a key-value write replaces the whole schema's data, the *entire* current record is sent, not just the one field — and because the Knowledge Box's filter index keeps every value ever written, this second write leaves the resource still matching a filter on the value it replaced. That is reported on `correction.kv.filterIndexStale` and `meta.kv.superseded` rather than hidden.

A write against shared state, so it needs a credential even when `API_KEYS` is unset: an API key, the admin token, or a same-origin session cookie.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `key` | path | string | yes | The `ExtractedField.key` being corrected, e.g. `invoice_number` |

Request body (`application/json`): [FieldCorrectionRequest](#fieldcorrectionrequest)


Responses:

- `200` OK — `application/json` [FieldCorrectionResult](#fieldcorrectionresult)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `DELETE /api/v1/documents/{id}/fields/{key}`

**Undo the most recent correction to a field** — Restores the value the last correction replaced — as a *new* correction, so the history stays append-only and the revert is as attributable as the change it undoes. The restored value is re-verified against the document like any other correction, and written back to the Knowledge Box the same way (with the same filter-index consequence). Answers 400 when the field has never been corrected.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `key` | path | string | yes | The `ExtractedField.key` being corrected, e.g. `invoice_number` |

Responses:

- `200` OK — `application/json` [FieldCorrectionResult](#fieldcorrectionresult)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `GET /api/v1/documents/{id}/corrections`

**The corrections made to one record, newest first** — The record's review history: every value a person changed, what it was before, why they say they changed it, whether the new value could be verified against the document, and whether it reached the Knowledge Box. The same list is on the record itself as `corrections` (oldest first); this is the reading order a review panel wants.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Responses:

- `200` OK — `application/json` object
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `POST /api/v1/ask`

**Ask one grounded question across a filtered set of documents** — The same grounded ask the record view offers, with the scope widened from one document to a filtered set of them — and the filter is the Documents list's own, so “ask the twelve invoices from last week” is the list already on screen. Citations come back mapped to this product's document ids, so “show me where” still works across documents.

Retrieval over the set, not `full_resource`: across dozens of documents that would be an enormous prompt and a slow, expensive call. Every ask is a real generative call against the Knowledge Box, so this route has its own tight rate-limit bucket.

Request body (`application/json`): [CorpusAskRequest](#corpusaskrequest)


Responses:

- `200` OK — `application/json` [CorpusAnswer](#corpusanswer)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer

## generators

### `POST /api/v1/extraction-configs/{id}/generator`

**Provision and start a Data Augmentation generator agent for this configuration** — The alternative extraction path: instead of this product asking the document a question per upload, ARAG runs a task of its own that sweeps resources and writes the values it extracts straight into this configuration's key-value schema. The schema's field descriptions are the instructions, which is why they are carried across verbatim when the schema is provisioned.

The agent writes into its **own** key-value schema (`<config schema>_gen`), provisioned on demand when the agent is started — not the schema the pipeline writes into. A key-value write is a full replace, so one shared schema would mean a sweep silently erasing the pipeline's values and polluting the resource's filter index; it also costs one more of the Knowledge Box's 20 key-value schemas, which is why it is not provisioned for every configuration at boot.

ARAG allows only one running `ask` task per destination and the destination is that key-value schema, so starting again replaces the existing agent (stopped first — a running task cannot be deleted, which answers 409). Answers 400 when the configuration's key-value schema is not provisioned, because the agent's schema is derived from it.

Note on what is verified: provisioning, the start → stop → delete lifecycle and reading generated values back were all confirmed against the live Knowledge Box. End-to-end write latency was **not** — every run started there was still scheduled after 20 minutes — so this returns as soon as the task is accepted and the caller polls.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Request body (`application/json`): object

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string |  | Generative model for the agent. Defaults to the configured one. |

Responses:

- `202` Started — `application/json` [GeneratorAgent](#generatoragent)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `GET /api/v1/extraction-configs/{id}/generator`

**The generator agent running for this configuration, if any** — There is no per-task GET on the platform (it answers 405), so the state is found by locating the task id in the buckets of the Knowledge Box's task list. `agent` is null when this workspace has not started one.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Responses:

- `200` OK — `application/json` object
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `DELETE /api/v1/extraction-configs/{id}/generator`

**Stop and delete this configuration's generator agent** — Stops the task first and then deletes it, because ARAG refuses to delete a running task. The values the agent has already written stay on their resources — deleting the agent stops future writes, it does not retract past ones. Requires a writer credential.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Responses:

- `204` Deleted
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `POST /api/v1/extraction-configs/{id}/generator/stop`

**Stop a running generator agent without deleting it** — Halts a sweep in progress while keeping the task, so it can be inspected in the ARAG dashboard before it is removed. Stopping is idempotent: a task that is already stopped, or already gone, is not an error. Requires a writer credential.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Responses:

- `200` OK — `application/json` [GeneratorAgent](#generatoragent)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `POST /api/v1/documents/{id}/generator-run`

**Run the generator agent over this one document** — There is no “run this task on that document” call on the platform, so a single-document run is a task filtered to one resource id — which is also the only safe way to keep a run from sweeping the whole Knowledge Box. Returns 202 with the task; poll `GET /api/v1/extraction-configs/{id}/generator` for its state and read the result with the comparison endpoint. Requires a writer credential: it starts real model work against the Knowledge Box.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Request body (`application/json`): object

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string |  |  |

Responses:

- `202` Started — `application/json` [GeneratorAgent](#generatoragent)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer


### `GET /api/v1/documents/{id}/generator-comparison`

**This product's extraction beside the generator agent's, field by field** — The record view's answer to “which path should I use?”, with agreement or disagreement marked per field.

The two columns are **not** equivalent and the payload says so rather than leaving it to be inferred from a layout: the evidence contract applies to this product's path only. Its values carry a verbatim quote checked against the document's own text; a generator agent returns values and no quote, so every `generator.evidence` is `null` and `evidenceContract.generator` states that those values are not grounded to the same standard.

`observed` is the same honesty about this product's own testing: provisioning, the task lifecycle and reading values back were verified against the live Knowledge Box; end-to-end write latency was not.

Parameters:

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | path | string | yes |  |

Responses:

- `200` OK — `application/json` [GeneratorComparison](#generatorcomparison)
- `400` Validation failed — `application/problem+json` [Problem](#problem)
- `401` Authentication required — `application/problem+json` [Problem](#problem)
- `403` Forbidden — `application/problem+json` [Problem](#problem)
- `404` Not found — `application/problem+json` [Problem](#problem)
- `429` Rate limited — `application/problem+json` [Problem](#problem)
- `502` Upstream (ARAG) error — `application/problem+json` [Problem](#problem)

Auth: ApiKey or Bearer

## Schemas

### Problem

RFC 9457 problem details

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | yes |  |
| `title` | string | yes |  |
| `status` | integer | yes |  |
| `detail` | string |  |  |
| `instance` | string |  |  |
| `requestId` | string |  |  |
| `errors` | array of object |  |  |

### Health

| Field | Type | Required | Description |
|---|---|---|---|
| `ok` | boolean | yes |  |
| `version` | string |  |  |
| `arag` | object |  |  |
| `uptimeSec` | number |  |  |

### Job

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `kind` | string | yes |  |
| `status` | string (`queued`, `running`, `succeeded`, `failed`, `cancelled`) | yes |  |
| `progress` | number | yes |  |
| `stage` | string |  |  |
| `message` | string |  |  |
| `input` | object |  |  |
| `result` | object |  |  |
| `error` | object |  |  |
| `events` | array of [JobEvent](#jobevent) |  |  |
| `createdAt` | string | yes |  |
| `updatedAt` | string | yes |  |
| `finishedAt` | string |  |  |
| `durationsMs` | object |  |  |

### JobEvent

| Field | Type | Required | Description |
|---|---|---|---|
| `ts` | string | yes |  |
| `stage` | string | yes |  |
| `status` | string (`start`, `progress`, `ok`, `error`, `skip`) | yes |  |
| `message` | string |  |  |
| `ms` | number |  |  |
| `data` | object |  |  |

### LogRecord

| Field | Type | Required | Description |
|---|---|---|---|
| `ts` | string | yes |  |
| `level` | string | yes |  |
| `msg` | string | yes |  |

### ExtractedField

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes | Stable machine key, e.g. invoice_number |
| `label` | string | yes | Human label |
| `value` | object | yes | Normalised value (string, number, boolean, null, or an array of those) |
| `raw` | string |  | Value exactly as the model returned it, before normalisation |
| `confidence` | number |  |  |
| `page` | integer |  |  |

### Entity

| Field | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes |  |
| `type` | string | yes | PERSON | ORG | DATE | MONEY | LOCATION | EMAIL | PHONE | ID | OTHER |
| `salience` | number |  |  |

### Evidence

A verbatim quote from the document supporting one extracted field, checked against the document's own extracted text rather than taken on trust.

| Field | Type | Required | Description |
|---|---|---|---|
| `field` | string | yes | The `ExtractedField.key` this quote supports |
| `quote` | string | yes | The quote exactly as the model returned it |
| `verified` | string (`exact`, `normalised`, `unverified`) | yes | `exact`: the quote appears character-for-character in the document. `normalised`: it appears once case, whitespace and punctuation are normalised. `unverified`: it does not appear — treat the field as ungrounded. |
| `paragraphId` | string |  | ARAG retrieval paragraph containing the quote (`<rid>/<type>/<field>/<start>-<end>`) |
| `start` | integer |  | Offset into the extracted text (exact matches only) |
| `end` | integer |  |  |

### ValidationIssue

| Field | Type | Required | Description |
|---|---|---|---|
| `field` | string | yes |  |
| `severity` | string (`info`, `warning`, `error`) | yes |  |
| `message` | string | yes |  |

### Document

Canonical, format-agnostic record for one document.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Document id (equal to the ARAG resource id) |
| `resourceId` | string | yes | ARAG resource id |
| `filename` | string | yes |  |
| `contentType` | string | yes |  |
| `bytes` | integer | yes |  |
| `status` | string (`pending`, `processing`, `ready`, `failed`) | yes |  |
| `jobId` | string |  |  |
| `docType` | string (`invoice`, `receipt`, `contract`, `resume`, `purchase_order`, `medical_claim`, `preauthorisation`, `bank_statement`, `form`, `report`, `generic`) | yes |  |
| `docTypeConfidence` | number |  |  |
| `fields` | array of [ExtractedField](#extractedfield) | yes |  |
| `entities` | array of [Entity](#entity) | yes |  |
| `summary` | string |  |  |
| `tags` | array of string | yes |  |
| `issues` | array of [ValidationIssue](#validationissue) | yes |  |
| `evidence` | array of [Evidence](#evidence) | yes |  |
| `corrections` | array of [FieldCorrection](#fieldcorrection) |  | Human corrections to extracted fields, oldest first. Never discarded — a correction is recorded alongside the model's original value, not in place of it. |
| `error` | string |  |  |
| `meta` | object | yes |  |
| `createdAt` | string | yes |  |
| `updatedAt` | string | yes |  |

### DocumentPage

| Field | Type | Required | Description |
|---|---|---|---|
| `items` | array of [Document](#document) | yes |  |
| `page` | integer | yes |  |
| `page_size` | integer | yes |  |
| `total` | integer | yes |  |
| `next_page` | boolean |  |  |
| `facets` | [Facets](#facets) |  |  |
| `filters` | [AppliedFilters](#appliedfilters) |  |  |

### DocumentAccepted

| Field | Type | Required | Description |
|---|---|---|---|
| `document` | [Document](#document) | yes |  |
| `job` | [Job](#job) | yes |  |

### BulkDeleteRequest

| Field | Type | Required | Description |
|---|---|---|---|
| `ids` | array of string | yes |  |

### BulkDeleteResult

Per-id outcome. A bulk delete is best-effort: ids that could not be deleted are reported rather than failing the whole request.

| Field | Type | Required | Description |
|---|---|---|---|
| `deleted` | array of string | yes |  |
| `failed` | array of object | yes |  |

### BulkExportRequest

| Field | Type | Required | Description |
|---|---|---|---|
| `ids` | array of string | yes |  |
| `format` | string (`json`, `xml`, `csv`) |  |  |

### Stats

Workspace counters for the documents overview — no credentials required.

| Field | Type | Required | Description |
|---|---|---|---|
| `documents` | object | yes | Counts by lifecycle status plus `total` and `degraded`. |
| `byDocType` | object | yes |  |
| `groundingScore` | number,null |  | Mean grounding score across stored records; null when none has one. |
| `fields` | integer |  | Total extracted fields across every record |
| `issues` | integer |  | Total open validation issues across every record |
| `lastProcessedAt` | string,null |  |  |
| `jobs` | object | yes |  |

### Settings

Effective, non-secret runtime settings for the signed-in workspace: what this deployment is connected to, how it extracts, and what it accepts. Everything here is already visible to a user of the product; secrets stay behind ADMIN_TOKEN.

| Field | Type | Required | Description |
|---|---|---|---|
| `product` | object | yes |  |
| `connection` | object | yes | Whether this deployment can reach its Knowledge Box, and roughly where it is. The Knowledge Box id and its base URL are NOT here: they identify the tenant and its region host, which is an operator's business for the same reason the extract-strategy id is (DP-40). Both are on `GET /api/v1/admin/settings` behind `ADMIN_TOKEN`. |
| `extraction` | object | yes |  |
| `uploads` | object | yes |  |
| `branding` | [Branding](#branding) | yes |  |
| `security` | object |  |  |

### Sample

A bundled sample document the first-run flow can process in one click.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `title` | string | yes |  |
| `description` | string |  |  |
| `filename` | string | yes |  |
| `contentType` | string | yes |  |
| `url` | string | yes | Static path to fetch the sample's bytes from |
| `kind` | string (`text`, `image`, `pdf`) |  |  |
| `expectedDocType` | string (`invoice`, `receipt`, `contract`, `resume`, `purchase_order`, `medical_claim`, `preauthorisation`, `bank_statement`, `form`, `report`, `generic`) |  |  |
| `featured` | boolean |  | Shown up front on the welcome screen rather than under “Other samples” |

### SampleRequest

| Field | Type | Required | Description |
|---|---|---|---|
| `sampleId` | string | yes |  |
| `config` | string |  | auto | agent | <extraction config id> |

### DocumentText

The document's own extracted text — the exact text every extraction stage read, and the text `Evidence.start`/`Evidence.end` are offsets into.

| Field | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes |  |
| `chars` | integer | yes | Length of the full extracted text, before truncation |
| `truncated` | boolean | yes |  |

### Facets

Counts across the whole collection (not the current page), for filter chips and the overview strip.

| Field | Type | Required | Description |
|---|---|---|---|
| `total` | integer | yes |  |
| `status` | object | yes |  |
| `docType` | object | yes |  |
| `degraded` | integer | yes |  |
| `needsReview` | integer | yes | Records carrying a warning/error issue, or a grounding score below 0.5 |

### SecurityPosture

What is protecting this deployment. Values only — never a key or a token.

| Field | Type | Required | Description |
|---|---|---|---|
| `apiKeys` | object | yes |  |
| `adminTokenSet` | boolean | yes |  |
| `sessionTtlSec` | integer |  |  |
| `cors` | array of string |  |  |
| `rateLimit` | object | yes |  |
| `maxUploadBytes` | integer | yes |  |
| `maxBodyBytes` | integer |  |  |
| `trustProxy` | string |  |  |
| `headers` | object |  |  |
| `writesRequireCredential` | boolean | yes |  |
| `retention` | object |  |  |

### AskRequest

| Field | Type | Required | Description |
|---|---|---|---|
| `question` | string | yes |  |

### AskResponse

| Field | Type | Required | Description |
|---|---|---|---|
| `answer` | string | yes |  |
| `sources` | array of string | yes | Titles of the resources retrieved |
| `citations` | array of object |  | The retrieval paragraphs behind the answer, so a caller can show where it came from rather than only which file it came from. Empty when retrieval returned nothing. |
| `ms` | integer | yes |  |

### ConfigField

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes |  |
| `label` | string | yes |  |
| `type` | string (`string`, `number`, `array`) | yes |  |
| `description` | string |  |  |
| `required` | boolean |  |  |
| `kvType` | string (`text`, `integer`, `float`, `boolean`, `date`) |  | Knowledge Box type for this field's key-value projection, overriding the type derived from `type`. Use it when the value is captured as text but should be filtered as a number or a date — an invoice total, an issue date. Validated on provisioning. |
| `kvRepeated` | boolean |  | Store a list of values. ARAG accepts `repeated` on `text` only. |
| `kvRange` | boolean |  | Store an interval (`{lower, upper}`) rather than a point. ARAG accepts `range` on integer, float and date only. |

### ExtractionConfig

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Use as the `config` parameter on upload |
| `name` | string | yes |  |
| `docType` | string | yes |  |
| `description` | string | yes |  |
| `builtin` | boolean | yes | Built-in configs cannot be deleted |
| `aragConfig` | string | yes | Stored ARAG search configuration (kind: ask) backing this config |
| `provisioned` | boolean |  | Whether the stored ARAG search configuration is in place (see `provisioning`) |
| `kvSchemaId` | string |  | Key-value schema this configuration's extracted records are written into, and the `schemaId` half of a `kv=` filter on `GET /api/v1/documents` |
| `kvFields` | object |  | Property name → key-value field key. They differ only where a property name contains `/` or `.`, which ARAG's `^[^/.]{1,64}$` forbids. |
| `provisioning` | [ConfigProvisioning](#configprovisioning) |  |  |
| `documentCount` | integer |  | Documents in this workspace extracted with this configuration |
| `fields` | array of [ConfigField](#configfield) | yes |  |
| `createdAt` | string |  |  |
| `updatedAt` | string |  |  |

### ExtractionConfigCreate

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes |  |
| `description` | string |  |  |
| `fields` | array of object | yes |  |

### Schema

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes |  |
| `docType` | string (`invoice`, `receipt`, `contract`, `resume`, `purchase_order`, `medical_claim`, `preauthorisation`, `bank_statement`, `form`, `report`, `generic`) | yes |  |
| `description` | string | yes |  |
| `required` | array of string | yes |  |
| `fields` | array of [ConfigField](#configfield) | yes |  |

### ProvisionResult

Provisioning one configuration. `ok` is the stored ARAG search configuration; `keyValueSchema` is the key-value schema provisioned alongside it — the two are provisioned together, and either can fail without the other.

| Field | Type | Required | Description |
|---|---|---|---|
| `schema` | string | yes |  |
| `aragConfig` | string | yes |  |
| `ok` | boolean | yes |  |
| `error` | string |  |  |
| `keyValueSchema` | [ProvisioningStatus](#provisioningstatus) |  |  |

### Branding

| Field | Type | Required | Description |
|---|---|---|---|
| `productName` | string | yes |  |
| `tagline` | string |  |  |
| `logoUrl` | string |  |  |
| `primaryColor` | string |  |  |
| `accentColor` | string |  |  |
| `poweredBy` | boolean | yes |  |
| `footerText` | string |  |  |
| `docsUrl` | string |  |  |
| `supportUrl` | string |  |  |

### SettingField

One editable setting: its effective value, which layer that value came from, and whether it is a secret. A UI renders `source: "env"` as “from the environment default”, `source: "store"` as “edited in the product” (with a reset), and a secret as “set · rotate”.

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes | Dotted key, e.g. `branding.tagline`. Also the patch path. |
| `group` | string (`branding`, `connection`, `limits`, `security`, `retention`, `operations`) | yes |  |
| `label` | string | yes |  |
| `description` | string |  |  |
| `type` | string (`string`, `number`, `boolean`, `color`, `uuid`, `enum`, `url`, `list`) | yes | How the field is edited and validated. `color` uses the platform's strict grammar. |
| `envVar` | string | yes | Environment variable that supplies this field's default |
| `secret` | boolean | yes | True when the value is write-only and never returned |
| `adminOnly` | boolean | yes | True when the value never appears on the viewer-facing `GET /api/v1/settings` (DP-40) |
| `source` | string (`store`, `env`, `default`) | yes | Which layer the effective value came from: an in-product edit, the environment, or the built-in default |
| `value` | object | yes | Effective value. Always `null` for a secret. |
| `set` | boolean |  | Secrets only: whether a value is in force |
| `hint` | string |  | Secrets only: the last four characters, to tell two apart |
| `envSet` | boolean | yes | Whether the environment sets this field, so a reset has a target |
| `constraints` | object |  | Bounds the API enforces: min, max, maxLength, values. |
| `note` | string |  | Operator-facing caveat shown next to the field |

### SettingsDocument

Every setting this deployment reads, grouped for the settings screen, plus `applied`: the values the running process is actually using, read back from the live objects rather than from the stored document. `applied` is how a UI proves an edit took effect without a restart.

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | integer | yes | Bumped on every applied change; usable as an ETag-ish guard |
| `updatedAt` | string,null |  |  |
| `groups` | array of object | yes |  |
| `applied` | object | yes | Live values in force right now: the ARAG client's KB id, base URL and timeout, the rate limiter's numbers, the upload and body ceilings, whether API keys are enforced, and the state of the retention scheduler. |

### SettingsPatch

Settings to change, either nested (`{ "branding": { "tagline": "…" } }`) or flat (`{ "branding.tagline": "…" }`). Only the keys present are touched. Every value is validated before anything is written: a bad colour, a non-UUID Knowledge Box id or an out-of-range number fails the whole patch with an RFC 9457 problem listing each field.

_object_

### SettingsChange

One applied change. `before`/`after` are null for a secret — that it changed is the record.

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes |  |
| `secret` | boolean | yes |  |
| `before` | object |  |  |
| `after` | object |  |  |

### SettingsPatchResult

The changes that were actually applied, plus the new settings document.

| Field | Type | Required | Description |
|---|---|---|---|
| `changed` | array of [SettingsChange](#settingschange) | yes |  |
| `settings` | [SettingsDocument](#settingsdocument) | yes |  |

### SettingsResetRequest

Drop in-product overrides so the named settings fall back to their environment default.

| Field | Type | Required | Description |
|---|---|---|---|
| `keys` | array of string | yes | Dotted setting keys, e.g. `["branding.primaryColor"]` |

### BrandingAsset

A brand asset written into `DATA_DIR/branding/` and served from `/branding/`.

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Path the asset is served from, e.g. `/branding/logo.svg` |
| `filename` | string | yes |  |
| `bytes` | integer | yes |  |
| `contentType` | string |  |  |
| `settings` | [SettingsDocument](#settingsdocument) |  |  |

### ApiKey

A stored API key. The key itself is never returned — only a salted digest is kept, and the prefix is what an operator matches against the value they saved at creation.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `name` | string | yes |  |
| `prefix` | string | yes | Non-secret leading part of the key, e.g. `dip_3f9c1a2b` |
| `createdAt` | string | yes |  |
| `createdBy` | string |  | Who created it: the admin token, a key's name, or a session |
| `lastUsedAt` | string,null |  |  |
| `revokedAt` | string,null |  |  |
| `revoked` | boolean | yes |  |

### ApiKeyCreateRequest

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | What this key is for, e.g. `ingest-worker` |

### ApiKeyCreated

The only response that ever contains the key. It is shown once and cannot be recovered: the store keeps a salted SHA-256 digest, not the value.

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes | The plaintext key. Copy it now — it is never returned again. |
| `apiKey` | [ApiKey](#apikey) | yes |  |

### AuditEntry

One audited change: who, what, when, and what it changed from and to. Secret values are replaced with `***` before the entry is written, so the log is safe to read.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `seq` | integer | yes | Monotonic ordering key; the page cursor encodes it |
| `ts` | string | yes |  |
| `actor` | object | yes |  |
| `action` | string | yes | Dotted verb: `settings.update`, `settings.reset`, `apikey.create`, `apikey.revoke`, `config.create`, `config.update`, `config.delete`, `config.provision`, `document.field.correct`, `document.delete`, `documents.purge`, `branding.logo` |
| `target` | string | yes | Setting key, key id, config id, document id, or `*` for a sweep |
| `before` | object |  |  |
| `after` | object |  |  |
| `requestId` | string,null |  | Correlates with the request log |
| `detail` | string |  |  |

### AuditPage

A page of audited changes, newest first. Paging is by sequence number, not offset, so an entry written while an operator is reading cannot duplicate or hide a row.

| Field | Type | Required | Description |
|---|---|---|---|
| `items` | array of [AuditEntry](#auditentry) | yes |  |
| `actions` | array of string |  | Distinct actions seen, for the filter |
| `nextCursor` | string,null | yes | Opaque cursor for the next page in the reading direction; null at the end. |
| `prevCursor` | string,null | yes | Opaque cursor for the page you came from; null at the start. |
| `hasMore` | boolean | yes |  |
| `hasPrev` | boolean |  |  |
| `total` | integer | yes | Rows matching the filter across every page |

### LogPage

A page of runtime log records, oldest first (the ring buffer has always read like a terminal), with the same stable cursor contract as the audit log.

| Field | Type | Required | Description |
|---|---|---|---|
| `items` | array of [LogRecord](#logrecord) | yes |  |
| `nextCursor` | string,null | yes | Opaque cursor for the next page in the reading direction; null at the end. |
| `prevCursor` | string,null | yes | Opaque cursor for the page you came from; null at the start. |
| `hasMore` | boolean | yes |  |
| `hasPrev` | boolean |  |  |
| `total` | integer | yes | Rows matching the filter across every page |

### KvRejection

One value the Knowledge Box refused, normalised out of ARAG's two different 422 dialects. This is the product's own “the KB rejected this value” signal: it names the field, what the schema expected and what was supplied, so a reviewer can see why a field is missing from the Knowledge Box.

| Field | Type | Required | Description |
|---|---|---|---|
| `field` | string |  | Product property name, when the error identifies one |
| `kind` | string (`type_mismatch`, `missing_required`, `unknown_key`, `range_bounds`, `too_many_fields`, `too_many_schemas`, `invalid_name`, `invalid_modifier`, `duplicate_key`, `unknown`) | yes |  |
| `message` | string | yes |  |
| `expected` | string |  | Declared key-value type for the field |
| `got` | string |  | What was actually supplied |

### KvWriteRecord

What reached the resource's key-value field for this document, and what did not.

**The overwrite trap.** A key-value write replaces the whole schema's data, and overwriting a value does *not* remove the old one from the Knowledge Box's filter index — the index accumulates every value ever written to that field on that resource and there is no purge call. Values are therefore written once per resource; when a second write is unavoidable (a human correction, a reprocess) `writes` counts it, `filterIndexStale` goes true and `superseded` lists the values this resource still matches a filter on despite having replaced them. It is reported rather than hidden.

| Field | Type | Required | Description |
|---|---|---|---|
| `schemaId` | string | yes | Key-value schema the values were written under |
| `written` | boolean | yes | True when the Knowledge Box accepted the write |
| `at` | string | yes |  |
| `fields` | integer | yes | Keys actually written |
| `keys` | object |  | Product property name → key-value field key, so the JSON tab can render both |
| `values` | object |  | Key-value field key → the value exactly as it reached the Knowledge Box |
| `skipped` | array of object |  | Extracted values that could not be represented in the schema, each with the reason |
| `rejected` | array of [KvRejection](#kvrejection) |  |  |
| `error` | string |  | Why the write did not happen, or did not land |
| `writes` | integer |  | How many times this resource's key-value field has been written |
| `filterIndexStale` | boolean |  | True once this resource has been written more than once: the Knowledge Box filter index also matches every superseded value, so a filter on an old value still returns this document. |
| `superseded` | array of object |  | Values this resource still matches a filter on although they have been replaced |

### ProvisioningStatus

| Field | Type | Required | Description |
|---|---|---|---|
| `state` | string (`provisioned`, `failed`, `not provisioned`) | yes |  |
| `error` | string |  | Why it failed, in a sentence an operator can act on |
| `at` | string |  |  |

### ConfigProvisioning

What this configuration has in the Knowledge Box. A config needs two objects there: a stored search configuration (how a document is read) and a key-value schema (how the result is kept and filtered). `state` is `provisioned` only when both are in place.

| Field | Type | Required | Description |
|---|---|---|---|
| `state` | string (`provisioned`, `failed`, `not provisioned`) | yes |  |
| `searchConfiguration` | object | yes |  |
| `keyValueSchema` | object | yes |  |

### AppliedFilters

Which half of the query was answered by which system. `kv` filters are resolved **in the Knowledge Box** (a `/find` with the key-value filter expression, whose matching resource ids are then intersected with this workspace's own list); everything else is a predicate over the local store. A list screen should label them differently because they are not interchangeable.

| Field | Type | Required | Description |
|---|---|---|---|
| `knowledgeBox` | object | yes |  |
| `local` | array of string | yes | Parameters applied against this workspace's own store |

### KvFilterSpec

One parsed `kv=<schemaId>:<field>:<op>:<value>` filter.

| Field | Type | Required | Description |
|---|---|---|---|
| `schemaId` | string | yes |  |
| `key` | string | yes |  |
| `op` | string (`eq`, `gte`, `lte`, `contains`) | yes |  |
| `value` | string | yes |  |

### FieldCorrection

One human correction to one extracted field, kept on the record forever. The model's original value and the reviewer are both preserved: a correction is recorded, never a silent overwrite. `verified` is the corrected value re-checked against the document's own text with the same contract the pipeline uses — a human typing a value does not make it grounded, but if the value they typed *is* in the document, that is worth showing.

| Field | Type | Required | Description |
|---|---|---|---|
| `field` | string | yes |  |
| `label` | string | yes |  |
| `previousValue` | object | yes |  |
| `value` | object | yes |  |
| `reason` | string |  |  |
| `actor` | string | yes | `admin`, `api-key` or `session`. Never a credential. |
| `at` | string | yes |  |
| `verified` | string (`exact`, `normalised`, `unverified`) | yes |  |
| `kv` | object |  | Whether the corrected value reached the Knowledge Box key-value field. |

### FieldCorrectionRequest

The value a reviewer is setting the field to, and why.

| Field | Type | Required | Description |
|---|---|---|---|
| `value` | object | yes | The corrected value. `null` clears the field. |
| `reason` | string |  | Why the value was wrong, in the reviewer's words |

### FieldCorrectionResult

| Field | Type | Required | Description |
|---|---|---|---|
| `document` | [Document](#document) | yes |  |
| `correction` | [FieldCorrection](#fieldcorrection) | yes |  |

### CorpusAskRequest

A question asked across a filtered set of documents rather than one. The filter is the Documents list's own filter, so “ask the twelve invoices from last week” is the list already on screen.

| Field | Type | Required | Description |
|---|---|---|---|
| `question` | string | yes |  |
| `maxResources` | integer |  | Ceiling on documents retrieved over, so one ask cannot fan out over the whole corpus |
| `filters` | object |  | The same filters `GET /api/v1/documents` accepts, by their query-parameter names. |

### CorpusAnswer

One grounded answer over many documents. Citations carry this product's own document ids, so “show me where” still works across the corpus.

| Field | Type | Required | Description |
|---|---|---|---|
| `answer` | string | yes |  |
| `scope` | object | yes |  |
| `citations` | array of object | yes |  |
| `documents` | array of object | yes | Distinct documents the citations came from, in citation order |
| `ms` | integer | yes |  |

### GeneratorAgent

A Data Augmentation generator agent this workspace started: an ARAG-side task (kind `ask`, `store_as_key_value: true`) that extracts into the configuration's key-value schema on the platform's own schedule. One per configuration — ARAG allows only one running `ask` task per destination, and the destination is the key-value schema.

| Field | Type | Required | Description |
|---|---|---|---|
| `configId` | string | yes |  |
| `kvSchemaId` | string | yes | The agent's own key-value schema (`<config schema>_gen`), never the pipeline's |
| `taskId` | string | yes | ARAG task id |
| `name` | string | yes | Task name as it appears in the ARAG dashboard |
| `resourceId` | string |  | Set when the run was scoped to one document |
| `startedAt` | string | yes |  |
| `state` | string (`running`, `done`, `failed`, `stopped`, `absent`) | yes |  |

### GeneratorComparison

This product's extraction beside the generator agent's, field by field.

**The two columns are not equivalent and the payload says so.** The evidence contract applies to the product's path only: its values carry a verbatim quote checked against the document's own text. A generator agent returns values and no quote, so every `generator.evidence` is `null` and `evidenceContract.generator` spells out that these values are not grounded to the same standard.

| Field | Type | Required | Description |
|---|---|---|---|
| `documentId` | string | yes |  |
| `resourceId` | string | yes |  |
| `configId` | string | yes |  |
| `kvSchemaId` | string | yes | Key-value schema the product's own pipeline writes into |
| `generatorKvSchemaId` | string | yes | Key-value schema the generator agent writes into — deliberately a different one (`<schema>_gen`). A key-value write is a full replace, so one shared schema would mean whichever path ran last silently erased the other's values and polluted the resource's filter index; two schemas keep both columns independently readable. |
| `agent` | object |  | The agent started for this configuration, or null when none is running. |
| `generatorHasWritten` | boolean |  | True once the agent has written values onto this resource |
| `fields` | array of object | yes |  |
| `summary` | object | yes |  |
| `evidenceContract` | object | yes |  |
| `observed` | object | yes | What this product has actually seen of the generator path against a live Knowledge Box, and what it has not. |

