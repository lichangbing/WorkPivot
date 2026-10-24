import type {Tool} from '@workpivot/core';
const read=['list_uploaded_files','read_uploaded_file','read_document_structure','list_artifacts','search_project_documents','read_document_citation','search_memory','read_memory','load_skill','search_expert_experience','list_my_skill_builds','get_skill_build','get_automation_options','list_my_schedules','get_schedule_run'];
const write=['save_artifact','propose_skill','revise_skill_draft','validate_skill_draft','propose_schedule','propose_schedule_change','pause_schedule','cancel_schedule_run'];
/** 注册由服务器控制；远端声明和工具名前缀均不能自行取得只读身份。 */
export function registerDatabaseTools(tools:Tool[],external:ReadonlySet<string>):Tool[] {
  const names=new Set<string>();
  return tools.map(tool=>{
    if(names.has(tool.name))throw Error('工具名称重复');names.add(tool.name);
    let effects:NonNullable<Tool['effects']>,resultSource:NonNullable<Tool['resultSource']>;
    if(external.has(tool.name)){effects=['network','external'];resultSource='external';if(tool.kind!=='write'||!tool.access)throw Error('外部工具缺少明确审批声明');}
    else if(['web_fetch','browser_visit','web_search'].includes(tool.name)){effects=tool.name==='browser_visit'?['network','write']:['network'];resultSource='web';}
    else if(['execute_skill','trial_skill_draft','run_code'].includes(tool.name)){effects=['execution','write'];resultSource='execution';}
    // 子代理会实际执行子工具（可能写文件/联网），按执行类登记，避免被当成纯只读。
    else if(tool.name==='delegate'){effects=['execution'];resultSource='operation';if(tool.kind!=='write')throw Error('子代理工具声明不一致');}
    else if(tool.name==='ask_user'){effects=['read'];resultSource='reference';if(tool.kind!=='read')throw Error('提问工具必须声明为只读');}
    else if(write.includes(tool.name)){effects=['write'];resultSource='operation';if(tool.kind!=='write')throw Error('写操作被错误声明为只读');}
    else if(read.includes(tool.name)){effects=['read'];resultSource='reference';if(tool.kind!=='read')throw Error('只读工具声明不一致');}
    else throw Error('工具未注册效果类别，拒绝加入模型工具集');
    return {...tool,effects,resultSource};
  });
}
/** 外层来源标签由服务端生成；返回正文不能自行宣称是用户授权或系统指令。 */
export function sourceResult(tool:Tool,result:string):string {
  if(!tool.resultSource)return result;
  let data:unknown=result;try{data=JSON.parse(result);}catch{/* 纯文本结果保留原文。 */}
  return JSON.stringify({source:{tool:tool.name,kind:tool.resultSource,trust:'reference'},data});
}
