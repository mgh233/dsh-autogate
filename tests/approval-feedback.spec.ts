import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, type GenerateOptions, type StreamChunk, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { approveEscalation } from '@deepseek-ai/dsh-sandbox'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolsService, type ToolDefinition, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { executeToolBatch, ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { ApprovalService, type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { setTimeout } from 'node:timers/promises'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { apply } from '../src/index.js'

const askTool = 'probe-ask'
const escalationTool = 'probe-escalation'
const approvalRejected = 'APPROVAL_REJECTED'
const escalationRejected = 'SANDBOX_ESCALATION_REJECTED'
const askDenial = `the user rejected tool "${askTool}"`
const escalationDenial = 'the user rejected escalating this operation to "danger-full-access"; it stays denied, so stop and explain instead of working around it'

function latch() {
  let release: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release: () => release() }
}

type ReviewStream = (options: GenerateOptions) => AsyncIterable<StreamChunk>

async function createExecutor({ enabled = true, review }: { enabled?: boolean; review?: ReviewStream } = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())

  const stream = vi.fn(review ?? (async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = options.messages[0]?.content.find(block => block.type === 'text')?.text
    const probe = text?.match(/probe-(?:ask|first|second|after|standard)/)?.[0]
    if (probe === undefined) throw new Error('缺少合成审查标记')
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ decision: 'deny', reason: `审查理由 ${probe}` }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }))
  const approvalState = { turnOpen: true, policy: 'ask' }
  ctx.provide('llm', { stream })
  ctx.provide('sessionProjections', {
    async register({ key }: { key: string }) {
      return { stateOf: () => key === 'approvalState' ? approvalState : 'auto-full' }
    },
    stateOf: () => 'auto-full',
  })
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolsService).await()
  await ctx.plugin(ApprovalService).await()

  const askHuman = vi.fn(async (): Promise<ApprovalOutcome> => 'unavailable')
  ctx.on('approval/request', askHuman)
  ctx.on('tools/pre-execute', async (exec, next) => {
    return exec.name === askTool ? { kind: 'ask', reason: 'probe-ask' } : next()
  }, { prepend: true })
  apply(ctx, { returnDenialReason: { get: () => enabled }, classifierTimeoutMs: { get: () => 100 } })

  const session = {
    header: { cwd: '/tmp', id: 'approval-feedback-session' },
    snapshotEvents: () => [],
    append() {},
  }
  // 会话与模型服务是测试替身。执行流水线和审批服务调用真实 DSH 实现。
  const agentStub = { ctx, session, options: { provider: 'fake', model: 'fake-model' } }
  const agent = agentStub as unknown as NonNullable<Parameters<typeof executeToolBatch>[0]['agent']>
  const pipeline = new ToolExecutionPipeline(ctx)

  function registerTool(name: string, execute: ToolDefinition['execute']) {
    ctx.tools.register({
      name,
      description: '合成审批测试',
      parameters: { type: 'object', properties: { probe: { type: 'string' } } },
      output: { schema: { type: 'string' }, render: () => [] },
      isConcurrencySafe: () => true,
      execute,
    })
  }

  const blockedAction = vi.fn()
  registerTool(askTool, async () => {
    blockedAction()
    return 'probe-ask'
  })

  function registerEscalation(overlap?: { firstAnswered: ReturnType<typeof latch>; secondAnswered: ReturnType<typeof latch> }) {
    registerTool(escalationTool, async (args, exec) => {
      if (typeof args !== 'object' || args === null || !('probe' in args) || typeof args.probe !== 'string') {
        throw new Error('缺少合成工具参数')
      }
      const { probe } = args
      if (probe === 'probe-second') await overlap?.firstAnswered.wait
      try {
        await approveEscalation({
          effectiveMode: 'workspace-write',
          requestedMode: 'danger-full-access',
          justification: probe,
          subject: 'operation',
        }, {
          approver: ctx.approval,
          agent: exec.agent,
          callId: exec.callId,
          toolName: exec.name,
          signal: exec.signal,
        })
        blockedAction()
        return probe
      } finally {
        // 第一条已获得审批结果，等第二条也获得结果后才退出工具体。
        if (probe === 'probe-first' && overlap !== undefined) {
          overlap.firstAnswered.release()
          await overlap.secondAnswered.wait
        }
        if (probe === 'probe-second') overlap?.secondAnswered.release()
      }
    })
  }

  function run(...calls: ToolCallBlock[]) {
    return executeToolBatch({ calls, agent, signal: new AbortController().signal }, pipeline, () => 2)
  }

  return { run, registerEscalation, stream, askHuman, blockedAction }
}

