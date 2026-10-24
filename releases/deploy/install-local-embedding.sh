#!/usr/bin/env bash
# WorkPivot 本地向量服务一键安装（Ollama + bge-m3）
#
# 作用：为已部署的 WorkPivot 实例启动一个名为 embedding 的 sidecar 容器，
#       使后台那条预置草稿（http://embedding:11434，协议 ollama，1024 维）能直接连通。
#
# 为什么用 docker run 而不是 compose：
#   这是与应用发布解耦的旁路服务，不应随应用升级/回退被重建；单独命名容器更直观。
#
# 用法（在 WSL 内、仓库根目录执行）：
#   bash releases/deploy/install-local-embedding.sh              # 前台安装
#   bash releases/deploy/install-local-embedding.sh --background # 后台安装
#   bash releases/deploy/install-local-embedding.sh status       # 查看状态
#   bash releases/deploy/install-local-embedding.sh logs         # 跟踪安装日志
#   bash releases/deploy/install-local-embedding.sh stop         # 停止（保留容器与模型）
#   bash releases/deploy/install-local-embedding.sh uninstall    # 删除容器（保留模型卷）
#   bash releases/deploy/install-local-embedding.sh uninstall --purge  # 连模型卷一起删除
#
# 可覆盖的环境变量：
#   WORKPIVOT_EMBEDDING_NETWORK   Docker 网络（默认 workpivot-dsh_default）
#   WORKPIVOT_EMBEDDING_CONTAINER 容器名（默认 embedding，与草稿地址一致，不建议改）
#   WORKPIVOT_EMBEDDING_VOLUME    模型卷（默认 workpivot-embedding）
#   WORKPIVOT_EMBEDDING_MODEL     模型（默认 bge-m3）
#   WORKPIVOT_EMBEDDING_DIMS      维度（默认 1024，须与后台草稿一致）
#   WORKPIVOT_EMBEDDING_PORT      宿主机调试端口（默认 11434，仅绑定 127.0.0.1）
#   WORKPIVOT_OLLAMA_IMAGE        Ollama 镜像（默认 ollama/ollama:0.6.8）
#
# 幂等：重复执行不会重建容器、不会重复下载已有镜像或模型。
# 安全：不修改 WorkPivot 应用容器；宿主机端口只绑定回环地址；不写入任何凭据。

set -uo pipefail

NETWORK="${WORKPIVOT_EMBEDDING_NETWORK:-workpivot-dsh_default}"
CONTAINER="${WORKPIVOT_EMBEDDING_CONTAINER:-embedding}"
VOLUME="${WORKPIVOT_EMBEDDING_VOLUME:-workpivot-embedding}"
MODEL="${WORKPIVOT_EMBEDDING_MODEL:-bge-m3}"
DIMS="${WORKPIVOT_EMBEDDING_DIMS:-1024}"
PORT="${WORKPIVOT_EMBEDDING_PORT:-11434}"
UI_URL="${WORKPIVOT_EMBEDDING_UI:-http://127.0.0.1:39990/}"
IMAGE="${WORKPIVOT_OLLAMA_IMAGE:-ollama/ollama:0.6.8}"
STATE_DIR="${WORKPIVOT_EMBEDDING_STATE:-$HOME/workpivot-dsh/embedding}"
LOG_FILE="$STATE_DIR/install.log"
# Docker Hub 直连在本机不可用，按顺序尝试镜像代理
MIRRORS=(docker.m.daocloud.io dockerproxy.net docker.1ms.run)

