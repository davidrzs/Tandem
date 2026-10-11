import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  imageMarkdown,
  isAllowedImageMime,
  mintImageUploadToken,
  saveImageBytes,
} from "../../images.js";
import { json, toolError, MCP_IMAGE_MAX_BYTES, type ToolContext } from "../shared.js";

/** Image uploads (inline base64 and token-based). */
export function registerImageTools(server: McpServer, ctx: ToolContext): void {
  const { services, publicUrl, uploads, logAudit, resolveWorkspace } = ctx;

  server.registerTool(
    "upload_image",
    {
      title: "Upload image",
      description:
        "Upload a SMALL image (base64) and get back a markdown snippet " +
        "`![alt](/api/images/<id>)` to embed with create_document or the edit " +
        "tools. Images are private to workspace members. Raster formats only " +
        "(no SVG); max 3MB decoded. workspaceId is required when you belong " +
        "to more than one workspace. For anything beyond a small icon — or a " +
        "file already on disk — use request_image_upload instead of inlining " +
        "base64.",
      inputSchema: {
        data: z.string().min(1),
        mime: z.string().min(1),
        alt: z.string().max(500).optional(),
        workspaceId: z.string().uuid().optional(),
      },
    },
    async ({ data, mime, alt, workspaceId }) => {
      const actor = services.actor;
      if (actor.kind !== "user") return toolError("image upload requires a user identity");
      if (!isAllowedImageMime(mime)) {
        return toolError("not a supported image type (raster image/* only, no SVG)");
      }
      // Node's base64 decoder silently skips invalid characters, so vet the
      // input strictly first — otherwise garbage would decode to garbage bytes.
      const b64 = data.replace(/^data:[^;,]+;base64,/, "").replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
        return toolError("data is not valid base64");
      }
      const bytes = Buffer.from(b64, "base64");
      if (bytes.length === 0) return toolError("image data is empty");
      if (bytes.length > MCP_IMAGE_MAX_BYTES) {
        return toolError("image exceeds 3MB — use request_image_upload for large files");
      }
      const ws = await resolveWorkspace(workspaceId);
      if ("error" in ws) return ws.error;
      const id = await saveImageBytes(services, {
        workspaceId: ws.id,
        uploadedBy: actor.userId,
        mime,
        bytes,
      });
      logAudit("upload_image", { workspaceId: ws.id, title: null }, `${mime}, ${bytes.length} bytes`);
      const url = `/api/images/${id}`;
      return json({
        id,
        url,
        markdown: imageMarkdown(alt, url),
        mime,
        size: bytes.length,
      });
    },
  );

  // Only advertised when the host wired up token minting (the HTTP server
  // does); otherwise the tool would be listed but always fail.
  if (uploads) {
    server.registerTool(
      "request_image_upload",
      {
        title: "Request an image upload URL",
        description:
          "Get a short-lived URL for uploading an image WITHOUT inlining " +
          "base64 — prefer this over upload_image whenever the file lives on " +
          "disk or is bigger than a small icon. Give the alt text HERE, not in " +
          "the upload; then POST the bytes within 15 minutes as multipart " +
          "field `file`, passing the returned token as a bearer header: " +
          '`curl -sf -H "Authorization: Bearer <token>" -F "file=@shot.png" ' +
          '"<uploadUrl>"` (the `example` field comes ready to run). The ' +
          "upload's JSON response matches upload_image ({ id, url, markdown }); " +
          "embed the markdown with the edit tools. Request one URL per image. " +
          "Raster formats only (no SVG); max 25MB. workspaceId is required " +
          "when you belong to more than one workspace.",
        inputSchema: {
          alt: z.string().max(500).optional(),
          workspaceId: z.string().uuid().optional(),
        },
      },
      async ({ alt, workspaceId }) => {
        const actor = services.actor;
        if (actor.kind !== "user") return toolError("image upload requires a user identity");
        const ws = await resolveWorkspace(workspaceId);
        if ("error" in ws) return ws.error;
        const { token, expiresAt } = mintImageUploadToken(uploads.secret, {
          userId: actor.userId,
          workspaceId: ws.id,
          alt,
        });
        const uploadUrl = new URL("/api/images/upload", publicUrl).toString();
        return json({
          uploadUrl,
          token,
          expiresAt,
          example: `curl -sf -H "Authorization: Bearer ${token}" -F "file=@<path>" "${uploadUrl}"`,
        });
      },
    );
  }
}
