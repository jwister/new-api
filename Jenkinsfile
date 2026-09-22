pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        timestamps()
    }

    environment {
        DOCKER_IMAGE = 'wenyou7/new-api'
        DOCKERHUB_CREDENTIALS = 'dockerhub-token'
        TARGET_BRANCH = 'dev'
    }

    stages {
        stage('检出代码') {
            steps {
                checkout scm
            }
        }

        stage('校验分支') {
            steps {
                script {
                    def currentBranch = env.BRANCH_NAME

                    if (!currentBranch && env.GIT_BRANCH) {
                        currentBranch = env.GIT_BRANCH.replaceFirst(/^origin\//, '')
                    }

                    if (!currentBranch) {
                        currentBranch = sh(
                            script: 'git symbolic-ref --short -q HEAD || true',
                            returnStdout: true
                        ).trim()
                    }

                    if (currentBranch != env.TARGET_BRANCH) {
                        error("仅允许 ${env.TARGET_BRANCH} 分支发布，当前分支：${currentBranch ?: '未知'}")
                    }

                    echo "发布分支：${currentBranch}"
                }
            }
        }

        stage('生成镜像标签') {
            steps {
                script {
                    env.IMAGE_TAG = sh(
                        script: 'TZ=Asia/Shanghai date +%Y%m%d-%H%M%S',
                        returnStdout: true
                    ).trim()

                    echo "本次镜像：${env.DOCKER_IMAGE}:${env.IMAGE_TAG}"
                    echo "同时更新：${env.DOCKER_IMAGE}:latest"
                }
            }
        }

        stage('构建镜像') {
            steps {
                retry(3) {
                    sh '''
                        set -eu
                        docker build --pull \\
                            --tag "${DOCKER_IMAGE}:${IMAGE_TAG}" \\
                            --tag "${DOCKER_IMAGE}:latest" \\
                            .
                    '''
                }
            }
        }

        stage('推送镜像') {
            steps {
                script {
                    docker.withRegistry('https://index.docker.io/v1/', env.DOCKERHUB_CREDENTIALS) {
                        retry(3) {
                            sh '''
                                set -eu
                                docker push "${DOCKER_IMAGE}:${IMAGE_TAG}"
                                docker push "${DOCKER_IMAGE}:latest"
                            '''
                        }
                    }
                }
            }
        }
    }

    post {
        success {
            echo "镜像发布成功：${env.DOCKER_IMAGE}:${env.IMAGE_TAG}"
            echo "latest 已更新：${env.DOCKER_IMAGE}:latest"
            
            sh '''
                echo "触发两台服务器的 Watchtower 拉取新镜像并重启服务..."
                
                # 触发节点 1
                echo "正在触发节点 16.162.55.129 ..."
                curl -H "Authorization: Bearer a3360059" http://16.162.55.129:8081/v1/update
                
                # 触发节点 2
                echo "正在触发节点 18.163.129.105 ..."
                curl -H "Authorization: Bearer a3360059" http://18.163.129.105:8081/v1/update
                
                echo "发送部署成功通知..."
                curl --fail --silent --show-error --get \
                    --connect-timeout 5 \
                    --max-time 15 \
                    --data-urlencode "t=部署成功：$DOCKER_IMAGE:$IMAGE_TAG" \
                    --data-urlencode "m=镜像：$DOCKER_IMAGE:$IMAGE_TAG，分支：$TARGET_BRANCH，已完成镜像推送与容器热更！" \
                    'http://192.168.100.153:9997/n/t' \
                    || echo 'Notification failed; deployment remains successful.'
            '''
        }

        failure {
            echo '镜像发布失败，请查看对应阶段的 Jenkins 构建日志。'
        }

        always {
            sh '''
                if [ -n "${IMAGE_TAG:-}" ]; then
                    docker image rm \\
                        "${DOCKER_IMAGE}:${IMAGE_TAG}" \\
                        "${DOCKER_IMAGE}:latest" \\
                        >/dev/null 2>&1 || true
                fi
            '''
        }
    }
}
