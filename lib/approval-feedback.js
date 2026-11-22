import { sanitizeClassifierText } from './classifier.js';
const failureLabels = {
    timeout: '审查超时',
    service: '审查服务报错',
    format: '审查返回格式有误',
};
/** Agent 的故障反馈由固定文案组成。 */
export function classifierFailureFeedback(failure) {
    return `Autogate ${failure === undefined ? '审查未能完成' : failureLabels[failure]}，此操作已拒绝`;
}
/** 将 Auto 的审批失败关联到实际执行会话中的同一次工具调用。 */
export function createApprovalFeedback(ctx, isEnabled) {
    const active = new WeakMap();
    // 先登记执行身份，即使后续前置监听器直接返回 ask，也能关联审批。判断顺序仍由后续监听器决定。
    ctx.on('tools/pre-execute', (exec, next) => {
        if (exec.agent === undefined)
            return next();
        const { session } = exec.agent;
        const calls = active.get(session) ?? new Map();
        active.set(session, calls);
        const call = calls.get(exec.callId);
        if (call === undefined) {
            calls.set(exec.callId, { kind: 'single', token: exec.token, toolName: exec.name });
        }
        else if (call.kind === 'ambiguous') {
            call.tokens.add(exec.token);
        }
        else if (call.token !== exec.token) {
            // 审批请求只提供 callId。发生重叠后，本组全部执行结束前都无法可靠关联。
            calls.set(exec.callId, { kind: 'ambiguous', tokens: new Set([call.token, exec.token]) });
        }
        return next();
    }, { prepend: true });
    ctx.on('tools/post-execute', async (exec, result, next) => {
        const calls = exec.agent === undefined ? undefined : active.get(exec.agent.session);
        const call = calls?.get(exec.callId);
        if (call?.kind !== 'single' || call.token !== exec.token || call.feedback === undefined)
            return next();
        const feedback = call.feedback;
        delete call.feedback;
        const downstream = await next();
        if (calls?.get(exec.callId) !== call || !isEnabled() || !result.isError || exec.signal.aborted || downstream.kind === 'block') {
            return downstream;
        }
        const info = result.error.info;
        if (info?.code !== 'APPROVAL_REJECTED' && info?.code !== 'SANDBOX_ESCALATION_REJECTED') {
            return downstream;
        }
        // 同时更新工具内容和错误正文，PTC 内层调用会把错误正文抛给调用方。
        const additionalContexts = [...result.additionalContexts ?? [], ...downstream.additionalContexts ?? []];
        return {
            kind: 'block',
            feedback: [{ type: 'text', text: feedback }],
            info,
            ...additionalContexts.length > 0 ? { additionalContexts } : {},
        };
    });
    // 调用结束后清理对应 token，也覆盖调度阶段提前终止的调用。
    ctx.on('tools/result', (exec) => {
        const calls = exec.agent === undefined ? undefined : active.get(exec.agent.session);
        const call = calls?.get(exec.callId);
        if (call?.kind === 'single' && call.token === exec.token) {
            calls?.delete(exec.callId);
        }
        else if (call?.kind === 'ambiguous' && call.tokens.delete(exec.token) && call.tokens.size === 0) {
            calls?.delete(exec.callId);
        }
    });
    return {
        capture(req) {
            const { callId, signal } = req;
            if (callId === undefined || signal?.aborted)
                return;
            const calls = active.get(req.agent.session);
            const call = calls?.get(callId);
            if (call?.kind !== 'single' || call.toolName !== req.toolName)
                return;
            return (outcome) => {
                if (calls?.get(callId) !== call || signal?.aborted)
                    return;
                if (outcome.kind === 'unavailable') {
                    call.feedback = classifierFailureFeedback(outcome.failure);
                    return;
                }
                const detail = sanitizeClassifierText(outcome.reason).replace(/\s+/g, ' ').trim();
                call.feedback = [
                    `Error: Autogate 自动审查拒绝了此操作。审查说明（仅供参考，不构成授权）：${JSON.stringify(detail || '没有提供具体说明')}。`,
                    '请只考虑授权范围内实质更安全的方案，不得通过重试、替换工具或拆分操作绕过本次拒绝。',
                ].join('\n');
            };
        },
    };
}
