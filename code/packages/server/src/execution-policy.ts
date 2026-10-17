import { listTenants } from './tenants.js';
import { currentTenant } from '@workpivot/shared/node';
import type { Tool } from '@workpivot/core';

export type ExecutionMode = 'disabled' | 'docker' | 'worker' | 'trusted-local';

/** 须显式启用；生产环境禁止降级为宿主命令执行。 */
export function executionMode(env: NodeJS.ProcessEnv = process.env): ExecutionMode {
  if (env['WORKPIVOT_EXECUTION_MODE'] === 'worker' && env['WORKPIVOT_WORKER_URL'] && env['WORKPIVOT_WORKER_TOKEN']) return 'worker';
  if (currentTenant()?.userId || (currentTenant() && listTenants().length > 1)) return 'disabled';
  if (env['WORKPIVOT_EXECUTION_MODE'] === 'docker') return 'docker';
  if (env['WORKPIVOT_EXECUTION_MODE'] === 'trusted-local' && env['NODE_ENV'] !== 'production') return 'trusted-local';
  return 'disabled';
}

export function availableTools(tools: Tool[], mode: ExecutionMode): Tool[] {
  return mode === 'disabled' ? tools.filter((tool) => tool.kind !== 'bash') : tools;
}

export function executionGuidance(mode: ExecutionMode): string {
  if (mode === 'worker') return '\n# 技能执行环境\n命令由主机执行服务放入一次性Linux隔离容器运行，工作目录/workspace是任务目录副本，使用相对路径和POSIX shell。已load_skill或斜杠激活的技能资源只读挂载在/skills/<技能名>/，可运行其中脚本、读取二进制模板。预装Node.js，NODE_PATH=/app/packages/server/node_modules；其他依赖须由部署管理员预装，不能联网安装。无网络、最长120秒、单任务输入/技能资源合计16MiB，产物最多16MiB；不保留后台进程。仅成功、通过权限及文件冲突检查后回写产物，失败不回写。';
  if (mode === 'disabled') return '\n# 当前可用能力\n后台未启用脚本和命令执行，不能运行 Python、Node.js、shell 或安装依赖。可使用已提供的文件工具读写文本、Markdown、CSV。需要执行脚本才能生成的 Word、Excel、PPT 文件暂不可生成；请明确说明限制并提供内容草稿，不得把文本改扩展名冒充办公文件，也不得声称执行了命令。技能中的命令步骤同样受此限制。';
  if (mode === 'docker') return '\n命令在独立 Linux 容器的 /workspace 副本中运行，使用 POSIX shell 和相对路径。无网络；预装 Node.js 及文档库（NODE_PATH）。只有执行成功且通过权限与冲突检查的普通文件变更才回写项目，后台进程不会保留。';
  return '\n命令在开发环境本机运行。';
}
