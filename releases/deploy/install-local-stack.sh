#!/usr/bin/env bash
#
# WorkPivot 本地一体化栈安装器（单命令、幂等）
#
# 一次装齐：PostgreSQL + 服务端 + Playwright 浏览器服务 + 宿主机 Skill 执行 Worker
#          + 隔离执行器（OCR、PDF、LibreOffice）+ PostgreSQL 对话存储
#          + 内置 Office 技能（含 PPT）+ 默认记忆/专家模板
#
# 默认部署形态与 releases/deploy/compose.local-current.yml 一致，但额外包含浏览器与 Worker，
# 因此安装完成后工具集里同时有 web_fetch、browser_visit、execute_skill、load_skill。
#
# 用法（在 WSL 内、仓库根目录执行）：
#   bash releases/deploy/install-local-stack.sh                     # 默认：项目 workpivot-stack，端口 39990，数据 ~/workpivot-stack
#   bash releases/deploy/install-local-stack.sh --port 39992        # 换端口
#   bash releases/deploy/install-local-stack.sh --rebuild           # 强制重建镜像
#   bash releases/deploy/install-local-stack.sh --auto-admin        # 自动创建管理员并打印密码
#   bash releases/deploy/install-local-stack.sh --minimal           # 精简模式，不装 LibreOffice/OCR 和 chat 存储
#   bash releases/deploy/install-local-stack.sh --seed-only         # 只重跑技能/模板发布与加载
#
# 可覆盖的环境变量：STACK_PROJECT / STACK_PORT / STACK_DATA_DIR / STACK_WORKER_PORT
#                    STACK_ADMIN_USER / STACK_SERVER_IMAGE / STACK_BROWSER_IMAGE
#
# 幂等与安全：
#   - 已存在的凭据不重新生成；数据卷不删除；已有数据库不做迁移以外的改动
#   - 重复执行只补齐缺失部分（镜像、容器、技能、模板、技能加载）
#   - 所有凭据写入 0600 文件，令牌规则 32 位以上；不把任何密钥写入仓库或日志

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/compose.local-stack.yml"
LOAD_SKILLS_SCRIPT="$SCRIPT_DIR/local-stack-load-skills.mts"

PROJECT="${STACK_PROJECT:-workpivot-stack}"
PORT="${STACK_PORT:-39990}"
WORKER_PORT="${STACK_WORKER_PORT:-39993}"
DATA_DIR="${STACK_DATA_DIR:-$HOME/$PROJECT}"
ADMIN_USER="${STACK_ADMIN_USER:-admin}"
SERVER_IMAGE="${STACK_SERVER_IMAGE:-workpivot-server:local-stack}"
BROWSER_IMAGE="${STACK_BROWSER_IMAGE:-workpivot-browser:local-stack}"
EXECUTOR_IMAGE="${STACK_EXECUTOR_IMAGE:-workpivot-executor:local-stack}"
APK_MIRROR="${APK_MIRROR:-https://mirrors.aliyun.com/alpine}"
REBUILD=0
SEED_ONLY=0
AUTO_ADMIN=0
OFFICE_CONVERT=1
CHAT_STORE=1

NETWORK="${PROJECT}_net"
ENV_FILE="$DATA_DIR/stack.env"
WORKER_DIR="$DATA_DIR/worker"

log()  { printf '\n\033[1m[%s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\n失败：%s\n' "$*" >&2; exit 1; }

usage() { awk 'NR > 2 && /^#/ { sub(/^# ?/, ""); print; next } NR > 2 { exit }' "${BASH_SOURCE[0]}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --project)    PROJECT="$2"; NETWORK="${PROJECT}_net"; shift 2 ;;
    --port)       PORT="$2"; shift 2 ;;
    --data-dir)   DATA_DIR="$2"; ENV_FILE="$DATA_DIR/stack.env"; WORKER_DIR="$DATA_DIR/worker"; shift 2 ;;
    --worker-port) WORKER_PORT="$2"; shift 2 ;;
    --rebuild)    REBUILD=1; shift ;;
    --seed-only)  SEED_ONLY=1; shift ;;
    --auto-admin) AUTO_ADMIN=1; shift ;;
    # 兼容旧调用；完整能力现在已是默认值。
    --with-office-convert) OFFICE_CONVERT=1; shift ;;
    --with-chat-store) CHAT_STORE=1; shift ;;
    --without-office-convert) OFFICE_CONVERT=0; shift ;;
    --without-chat-store) CHAT_STORE=0; shift ;;
    --minimal) OFFICE_CONVERT=0; CHAT_STORE=0; shift ;;
    --admin-user) ADMIN_USER="$2"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

