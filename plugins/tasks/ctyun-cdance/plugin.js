export const meta = {
  apiVersion: 1,
  key: "ctyun-cdance",
  name: "CTYun CDance Video",
  icon: "Doubao.Color",
  description: {
    en: "CTYun Edge AI Gateway CDance video generation",
    zh: "天翼云边缘 AI 网关 CDance 视频生成",
  },
  version: "1.0.0",
  author: { name: "QuantumNous" },
  models: ["cdance2.0-0807", "cdance2.0-fast-0807", "cdance2.0-mini-0807", "cdance2.5-0807", "cdance2.0-0813"],
  fetchMode: "per_task",
  usageSchema: {
    tokens: {
      type: "number",
      unit: "token",
      description: { en: "Upstream CDance token usage.", zh: "上游 CDance Token 用量。" },
    },
    duration: {
      type: "number",
      unit: "second",
      description: { en: "Requested video duration in seconds.", zh: "请求的视频时长，单位为秒。" },
    },
    resolution: {
      enum: ["480p", "720p", "1080p"],
      description: { en: "Requested output resolution.", zh: "请求的输出分辨率。" },
    },
  },
  usageExamples: [{ label: "2.0 5s 720p", facts: { tokens: 108000, duration: 5, resolution: "720p" } }],
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
  if (!content.every(function (item) { return item && typeof item === "object" && ["text", "image_url"].includes(item.type); })) {
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
  const videoURL = trimmed(taskData(task).content && taskData(task).content.video_url);
  return task.status === "SUCCESS" && videoURL ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : [];
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("artifact_not_found");
  const url = trimmed(taskData(ctx).content && taskData(ctx).content.video_url);
  if (!url) throw new Error("artifact_not_found");
  return { url: url, method: ctx.clientRequest.method, credentialless: true };
}

export function extractUsage(ctx) {
  const req = ctx.requestBody || {};
  const facts = {};
  const seconds = durationFrom(req);
  if (seconds !== undefined) facts.duration = seconds;
  const resolution = trimmed((req.metadata || {}).resolution).toLowerCase();
  if (["480p", "720p", "1080p"].includes(resolution)) facts.resolution = resolution;
  return facts;
}

export function extractUsageOnComplete(_task, _taskResult, body) {
  const usage = (body || {}).usage || {};
  let tokens = Number(usage.completion_tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) tokens = Number(usage.total_tokens);
  return Number.isFinite(tokens) && tokens > 0 ? { tokens: tokens } : {};
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
    const videoURL = trimmed(taskData(task).content && taskData(task).content.video_url);
    if (videoURL) output.metadata = { video_url: videoURL };
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
