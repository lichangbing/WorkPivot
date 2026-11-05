import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {schemaUpgrades,schemaVersion} from '../packages/server/src/database/schema.js';

const root=resolve(import.meta.dirname,'../..'),codeRoot=resolve(import.meta.dirname,'..');
const output=resolve(process.argv[2]??join(root,'local-runtime','releases','v0.3.0-rc.8'));
const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const exists=async(path:string)=>access(path,constants.R_OK).then(()=>true,()=>false);
const workspace=JSON.parse(await readFile(join(codeRoot,'package.json'),'utf8')) as {version:string};
const desktop=JSON.parse(await readFile(join(codeRoot,'apps/desktop/package.json'),'utf8')) as {version:string};
const manifestFiles=[
  'apps/web/dist/index.html',
  'apps/web/dist/admin.html',
  'apps/desktop/release/artifacts/WorkPivot-Windows-0.3.0-rc.8-portable.zip',
  'apps/mobile/android/app/build/outputs/apk/release/app-release.apk',
];
const artifacts:Record<string,{path:string;bytes:number;sha256:string}>={};
for(const relative of manifestFiles){
  const path=join(codeRoot,relative);
  if(!await exists(path))continue;
  const data=await readFile(path);
  artifacts[relative]={path:relative,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};
}
const manifest={
  format:'workpivot-release-readiness',
  version:'0.3.0-rc.8',
  generatedAt:new Date().toISOString(),
  git:{commit:git('rev-parse','HEAD'),branch:git('branch','--show-current'),clean:git('status','--porcelain')==='' },
  schema:{expected:schemaUpgrades.at(-1)?.version??schemaVersion},
  versions:{workspace:workspace.version,desktop:desktop.version,android:{versionCode:12,versionName:'1.11'}},
  supportMatrix:{
    deployment:'single-server-docker-compose',
    web:'supported',
    windows:'supported-beta-unsigned',
    android:'supported-beta-requires-physical-device',
    oidc:'optional-keycloak-validated',
    officePreview:'isolated-libreoffice-required',
    multiServer:'not-supported-until-v0.4.0',
  },
  artifacts,
  missingArtifacts:manifestFiles.filter(file=>!artifacts[file]),
  checks:{
    typecheck:'run separately and record result',
    lint:'run separately and record result',
    database:'run separately and record result',
    fullEval:'run separately and record result',
    soak24h:'required before v0.3.0 tag',
    physicalDevice:'required before v0.3.0 tag',
  },
  containsSecrets:false,
};
await mkdir(output,{recursive:true,mode:0o700});
const target=join(output,'readiness.json');
await writeFile(target,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
console.log(`发布准备清单已写入 ${target}`);
if(manifest.missingArtifacts.length)console.log(`待构建制品：${manifest.missingArtifacts.join('、')}`);
