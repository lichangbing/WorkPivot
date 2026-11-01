/** v70：区分当前任务纠正与当前任务完成后的后续请求。 */
export const steeringClassificationSchema = `
ALTER TABLE workpivot.run_steering_messages DROP CONSTRAINT run_steering_messages_status_check;
ALTER TABLE workpivot.run_steering_messages ADD CONSTRAINT run_steering_messages_status_check
  CHECK(status IN ('pending','deferred','applied','cancelled'));
ALTER TABLE workpivot.run_steering_messages ADD COLUMN relation text NOT NULL DEFAULT 'unknown'
  CHECK(relation IN ('unknown','related','unrelated'));
ALTER TABLE workpivot.run_steering_messages ADD COLUMN classification_reason text
  CHECK(classification_reason IS NULL OR length(classification_reason)<=1000);
CREATE INDEX run_steering_deferred
  ON workpivot.run_steering_messages(task_id,created_at,id)
  WHERE status='deferred';
`;
