import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";

export const UPLOAD_DIR = join(process.cwd(), "uploads");
const CHUNK_DIR = join(UPLOAD_DIR, "chunks");

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
};

const routes = new Hono();

routes.post("/upload", async (c) => {
  const contentType = c.req.header("content-type") || "";

  try {
    // ---------- 1. multipart/form-data（FormData）----------
    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      const saved: Array<{
        field: string;
        filename: string;
        size: number;
        url: string;
      }> = [];

      // 确保目录存在（懒创建，避免顶层 await 影响打包）
      await mkdir(UPLOAD_DIR, { recursive: true });

      for (const [field, value] of formData.entries()) {
        if (value instanceof File) {
          const ext = extname(value.name) || "";
          const filename = `${randomUUID()}${ext}`;
          const filepath = join(UPLOAD_DIR, filename);
          const buffer = Buffer.from(await value.arrayBuffer());
          await writeFile(filepath, buffer);

          saved.push({
            field,
            filename: value.name,
            size: value.size,
            url: `/files/${filename}`,
          });
        }
        // 普通字段按需处理，这里忽略
      }

      return c.json({ success: true, files: saved });
    }

    // ---------- 2. application/json（普通对象）----------
    if (contentType.includes("application/json")) {
      const body = await c.req.json();
      // TODO: 按业务逻辑处理
      return c.json({ success: true, received: body });
    }

    // ---------- 3. 二进制：Blob / File / ArrayBuffer / 其他 ----------
    const arrayBuffer = await c.req.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 根据 Content-Type 推断扩展名
    let ext = "";
    if (contentType.includes("image/png")) ext = ".png";
    else if (contentType.includes("image/jpeg")) ext = ".jpg";
    else if (contentType.includes("image/gif")) ext = ".gif";
    else if (contentType.includes("image/webp")) ext = ".webp";
    else if (contentType.includes("application/pdf")) ext = ".pdf";
    else {
      const guess = contentType.split("/")[1]?.split(";")[0];
      if (guess && guess !== "octet-stream") ext = `.${guess}`;
    }

    await mkdir(UPLOAD_DIR, { recursive: true });
    const filename = `${randomUUID()}${ext}`;
    const filepath = join(UPLOAD_DIR, filename);
    await writeFile(filepath, buffer);

    return c.json({
      success: true,
      size: buffer.length,
      url: `/files/${filename}`,
    });
  } catch (e) {}
});

// ============ 1. 上传单个分片 ============
routes.post("/upload-big", async (c) => {
  try {
    const fd = await c.req.formData();

    const raw = fd.get("file");
    const hash = fd.get("hash");
    const index = Number(fd.get("index"));
    const fileHash = fd.get("fileHash");

    // 关键：先排除 string / null
    if (!raw || typeof raw === "string") {
      return c.json({ success: false, message: "missing chunk file" }, 400);
    }

    // 到这里 raw 一定是 File（FormData 里的文件值）
    if (!fileHash || typeof fileHash !== "string" || Number.isNaN(index)) {
      return c.json({ success: false, message: "missing fileHash or index" }, 400);
    }

    const dir = join(CHUNK_DIR, fileHash);
    await mkdir(dir, { recursive: true });

    const buffer = Buffer.from(await raw.arrayBuffer());
    await writeFile(join(dir, String(index)), buffer);

    return c.json({ success: true, index, hash });
  } catch (err) {
    console.error("[upload-big]", err);
    return c.json({ success: false, message: (err as Error).message }, 500);
  }
});

// ============ 2. 查询已上传分片（断点续传/秒传）============
routes.get("/upload-big/check", async (c) => {
  const fileHash = c.req.query("fileHash");
  if (!fileHash) {
    return c.json({ success: false, message: "missing fileHash" }, 400);
  }

  // 秒传：最终文件已存在
  const finalFiles = await readdir(UPLOAD_DIR).catch(() => [] as string[]);
  const exist = finalFiles.find(
    (f) => f.startsWith(fileHash + ".") || f === fileHash,
  );
  if (exist) {
    return c.json({ success: true, uploaded: true, url: `/files/${exist}` });
  }

  // 已上传的分片索引
  let uploaded: number[] = [];
  try {
    const files = await readdir(join(CHUNK_DIR, fileHash));
    uploaded = files
      .map((f) => Number(f))
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b);
  } catch {
    // 目录不存在，一个都没传
  }

  return c.json({ success: true, uploaded: false, chunks: uploaded });
});

// ============ 3. 合并分片 ============
routes.post("/upload-big/merge", async (c) => {
  try {
    const fd = await c.req.formData();
    const fileHash = String(fd.get("fileHash") || "");
    const fileName = String(fd.get("fileName") || "");
    const total = Number(fd.get("total"));

    if (!fileHash || !total) {
      return c.json(
        { success: false, message: "missing fileHash or total" },
        400,
      );
    }

    const dir = join(CHUNK_DIR, fileHash);
    const ext = extname(fileName);
    const finalName = `${fileHash}${ext}`;
    const finalPath = join(UPLOAD_DIR, finalName);

    await mkdir(UPLOAD_DIR, { recursive: true });

    // 按 index 顺序流式合并
    const writeStream = createWriteStream(finalPath);
    for (let i = 0; i < total; i++) {
      const chunkPath = join(dir, String(i));
      try {
        await stat(chunkPath);
      } catch {
        writeStream.destroy();
        return c.json({ success: false, message: `chunk ${i} missing` }, 400);
      }
      await pipeline(
        createReadStream(chunkPath),
        writeStream,
        { end: false }, // 不关闭 writeStream，继续写下一个分片
      );
    }
    writeStream.end();
    await new Promise<void>((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    const size = (await stat(finalPath)).size;

    // 合并成功后清理分片目录
    await rm(dir, { recursive: true, force: true });

    return c.json({
      success: true,
      url: `/files/${finalName}`,
      size,
    });
  } catch (err) {
    console.error("[upload-big/merge]", err);
    return c.json({ success: false, message: (err as Error).message }, 500);
  }
});

routes.get("/test", (c) => {
  return c.json({
    message: "你好",
  });
});

routes.get("/files/:name", async (c) => {
  const name = c.req.param("name");

  // 防路径穿越
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return c.text("Bad request", 400);
  }

  const filepath = join(UPLOAD_DIR, name);

  try {
    const info = await stat(filepath);
    if (!info.isFile()) return c.text("Not found", 404);

    const buf = await readFile(filepath);
    const type =
      MIME[extname(name).toLowerCase()] || "application/octet-stream";

    return c.body(buf, 200, {
      "Content-Type": type,
      "Content-Length": String(info.size),
      "Cache-Control": "public, max-age=31536000, immutable", // 文件名是 UUID，可长缓存
    });
  } catch {
    return c.text("Not found", 404);
  }
});

export { routes };
