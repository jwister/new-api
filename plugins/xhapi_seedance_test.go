package plugins_test

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	builtinplugins "github.com/QuantumNous/new-api/plugins"
	taskplugin "github.com/QuantumNous/new-api/relay/channel/task/jsplugin"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestXHAPISeedanceVideoDetailIncludesPublicVideoURL(t *testing.T) {
	source, err := builtinplugins.Source("xhapi-seedance")
	require.NoError(t, err)
	plugin, err := jsplugin.NewRegistry().RegisterFactory(source, jsplugin.Options{Key: "xhapi-seedance"})
	require.NoError(t, err)

	const videoURL = "https://xhuan-sd-videos.oss-cn-hangzhou.aliyuncs.com/task_public.mp4"
	data, err := common.Marshal(map[string]any{
		"status": "succeeded",
		"content": map[string]any{"video_url": videoURL},
	})
	require.NoError(t, err)

	rendered, err := taskplugin.New(plugin).ConvertToOpenAIVideo(&model.Task{
		TaskID:     "task_public",
		Status:     model.TaskStatusSuccess,
		Properties: model.Properties{OriginModelName: "seedance-2.0"},
		Data:       data,
	})
	require.NoError(t, err)

	video := dto.NewOpenAIVideo()
	require.NoError(t, common.Unmarshal(rendered, video))
	assert.Equal(t, videoURL, video.Metadata["video_url"])
	assert.NotContains(t, video.Metadata, "url")
}
