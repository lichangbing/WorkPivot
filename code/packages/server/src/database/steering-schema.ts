/** v69：运行中用户补充/纠正，按安全步骤边界应用。 */
export const steeringSchema = `
CREATE TABLE workpivot.run_steering_messages (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  task_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES workpivot.task_runs(id),
  request_id uuid NOT NULL,
  content text NOT NULL CHECK(length(btrim(content)) BETWEEN 1 AND 20000),
  mode text NOT NULL DEFAULT 'safe' CHECK(mode IN ('safe')),
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','applied','cancelled')),
  event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE(owner_user_id,task_id,request_id),
  FOREIGN KEY(owner_user_id,task_id) REFERENCES workpivot.tasks(owner_user_id,id)
);
CREATE INDEX run_steering_pending ON workpivot.run_steering_messages(task_id,created_at,id)
  WHERE status='pending';
ALTER TABLE workpivot.run_steering_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.run_steering_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_scope ON workpivot.run_steering_messages
  USING(owner_user_id=workpivot.actor_id())
  WITH CHECK(owner_user_id=workpivot.actor_id());
CREATE TRIGGER notify_run_steering
  AFTER INSERT OR UPDATE OR DELETE ON workpivot.run_steering_messages
  FOR EACH ROW EXECUTE FUNCTION workpivot.notify_task_event();
`;
