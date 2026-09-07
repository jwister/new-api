# 天翼 CDance 通用视频渠道插件设计

## 目标

新增一个任务插件，将天翼云边缘 AI 网关的 CDance 视频生成接口接入为通用 OpenAI Video API。下游只使用 `POST /v1/videos`、`GET /v1/videos/{task_id}` 和 `GET /v1/videos/{task_id}/content`；天翼上游的路径、任务格式与临时视频 URL 不直接暴露为下游协议。

## 范围与非目标

本次只支持文档 4.1、4.2 的创建与查询任务能力，以及已完成视频内容的读取。支持模型：`cdance2.0-0807`、`cdance2.0-fast-0807`、`cdance2.0-mini-0807`、`cdance2.5-0807`、`cdance2.0-0813`。

不实现素材上传、虚拟人像、连续视频、取消任务或删除任务。它们分别属于文档后续章节，且上游明确暂不支持取消和删除。

## 方案选择

采用独立的工厂任务插件 `ctyun-cdance`，而不修改现有 `doubao` 或 `sora` 插件。

- `doubao` 的上游固定为 `/api/v3/contents/generations/tasks`，与天翼要求的 `/v1/contents/generations/tasks` 不兼容；按模型条件分支会把两个供应商的路径与计费语义耦合在同一个插件中。
- `sora` 的下游协议相符，但其上游请求与任务响应不相符，复用会混淆供应商契约。
- `ctyun-cdance` 只声明 `openai_video` 协议，因此由任务插件宿主注册下游的三条通用视频路由，且只会对本插件声明的 CDance 模型生效。

## 渠道配置与上游交互

渠道类型为 `Task Plugin`，插件键为 `ctyun-cdance`，Base URL 只填写 `https://ai.ctaigw.cn`，密钥是天翼边缘 AI 网关 API Key。插件为创建请求和轮询请求分别拼接：

```
POST https://ai.ctaigw.cn/v1/contents/generations/tasks
GET  https://ai.ctaigw.cn/v1/contents/generations/tasks/{upstreamTaskId}
Authorization: Bearer {apiKey}
```

请求体按天翼文档转为 `model` 与 `content`。通用 API 的 `prompt` 转为 `{type: "text", text: prompt}`；`input_reference` 的 URL 或 multipart 文件转为图像素材项。`seconds` 或 `duration` 转为上游 `duration`。`metadata` 中的对象字段覆盖或补充上游扩展字段，因而可传递 `resolution`、`ratio`、`generate_audio` 和 `return_last_frame`，同时不改变下游主协议。

对于 multipart 上传文件，插件使用宿主文件占位符生成 data URL。它不调用天翼的可选素材上传 API；该 API 不在本次范围内。

## 下游协议与结果

下游创建只接受通用 OpenAI Video API 的 JSON 或 multipart 表单。模型必须是本插件声明的 CDance 模型，且请求至少提供非空 `prompt` 或 `input_reference`。下游读取接口由宿主使用公开任务 ID 查询，不能使用上游任务 ID。

任务创建时保存上游 `id`；轮询时将 `queued`、`pending` 映射为排队，将 `processing`、`running` 映射为进行中，将 `succeeded` 映射为成功，将 `failed`、`expired`、`cancelled` 映射为失败。未知状态必须返回 `UNKNOWN`，由宿主执行既有的轮询失败保护，不伪装成进行中。

插件将完成结果中的 `content.video_url` 声明为 `video` 产物。`GET /v1/videos/{task_id}/content` 通过既有安全代理读取该产物；下游获得的是通用视频内容响应，而不是天翼任务 JSON。

## 错误处理与计费

创建响应必须含 `id`，否则创建失败。轮询失败状态优先使用上游 `error.message` 或状态值作为失败原因。视频 URL 缺失时不声明产物，内容读取返回既有的 `artifact_not_found`。

插件仅记录时长、分辨率与最终上游 token 用量（上游返回时）等使用事实；它不自行定价或结算。渠道管理员为 CDance 模型配置价格，宿主的既有计费和限额机制负责预扣与结算。

## 验证

新增针对工厂插件的确定性测试，覆盖：CDance 模型的协议路由声明；JSON 与 multipart 通用请求到天翼请求描述符的转换；根 Base URL 到 `/v1/contents/generations/tasks` 的固定拼接；上游任务状态映射；成功视频产物的安全内容描述符；以及未知状态的 `UNKNOWN` 结果。

运行插件相关 Go 测试和完整 `go test ./plugins/...`。不进行真实天翼 API 调用，因为当前没有已授权的测试 API Key；这项限制将在实现交付中明确说明。
