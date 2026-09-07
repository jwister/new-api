# 天翼 CDance 通用视频插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `ctyun-cdance` 任务插件，将天翼 CDance 暴露为现有 OpenAI Video 下游接口。

**Architecture:** 插件只声明 `openai_video`，因此宿主为它所声明的模型处理 `POST /v1/videos`、`GET /v1/videos/{task_id}` 和 `GET /v1/videos/{task_id}/content`。插件把通用输入转换为天翼 `content` 数组，并固定在根 Base URL 后追加 `/v1/contents/generations/tasks`。

**Tech Stack:** Go 1.22、Goja JavaScript 任务插件运行时、Gin、Testify。

---

## 文件结构

- 新建 `plugins/tasks/ctyun-cdance/plugin.js`：CDance 模型、通用视频协议解码、上游请求和轮询、产物、渲染与用量事实。
- 新建 `plugins/ctyun_cdance_test.go`：协议路由、JSON/multipart 转换、状态与产物契约。
- 修改 `plugins/builtin_plugins_test.go`：嵌入插件清单和仅 `openai_video` 插件的路由断言。

### Task 1: 先写失败测试

**Files:**

- Create: `plugins/ctyun_cdance_test.go`
- Modify: `plugins/builtin_plugins_test.go`

- [ ] **Step 1: 编写协议与转换测试**

在 `plugins/ctyun_cdance_test.go` 使用 `builtinplugins.Source("ctyun-cdance")`、`jsplugin.NewRegistry()` 和 `RegisterFactory` 加载插件。对每一个模型断言：

```go
binding, found := registry.Generation().LookupEndpoint("POST", "/v1/videos", model)
require.True(t, found, model)
assert.Same(t, plugin, binding.Plugin)
assert.Equal(t, "openai_video", binding.Protocol)
```

调用 `protocols.openai_video.decodeRequest`，输入为：

```go
map[string]any{
  "model": "cdance2.0-0807",
  "body": map[string]any{"kind": "json", "value": map[string]any{
    "model": "cdance2.0-0807", "prompt": "sunset", "seconds": 5,
    "input_reference": "https://assets.example/reference.png",
    "metadata": map[string]any{"resolution": "720p", "generate_audio": true},
  }},
}
```

把解码出的 `requestBody` 传给 `buildSubmitRequest`，上下文为 `{baseUrl:"https://ai.ctaigw.cn", apiKey:"secret", upstreamModel:"cdance2.0-0807"}`。断言 descriptor URL 是 `https://ai.ctaigw.cn/v1/contents/generations/tasks`，Authorization 是 `Bearer secret`，body 包含 model、duration、resolution、generate_audio，且 content 包含 text 和 image_url 两项。

同一测试调用 `buildQueryRequest`，断言 URL 为 `https://ai.ctaigw.cn/v1/contents/generations/tasks/upstream-task`。对 `parseTaskResult` 断言 `queued`、`processing`、`succeeded`、`failed`、未知状态分别映射为 `QUEUED`、`IN_PROGRESS`、`SUCCESS`、`FAILURE`、`UNKNOWN`。成功 body 使用 `{status:"succeeded",content:{video_url:"https://cdn.example/video.mp4"}}`，并断言 `listArtifacts` 返回 video，`buildContentRequest` 返回同一 URL 与 `credentialless:true`。

用 `{status:"succeeded",usage:{total_tokens:108000}}` 调用 `extractUsageOnComplete`，断言最终 facts 包含 `tokens: 108000`；不含 usage 或非数值 token 时只返回空对象或其他已验证事实。

增加 multipart 测试：只允许一个 `input_reference` 文件，解码后该输入为 `{__fileRef:"request_file:input_reference",encoding:"dataUrl",maxBytes:15728640}`；无 prompt、无 URL、无文件时必须报 `input is required`；任意其他文件字段必须被拒绝。

- [ ] **Step 2: 验证测试先失败**

运行：

```powershell
go test ./plugins -run '^TestCTYunCDanceOpenAIVideoProtocol$' -count=1
```

预期：失败，原因是 `tasks/ctyun-cdance/plugin.js` 尚不存在。

- [ ] **Step 3: 更新内置插件清单测试**

在 `expectedKeys` 里按字母序加入 `ctyun-cdance`。在现有 `xhapi-seedance` 特判之后加入以下分支，避免把该插件误当作 Responses 插件：

```go
if key == "ctyun-cdance" {
  for _, model := range plugin.Meta.Models {
    binding, claimed := registry.Generation().LookupEndpoint("POST", "/v1/videos", model)
    require.True(t, claimed, model)
    assert.Same(t, plugin, binding.Plugin)
    assert.Equal(t, "openai_video", binding.Protocol)
  }
  continue
}
```

- [ ] **Step 4: 执行插件测试包**

