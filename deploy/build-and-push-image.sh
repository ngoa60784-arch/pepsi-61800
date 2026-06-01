#!/usr/bin/env bash
# 在有源码的机器（本地/CI）上构建 solver 镜像并推送到 registry。
# 服务器侧只需 `docker pull`，不要在服务器上 build——构建会拉取大量工具、
# 产生数百 GB 构建缓存且耗时很长。
#
# 用法：
#   deploy/build-and-push-image.sh <registry/namespace> [tag]
# 例：
#   deploy/build-and-push-image.sh registry.example.com/sec latest
#
# 推送后在服务器上：
#   docker pull registry.example.com/sec/tch-agent:latest
#   docker tag  registry.example.com/sec/tch-agent:latest tch-agent:latest
#   # 或在 UI Config→Host 把 runtime.image 设为完整 registry 路径
set -euo pipefail

REGISTRY="${1:?usage: build-and-push-image.sh <registry/namespace> [tag]}"
TAG="${2:-latest}"
IMAGE="${REGISTRY}/tch-agent:${TAG}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOCKERFILE_DIR="${PROJECT_ROOT}/packages/core/src/runtime/assets"

if [ ! -f "${DOCKERFILE_DIR}/Dockerfile" ]; then
    echo "ERROR: Dockerfile not found at ${DOCKERFILE_DIR}/Dockerfile" >&2
    exit 1
fi

echo ">> building ${IMAGE} (platform linux/amd64) from ${DOCKERFILE_DIR}"
echo ">> 这一步会很久（完整 Kali + 数百个工具，镜像约 10GB+）"
docker build --platform linux/amd64 -t "${IMAGE}" "${DOCKERFILE_DIR}"

echo ">> pushing ${IMAGE}"
docker push "${IMAGE}"

cat <<EOF

完成。镜像已推送：${IMAGE}

服务器上执行：
  docker pull ${IMAGE}
  docker tag  ${IMAGE} tch-agent:latest
（或在 UI Config→Host 把 runtime.image 设为 ${IMAGE}）
EOF
