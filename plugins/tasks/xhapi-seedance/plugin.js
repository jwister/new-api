export const meta = {
  apiVersion: 1,
  key: "xhapi-seedance",
  name: "XHAPI Seedance",
  icon: "text:XH",
  description: {
    en: "XHAPI Seedance video generation and asset management",
    zh: "星环 API Seedance 视频生成及素材管理",
  },
  version: "1.0.1",
  author: { name: "QuantumNous" },
  models: ["seedance-2.0", "seedance-2.0-fast", "seedance-2.0-mini","seedance-2.5"],
  fetchMode: "per_task",
  usageSchema: {
    duration: { type: "number", unit: "second", description: { en: "Requested video duration in seconds.", zh: "请求的视频时长（秒）。" } },
    resolution: { enum: ["480p", "720p", "1080p", "4k"], description: { en: "Output resolution.", zh: "输出分辨率。" } },
    ratio: { enum: ["16:9", "9:16", "adaptive"], description: { en: "Output aspect ratio.", zh: "输出画幅比例。" } },
  },
  routes: [
    { method: "POST", path: "/v1/assets", type: "proxy", decode: "decodeAsset", render: "renderAsset" },
  ],
  protocols: ["openai_video"],
};

function text(value) { return typeof value === "string" ? value.trim() : ""; }

function assetAction(ctx) {
  const values = (ctx.query || {}).action || [];
  const action = text(values[0]);
  const allowed = [
    "createAssetGroup", "listAssetGroups", "getAssetGroup", "updateAssetGroup", "deleteAssetGroup",
    "createAsset", "listAssets", "getAsset", "updateAsset", "deleteAsset",
  ];
  if (!allowed.includes(action)) throw new Error("invalid assets action");
  return action;
}

function assetVersion(ctx) {
  const values = (ctx.query || {}).version || [];
  const version = text(values[0]) || "2024-01-01";
  if (version !== "2024-01-01") throw new Error("unsupported assets API version");
  return version;
}

function jsonBody(ctx) {
  if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
  const value = ctx.body.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value;
}

export const native = {
  decodeAsset(ctx) {
    return { requestBody: jsonBody(ctx), action: assetAction(ctx) };
  },
  renderAsset(ctx, response) {
    return response && Object.prototype.hasOwnProperty.call(response, "body") ? response.body : response;
  },
  error(ctx, error) {
    return { error: { code: error.code, message: error.message } };
  },
};

export function buildProxyRequest(ctx) {
  const action = text(ctx.action);
  const version = "2024-01-01";
  return {
    url: ctx.baseUrl + "/v1/assets?action=" + encodeURIComponent(action) + "&version=" + encodeURIComponent(version),
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + ctx.apiKey },
    body: ctx.requestBody || {},
  };
}

function normalizeDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 5 || duration > 15 || Math.floor(duration) !== duration) {
    throw new Error("duration must be an integer between 5 and 15");
  }
  return duration;
}

function normalizeResolution(value) {
  const resolution = text(value).toLowerCase();
  if (!resolution) return undefined;
  if (!["480p", "720p", "1080p", "4k"].includes(resolution)) throw new Error("resolution must be 480p, 720p, 1080p, or 4k");
  return resolution;
}

function normalizeRatio(value) {
  const ratio = text(value).toLowerCase();
  if (!ratio) return undefined;
  if (!["16:9", "9:16", "adaptive"].includes(ratio)) throw new Error("ratio must be 16:9, 9:16, or adaptive");
  return ratio;
}

function contentFromOpenAI(req) {
  if (Array.isArray(req.content)) return req.content;
  const content = [];
  if (text(req.prompt)) content.push({ type: "text", text: req.prompt });
  const reference = req.input_reference || req.image || req.video || req.audio;
  if (text(reference)) content.push({ type: req.video ? "video_url" : req.audio ? "audio_url" : "image_url", [req.video ? "video_url" : req.audio ? "audio_url" : "image_url"]: { url: text(reference) } });
  return content;
}

