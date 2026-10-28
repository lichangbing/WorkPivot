// 验证当前本地部署的服务端没有 Docker socket、应用数据挂载或提权能力。
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

const docker=(args)=>execFileSync('docker',args,{encoding:'utf8'}).trim();
const info=JSON.parse(docker(['inspect','workpivot-server']))[0];
assert.equal(info.HostConfig.ReadonlyRootfs,true,'服务端根文件系统必须只读');
assert.ok(info.HostConfig.CapDrop?.includes('ALL'),'服务端必须丢弃全部 Linux capabilities');
assert.ok(info.HostConfig.SecurityOpt?.some(value=>value.includes('no-new-privileges')),'服务端必须禁止提权');
assert.equal(info.Mounts.some(mount=>mount.Source?.includes('docker.sock')),false,'服务端不得挂载 Docker socket');
assert.equal(docker(['exec','workpivot-server','sh','-lc','test -e /var/run/docker.sock; echo $?']),'1','服务端容器内不得存在 Docker socket');
const executor=JSON.parse(docker(['inspect','workpivot-executor:local-stack']))[0];
assert.equal(executor.Config.User,'node','执行器必须以非 root 运行');
assert.equal(docker(['run','--rm','--network','none','--entrypoint','sh','workpivot-executor:local-stack','-lc','test ! -e /var/run/docker.sock && test ! -e /data/workpivot']),'','隔离执行器不得访问应用数据或 Docker socket');
console.log('执行边界检查通过：服务端无 socket、只读根、全量降权；执行器无应用数据访问。');