运行：

```powershell
go test ./plugins -count=1
```

预期：仅因新插件目录尚不存在而失败；既有插件测试不应回归。

### Task 2: 实现 CDance 工厂插件

**Files:**

- Create: `plugins/tasks/ctyun-cdance/plugin.js`
- Test: `plugins/ctyun_cdance_test.go`

- [ ] **Step 1: 实现元数据与请求解码**

导出 `meta`，固定 `key:"ctyun-cdance"`、`version:"1.0.0"`、`fetchMode:"per_task"`、`protocols:["openai_video"]`；模型只包括 `cdance2.0-0807`、`cdance2.0-fast-0807`、`cdance2.0-mini-0807`、`cdance2.5-0807`、`cdance2.0-0813`。不声明 `channelTypes`、`routes` 或 `openai_responses`。

声明 `usageSchema` 的 `tokens`、`duration`、`resolution` 三个字段；每项包含类型、单位和中英文说明，并提供覆盖至少一个模型与分辨率的 `usageExamples`。

实现 `protocols.openai_video.decodeRequest(ctx)`：接受 JSON 和 multipart；验证 JSON 对象、模型、metadata 对象和 1–3600 的 seconds/duration；保留 `ctx.model`；将单个上传文件放入如下占位符；返回标准 submit intent。

```js
{ __fileRef: "request_file:input_reference", encoding: "dataUrl", maxBytes: 15728640 }
```

- [ ] **Step 2: 实现提交、查询和状态 hooks**

实现 `buildSubmitRequest(ctx)`：`ctx.upstreamModel || req.model` 写入上游 model；prompt 转为 `{type:"text",text:prompt}`；URL 或文件引用转为 `{type:"image_url",image_url:{url:value}}`；metadata 的扩展字段合并到 body；seconds/duration 写入 duration。返回：

```js
{
  url: ctx.baseUrl + "/v1/contents/generations/tasks",
  method: "POST",
  headers: {"Content-Type":"application/json", Accept:"application/json", Authorization:"Bearer " + ctx.apiKey},
  body, action, rewriteModel: body.model,
}
```

`parseSubmitResponse` 仅接受非空 `resp.body.id`。`buildQueryRequest(ctx)` 返回 `ctx.baseUrl + "/v1/contents/generations/tasks/" + encodeURIComponent(ctx.taskId)` 并使用 Bearer 鉴权。`parseTaskResult` 显式映射 queued/pending、processing/running、succeeded、failed/expired/cancelled/canceled；未知状态必须返回 `{status:"UNKNOWN",reason:"unrecognized status: ..."}`，不得降级为进行中。

- [ ] **Step 3: 实现下游视频投影、产物与用量事实**

实现 `listArtifacts`：仅在成功且 `content.video_url` 非空时返回 `{key:"video",type:"video",mimeType:"video/mp4"}`。`buildContentRequest` 对 video 返回 `{url,method:ctx.clientRequest.method,credentialless:true}`，其他 key 抛出 `artifact_not_found`。实现 `protocols.openai_video.render`，让宿主生成标准公开视频 DTO，且不把上游 URL 塞入 metadata。

实现 `extractUsage`/ `extractUsageOnComplete`，只返回已经声明的 `duration`、`resolution`、`tokens` facts；时长被限制在 3600，完成时仅在 `usage.total_tokens` 或 `usage.completion_tokens` 是有限正数时记录 tokens。绝不计算价格或结算。

- [ ] **Step 4: 运行定向测试**

运行：

```powershell
go test ./plugins -run '^(TestCTYunCDanceOpenAIVideoProtocol|TestBuiltInTaskPluginResponsesAndUsageContracts)$' -count=1
```

预期：通过，五个模型均由 `POST /v1/videos` 的 `openai_video` 绑定处理。

- [ ] **Step 5: 提交实现**

运行：

```powershell
git add plugins/tasks/ctyun-cdance/plugin.js plugins/ctyun_cdance_test.go plugins/builtin_plugins_test.go
git commit -m "功能：新增天翼CDance视频任务插件"
```

### Task 3: 完整验证与交付

**Files:**

- Modify: `docs/superpowers/plans/2026-09-07-ctyun-cdance-video-plugin.md`

- [ ] **Step 1: 执行完整插件回归**

运行：

```powershell
go test ./plugins -count=1
```

预期：通过，包含嵌入插件列表、新增路由和现有视频插件测试。

- [ ] **Step 2: 执行仓库 Go 回归**

运行：

```powershell
go test ./...
```

预期：通过；若环境或既有测试失败，记录命令、失败包和错误，不把它归因于本插件。

- [ ] **Step 3: 检查提交边界**

运行：

```powershell
git diff --check
git status --short
git log -2 --oneline
```

预期：没有空白错误；不提交浏览器或测试临时文件。
