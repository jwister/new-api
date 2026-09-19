export const meta = {
  apiVersion: 1,
  key: "ctyun-cdance",
  name: "CTYun CDance Video",
  icon: "Doubao.Color",
  description: {
    en: "CTYun Edge AI Gateway CDance video generation",
    zh: "天翼云边缘 AI 网关 CDance 视频生成",
  },
  version: "1.0.1",
  author: { name: "QuantumNous" },
  models: ["cdance2.0-0807", "cdance2.0-fast-0807", "cdance2.0-mini-0807", "cdance2.5-0807", "cdance2.0-0813"],
  fetchMode: "per_task",
  usageSchema: {
    tokens: {
      type: "number",
      unit: "token",
      description: { en: "Upstream CDance billing token usage (estimated on submit, actual on completion).", zh: "上游 CDance 计费 Token 用量（提交时预估，完成时实扣）。" },
    },
    duration: {
      type: "number",
      unit: "second",
      description: { en: "Requested video duration in seconds.", zh: "请求的视频时长，单位为秒。" },
    },
    resolution: {
      enum: ["480p", "720p", "1080p", "4k"],
      enumLabels: {
        "480p": { en: "480p", zh: "480p" },
        "720p": { en: "720p", zh: "720p" },
        "1080p": { en: "1080p", zh: "1080p" },
        "4k": { en: "4k", zh: "4k" },
      },
      description: { en: "Requested output resolution.", zh: "请求的输出分辨率。" },
    },
    video_input: {
      enum: ["none", "video"],
      enumLabels: { none: { en: "No reference video", zh: "无参考视频" }, video: { en: "With reference video", zh: "有参考视频" } },
      description: { en: "Reference video input", zh: "参考视频输入" },
    },
  },
  usageExamples: [
    { label: "480p · 5s", facts: { tokens: 48038, duration: 5, resolution: "480p", video_input: "none" } },
    { label: "720p · 5s", facts: { tokens: 108000, duration: 5, resolution: "720p", video_input: "none" } },
    { label: "1080p · 5s", facts: { tokens: 243000, duration: 5, resolution: "1080p", video_input: "none" } },
    { label: "4k · 5s", facts: { tokens: 972000, duration: 5, resolution: "4k", video_input: "none" } },
  ],
  protocols: ["openai_video"],
};

function trimmed(value) {
  return String(value || "").trim();
}

function durationFrom(req) {
  const value = req.seconds === undefined ? req.duration : req.seconds;
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new Error("seconds must be between 1 and 3600");
  return seconds;
}

function parseMetadata(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("metadata must be an object");
  return value;
}

function normalizeResolution(value) {
  const raw = trimmed(value).toLowerCase();
  if (["480p", "720p", "1080p", "4k"].includes(raw)) return raw;
  const parts = raw.replace("*", "x").split("x");
  if (parts.length !== 2) return "720p";
  const max = Math.max(Number(parts[0]), Number(parts[1]));
  if (max >= 3840) return "4k";
  if (max >= 1920) return "1080p";
  if (max >= 1280) return "720p";
  return "480p";
}

function resolutionMaxPixels(resolution) {
  if (resolution === "480p") return [854, 480];
  if (resolution === "1080p") return [1920, 1080];
  if (resolution === "4k") return [3840, 2160];
  return [1280, 720];
}

function estimateTokens(seconds, resolution) {
  const dims = resolutionMaxPixels(resolution);
  return (seconds * dims[0] * dims[1] * 24) / 1024;
}

function hasVideo(content) {
  return Array.isArray(content) && content.some(function (item) {
    return item && (item.type === "video_url" || Object.prototype.hasOwnProperty.call(item, "video_url"));
  });
}

function contentFrom(req) {
  if (Array.isArray(req.content)) return req.content;
  const metadata = req.metadata || {};
  const content = [];
  const prompt = trimmed(req.prompt);
  if (prompt) content.push({ type: "text", text: prompt });
  if (req.input_reference) content.push({ type: "image_url", image_url: { url: req.input_reference } });
  if (Array.isArray(metadata.content)) content.push.apply(content, metadata.content);
  return content;
}

