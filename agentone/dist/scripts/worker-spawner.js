// Flow Script: Worker Spawner
// Deterministic — takes subtasks from TeamLead, spawns Worker flows.
// Respects dependencies: runs independent tasks in parallel, dependent tasks sequentially.
//
// Input:
//   dictionary.allSubtasks — array of subtasks from task-router
//   dictionary.workingDirectory — target project path
//
// Output:
//   dictionary.workerResults — results from all worker executions

import flow from 'system/flow';

const BRIDGE_URL = process.env.AGENTONE_BRIDGE_URL || process.env.BRIDGE_URL || 'http://localhost:3222';
const API_TOKEN = process.env.AGENTONE_API_TOKEN || process.env.BRIDGE_API_TOKEN || '';
const CHECKPOINT_DIR = '.keen-checkpoint';
const CHECKPOINT_STAGES = ['task-intake', 'judge', 'task-router', 'worker-spawner', 'review-loop', 'results-aggregator', 'completed'];

async function saveCheckpoint(runId, completedIds, completedResults, totalSubtasks) {
    try {
        const checkpoint = {
            runId: runId,
            lastCheckpoint: new Date().toISOString(),
            stage: 'worker-spawner',
            data: {
                jiraTasks: dictionary.jiraTasks,
                workingDirectory: dictionary.workingDirectory,
                projectContext: dictionary.projectContext,
                preferredCli: dictionary.preferredCli,
                judgeInput: dictionary.judgeInput,
                judgeOutput: dictionary['llmResponse_Agent-Judge'],
                teamLeadResults: dictionary.teamLeadResults,
                allSubtasks: dictionary.allSubtasks
            },
            workerProgress: {
                completedIds: Array.from(completedIds),
                completedResults: completedResults,
                totalSubtasks: totalSubtasks
            }
        };
        await fetch(`${BRIDGE_URL}/api/file/write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-token': API_TOKEN },
            body: JSON.stringify({
                path: `${CHECKPOINT_DIR}/pipeline-${runId}.json`,
                content: JSON.stringify(checkpoint, null, 2)
            })
        });
    } catch (e) {
        writeThinking(`Checkpoint save failed: ${e.message}`);
    }
}

export async function exec() {
    // CHECKPOINT: Skip if resuming past this stage
    const resumeFrom = dictionary.resumeFrom || 'task-intake';
    if (CHECKPOINT_STAGES.indexOf(resumeFrom) > CHECKPOINT_STAGES.indexOf('worker-spawner')) {
        writeThinking('Worker Spawner: Skipping (resumed from checkpoint)');
        return;
    }

    writeThinking('Worker Spawner: Starting worker execution...');

    const parentSessionId = dictionary.promptMessage?.userSessionCredentials?.sessionID || 'default';
    const parentUserId = dictionary.promptMessage?.userSessionCredentials?.userID || 'system';
    const allSubtasks = dictionary.allSubtasks || [];
    const workingDirectory = dictionary.workingDirectory || '';
    const runId = dictionary.runId || `pipeline_${Date.now()}`;

    if (allSubtasks.length === 0) {
        writeThinking('No subtasks to execute.');
        dictionary.workerResults = { total: 0, successful: [], failed: [] };
        return;
    }

    writeOut(`\n## Worker Execution\n\nSpawning workers for **${allSubtasks.length}** subtasks...`);

    // Restore checkpoint progress if resuming
    const restoredProgress = dictionary._checkpointWorkerProgress || null;
    const completedIds = new Set(restoredProgress?.completedIds || []);
    const results = { total: allSubtasks.length, successful: [], failed: [] };

    // Restore previously completed results
    if (restoredProgress?.completedResults) {
        const prev = restoredProgress.completedResults;
        if (prev.successful) results.successful.push(...prev.successful);
        if (prev.failed) results.failed.push(...prev.failed);
        writeThinking(`Restored ${completedIds.size} completed workers from checkpoint.`);
        writeOut(`\n*Resumed from checkpoint — ${completedIds.size} subtasks already completed.*\n`);
    }

    // Sort subtasks by order within each parent task, skip already completed
    const sorted = [...allSubtasks]
        .filter(task => !completedIds.has(task.id))
        .sort((a, b) => (a.order || 0) - (b.order || 0));

    // Group into waves: tasks whose dependencies are all met can run in parallel
    async function executeWave(remaining) {
        if (remaining.length === 0) return;

        // Find tasks whose dependencies are satisfied
        const ready = remaining.filter(task => {
            const deps = task.dependsOn || [];
            return deps.every(dep => completedIds.has(dep));
        });

        const notReady = remaining.filter(task => {
            const deps = task.dependsOn || [];
            return !deps.every(dep => completedIds.has(dep));
        });

        if (ready.length === 0 && notReady.length > 0) {
            // Circular dependency or unresolvable deps — force execute remaining
            writeThinking(`Warning: ${notReady.length} tasks have unmet dependencies. Force executing.`);
            ready.push(...notReady);
            notReady.length = 0;
        }

        writeThinking(`Wave: executing ${ready.length} tasks in parallel, ${notReady.length} waiting.`);

        // Execute this wave in parallel
        const wavePromises = ready.map(async (subtask) => {
            const subSessionId = `${parentSessionId}_w_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            writeAgentStart(parentSessionId, subSessionId, 'Worker', `${subtask.id}: ${subtask.title}`);
            writeAgentStream(subSessionId, `Using ${subtask.cliTool || 'claude'} CLI...`);

            try {
                const workerInput = JSON.stringify({
                    subtask: subtask,
                    workingDirectory: workingDirectory,
                    // Metadata flows through to cli-executor → bridge for PID tracking
                    pipelineRunId: runId,
                    agentType: 'Worker',
                    subtaskId: subtask.id,
                    parentSessionId: parentSessionId,
                    label: `Worker: ${subtask.id} — ${subtask.title}`
                });

                const result = await flow.run('Worker', {
                    promptMessage: {
                        role: 'user',
                        content: workerInput,
                        userSessionCredentials: {
                            sessionID: subSessionId,
                            userID: parentUserId
                        },
                        agentChat: false
                    }
                });

                const workerOutput = result?.['llmResponse_Agent-Worker']?.output || '';
                let parsedResult;
                try {
                    const cleaned = workerOutput.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                    parsedResult = JSON.parse(cleaned);
                } catch {
                    parsedResult = { status: 'UNKNOWN', raw: workerOutput };
                }

                if (parsedResult.status === 'SUCCESS') {
                    writeAgentStream(subSessionId, 'Completed successfully');
                    writeAgentEnd(subSessionId, 'completed');
                    completedIds.add(subtask.id);
                    results.successful.push({ ...subtask, result: parsedResult });
                } else {
                    writeAgentStream(subSessionId, `Status: ${parsedResult.status || 'UNKNOWN'}`);
                    writeAgentEnd(subSessionId, 'warning');
                    completedIds.add(subtask.id); // Mark as done even if failed to unblock dependents
                    results.failed.push({ ...subtask, result: parsedResult });
                }

                // Incremental checkpoint save after each worker completes
                await saveCheckpoint(runId, completedIds, results, allSubtasks.length);

            } catch (error) {
                writeAgentStream(subSessionId, `Error: ${error.message}`);
                writeAgentEnd(subSessionId, 'error');
                completedIds.add(subtask.id);
                results.failed.push({ ...subtask, error: error.message });

                // Save checkpoint even on failure
                await saveCheckpoint(runId, completedIds, results, allSubtasks.length);
            }
        });

        await Promise.all(wavePromises);

        // Execute next wave
        if (notReady.length > 0) {
            await executeWave(notReady);
        }
    }

    await executeWave(sorted);

    dictionary.workerResults = results;

    // CHECKPOINT: Mark this stage as done
    dictionary._checkpointStage = 'worker-spawner';

    writeThinking(`Worker Spawner complete. ${results.successful.length} succeeded, ${results.failed.length} failed.`);
}
