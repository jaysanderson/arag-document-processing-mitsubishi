/** HTTP surface for documents. Thin: all logic lives in `services/documents.ts`. */
import {
  type App,
  badRequest,
  HttpError,
  notFound,
  operationSchemas,
  parseMultipart,
  type UploadedFile,
} from "../../vendor/arag-platform/src/index.ts";
import { openapi } from "../openapi.ts";
import type { DocumentsService, SortKey } from "../services/documents.ts";
import { FORMATS as FORMAT_LIST, type Format } from "../services/formats.ts";
import { KvValidationError } from "../services/kv.ts";
import { requireWriter } from "./guards.ts";

const FORMATS = new Set<string>(FORMAT_LIST);

export function registerDocumentRoutes(
  app: App,
  deps: { documents: DocumentsService; jobCounts: () => Record<string, number> },
): void {
  app.get(
    "/api/v1/documents",
    async (ctx) => {
      try {
        return await deps.documents.listWithKv({
          page: Number(ctx.queryObj.page ?? 1),
          pageSize: Number(ctx.queryObj.page_size ?? 50),
          status: ctx.queryObj.status as string | undefined,
          q: ctx.queryObj.q as string | undefined,
          sort: ctx.queryObj.sort as SortKey | undefined,
          order: ctx.queryObj.order as "asc" | "desc" | undefined,
          dateFrom: ctx.queryObj.date_from as string | undefined,
          dateTo: ctx.queryObj.date_to as string | undefined,
          config: ctx.queryObj.config as string | undefined,
          degraded: ctx.queryObj.degraded as boolean | undefined,
          hasIssues: ctx.queryObj.has_issues as boolean | undefined,
          minGrounding:
            ctx.queryObj.min_grounding === undefined ? undefined : Number(ctx.queryObj.min_grounding),
          // Declared in the spec as repeatable parameters, so the platform hands back an
          // array whether one value or several were asked for.
          docTypes: ctx.queryObj.doc_type as string[] | undefined,
          kv: ctx.queryObj.kv as string[] | undefined,
        });
      } catch (err) {
        // A key-value filter the Knowledge Box would refuse with an opaque 412 is refused
        // here instead, with the operators that field does accept.
        if (err instanceof KvValidationError) throw badRequest(err.message);
        throw err;
      }
    },
    {
      auth: "api",
      validate: operationSchemas(openapi, "/api/v1/documents", "get"),
      operationId: "listDocuments",
    },
  );

  // Counters for the list screen's overview strip. Registered before `/documents/:id` so
  // "stats" can never be read as a document id.
  app.get("/api/v1/stats", (_ctx) => ({ ...deps.documents.overview(), jobs: deps.jobCounts() }), {
    auth: "api",
    operationId: "getStats",
  });

  // Bulk actions. Both are POSTs on fixed paths, so they cannot collide with
  // `/documents/:id` (which has no POST) regardless of registration order.
  app.post(
    "/api/v1/documents/bulk-delete",
    async (ctx) => {
      requireWriter(ctx);
      const { ids } = ctx.body as { ids: string[] };
      return await deps.documents.bulkDelete(ids);
    },
    {
      auth: "api",
      validate: operationSchemas(openapi, "/api/v1/documents/bulk-delete", "post"),
      operationId: "bulkDeleteDocuments",
    },
  );

  app.post(
    "/api/v1/documents/bulk-export",
    (ctx) => {
      const { ids, format = "json" } = ctx.body as { ids: string[]; format?: string };
      if (!FORMATS.has(format)) throw badRequest(`format must be one of ${[...FORMATS].join(", ")}`);
      const out = deps.documents.bulkExport(ids, format as Format);
      ctx.text(200, out.body, out.contentType, {
        "Content-Disposition": `attachment; filename="${out.filename}"`,
        // Reported rather than failed: a stale selection should still export what exists.
        "X-Skipped-Ids": out.skipped.join(","),
      });
    },
    {
      auth: "api",
      validate: operationSchemas(openapi, "/api/v1/documents/bulk-export", "post"),
      operationId: "bulkExportDocuments",
    },
  );

  app.post(
    "/api/v1/documents/sample",
    async (ctx) => {
      const { sampleId, config } = ctx.body as { sampleId: string; config?: string };
      const out = await deps.documents.createFromSample(sampleId, config);
      ctx.json(202, out, { Location: `/api/v1/documents/${out.document.id}` });
    },
    {
      auth: "api",
      validate: operationSchemas(openapi, "/api/v1/documents/sample", "post"),
      operationId: "createSampleDocument",
    },
  );

  app.post(
    "/api/v1/documents",
    async (ctx) => {
      // Two accepted shapes: multipart/form-data with a `file` part, or a raw body with an
      // X-Filename header (what `curl --data-binary` and the demo's dropzone send).
      //
      // The multipart body is parsed here rather than by the platform's `body: "auto"`
      // path: that path lowercases the Content-Type before handing it to `parseMultipart`,
      // which destroys mixed-case boundaries (`----WebKitFormBoundaryAbC…`) and silently
      // yields zero parts for every browser upload. Platform bug — reported upstream.
      const contentType = ctx.header("content-type") ?? "";
      let fields: Record<string, string> = {};
      let file: UploadedFile | undefined;
      if (contentType.toLowerCase().startsWith("multipart/form-data")) {
        try {
          const parsed = parseMultipart(ctx.rawBody ?? Buffer.alloc(0), contentType);
          fields = parsed.fields;
          file = parsed.files.find((f) => f.field === "file") ?? parsed.files[0];
        } catch (err) {
          // The platform's parser calls decodeURIComponent on the part filename without a
          // guard, so `filename="100%"` throws a raw URIError that would surface as a 500.
          if (err instanceof HttpError) throw err;
          throw badRequest(`Could not parse the multipart body: ${(err as Error).message}`);
        }
      }
      const bytes = file ? file.data : ctx.rawBody;
      if (!bytes || bytes.length === 0) {
        throw badRequest(
          "Send a multipart/form-data body with a `file` part, or a raw body with an X-Filename header.",
        );
      }
      const config = String(ctx.query.get("config") ?? fields.config ?? "auto");
      const out = await deps.documents.create({
        bytes,
        filename: file?.filename ?? ctx.header("x-filename"),
        contentType: file?.contentType ?? contentType,
        config,
      });
      ctx.json(202, out, { Location: `/api/v1/documents/${out.document.id}` });
    },
    {
      auth: "api",
      body: "raw",
      validate: operationSchemas(openapi, "/api/v1/documents", "post"),
      operationId: "createDocument",
    },
  );

  app.get("/api/v1/documents/:id", (ctx) => deps.documents.require(ctx.params.id!), {
    auth: "api",
    operationId: "getDocument",
  });

  app.get(
    "/api/v1/documents/:id/export",
    (ctx) => {
      const format = String(ctx.queryObj.format ?? "json");
      if (!FORMATS.has(format)) throw badRequest(`format must be one of ${[...FORMATS].join(", ")}`);
      const out = deps.documents.export(ctx.params.id!, format as Format);
      ctx.text(200, out.body, out.contentType, {
        "Content-Disposition": `attachment; filename="${out.filename}"`,
      });
    },
    {
      auth: "api",
      validate: operationSchemas(openapi, "/api/v1/documents/{id}/export", "get"),
      operationId: "exportDocument",
    },
  );

  app.get(
    "/api/v1/documents/:id/text",
    async (ctx) => await deps.documents.text(ctx.params.id!, Number(ctx.queryObj.max_chars ?? 200_000)),
    {
      auth: "api",
      validate: operationSchemas(openapi, "/api/v1/documents/{id}/text", "get"),
      operationId: "getDocumentText",
    },
  );

  app.get(
    "/api/v1/documents/:id/source",
    async (ctx) => {
      const out = await deps.documents.source(ctx.params.id!);
      // `inline`, not `attachment`: this is for looking at the page, not saving it. The
      // filename is already sanitised on the record.
      ctx.res.writeHead(200, {
        "Content-Type": out.contentType,
        "Content-Length": out.bytes.length,
        "Content-Disposition": `inline; filename="${out.filename}"`,
        "Cache-Control": "private, max-age=300",
      });
      ctx.res.end(out.bytes);
    },
    { auth: "api", operationId: "getDocumentSource" },
  );

  app.post(
    "/api/v1/documents/:id/ask",
    (ctx) => {
      const { question } = ctx.body as { question: string };
      return deps.documents.ask(ctx.params.id!, question.trim());
    },
    {
      auth: "api",
      // Its own bucket, for the same reason the SSE route has one: every ask is a real
      // generative call against the Knowledge Box. Anonymous callers can still try the
      // product — that is the point of the guided sample — but not at the full public rate.
      rateLimit: { rps: 1, burst: 10 },
      validate: operationSchemas(openapi, "/api/v1/documents/{id}/ask", "post"),
      operationId: "askDocument",
    },
  );

  app.post(
    "/api/v1/documents/:id/reprocess",
    (ctx) => {
      // Re-running spends model calls against the Knowledge Box, so it needs the same
      // credential as a delete even when the public API is otherwise open.
      requireWriter(ctx);
      const out = deps.documents.reprocess(
        ctx.params.id!,
        (ctx.query.get("config") ?? undefined) || undefined,
      );
      ctx.json(202, out, { Location: `/api/v1/documents/${out.document.id}` });
    },
    { auth: "api", operationId: "reprocessDocument" },
  );

  app.delete(
    "/api/v1/documents/:id",
    async (ctx) => {
      requireWriter(ctx);
      if (!(await deps.documents.delete(ctx.params.id!))) throw notFound("Document");
      ctx.noContent();
    },
    { auth: "api", operationId: "deleteDocument" },
  );
}