log()  { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
warn() { printf '[%s] 警告：%s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
die()  { printf '[%s] 失败：%s\n' "$(date '+%H:%M:%S')" "$*" >&2; exit 1; }

need_docker() {
  command -v docker >/dev/null 2>&1 || die 'docker 不可用；请先启动 Docker（WSL 内）'
  docker info >/dev/null 2>&1 || die 'Docker 守护进程未运行'
}

network_exists() { docker network inspect "$NETWORK" >/dev/null 2>&1; }

ensure_network() {
  network_exists && return 0
  cat >&2 <<EOF
失败：找不到 Docker 网络 $NETWORK

该网络由 WorkPivot 应用 compose 创建。请先确认实例在运行：
  docker ps --filter name=workpivot-dsh-server

如果实例用了别的项目名，通过环境变量指定网络：
  WORKPIVOT_EMBEDDING_NETWORK=<网络名> bash $0
EOF
  exit 1
}

image_exists() { docker image inspect "$IMAGE" >/dev/null 2>&1; }

ensure_image() {
  if image_exists; then
    log "镜像已存在：$IMAGE"
    return 0
  fi
  local name tag
  name="${IMAGE%%:*}"; tag="${IMAGE##*:}"
  for mirror in "${MIRRORS[@]}"; do
    log "尝试从代理拉取：$mirror/$name:$tag"
    if docker pull "$mirror/$name:$tag"; then
      docker tag "$mirror/$name:$tag" "$IMAGE" || die "打标签失败：$IMAGE"
      docker rmi "$mirror/$name:$tag" >/dev/null 2>&1 || true
      log "镜像就绪：$IMAGE"
      return 0
    fi
    warn "该代理失败，换下一个"
  done
  die '所有镜像代理均失败；可手动 docker pull 后重跑本脚本'
}

container_exists() { docker container inspect "$CONTAINER" >/dev/null 2>&1; }

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = 'true' ]
}

ensure_container() {
  if container_exists; then
    if container_running; then
      log "容器已在运行：$CONTAINER"
      return 0
    fi
    log "容器已存在但未运行，启动：$CONTAINER"
    docker start "$CONTAINER" >/dev/null || die '启动已有容器失败'
    return 0
  fi

  docker volume inspect "$VOLUME" >/dev/null 2>&1 || {
    log "创建模型卷：$VOLUME"
    docker volume create "$VOLUME" >/dev/null || die '创建模型卷失败'
  }

  log "创建容器：$CONTAINER（网络 $NETWORK）"
  docker run -d \
    --name "$CONTAINER" \
    --network "$NETWORK" \
    --restart unless-stopped \
    -p "127.0.0.1:${PORT}:11434" \
    -e OLLAMA_NUM_PARALLEL=1 \
    -e OLLAMA_MAX_LOADED_MODELS=1 \
    -v "${VOLUME}:/root/.ollama" \
    --label workpivot.role=embedding \
    "$IMAGE" >/dev/null || die '创建容器失败'

  log '容器已创建'
}

wait_ready() {
  local i
  for i in $(seq 1 60); do
    if docker exec "$CONTAINER" ollama list >/dev/null 2>&1; then
      log 'Ollama 已就绪'
      return 0
    fi
    sleep 2
  done
  docker logs --tail 30 "$CONTAINER" >&2 || true
  die 'Ollama 在 120 秒内未就绪'
}

model_present() {
  docker exec "$CONTAINER" ollama list 2>/dev/null | awk '{print $1}' | grep -qx "${MODEL}:latest" \
    || docker exec "$CONTAINER" ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$MODEL"
}

ensure_model() {
  if model_present; then
    log "模型已存在：$MODEL"
    return 0
  fi
  local attempt
  for attempt in 1 2 3; do
    log "拉取模型：$MODEL（第 $attempt 次）"
    if docker exec "$CONTAINER" ollama pull "$MODEL"; then
      log "模型就绪：$MODEL"
      return 0
    fi
    warn "模型拉取失败，10 秒后重试"
    sleep 10
  done
  die "模型拉取失败：$MODEL。可稍后单独执行 docker exec $CONTAINER ollama pull $MODEL 再重跑本脚本"
}

