import { cutFile, uploadFile } from "@onoxm/utils";
import { useRef, useState } from "react";
import SparkMD5 from "spark-md5";
import { myHash } from "./utils";

const serverUrl = "http://localhost:9527/";

function App() {
  const [progress, setProgress] = useState("");
  const [videoSrc, setVideoSrc] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);

  const createUrl = (path: string, baseUrl: string) => {
    return new URL(path, baseUrl).href;
  };

  const upload = (file: File) => {
    const form = new FormData();
    form.set("file", file);
    uploadFile(createUrl("/upload", serverUrl), form, {
      onProgress(p) {
        setProgress(p.toFixed(2) + "%");
      },
      onFinish(res) {
        if (res.success) {
          setVideoSrc(createUrl(res.files[0].url, serverUrl));
        }
      },
    });
  };

  const uploadBig = async (file: File) => {
    const chunks = await cutFile({
      file,
      chunkSize: 10 * 1024 * 1024,
      createWorker: () =>
        new Worker(new URL("./utils/cutFile.worker.ts", import.meta.url), {
          type: "module",
        }),
      createHash: myHash,
      onProgress: (done, total) =>
        setProgress(`分片中：${((done / total) * 100).toFixed(2)}%`),
    });

    const fileHash = SparkMD5.hash(chunks.map((c) => c.hash).join(""));

    // 3. 询问后端：已上传哪些分片 / 是否秒传
    const checkRes = await fetch(
      createUrl(`/upload-big/check?fileHash=${fileHash}`, serverUrl),
    ).then((r) => r.json());

    if (checkRes.uploaded) {
      // 秒传
      return checkRes.url as string;
    }
    const uploadedSet = new Set<number>(checkRes.chunks || []);

    // 4. 上传缺失的分片
    for (const chunk of chunks) {
      if (uploadedSet.has(chunk.index)) continue;

      const fd = new FormData();
      fd.append("file", chunk.blob);
      fd.append("hash", chunk.hash);
      fd.append("index", String(chunk.index));
      fd.append("fileHash", fileHash);

      await new Promise<void>((resolve, reject) => {
        uploadFile(createUrl("/upload-big", serverUrl), fd, {
          onFinish: () => resolve(),
          onError: (e) => reject(e),
          onProgress: (p) => {
            // 可以聚合出总体进度
            setProgress(`分片 ${chunk.index}: ${p}%`);
          },
        });
      });
    }

    // 5. 请求合并
    const mergeFd = new FormData();
    mergeFd.append("fileHash", fileHash);
    mergeFd.append("fileName", file.name);
    mergeFd.append("total", String(chunks.length));

    const mergeRes = await fetch(createUrl("/upload-big/merge", serverUrl), {
      method: "POST",
      body: mergeFd,
    }).then((r) => r.json());

    if (!mergeRes.success) throw new Error(mergeRes.message);

    return mergeRes.url;
  };

  const handleUpload = async (file: File) => {
    if (file.size > 1024 * 1024 * 1024)
      setVideoSrc(createUrl(await uploadBig(file), serverUrl));
    else upload(file);
  };

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {videoSrc ? (
        <video
          src={videoSrc}
          style={{ width: 1280, height: 720 }}
          autoPlay
          controls
        />
      ) : (
        <p>{progress}</p>
      )}
      <input
        ref={fileRef}
        type="file"
        style={{ display: "none" }}
        value=""
        onChange={(e) => {
          const file = e.target.files?.[0];
          file && handleUpload(file);
        }}
      />
      <button
        onClick={() => {
          fileRef.current && fileRef.current.click();
        }}
      >
        上传按钮
      </button>
    </div>
  );
}

export default App;