function validateContent(content) {
  if (!content.every(function (item) {
    return item && typeof item === "object" && ["text", "image_url", "video_url", "audio_url"].includes(item.type);
  })) {
    throw new Error("content item type is invalid");
  }
}

function actionFrom(content) {
  return content.some(function (item) { return item && item.type !== "text"; }) ? "image_to_video" : "text_to_video";
}

function taskData(ctx) {
  const data = (ctx && ctx.data) || {};
  if (data.data && typeof data.data === "object" && !Array.isArray(data.data)) return data.data;
  return data;
}

export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody || {};
  const metadata = Object.assign({}, req.metadata || {});
  const content = contentFrom(req);
  const body = Object.assign({}, metadata, { model: ctx.upstreamModel || req.model || "", content: content });
  const seconds = durationFrom(req);
  if (seconds !== undefined) body.duration = seconds;
  return {
    url: ctx.baseUrl + "/v1/contents/generations/tasks",
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + ctx.apiKey },
    body: body,
    action: ctx.action || actionFrom(content),
    rewriteModel: body.model,
  };
}

export function parseSubmitResponse(_ctx, resp) {
  const body = resp.body || {};
  if (!trimmed(body.id)) throw new Error("task_id is empty");
  return { taskId: body.id, taskData: body };
}

export function buildQueryRequest(ctx) {
  return {
    url: ctx.baseUrl + "/v1/contents/generations/tasks/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: { Accept: "application/json", Authorization: "Bearer " + ctx.apiKey },
  };
}

export function parseTaskResult(_ctx, body) {
  const statuses = {
    queued: "QUEUED",
    pending: "QUEUED",
    processing: "IN_PROGRESS",
    running: "IN_PROGRESS",
    succeeded: "SUCCESS",
    failed: "FAILURE",
    expired: "FAILURE",
    cancelled: "FAILURE",
    canceled: "FAILURE",
  };
  const status = statuses[trimmed(body.status).toLowerCase()];
  if (!status) return { status: "UNKNOWN", reason: "unrecognized status: " + String(body.status || "") };
  const result = { status: status };
  if (status === "SUCCESS") result.url = trimmed(body.content && body.content.video_url);
  if (status === "FAILURE") result.reason = trimmed(body.error && (body.error.message || body.error.code)) || trimmed(body.status);
  return result;
}

export function listArtifacts(task) {
  const data = taskData(task);
  const content = (data && data.content) || {};
  const videoURL = trimmed(content.video_url);
  const lastFrameURL = trimmed(content.last_frame_url);
  const artifacts = [];
  if (task.status === "SUCCESS" && videoURL) {
    artifacts.push({ key: "video", type: "video", mimeType: "video/mp4" });
  }
  if (task.status === "SUCCESS" && lastFrameURL) {
    artifacts.push({ key: "last_frame", type: "image", mimeType: "image/png" });
  }
  return artifacts;
}

export function buildContentRequest(ctx) {
  const data = taskData(ctx);
  const content = (data && data.content) || {};
  if (ctx.artifactKey === "video") {
    const url = trimmed(content.video_url);
    if (!url) throw new Error("artifact_not_found");
    return { url: url, method: ctx.clientRequest.method, credentialless: true };
  }
  if (ctx.artifactKey === "last_frame") {
    const url = trimmed(content.last_frame_url);
    if (!url) throw new Error("artifact_not_found");
    return { url: url, method: ctx.clientRequest.method, credentialless: true };
  }
  throw new Error("artifact_not_found");
}

export function extractUsage(ctx) {
  const req = ctx.requestBody || {};
  const metadata = req.metadata || {};
  let seconds = durationFrom(req);
  if (seconds === undefined) {
    const fromMeta = Number(metadata.duration || metadata.seconds);
    if (Number.isFinite(fromMeta) && fromMeta > 0) seconds = fromMeta;
  }
  const sec = seconds !== undefined ? seconds : 5;
  const rawResolution = metadata.resolution || req.resolution || req.size;
  const resolution = normalizeResolution(rawResolution);
  const content = contentFrom(req);
  const withVideo = hasVideo(content);

  const facts = {
    tokens: estimateTokens(sec, resolution),
    resolution: resolution,
    video_input: withVideo ? "video" : "none",
  };
  if (seconds !== undefined) {
    facts.duration = seconds;
  }
  return facts;
}

