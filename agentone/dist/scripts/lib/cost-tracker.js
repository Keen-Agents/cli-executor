// @ts-check

import { mkdir, writeFile } from 'fs/promises';
import { resolve } from 'path';

const COST_SUMMARY_FILE = 'cost-summary.json';

export const DEFAULT_PROFILE_BUDGETS_USD = {
    simple: { soft: 12, hard: 15 },
    standard: { soft: 48, hard: 60 },
    complex: { soft: 120, hard: 150 }
};

export class CostTracker {
    /**
     * @param {string} runDir
     * @param {{soft?: number, hard?: number, profile?: 'simple' | 'standard' | 'complex'} | undefined} budgets
     */
    constructor(runDir, budgets = undefined) {
        this.runDir = runDir;
        this.budgets = normalizeBudgets(budgets);
        /** @type {Record<string, {
         * calls: Array<{
         * model: string,
         * inputTokens: number,
         * outputTokens: number,
         * cacheReadTokens: number,
         * cacheWriteTokens: number,
         * costUsd: number,
         * durationMs: number,
         * label: string,
         * timestamp: string
         * }>,
         * totalCost: number,
         * totalInputTokens: number,
         * totalOutputTokens: number,
         * totalCacheReadTokens: number,
         * totalCacheWriteTokens: number,
         * totalDurationMs: number
         * }>} */
        this.stages = {};

        this.totalCost = 0;
        this.totalCalls = 0;
        this.totalInputTokens = 0;
        this.totalOutputTokens = 0;
        this.totalCacheReadTokens = 0;
        this.totalCacheWriteTokens = 0;
    }

    /**
     * @param {string} stageName
     * @param {{
     * model?: string,
     * inputTokens?: number,
     * outputTokens?: number,
     * cacheReadTokens?: number,
     * cacheWriteTokens?: number,
     * costUsd?: number,
     * durationMs?: number,
     * label?: string
     * }} callData
     */
    recordCall(stageName, callData) {
        if (!stageName || typeof stageName !== 'string') {
            throw new Error('recordCall(stageName, callData): stageName must be a non-empty string');
        }

        const safe = {
            model: toStringSafe(callData?.model, 'unknown'),
            inputTokens: toNumberSafe(callData?.inputTokens),
            outputTokens: toNumberSafe(callData?.outputTokens),
            cacheReadTokens: toNumberSafe(callData?.cacheReadTokens),
            cacheWriteTokens: toNumberSafe(callData?.cacheWriteTokens),
            costUsd: toNumberSafe(callData?.costUsd),
            durationMs: toNumberSafe(callData?.durationMs),
            label: toStringSafe(callData?.label, ''),
            timestamp: new Date().toISOString()
        };

        if (!this.stages[stageName]) {
            this.stages[stageName] = {
                calls: [],
                totalCost: 0,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCacheReadTokens: 0,
                totalCacheWriteTokens: 0,
                totalDurationMs: 0
            };
        }

        const stage = this.stages[stageName];
        stage.calls.push(safe);
        stage.totalCost += safe.costUsd;
        stage.totalInputTokens += safe.inputTokens;
        stage.totalOutputTokens += safe.outputTokens;
        stage.totalCacheReadTokens += safe.cacheReadTokens;
        stage.totalCacheWriteTokens += safe.cacheWriteTokens;
        stage.totalDurationMs += safe.durationMs;

        this.totalCost += safe.costUsd;
        this.totalCalls += 1;
        this.totalInputTokens += safe.inputTokens;
        this.totalOutputTokens += safe.outputTokens;
        this.totalCacheReadTokens += safe.cacheReadTokens;
        this.totalCacheWriteTokens += safe.cacheWriteTokens;

        return this.getStageCost(stageName);
    }

    /**
     * @param {string} stageName
     */
    getStageCost(stageName) {
        const stage = this.stages[stageName];
        if (!stage) {
            return {
                calls: 0,
                totalCost: 0,
                totalInputTokens: 0,
                totalOutputTokens: 0
            };
        }

        return {
            calls: stage.calls.length,
            totalCost: roundCurrency(stage.totalCost),
            totalInputTokens: stage.totalInputTokens,
            totalOutputTokens: stage.totalOutputTokens
        };
    }

    getRunCost() {
        const stages = {};
        for (const stageName of Object.keys(this.stages)) {
            stages[stageName] = this.getStageCost(stageName);
        }

        const budget = this.checkBudget();

        return {
            stages,
            totalCost: roundCurrency(this.totalCost),
            totalCalls: this.totalCalls,
            budgetStatus: budget.status
        };
    }

    checkBudget() {
        const spent = roundCurrency(this.totalCost);

        let status = 'ok';
        if (spent >= this.budgets.hard) {
            status = 'exceeded';
        } else if (spent >= this.budgets.soft) {
            status = 'warning';
        }

        return {
            ok: status !== 'exceeded',
            status,
            remaining: roundCurrency(this.budgets.hard - spent),
            spent
        };
    }

