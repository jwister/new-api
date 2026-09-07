package plugins_test

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	builtinplugins "github.com/QuantumNous/new-api/plugins"
	taskplugin "github.com/QuantumNous/new-api/relay/channel/task/jsplugin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func pluginObject(t *testing.T, value any) map[string]any {
	t.Helper()
	encoded, err := common.Marshal(value)
	require.NoError(t, err)
	var object map[string]any
	require.NoError(t, common.Unmarshal(encoded, &object))
	return object
}

func TestCTYunCDanceOpenAIVideoProtocol(t *testing.T) {
	source, err := builtinplugins.Source("ctyun-cdance")
	require.NoError(t, err)
	registry := jsplugin.NewRegistry()
	plugin, err := registry.RegisterFactory(source, jsplugin.Options{Key: "ctyun-cdance"})
	require.NoError(t, err)

	for _, model := range []string{
		"cdance2.0-0807",
		"cdance2.0-fast-0807",
		"cdance2.0-mini-0807",
		"cdance2.5-0807",
		"cdance2.0-0813",
	} {
		binding, found := registry.Generation().LookupEndpoint("POST", "/v1/videos", model)
		require.True(t, found, model)
		assert.Same(t, plugin, binding.Plugin)
		assert.Equal(t, "openai_video", binding.Protocol)
	}

	decodedValue, err := plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_video", "decodeRequest"}, map[string]any{
		"model": "cdance2.0-0807",
		"body": map[string]any{"kind": "json", "value": map[string]any{
			"model":           "cdance2.0-0807",
			"prompt":          "sunset over the sea",
			"seconds":         5,
			"input_reference": "https://assets.example/reference.png",
			"metadata":        map[string]any{"resolution": "720p", "generate_audio": true},
		}},
	})
	require.NoError(t, err)
	decoded := pluginObject(t, decodedValue)
	requestBody, ok := decoded["requestBody"].(map[string]any)
	require.True(t, ok)

	submitValue, err := plugin.Engine.Call(t.Context(), "buildSubmitRequest", map[string]any{
		"baseUrl":       "https://ai.ctaigw.cn",
		"apiKey":        "secret",
		"upstreamModel": "cdance2.0-0807",
		"requestBody":   requestBody,
		"action":        "image_to_video",
	})
	require.NoError(t, err)
	submit := pluginObject(t, submitValue)
	assert.Equal(t, "https://ai.ctaigw.cn/v1/contents/generations/tasks", submit["url"])
	headers, ok := submit["headers"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "Bearer secret", headers["Authorization"])
	body, ok := submit["body"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "cdance2.0-0807", body["model"])
	assert.Equal(t, float64(5), body["duration"])
	assert.Equal(t, "720p", body["resolution"])
	assert.Equal(t, true, body["generate_audio"])
	content, ok := body["content"].([]any)
	require.True(t, ok)
	require.Len(t, content, 2)
	textPart, ok := content[0].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "sunset over the sea", textPart["text"])
	imagePart, ok := content[1].(map[string]any)
	require.True(t, ok)
	imageURL, ok := imagePart["image_url"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "https://assets.example/reference.png", imageURL["url"])

	queryValue, err := plugin.Engine.Call(t.Context(), "buildQueryRequest", map[string]any{
		"baseUrl": "https://ai.ctaigw.cn",
		"apiKey":  "secret",
		"taskId":  "upstream-task",
	})
	require.NoError(t, err)
	query := pluginObject(t, queryValue)
	assert.Equal(t, "https://ai.ctaigw.cn/v1/contents/generations/tasks/upstream-task", query["url"])

	createdValue, err := plugin.Engine.Call(t.Context(), "parseSubmitResponse", map[string]any{}, map[string]any{"body": map[string]any{"id": "upstream-task"}})
	require.NoError(t, err)
	assert.Equal(t, "upstream-task", pluginObject(t, createdValue)["taskId"])
	_, err = plugin.Engine.Call(t.Context(), "parseSubmitResponse", map[string]any{}, map[string]any{"body": map[string]any{}})
	require.ErrorContains(t, err, "task_id is empty")

	for upstreamStatus, expectedStatus := range map[string]string{
		"queued":     "QUEUED",
		"processing": "IN_PROGRESS",
		"succeeded":  "SUCCESS",
		"failed":     "FAILURE",
		"unexpected": "UNKNOWN",
	} {
		resultValue, callErr := plugin.Engine.Call(t.Context(), "parseTaskResult", map[string]any{}, map[string]any{"status": upstreamStatus})
		require.NoError(t, callErr)
		assert.Equal(t, expectedStatus, pluginObject(t, resultValue)["status"], upstreamStatus)
	}

	successTask := map[string]any{
		"status": "SUCCESS",
		"data":   map[string]any{"status": "succeeded", "content": map[string]any{"video_url": "https://cdn.example/video.mp4"}},
	}
	artifactsValue, err := plugin.Engine.Call(t.Context(), "listArtifacts", successTask)
	require.NoError(t, err)
	artifacts := pluginObject(t, map[string]any{"items": artifactsValue})["items"].([]any)
	require.Len(t, artifacts, 1)

	contentValue, err := plugin.Engine.Call(t.Context(), "buildContentRequest", map[string]any{
		"artifactKey":   "video",
		"data":          successTask["data"],
		"clientRequest": map[string]any{"method": "GET"},
	})
	require.NoError(t, err)
	contentRequest := pluginObject(t, contentValue)
	assert.Equal(t, "https://cdn.example/video.mp4", contentRequest["url"])
	assert.Equal(t, true, contentRequest["credentialless"])

	rawTaskData, err := common.Marshal(successTask["data"])
	require.NoError(t, err)
	rendered, err := taskplugin.New(plugin).ConvertToOpenAIVideo(&model.Task{
		TaskID:     "task_public",
		Status:     model.TaskStatusSuccess,
		Properties: model.Properties{OriginModelName: "cdance2.0-0807"},
		Data:       rawTaskData,
	})
	require.NoError(t, err)
	var videoResponse map[string]any
	require.NoError(t, common.Unmarshal(rendered, &videoResponse))
	metadataResponse, ok := videoResponse["metadata"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "https://cdn.example/video.mp4", metadataResponse["video_url"])

	usageValue, err := plugin.Engine.Call(t.Context(), "extractUsage", map[string]any{"requestBody": requestBody})
	require.NoError(t, err)
	usage := pluginObject(t, usageValue)
	assert.Equal(t, float64(5), usage["duration"])
	assert.Equal(t, "720p", usage["resolution"])
	completedUsageValue, err := plugin.Engine.Call(t.Context(), "extractUsageOnComplete", map[string]any{}, map[string]any{}, map[string]any{"usage": map[string]any{"total_tokens": 108000}})
	require.NoError(t, err)
	assert.Equal(t, float64(108000), pluginObject(t, completedUsageValue)["tokens"])

	multipartValue, err := plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_video", "decodeRequest"}, map[string]any{
		"model": "cdance2.0-0807",
		"body": map[string]any{
			"kind":   "multipart",
			"fields": map[string]any{"prompt": []any{"sunset"}},
			"files":  []any{map[string]any{"field": "input_reference"}},
		},
	})
	require.NoError(t, err)
	multipart := pluginObject(t, multipartValue)
	multipartBody := multipart["requestBody"].(map[string]any)
	placeholder := multipartBody["input_reference"].(map[string]any)
	assert.Equal(t, "request_file:input_reference", placeholder["__fileRef"])
	assert.Equal(t, "dataUrl", placeholder["encoding"])
	_, err = plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_video", "decodeRequest"}, map[string]any{
		"model": "cdance2.0-0807",
		"body":  map[string]any{"kind": "multipart", "fields": map[string]any{}, "files": []any{map[string]any{"field": "unexpected"}}},
	})
	require.ErrorContains(t, err, "unexpected file field")
}