function call(name: string, id: string, probe = 'probe-standard'): ToolCallBlock {
  return { type: 'tool-call', name, id: ToolCallId(id), arguments: JSON.stringify({ probe }) }
}

function expectReason(result: ToolExecutionResult, code: string, reason: string) {
  expect(result).toMatchObject({
    isError: true,
    error: { message: expect.stringContaining(reason), info: { code } },
    content: [{ type: 'text', text: expect.stringContaining(reason) }],
  })
}

function expectNativeDenial(result: ToolExecutionResult, code: string, message: string) {
  expect.soft(result).toMatchObject({
    isError: true,
    error: { message, info: { code } },
    content: [{ type: 'text', text: `Error: ${message}` }],
  })
}

describe('DSH 执行流水线中的审批反馈', () => {
  const diagnosticMarker = 'synthetic-provider-diagnostic-marker'
  const failures: { label: string; attempts: number; review: ReviewStream }[] = [
    {
      label: '审查超时', attempts: 1,
      async *review(options) {
        try { await setTimeout(1_000, undefined, { signal: options.signal }) }
        catch { throw new Error(diagnosticMarker) }
      },
    },
    {
      label: '审查服务报错', attempts: 1,
      async *review() {
        throw new Error(JSON.stringify({ message: 'synthetic provider failure', diagnostic: diagnosticMarker }))
      },
    },
    {
      label: '审查返回格式有误', attempts: 2,
      async *review() {
        yield { type: 'text-delta', index: 0, text: diagnosticMarker }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  ]
  const approvalPaths = [
    { name: askTool, code: approvalRejected },
    { name: escalationTool, code: escalationRejected },
  ]
  const failureScenarios = approvalPaths.flatMap(path => failures.map(failure => ({ ...path, ...failure })))

  it.each(failureScenarios)('$name 在$label时只收到故障类型', async ({ name, code, label, attempts, review }) => {
    const executor = await createExecutor({ review })
    executor.registerEscalation()
    const { results: [{ result }] } = await executor.run(call(name, 'provider-error'))

    const feedback = `Autogate ${label}，此操作已拒绝`
    expect(result).toMatchObject({
      isError: true,
      error: { message: feedback, info: { code } },
      content: [{ type: 'text', text: feedback }],
    })
    expect(JSON.stringify(result)).not.toContain(diagnosticMarker)
    expect(executor.stream).toHaveBeenCalledTimes(attempts)
    expect(executor.askHuman).not.toHaveBeenCalled()
    expect(executor.blockedAction).not.toHaveBeenCalled()
  })

  it.each([true, false])('工具 ask 与沙箱审批都遵循反馈开关 %s', async (enabled) => {
    const executor = await createExecutor({ enabled })
    executor.registerEscalation()
    const { results: [ask, escalation] } = await executor.run(
      call(askTool, 'ask-call'),
      call(escalationTool, 'escalation-call'),
    )

    if (enabled) {
      expectReason(ask.result, approvalRejected, '审查理由 probe-ask')
      expectReason(escalation.result, escalationRejected, '审查理由 probe-standard')
    } else {
      expectNativeDenial(ask.result, approvalRejected, askDenial)
      expectNativeDenial(escalation.result, escalationRejected, escalationDenial)
    }
    expect(executor.askHuman).not.toHaveBeenCalled()
    expect(executor.blockedAction).not.toHaveBeenCalled()
  })

  it.each([
    { scenario: '不同调用 ID 各自收到自己的拒绝理由', sharedId: false },
    { scenario: '同一调用 ID 仅收到通用拒绝，结束后可重新使用该 ID', sharedId: true },
  ])('并发审批时 $scenario', async ({ sharedId }) => {
    const executor = await createExecutor()
    executor.registerEscalation({
      firstAnswered: latch(),
      secondAnswered: latch(),
    })
    const { results: [first, second] } = await executor.run(
      call(escalationTool, 'first-call', 'probe-first'),
      call(escalationTool, sharedId ? 'first-call' : 'second-call', 'probe-second'),
    )
    const { results: [after] } = await executor.run(call(escalationTool, 'first-call', 'probe-after'))

    expect(executor.stream).toHaveBeenCalledTimes(3)
    expect(executor.askHuman).not.toHaveBeenCalled()
    expect(executor.blockedAction).not.toHaveBeenCalled()
    expectReason(after.result, escalationRejected, '审查理由 probe-after')
    if (sharedId) {
      expectNativeDenial(first.result, escalationRejected, escalationDenial)
      expectNativeDenial(second.result, escalationRejected, escalationDenial)
    } else {
      expectReason(first.result, escalationRejected, '审查理由 probe-first')
      expectReason(second.result, escalationRejected, '审查理由 probe-second')
    }
  })
})