function decodeVideoRequest(ctx) {
  if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
  const req = ctx.body.value;
  if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("JSON object required");
  const model = text(ctx.model);
  if (!model) throw new Error("model is required");
  const content = contentFromOpenAI(req);
  if (!content.length) throw new Error("prompt or input_reference is required");
  if (!content.every((item) => item && typeof item === "object" && ["text", "image_url", "video_url", "audio_url"].includes(item.type))) throw new Error("content item type is invalid");
  const durationValue = req.duration === undefined ? req.seconds : req.duration;
  const requestBody = { model: model, content: content };
  if (durationValue !== undefined) requestBody.duration = normalizeDuration(durationValue);
  const resolution = normalizeResolution(req.resolution || (text(req.size).match(/^(480p|720p|1080p|4k)$/) || [])[1]);
  if (resolution) requestBody.resolution = resolution;
  const ratio = normalizeRatio(req.ratio);
  if (ratio) requestBody.ratio = ratio;
  return { kind: "submit", model: model, action: content.some((item) => item.type !== "text") ? "reference_to_video" : "text_to_video", requestBody: requestBody };
}

export const protocols = {
  openai_video: {
    decodeRequest: decodeVideoRequest,
    render(ctx, task) {
      const statuses = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "in_progress", SUCCESS: "completed", FAILURE: "failed" };
      const output = { id: task.task_id, object: "video", model: (task.properties || {}).origin_model_name || "", status: statuses[task.status] || "unknown", progress: Number(String(task.progress || "0").replace("%", "")), created_at: task.created_at };
      if (task.updated_at) output.completed_at = task.updated_at;
      const videoURL = text(taskData(task).content && taskData(task).content.video_url);
      if (videoURL) output.metadata = { video_url: videoURL };
      if (task.status === "FAILURE") output.error = { code: "video_generation_failed", message: task.fail_reason || "video generation failed" };
      return output;
    },
  },
};

export function buildSubmitRequest(ctx) {
  return { url: ctx.baseUrl + "/v1/custom-videos/generations", method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + ctx.apiKey }, body: ctx.requestBody, action: ctx.action, rewriteModel: ctx.requestBody.model };
}

export function parseSubmitResponse(ctx, resp) {
  const body = resp.body || {};
  const id = body.id || body.task_id || (body.data && (body.data.id || body.data.task_id));
  if (!text(id)) throw new Error("task_id is empty");
  return { taskId: text(id), taskData: body };
}

export function extractUsage(ctx) {
  const req = ctx.requestBody || {};
  if (ctx.usagePurpose === "billing_ratios") return null;
  const facts = {};
  if (req.duration !== undefined) facts.duration = normalizeDuration(req.duration);
  if (req.resolution) facts.resolution = normalizeResolution(req.resolution);
  if (req.ratio) facts.ratio = normalizeRatio(req.ratio);
  return facts;
}

export function buildQueryRequest(ctx) {
  return { url: ctx.baseUrl + "/v1/custom-videos/tasks/" + encodeURIComponent(ctx.taskId), method: "GET", headers: { Accept: "application/json", Authorization: "Bearer " + ctx.apiKey } };
}

export function parseTaskResult(ctx, body) {
  const status = text(body && body.status).toLowerCase();
  if (["pending", "queued", "created"].includes(status)) return { status: "QUEUED", progress: "10%" };
  if (["processing", "running", "in_progress"].includes(status)) return { status: "IN_PROGRESS", progress: "50%" };
  if (status === "succeeded" || status === "success" || status === "completed") return { status: "SUCCESS", progress: "100%", url: text(body.content && body.content.video_url) };
  if (["failed", "failure", "expired", "cancelled", "canceled"].includes(status)) return { status: "FAILURE", progress: "100%", reason: text(body.error && (body.error.message || body.error.code)) || status };
  return { status: "IN_PROGRESS", progress: "30%" };
}

function taskData(ctx) {
  const data = (ctx && ctx.data) || {};
  return data.data && typeof data.data === "object" && data.data.content ? data.data : data;
}

export function listArtifacts(task) {
  if (task.status !== "SUCCESS") return [];
  return text(taskData(task).content && taskData(task).content.video_url) ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : [];
}

export function buildContentRequest(ctx) {
  const url = text(taskData(ctx).content && taskData(ctx).content.video_url);
  if (!url) throw new Error("artifact_not_found");
  return { url: url, method: ctx.clientRequest.method, credentialless: true };
}

export function extractUsageOnComplete(task, taskResult, body) {
  if (!body || body.status !== "succeeded") return {};
  const facts = {};
  if (body.duration !== undefined) facts.duration = Math.min(15, Math.max(5, Number(body.duration)));
  if (["480p", "720p", "1080p", "4k"].includes(text(body.resolution).toLowerCase())) facts.resolution = text(body.resolution).toLowerCase();
  if (["16:9", "9:16", "adaptive"].includes(text(body.ratio).toLowerCase())) facts.ratio = text(body.ratio).toLowerCase();
  return facts;
}
