/**
 * 项目协作只共享项目元数据和业务事实；个人任务、私人聊天仍按 owner_user_id 隔离。
 * project_role 使用 SECURITY DEFINER 读取成员关系，避免 projects/project_members 策略递归。
 */
export const projectSharingSchema = `
CREATE FUNCTION workpivot.project_role(target_project uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,workpivot,identity AS $$
  SELECT pm.role
  FROM workpivot.project_members pm
  JOIN workpivot.projects p ON p.id=pm.project_id
  JOIN identity.users u ON u.id=pm.user_id
  WHERE pm.project_id=target_project
    AND pm.user_id=workpivot.actor_id()
    AND pm.revoked_at IS NULL
    AND p.deleted_at IS NULL
    AND NOT u.disabled
  LIMIT 1
$$;
DROP POLICY personal_projects ON workpivot.projects;
CREATE POLICY shared_projects ON workpivot.projects
  USING(owner_user_id=workpivot.actor_id() OR workpivot.project_role(id) IS NOT NULL)
  WITH CHECK(owner_user_id=workpivot.actor_id());

DROP POLICY personal_members ON workpivot.project_members;
CREATE POLICY shared_project_members ON workpivot.project_members
  USING(user_id=workpivot.actor_id() OR workpivot.project_role(project_id)='owner')
  WITH CHECK(
    (user_id=workpivot.actor_id() AND role='owner' AND EXISTS(
      SELECT 1 FROM workpivot.projects p WHERE p.id=project_id AND p.owner_user_id=workpivot.actor_id()
    ))
    OR workpivot.project_role(project_id)='owner'
  );

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'business_project_profile','business_object','business_object_identifier','business_object_alias',
    'business_fact_series','business_fact_revision','business_relation_series','business_relation_revision',
    'business_fact_evidence','business_fact_conflict','business_fact_job','business_fact_epoch',
    'business_object_merge','business_fact_import'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS personal_scope ON workpivot.%I',table_name);
    EXECUTE format('DROP POLICY IF EXISTS personal_business_object_merge ON workpivot.%I',table_name);
    EXECUTE format('DROP POLICY IF EXISTS personal_business_fact_import ON workpivot.%I',table_name);
    EXECUTE format(
      'CREATE POLICY shared_business_scope ON workpivot.%I USING(workpivot.project_role(project_id) IS NOT NULL) WITH CHECK(workpivot.project_role(project_id) IN (''owner'',''editor''))',
      table_name
    );
  END LOOP;
END $$;
`;