# 调用后台真实使用的接口形态，校验返回维数与配置一致
verify() {
  local out dims
  log '自检：调用 /api/embed 校验向量维度'
  out=$(curl -sS --max-time 180 -X POST "http://127.0.0.1:${PORT}/api/embed" \
        -H 'content-type: application/json' \
        -d "{\"model\":\"${MODEL}\",\"input\":[\"WorkPivot 安装自检，仅包含合成文本。\"],\"truncate\":false,\"keep_alive\":\"5m\"}" 2>&1) || {
    warn "自检请求失败：$out"
    return 1
  }
  if command -v node >/dev/null 2>&1; then
    dims=$(printf '%s' "$out" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=j.embeddings?.[0];console.log(Array.isArray(v)?v.length:'0')}catch{console.log('0')}})")
  elif command -v python3 >/dev/null 2>&1; then
    dims=$(printf '%s' "$out" | python3 -c "import sys,json
try:
    j=json.load(sys.stdin)
    v=j.get('embeddings',[None])[0]
    print(len(v) if isinstance(v,list) else 0)
except Exception:
    print(0)")
  else
    warn '缺少 node/python3，跳过维度校验'
    return 0
  fi
  if [ "$dims" = "$DIMS" ]; then
    log "自检通过：向量维度 $dims"
    return 0
  fi
  warn "自检失败：返回维度 $dims，期望 $DIMS。请核对后台草稿的维度设置"
  return 1
}

install() {
  mkdir -p "$STATE_DIR"
  need_docker
  ensure_network
  ensure_image
  ensure_container
  wait_ready
  ensure_model
  verify || warn '服务已启动，但接口自检未通过，请按上面的提示核对'
  cat <<EOF

完成。剩余步骤在后台页面操作（脚本不代替人工确认）：
  1. 打开 ${UI_URL} ，用管理员登录
  2. 设置 → 向量服务，找到「本地 BGE-M3」草稿
  3. 地址保持 http://embedding:11434，协议 ollama，模型 bge-m3，维度 1024
  4. 点「测试连接」，成功后点「启动构建」
  5. 启动后才会对已解析的资料切分并生成向量；当前 0 分片是因为还没有已解析文档

运维：
  状态  bash $0 status
  日志  bash $0 logs
  停止  bash $0 stop
EOF
}

status() {
  need_docker
  echo "网络：$NETWORK  $(network_exists && echo 存在 || echo 缺失)"
  echo "镜像：$IMAGE  $(image_exists && echo 存在 || echo 缺失)"
  if container_exists; then
    docker ps -a --filter "name=^${CONTAINER}$" --format '容器：{{.Names}}  {{.Status}}  {{.Ports}}'
    echo '已装模型：'
    docker exec "$CONTAINER" ollama list 2>/dev/null || echo '  （容器未就绪）'
    if container_running; then verify || true; fi
  else
    echo '容器：未创建'
  fi
}

logs() {
  [ -f "$LOG_FILE" ] || { echo "没有安装日志：$LOG_FILE"; exit 0; }
  tail -n 40 -f "$LOG_FILE"
}

stop() {
  need_docker
  container_exists || { echo '容器不存在'; exit 0; }
  docker stop "$CONTAINER" >/dev/null && echo "已停止：$CONTAINER"
}

uninstall() {
  need_docker
  local purge=0
  [ "${1:-}" = '--purge' ] && purge=1
  if container_exists; then
    docker rm -f "$CONTAINER" >/dev/null && echo "已删除容器：$CONTAINER"
  fi
  if [ "$purge" = 1 ]; then
    docker volume rm "$VOLUME" >/dev/null 2>&1 && echo "已删除模型卷：$VOLUME"
  else
    echo "模型卷保留：$VOLUME（加 --purge 可删除）"
  fi
  echo '提醒：后台那条向量空间草稿仍在，需要时在页面上删除或保留。'
}

# ---------- 入口 ----------
case "${1:-install}" in
  install)
    if [ "${2:-}" = '--background' ]; then
      mkdir -p "$STATE_DIR"
      if [ "${WORKPIVOT_EMBEDDING_BG:-0}" = '1' ]; then
        install
        exit $?
      fi
      WORKPIVOT_EMBEDDING_BG=1 nohup bash "$0" install >>"$LOG_FILE" 2>&1 &
      echo "已在后台安装，pid=$!"
      echo "日志：$LOG_FILE"
      echo "查看进度：bash $0 logs"
      exit 0
    fi
    install
    ;;
  status)    status ;;
  logs)      logs ;;
  stop)      stop ;;
  uninstall) uninstall "${2:-}" ;;
  *)
    echo "用法：$0 [install [--background] | status | logs | stop | uninstall [--purge]]" >&2
    exit 2
    ;;
esac
