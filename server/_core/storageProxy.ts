import type { Express, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { ENV } from "./env";

// Local copies of storage files, checked before Manus storage. Put files in
// client/public/manus-storage/ (the build copies them to dist/public/manus-storage/).
const LOCAL_STORAGE_DIRS = [
  path.resolve(import.meta.dirname, "../..", "client", "public", "manus-storage"),
  path.resolve(import.meta.dirname, "public", "manus-storage"),
];

function sendLocalCopy(key: string, res: Response) {
  const dir = LOCAL_STORAGE_DIRS.find((candidate) => {
    const file = path.resolve(candidate, key);
    return file.startsWith(candidate + path.sep) && fs.existsSync(file);
  });
  if (!dir) return false;
  res.sendFile(key, { root: dir });
  return true;
}

export function registerStorageProxy(app: Express) {
  app.get("/manus-storage/*", async (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }

    if (sendLocalCopy(key, res)) return;

    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(404).send("Not available locally. Add the file to client/public/manus-storage/ or set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY.");
      return;
    }

    try {
      const forgeUrl = new URL(
        "v1/storage/presign/get",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/",
      );
      forgeUrl.searchParams.set("path", key);

      const forgeResp = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` },
      });

      if (!forgeResp.ok) {
        const body = await forgeResp.text().catch(() => "");
        console.error(`[StorageProxy] forge error: ${forgeResp.status} ${body}`);
        res.status(502).send("Storage backend error");
        return;
      }

      const { url } = (await forgeResp.json()) as { url: string };
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }

      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}