# ---------- 工具函数 ----------
compose() { docker compose --env-file "$ENV_FILE" -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

load_env() {
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

random_hex() { openssl rand -hex "$1"; }

image_exists() { docker image inspect "$1" >/dev/null 2>&1; }

executor_image_ready() {
  local expected_base actual_base checks
  expected_base="$(docker image inspect "$SERVER_IMAGE" --format '{{.Id}}')"
  actual_base="$(docker image inspect "$EXECUTOR_IMAGE" --format '{{index .Config.Labels "org.workpivot.base-image-id"}}' 2>/dev/null || true)"
  [ "$actual_base" = "$expected_base" ] || return 1
  checks='command -v python3 >/dev/null && command -v pdftoppm >/dev/null && command -v tesseract >/dev/null'
  if [ "$OFFICE_CONVERT" = 1 ]; then
    checks="$checks && command -v libreoffice >/dev/null && command -v soffice >/dev/null"
  fi
  docker run --rm --entrypoint sh "$EXECUTOR_IMAGE" -lc "$checks" >/dev/null 2>&1
}

network_gateway() {
  docker network inspect "$NETWORK" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
}

wait_http() {
  local url="$1" tries="${2:-40}"
  for _ in $(seq 1 "$tries"); do
    if curl -sf --max-time 3 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# ---------- 0. 预检 ----------
preflight() {
  log '0/7 预检'
  command -v docker >/dev/null || die '缺少 docker'
  docker compose version >/dev/null 2>&1 || die '缺少 docker compose 插件'
  command -v openssl >/dev/null || die '缺少 openssl（用于生成令牌）'
  command -v curl >/dev/null || die '缺少 curl'
  [ -f "$COMPOSE_FILE" ] || die "缺少编排文件：$COMPOSE_FILE"
  [ -f "$LOAD_SKILLS_SCRIPT" ] || die "缺少技能加载脚本：$LOAD_SKILLS_SCRIPT"
  # 重复安装时端口被同一 Compose 项目占用是正常状态；其他进程占用仍应拒绝。
  if [ "$SEED_ONLY" != 1 ] && command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q "127.0.0.1:$PORT "; then
    local existing_project
    existing_project="$(docker inspect workpivot-server --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
    if [ "$existing_project" != "$PROJECT" ]; then
      die "端口 $PORT 已被其他进程或项目占用；请用 --port 指定其他端口"
    fi
    info "检测到同一项目的运行实例，将执行增量更新"
  fi
  info "项目：$PROJECT   端口：$PORT   数据目录：$DATA_DIR"
}

# ---------- 1. 准备凭据与配置 ----------
prepare_env() {
  log '1/7 准备受保护配置'
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  if [ -f "$ENV_FILE" ]; then
    chmod 600 "$ENV_FILE"
    info "沿用已有配置：$ENV_FILE"
  else
    umask 077
    {
      echo "DATABASE_APP_PASSWORD=$(random_hex 24)"
      echo "DATABASE_AUTH_PASSWORD=$(random_hex 24)"
      echo "DATABASE_ADMIN_PASSWORD=$(random_hex 24)"
      echo "WORKPIVOT_ADMIN_INIT_TOKEN=$(random_hex 24)"
      echo "WORKPIVOT_SECRET_KEY=$(random_hex 32)"
      echo "WORKPIVOT_BROWSER_TOKEN=$(random_hex 32)"
      echo "WORKPIVOT_WORKER_TOKEN=$(random_hex 32)"
      echo "SEARXNG_SECRET=$(random_hex 24)"
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    info '已生成新凭据'
  fi
  # 兼容旧安装：已有 stack.env 时补上 SearXNG 密钥，避免升级后缺变量起不来。
  if ! grep -q '^SEARXNG_SECRET=' "$ENV_FILE" 2>/dev/null; then
    echo "SEARXNG_SECRET=$(random_hex 24)" >> "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi

  # 计算值每次重写，保证换端口/网络后仍然一致
  sed -i '/^STACK_NETWORK=/d;/^STACK_PORT=/d;/^WORKPIVOT_WORKER_URL=/d;/^STACK_SERVER_IMAGE=/d;/^STACK_BROWSER_IMAGE=/d;/^WORKPIVOT_SEARCH_PROVIDER=/d;/^WORKPIVOT_SEARCH_URL=/d' "$ENV_FILE" 2>/dev/null || true
  {
    echo "STACK_NETWORK=$NETWORK"
    echo "STACK_PORT=$PORT"
    echo "STACK_SERVER_IMAGE=$SERVER_IMAGE"
    echo "STACK_BROWSER_IMAGE=$BROWSER_IMAGE"
    # 内置 SearXNG：需要离线搜索时把这两个变量清空即可关闭 web_search。
    echo "WORKPIVOT_SEARCH_PROVIDER=${WORKPIVOT_SEARCH_PROVIDER:-searxng}"
    echo "WORKPIVOT_SEARCH_URL=${WORKPIVOT_SEARCH_URL:-http://searxng:8080}"
  } >> "$ENV_FILE"
  load_env
  info '凭据已就绪（0600）'
}

# ---------- 2. 网络 ----------
prepare_network() {
  log '2/7 准备 Docker 网络'
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then
    info "网络已存在：$NETWORK"
  else
    docker network create --label "workpivot.stack=$PROJECT" "$NETWORK" >/dev/null
    info "已创建网络：$NETWORK"
  fi
  local gateway
  gateway="$(network_gateway)"
  [ -n "$gateway" ] || die "无法获取网络 $NETWORK 的网关地址"
  STACK_GATEWAY="$gateway"
  WORKER_URL="http://$gateway:$WORKER_PORT"
  grep -q '^WORKPIVOT_WORKER_URL=' "$ENV_FILE" && sed -i "/^WORKPIVOT_WORKER_URL=/d" "$ENV_FILE"
  echo "WORKPIVOT_WORKER_URL=$WORKER_URL" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  load_env
  info "网关：$gateway   Worker：$WORKER_URL"
}

# ---------- 3. 镜像 ----------
build_images() {
  log '3/7 准备镜像'
  if [ "$REBUILD" = 1 ] || ! image_exists "$SERVER_IMAGE"; then
    info "构建服务端镜像：$SERVER_IMAGE"
    docker build -f "$SCRIPT_DIR/Dockerfile.local-stack-server" -t "$SERVER_IMAGE" "$REPO_ROOT/code"
  else
    info "服务端镜像已存在：$SERVER_IMAGE"
  fi

  if [ "$REBUILD" = 1 ] || ! image_exists "$BROWSER_IMAGE"; then
    info "构建浏览器镜像：$BROWSER_IMAGE"
    docker build -f "$SCRIPT_DIR/Dockerfile.local-stack-browser" -t "$BROWSER_IMAGE" "$REPO_ROOT/code"
  else
    info "浏览器镜像已存在：$BROWSER_IMAGE"
  fi

  if [ "$REBUILD" = 1 ] || ! executor_image_ready; then
    info "构建执行器镜像：$EXECUTOR_IMAGE（转 PDF：$([ "$OFFICE_CONVERT" = 1 ] && echo 启用 || echo 未启用)）"
    local ctx base_id
    ctx="$(mktemp -d)"
    base_id="$(docker image inspect "$SERVER_IMAGE" --format '{{.Id}}')"
    docker build --build-arg "BASE_IMAGE=$SERVER_IMAGE" --build-arg "BASE_IMAGE_ID=$base_id" \
      --build-arg "WITH_OFFICE_CONVERT=$OFFICE_CONVERT" --build-arg "APK_MIRROR=$APK_MIRROR" \
      -f "$SCRIPT_DIR/Dockerfile.local-stack-executor" -t "$EXECUTOR_IMAGE" "$ctx" \
      || die "执行器镜像构建失败；完整安装已中止，不会用缺少文档能力的服务端镜像冒充执行器"
    rmdir "$ctx" 2>/dev/null || true
  else
    info "执行器镜像已就绪：$EXECUTOR_IMAGE"
  fi

  # SearXNG：联网搜索的内置后端；拉不到不影响安装，只关闭 web_search。
  if ! image_exists 'searxng/searxng:latest'; then
    info '拉取 SearXNG 镜像（联网搜索）'
    docker pull searxng/searxng:latest \
      || die 'SearXNG 镜像拉取失败；完整安装已中止'
  fi
}

# ---------- 4. Worker ----------
start_worker() {
  log '4/7 启动 Skill 执行 Worker'
  if curl -sf --max-time 3 -H "Authorization: Bearer $WORKPIVOT_WORKER_TOKEN" "http://$STACK_GATEWAY:$WORKER_PORT/v1/health" >/dev/null 2>&1; then
    info 'Worker 已在运行'
    return 0
  fi
  mkdir -p "$WORKER_DIR"
  chmod 700 "$WORKER_DIR"
  cat > "$WORKER_DIR/run-worker.sh" <<EOF
#!/usr/bin/env bash
cd "$REPO_ROOT" || exit 1
export WORKPIVOT_WORKER_BIND="$STACK_GATEWAY"
export WORKPIVOT_WORKER_PORT=$WORKER_PORT
export WORKPIVOT_WORKER_TOKEN="$WORKPIVOT_WORKER_TOKEN"
export WORKPIVOT_WORKER_IMAGE="$EXECUTOR_IMAGE"
export WORKPIVOT_WORKER_STATE_DIR="$WORKER_DIR"
exec /usr/bin/node "$REPO_ROOT/code/scripts/skill-worker.mjs"
EOF
  chmod 700 "$WORKER_DIR/run-worker.sh"
  setsid nohup "$WORKER_DIR/run-worker.sh" > "$WORKER_DIR/worker.log" 2>&1 < /dev/null &
  # Worker 的 /v1/health 也需要令牌，不能用匿名请求探测
  local up=0
  for _ in $(seq 1 30); do
    if curl -sf --max-time 3 -H "Authorization: Bearer $WORKPIVOT_WORKER_TOKEN" \
         "http://$STACK_GATEWAY:$WORKER_PORT/v1/health" >/dev/null 2>&1; then up=1; break; fi
    sleep 1
  done
  if [ "$up" = 1 ]; then
    info "Worker 已启动并健康：$STACK_GATEWAY:$WORKER_PORT"
  else
    tail -20 "$WORKER_DIR/worker.log" 2>/dev/null || true
    die 'Worker 启动失败'
  fi
  info "自启脚本：$WORKER_DIR/run-worker.sh（WSL 重启后需重新执行）"
}

# ---------- 5. 数据库与服务 ----------
bootstrap_database() {
  log '5/7 启动数据库并在需要时初始化'
  compose up -d --wait --wait-timeout 180 database
  local db_container
  db_container="$(compose ps -q database)"

  local has_schema
  has_schema="$(docker exec "$db_container" psql -U workpivot_schema -d workpivot -At -c "SELECT to_regclass('workpivot.tasks') IS NOT NULL")"

  if [ "$has_schema" = "t" ]; then
    info '数据库已初始化，跳过建库与迁移'
    return 0
  fi

  info '空库：创建运行角色'
  for pair in "workpivot_app:$DATABASE_APP_PASSWORD" "workpivot_auth:$DATABASE_AUTH_PASSWORD"; do
    local role="${pair%%:*}" password="${pair#*:}"
    docker exec "$db_container" psql -U workpivot_schema -d postgres -v ON_ERROR_STOP=1 -At \
      -c "CREATE ROLE $role LOGIN PASSWORD '$password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS" >/dev/null
  done

  info '执行 schema 迁移'
  local schema_env
  schema_env="$(mktemp)"
  chmod 600 "$schema_env"
  printf 'WORKPIVOT_DATABASE_ADMIN_URL=%s\n' \
    "postgresql://workpivot_schema:${DATABASE_ADMIN_PASSWORD}@database:5432/workpivot" > "$schema_env"
  docker run --rm --network "$NETWORK" --env-file "$schema_env" \
    "$SERVER_IMAGE" ./node_modules/.bin/tsx scripts/postgres-schema.mts
  rm -f "$schema_env"

  info '初始化文件卷权限'
  docker run --rm --user 0 --cap-add CHOWN --cap-add FOWNER \
    -v "${PROJECT}_files:/data/files" "$SERVER_IMAGE" \
    node -e "const fs=require('fs');fs.mkdirSync('/data/files',{recursive:true});if(fs.readdirSync('/data/files').length)throw Error('文件卷必须为空');fs.chownSync('/data/files',1000,1000);fs.chmodSync('/data/files',0o700);"
}

start_stack() {
  log '5/7 启动整套服务'
  compose up -d --wait --wait-timeout 240
  local gateway_ok=0
  for _ in $(seq 1 60); do
    if curl -sf --max-time 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then gateway_ok=1; break; fi
    sleep 1
  done
  [ "$gateway_ok" = 1 ] || die "服务未就绪：http://127.0.0.1:$PORT/api/health"
  info "服务端就绪：http://127.0.0.1:$PORT/"
  info "浏览器服务就绪：composition 内 browser:39991（不对外暴露）"
}

# ---------- 5b. 可选：对话消息入库（R007） ----------
# 应用自身不建表：这里用管理员连接创建 chat schema 与受限角色，然后把运行时连接串写进 stack.env。
install_chat_store() {
  log '5b/7 安装 chat 存储（R007）'
  local chat_pw chat_env
  chat_pw="$(printf '%s' "${WORKPIVOT_CHAT_DATABASE_URL:-}" \
    | sed -n 's#^postgresql://workpivot_chat:\([^@]*\)@database:5432/workpivot$#\1#p')"
  [ -n "$chat_pw" ] || chat_pw="$(random_hex 24)"
  chat_env="$(mktemp)"
  chmod 600 "$chat_env"
  printf 'WORKPIVOT_CHAT_DATABASE_ADMIN_URL=%s\nWORKPIVOT_CHAT_ROLE_PASSWORD=%s\n' \
    "postgresql://workpivot_schema:${DATABASE_ADMIN_PASSWORD}@database:5432/workpivot" "$chat_pw" > "$chat_env"
  docker run --rm --network "$NETWORK" --env-file "$chat_env" \
    "$SERVER_IMAGE" ./node_modules/.bin/tsx scripts/chat-schema.mts
  rm -f "$chat_env"
  sed -i '/^WORKPIVOT_CHAT_DATABASE_URL=/d' "$ENV_FILE" 2>/dev/null || true
  echo "WORKPIVOT_CHAT_DATABASE_URL=postgresql://workpivot_chat:${chat_pw}@database:5432/workpivot" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  info 'chat schema 已就绪，运行时连接串写入 stack.env'
}

# ---------- 6. 内容：技能与模板 ----------
seed_content() {
  log '6/7 发布内置技能与默认模板'
  local server database
  server="$(compose ps -q server)"
  database="$(compose ps -q database)"
  [ -n "$server" ] || die '服务端容器未运行'
  [ -n "$database" ] || die '数据库容器未运行'

  # 技能发布必须指定管理员所有者，所以先确保账号存在
  local users
  users="$(docker exec "$database" psql -U workpivot_schema -d workpivot -At -c "SELECT count(*) FROM identity.users")"
  if [ "$users" = "0" ]; then
    if [ "$AUTO_ADMIN" = 1 ]; then
      info "自动创建管理员：$ADMIN_USER"
      local password body
      password="$(random_hex 12)"
      body=$(printf '{"username":"%s","password":"%s"}' "$ADMIN_USER" "$password")
      if curl -sf --max-time 20 -H 'content-type: application/json' -d "$body" "http://127.0.0.1:$PORT/api/auth/register" >/dev/null; then
        printf '\n  管理员账号：%s\n  初始密码：%s\n  （请登录后立即修改）\n\n' "$ADMIN_USER" "$password"
      else
        die '自动创建管理员失败；请手动注册后重跑本脚本'
      fi
    else
      printf '\n  尚未注册管理员。打开页面注册的第一个账户即为管理员；注册后重跑本脚本（或 --seed-only）即可发布并加载技能：\n'
      printf '    注册地址：http://127.0.0.1:%s/\n' "$PORT"
      return 0
    fi
  fi

  info '发布 Office 技能（含 PPT）'
  docker exec -w /app "$server" ./node_modules/.bin/tsx scripts/seed-office-skills.mts 2>&1 | tail -6
  info '发布默认记忆模板'
  docker exec -w /app "$server" ./node_modules/.bin/tsx scripts/seed-memory-templates.mts 2>&1 | tail -3
  info '发布默认专家模板'
  docker exec -w /app "$server" ./node_modules/.bin/tsx scripts/seed-expert-templates.mts 2>&1 | tail -2

  info '为管理员加载内置技能'
  local server_env
  server_env="$(mktemp)"
  chmod 600 "$server_env"
  {
    echo "WORKPIVOT_DATABASE_URL=postgresql://workpivot_app:${DATABASE_APP_PASSWORD}@database:5432/workpivot"
    echo "WORKPIVOT_AUTH_DATABASE_URL=postgresql://workpivot_auth:${DATABASE_AUTH_PASSWORD}@database:5432/workpivot"
  } > "$server_env"
  docker run --rm --network "$NETWORK" --env-file "$server_env" \
    -v "$LOAD_SKILLS_SCRIPT:/tmp/load.mts:ro" \
    --entrypoint ./node_modules/.bin/tsx "$SERVER_IMAGE" /tmp/load.mts || true
  rm -f "$server_env"
}

# ---------- 7. 验收 ----------
verify() {
  log '7/7 验收'
  local ok=0 fail=0
  check() {
    local name="$1"; shift
    if "$@" >/dev/null 2>&1; then info "✅ $name"; ok=$((ok+1)); else info "❌ $name"; fail=$((fail+1)); fi
  }

  check '服务端健康接口' curl -sf --max-time 8 "http://127.0.0.1:$PORT/api/health"
  check '首页可访问'     curl -sf --max-time 8 "http://127.0.0.1:$PORT/"
  check '浏览器服务健康' docker exec "$(compose ps -q server)" node -e "fetch('http://browser:39991/health',{signal:AbortSignal.timeout(5000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
  check '执行 Worker 健康' curl -sf --max-time 8 -H "Authorization: Bearer $WORKPIVOT_WORKER_TOKEN" "http://$STACK_GATEWAY:$WORKER_PORT/v1/health"
  check '执行器文档能力' executor_image_ready
  if [ "$CHAT_STORE" = 1 ]; then
    check '对话 PostgreSQL 存储' docker exec workpivot-database psql -U workpivot_schema -d workpivot -Atc \
      "SELECT (to_regclass('chat.tasks') IS NOT NULL AND to_regclass('chat.messages') IS NOT NULL)"
  fi

  log '部署摘要'
  info "访问地址：http://127.0.0.1:$PORT/"
  info "管理端：  http://127.0.0.1:$PORT/admin"
  info "数据目录：$DATA_DIR（凭据 $ENV_FILE，0600）"
  info "容器：    docker compose --env-file $ENV_FILE -p $PROJECT -f $COMPOSE_FILE ps"
  info "Worker：  $WORKER_DIR/run-worker.sh（WSL 重启后重跑）"
  local pdf_note='精简模式未安装'
  if [ "$OFFICE_CONVERT" = 1 ]; then pdf_note='已包含 OCR、PDF 与 LibreOffice'; fi
  info "Office 转 PDF：$pdf_note"
  local chat_note='精简模式使用文件存储'
  if [ "$CHAT_STORE" = 1 ]; then chat_note='已使用 PostgreSQL chat schema'; fi
  info "对话存储：$chat_note"
  info "重跑安装：bash releases/deploy/install-local-stack.sh --project $PROJECT --port $PORT"
  if [ "$fail" -gt 0 ]; then
    die "验收有 $fail 项失败，请查看上面的输出"
  fi
  printf '\n全部通过（%d 项）\n' "$ok"
}

# ---------- 主流程 ----------
preflight
prepare_env
prepare_network

if [ "$SEED_ONLY" = 1 ]; then
  load_env
  STACK_GATEWAY="$(network_gateway)"
  WORKER_URL="http://$STACK_GATEWAY:$WORKER_PORT"
  seed_content
  exit 0
fi

build_images
start_worker
bootstrap_database
if [ "$CHAT_STORE" = 1 ]; then install_chat_store; fi
start_stack
seed_content
verify
