/** 只在建议等待用户决定期间保留上下文证据。 */
export const memoryContextSchema = `
ALTER TABLE workpivot.memory_suggestions ADD COLUMN source_context jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(source_context)='array');
CREATE FUNCTION workpivot.clear_memory_suggestion_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status<>'pending' THEN NEW.source_context='[]'::jsonb; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER memory_suggestion_context BEFORE INSERT OR UPDATE ON workpivot.memory_suggestions FOR EACH ROW EXECUTE FUNCTION workpivot.clear_memory_suggestion_context();
`;
