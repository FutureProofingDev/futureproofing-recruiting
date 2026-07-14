// D1 access layer. Plain prepare/bind calls (no ORM), matching the
// remote-ready-platform / gabi-wellness-bot-cf convention already in use
// across this account.

export async function upsertCandidate(db, { ashbyApplicationId, ashbyCandidateId, pipelineKey, name, email, jobTitle, currentStage }) {
  const existing = await db.prepare(
    `SELECT * FROM candidates WHERE ashby_application_id = ?`
  ).bind(ashbyApplicationId).first();

  if (existing) {
    await db.prepare(
      `UPDATE candidates
       SET name = ?, email = ?, job_title = ?, current_stage = ?, last_polled_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    ).bind(name || existing.name, email || existing.email, jobTitle || existing.job_title, currentStage, existing.id).run();
    return { ...existing, current_stage: currentStage };
  }

  const result = await db.prepare(
    `INSERT INTO candidates
       (ashby_application_id, ashby_candidate_id, pipeline_key, name, email, job_title, current_stage, first_seen_at_trigger_stage, last_polled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(ashbyApplicationId, ashbyCandidateId || null, pipelineKey, name || null, email || null, jobTitle || null, currentStage).run();

  return getCandidateById(db, result.meta.last_row_id);
}

export async function getCandidateById(db, id) {
  return db.prepare(`SELECT * FROM candidates WHERE id = ?`).bind(id).first();
}

export async function getCandidateByApplicationId(db, ashbyApplicationId) {
  return db.prepare(`SELECT * FROM candidates WHERE ashby_application_id = ?`).bind(ashbyApplicationId).first();
}

export async function listCandidatesByPipeline(db, pipelineKey) {
  const { results } = await db.prepare(
    `SELECT * FROM candidates WHERE pipeline_key = ? ORDER BY updated_at DESC`
  ).bind(pipelineKey).all();
  return results || [];
}

export async function insertRawSnapshot(db, { candidateId, contentHash, payload }) {
  const result = await db.prepare(
    `INSERT INTO raw_snapshots (candidate_id, content_hash, payload_json) VALUES (?, ?, ?)`
  ).bind(candidateId, contentHash, JSON.stringify(payload)).run();
  return result.meta.last_row_id;
}

export async function getLatestSnapshot(db, candidateId) {
  const row = await db.prepare(
    `SELECT * FROM raw_snapshots WHERE candidate_id = ? ORDER BY fetched_at DESC LIMIT 1`
  ).bind(candidateId).first();
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload_json) };
}

export async function insertStageEvaluation(db, { candidateId, stageKey, stageName, evalType, promptVersion, model, inputHash, output, status = 'complete', errorMessage = null }) {
  const result = await db.prepare(
    `INSERT INTO stage_evaluations
       (candidate_id, stage_key, stage_name, eval_type, prompt_version, model, input_hash, output_json, status, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(candidateId, stageKey, stageName || null, evalType, promptVersion, model, inputHash, JSON.stringify(output || null), status, errorMessage).run();
  return result.meta.last_row_id;
}

// Latest row per stage_key for this candidate (the "current" evaluation).
export async function getLatestStageEvaluations(db, candidateId) {
  const { results } = await db.prepare(
    `SELECT se.* FROM stage_evaluations se
     INNER JOIN (
       SELECT stage_key, MAX(created_at) AS max_created_at
       FROM stage_evaluations WHERE candidate_id = ? GROUP BY stage_key
     ) latest ON se.stage_key = latest.stage_key AND se.created_at = latest.max_created_at
     WHERE se.candidate_id = ?
     ORDER BY se.created_at ASC`
  ).bind(candidateId, candidateId).all();
  return (results || []).map(deserializeEvaluation);
}

// Full history for one stage_key, oldest first — used for the evidence timeline.
export async function getStageEvaluationHistory(db, candidateId, stageKey) {
  const { results } = await db.prepare(
    `SELECT * FROM stage_evaluations WHERE candidate_id = ? AND stage_key = ? ORDER BY created_at ASC`
  ).bind(candidateId, stageKey).all();
  return (results || []).map(deserializeEvaluation);
}

export async function insertFinalSummary(db, { candidateId, basedOnEvaluationIds, inputHash, promptVersion, model, output, recommendation, confidence, status = 'complete', errorMessage = null }) {
  const result = await db.prepare(
    `INSERT INTO final_summaries
       (candidate_id, based_on_evaluation_ids, input_hash, prompt_version, model, output_json, recommendation, confidence, status, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(candidateId, JSON.stringify(basedOnEvaluationIds || []), inputHash, promptVersion, model, JSON.stringify(output || null), recommendation || null, confidence || null, status, errorMessage).run();
  return result.meta.last_row_id;
}

export async function getLatestFinalSummary(db, candidateId) {
  const row = await db.prepare(
    `SELECT * FROM final_summaries WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(candidateId).first();
  return row ? deserializeSummary(row) : null;
}

export async function insertManualNote(db, { candidateId, noteType, content, addedBy = null }) {
  const result = await db.prepare(
    `INSERT INTO manual_notes (candidate_id, note_type, content_json, added_by) VALUES (?, ?, ?, ?)`
  ).bind(candidateId, noteType, JSON.stringify(content), addedBy).run();
  return result.meta.last_row_id;
}

export async function getLatestManualNote(db, candidateId, noteType) {
  const row = await db.prepare(
    `SELECT * FROM manual_notes WHERE candidate_id = ? AND note_type = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(candidateId, noteType).first();
  if (!row) return null;
  return { ...row, content: JSON.parse(row.content_json) };
}

export async function getPollState(db, pipelineKey) {
  return db.prepare(`SELECT * FROM poll_state WHERE pipeline_key = ?`).bind(pipelineKey).first();
}

export async function setPollState(db, pipelineKey) {
  await db.prepare(
    `INSERT INTO poll_state (pipeline_key, last_run_at) VALUES (?, datetime('now'))
     ON CONFLICT(pipeline_key) DO UPDATE SET last_run_at = datetime('now')`
  ).bind(pipelineKey).run();
}

function deserializeEvaluation(row) {
  return { ...row, output: row.output_json ? JSON.parse(row.output_json) : null };
}

function deserializeSummary(row) {
  return {
    ...row,
    output: row.output_json ? JSON.parse(row.output_json) : null,
    basedOnEvaluationIds: row.based_on_evaluation_ids ? JSON.parse(row.based_on_evaluation_ids) : [],
  };
}
