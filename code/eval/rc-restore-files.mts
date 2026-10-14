import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pool} from '../packages/server/src/database/connection.js';
import {FileRepository} from '../packages/server/src/database/files.js';
const root=process.env.WORKPIVOT_RC_FILES_ROOT!,url=process.env.WORKPIVOT_MEMORY_TEST_URL!;
if(!root.startsWith('/tmp/workpivot-memory-check-')||new URL(url).pathname!=='/workpivot_restore_test')throw Error('Isolated restore fixture required');
const db=pool(url);
try{const fixture=JSON.parse(await readFile(root+'/fixture.json','utf8'));
assert.equal((await new FileRepository(db,root).download(fixture.actor,fixture.task,fixture.file)).data.toString(),'RC restoration fixture');
console.log('PASS restored database and separately restored file directory produce the original verified bytes');
}finally{await db.end();}