export function extractUsageOnComplete(_task, _taskResult, body) {
  if (!body) return {};
  if (body.status && body.status !== "succeeded") return {};
  const facts = {};
  const usage = body.usage || {};
  let tokens = Number(usage.completion_tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) tokens = Number(usage.total_tokens);
  if (Number.isFinite(tokens) && tokens > 0) facts.tokens = tokens;
  const content = body.content || {};
  const resolution = trimmed(content.resolution || body.resolution).toLowerCase();
  if (["480p", "720p", "1080p", "4k"].includes(resolution)) facts.resolution = resolution;
  return facts;
}

const legacyRenderers = {
  openai_video: function (task) {
    const statuses = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "in_progress", SUCCESS: "completed", FAILURE: "failed" };
    const output = {
      id: task.task_id,
      object: "video",
      model: (task.properties || {}).origin_model_name || "",
      status: statuses[task.status] || "unknown",
      progress: Number(String(task.progress || "0").replace("%", "")),
      created_at: Number(task.created_at || 0),
    };
    const completedAt = Number(task.finished_at || task.updated_at || 0);
    if (completedAt > 0) output.completed_at = completedAt;
    const content = (taskData(task) && taskData(task).content) || {};
    const videoURL = trimmed(content.video_url);
    if (videoURL) {
      output.metadata = { video_url: videoURL };
      if (trimmed(content.last_frame_url)) {
        output.metadata.last_frame_url = trimmed(content.last_frame_url);
      }
    }
    if (task.status === "FAILURE") output.error = { code: "video_generation_failed", message: task.fail_reason || "The video generation task failed." };
    return output;
  },
};

export const protocols = {
  openai_video: {
    decodeRequest: function (ctx) {
      if (!ctx.body || (ctx.body.kind !== "json" && ctx.body.kind !== "multipart")) throw new Error("JSON or multipart body required");
      let req;
      let hasInputReferenceFile = false;
      if (ctx.body.kind === "json") {
        if (!ctx.body.value || typeof ctx.body.value !== "object" || Array.isArray(ctx.body.value)) throw new Error("JSON object required");
        req = Object.assign({}, ctx.body.value);
        parseMetadata(req.metadata);
      } else {
        req = {};
        const fields = ctx.body.fields || {};
        for (const name of Object.keys(fields)) {
          const values = fields[name] || [];
          if (values.length > 1) throw new Error(name + " must be provided once");
          req[name] = values[0];
        }
        for (const file of ctx.body.files || []) {
          if (file.field !== "input_reference") throw new Error("unexpected file field: " + file.field);
          if (hasInputReferenceFile) throw new Error("input_reference must be provided once");
          hasInputReferenceFile = true;
        }
        if (req.metadata !== undefined) {
          try {
            req.metadata = JSON.parse(req.metadata);
          } catch (_error) {
            throw new Error("metadata must be a JSON object string");
          }
          parseMetadata(req.metadata);
        }
        if (req.seconds !== undefined) req.seconds = Number(req.seconds);
        else if (req.duration !== undefined) req.duration = Number(req.duration);
      }
      durationFrom(req);
      if (hasInputReferenceFile) req.input_reference = { __fileRef: "request_file:input_reference", encoding: "dataUrl", maxBytes: 15728640 };
      if (req.input_reference === undefined && req.image !== undefined) req.input_reference = req.image;
      const metadata = Object.assign({}, req.metadata || {});
      if (req.resolution && !metadata.resolution) metadata.resolution = normalizeResolution(req.resolution);
      else if (req.size && !metadata.resolution) metadata.resolution = normalizeResolution(req.size);
      req.metadata = metadata;

      const content = contentFrom(req);
      if (!content.length) throw new Error("input is required");
      validateContent(content);
      return {
        kind: "submit",
        model: ctx.model,
        action: actionFrom(content),
        requestBody: Object.assign({}, req, { model: ctx.model }),
      };
    },
    render: function (_ctx, task) {
      return legacyRenderers.openai_video(task);
    },
  },
};
