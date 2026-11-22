import type { Context } from '@deepseek-ai/cordis';
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import type { ClassifierFailureKind } from './types.js';
type DenialFeedback = {
    kind: 'denied';
    reason: string;
} | {
    kind: 'unavailable';
    failure?: ClassifierFailureKind;
};
/** Agent 的故障反馈由固定文案组成。 */
export declare function classifierFailureFeedback(failure?: ClassifierFailureKind): string;
/** 将 Auto 的审批失败关联到实际执行会话中的同一次工具调用。 */
export declare function createApprovalFeedback(ctx: Context, isEnabled: () => boolean): {
    capture(req: ApprovalRequest): ((outcome: DenialFeedback) => void) | undefined;
};
export {};
