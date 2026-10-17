/** 恢复快照与在线资料分离，普通检索及模型工具无法读取回收站正文。 */
export const trashSchema=`
CREATE TABLE workpivot.trash_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('project','task','document','memory','skill')),
 entity_id uuid NOT NULL,name text NOT NULL,revision uuid NOT NULL DEFAULT gen_random_uuid(),
 parent_id uuid,payload jsonb NOT NULL,files jsonb NOT NULL DEFAULT '[]',
 deleted_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_user_id,kind,entity_id)
);
ALTER TABLE workpivot.trash_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.trash_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_trash ON workpivot.trash_entries USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
CREATE INDEX trash_owner_date ON workpivot.trash_entries(owner_user_id,deleted_at);
INSERT INTO workpivot.trash_entries(owner_user_id,kind,entity_id,name,payload,deleted_at)
SELECT owner_user_id,'skill',skill_id,display_name,jsonb_build_object('name',name),deleted_at FROM workpivot.skill_drafts WHERE visibility='private' AND deleted_at IS NOT NULL;
`;
