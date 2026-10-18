import {Ajv,type ValidateFunction} from 'ajv';
/** 校验不修改参数；拒绝远端引用和异步校验，不能在校验阶段联网。 */
export function toolValidator(schema:Record<string,unknown>):(args:Record<string,unknown>)=>void {
  let validate:ValidateFunction|undefined;
  return args=>{
    if(!validate){
      const stack:[unknown,number][]=[[schema,0]];
      while(stack.length){const [value,depth]=stack.pop()!;if(depth>32)throw Error('工具参数定义嵌套过深');if(value&&typeof value==='object'){for(const [key,item] of Object.entries(value)){if(key==='$async'||key==='$ref'&&typeof item==='string'&&!item.startsWith('#'))throw Error('工具定义不允许异步校验或外部引用');stack.push([item,depth+1]);}}}
      if(JSON.stringify(schema).length>65536)throw Error('工具参数定义过大');
      try{validate=new Ajv({strict:true,strictTypes:false,allowUnionTypes:true,coerceTypes:false,useDefaults:false,removeAdditional:false,logger:false,ownProperties:true}).compile(schema);}
      catch{throw Error('工具参数定义不受支持，请修正定义后重试');}
    }
    if(!validate(args)){const error=validate.errors?.[0];throw Error(`工具参数不符合定义：${error?.instancePath||'/'} ${error?.keyword??'invalid'}`);}
  };
}