    async save() {
        const summary = {
            budgets: this.budgets,
            budget: this.checkBudget(),
            totals: {
                costUsd: roundCurrency(this.totalCost),
                calls: this.totalCalls,
                inputTokens: this.totalInputTokens,
                outputTokens: this.totalOutputTokens,
                cacheReadTokens: this.totalCacheReadTokens,
                cacheWriteTokens: this.totalCacheWriteTokens
            },
            stages: this.stages,
            runCost: this.getRunCost(),
            updatedAt: new Date().toISOString()
        };

        const filePath = resolve(this.runDir, COST_SUMMARY_FILE);
        await mkdir(this.runDir, { recursive: true });
        await writeFile(filePath, JSON.stringify(summary, null, 2), 'utf8');

        return summary;
    }

    /**
     * Extract a call data payload from agent-runner output.
     * Handles common Claude and Codex JSON shapes plus normalized runner output.
     *
     * @param {any} result
     * @returns {{
     * model: string,
     * inputTokens: number,
     * outputTokens: number,
     * cacheReadTokens: number,
     * cacheWriteTokens: number,
     * costUsd: number,
     * durationMs: number,
     * label: string
     * }}
     */
    static fromAgentResult(result) {
        const parsed = result?.parsedJson && typeof result.parsedJson === 'object' ? result.parsedJson : null;
        const usage = pickObject(result?.usage, parsed?.usage, parsed?.response?.usage, result?.response?.usage);

        return {
            model: toStringSafe(
                pickValue(
                    result?.model,
                    parsed?.model,
                    parsed?.model_name,
                    result?.response?.model,
                    parsed?.response?.model
                ),
                'unknown'
            ),
            inputTokens: toNumberSafe(
                pickValue(
                    result?.inputTokens,
                    parsed?.inputTokens,
                    parsed?.input_tokens,
                    usage?.inputTokens,
                    usage?.input_tokens,
                    usage?.prompt_tokens,
                    result?.tokenUsage?.inputTokens,
                    result?.tokenUsage?.input,
                    result?.promptTokens
                )
            ),
            outputTokens: toNumberSafe(
                pickValue(
                    result?.outputTokens,
                    parsed?.outputTokens,
                    parsed?.output_tokens,
                    usage?.outputTokens,
                    usage?.output_tokens,
                    usage?.completion_tokens,
                    result?.tokenUsage?.outputTokens,
                    result?.tokenUsage?.output,
                    result?.completionTokens
                )
            ),
            cacheReadTokens: toNumberSafe(
                pickValue(
                    result?.cacheReadTokens,
                    parsed?.cacheReadTokens,
                    parsed?.cache_read_tokens,
                    usage?.cacheReadTokens,
                    usage?.cache_read_tokens,
                    usage?.cache_read_input_tokens,
                    result?.tokenUsage?.cacheReadTokens,
                    result?.tokenUsage?.cacheReadInputTokens
                )
            ),
            cacheWriteTokens: toNumberSafe(
                pickValue(
                    result?.cacheWriteTokens,
                    parsed?.cacheWriteTokens,
                    parsed?.cache_write_tokens,
                    usage?.cacheWriteTokens,
                    usage?.cache_write_tokens,
                    usage?.cache_creation_input_tokens,
                    result?.tokenUsage?.cacheWriteTokens,
                    result?.tokenUsage?.cacheCreationInputTokens
                )
            ),
            costUsd: roundCurrency(
                toNumberSafe(
                    pickValue(
                        result?.costUsd,
                        result?.totalCostUsd,
                        result?.total_cost_usd,
                        parsed?.costUsd,
                        parsed?.cost_usd,
                        parsed?.totalCostUsd,
                        parsed?.total_cost_usd,
                        usage?.costUsd,
                        usage?.cost_usd,
                        usage?.total_cost_usd
                    )
                )
            ),
            durationMs: toNumberSafe(
                pickValue(
                    result?.durationMs,
                    result?.duration_ms,
                    parsed?.durationMs,
                    parsed?.duration_ms,
                    result?.metrics?.durationMs,
                    parsed?.metrics?.durationMs
                )
            ),
            label: toStringSafe(
                pickValue(result?.label, parsed?.label, result?.metadata?.label),
                ''
            )
        };
    }
}

function normalizeBudgets(budgets) {
    if (budgets?.profile && DEFAULT_PROFILE_BUDGETS_USD[budgets.profile]) {
        return { ...DEFAULT_PROFILE_BUDGETS_USD[budgets.profile] };
    }

    const hard = toNumberSafe(budgets?.hard);
    const soft = toNumberSafe(budgets?.soft);

    if (hard > 0 && soft > 0 && soft <= hard) {
        return { soft, hard };
    }

    if (hard > 0) {
        return { soft: roundCurrency(hard * 0.8), hard };
    }

    return { ...DEFAULT_PROFILE_BUDGETS_USD.standard };
}

function pickObject(...values) {
    for (const value of values) {
        if (value && typeof value === 'object') {
            return value;
        }
    }
    return null;
}

function pickValue(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null) {
            return value;
        }
    }
    return undefined;
}

function toNumberSafe(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
        return 0;
    }
    return num;
}

function toStringSafe(value, fallback) {
    if (typeof value === 'string' && value.trim().length > 0) {
        return value;
    }
    return fallback;
}

function roundCurrency(value) {
    return Number(toNumberSafe(value).toFixed(6));
}
