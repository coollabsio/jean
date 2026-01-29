import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from './chat-store'
import type { ToolCall, QueuedMessage, PermissionDenial, PendingImage, QuestionAnswer } from '@/types/chat'
import type { ReviewResponse } from '@/types/projects'

describe('ChatStore', () => {
  beforeEach(() => {
    useChatStore.setState({
      activeWorktreeId: null,
      activeWorktreePath: null,
      activeSessionIds: {},
      reviewResults: {},
      viewingReviewTab: {},
      fixedReviewFindings: {},
      worktreePaths: {},
      sendingSessionIds: {},
      waitingForInputSessionIds: {},
      sessionWorktreeMap: {},
      streamingContents: {},
      activeToolCalls: {},
      streamingContentBlocks: {},
      streamingThinkingContent: {},
      inputDrafts: {},
      executionModes: {},
      thinkingLevels: {},
      manualThinkingOverrides: {},
      selectedModels: {},
      answeredQuestions: {},
      submittedAnswers: {},
      errors: {},
      lastSentMessages: {},
      setupScriptResults: {},
      pendingImages: {},
      pendingFiles: {},
      pendingTextFiles: {},
      activeTodos: {},
      fixedFindings: {},
      streamingPlanApprovals: {},
      messageQueues: {},
      executingModes: {},
      approvedTools: {},
      pendingPermissionDenials: {},
      deniedMessageContext: {},
      lastCompaction: {},
      reviewingSessions: {},
      savingContext: {},
      skippedQuestionSessions: {},
    })
  })

  describe('session management', () => {
    it('sets active session for worktree', () => {
      const { setActiveSession, getActiveSession } = useChatStore.getState()

      setActiveSession('worktree-1', 'session-1')

      expect(getActiveSession('worktree-1')).toBe('session-1')
      expect(useChatStore.getState().sessionWorktreeMap['session-1']).toBe('worktree-1')
    })

    it('updates session-worktree mapping', () => {
      const { setActiveSession } = useChatStore.getState()

      setActiveSession('worktree-1', 'session-1')
      setActiveSession('worktree-2', 'session-2')

      const state = useChatStore.getState()
      expect(state.sessionWorktreeMap['session-1']).toBe('worktree-1')
      expect(state.sessionWorktreeMap['session-2']).toBe('worktree-2')
    })
  })

  describe('worktree management', () => {
    it('sets active worktree', () => {
      const { setActiveWorktree } = useChatStore.getState()

      setActiveWorktree('worktree-1', '/path/to/worktree')

      const state = useChatStore.getState()
      expect(state.activeWorktreeId).toBe('worktree-1')
      expect(state.activeWorktreePath).toBe('/path/to/worktree')
      expect(state.worktreePaths['worktree-1']).toBe('/path/to/worktree')
    })

    it('clears active worktree', () => {
      const { setActiveWorktree, clearActiveWorktree } = useChatStore.getState()

      setActiveWorktree('worktree-1', '/path')
      clearActiveWorktree()

      const state = useChatStore.getState()
      expect(state.activeWorktreeId).toBeNull()
      expect(state.activeWorktreePath).toBeNull()
    })

    it('registers worktree path', () => {
      const { registerWorktreePath, getWorktreePath } = useChatStore.getState()

      registerWorktreePath('worktree-1', '/path/to/worktree')

      expect(getWorktreePath('worktree-1')).toBe('/path/to/worktree')
    })
  })

  describe('sending state', () => {
    it('adds and removes sending session', () => {
      const { addSendingSession, removeSendingSession, isSending } = useChatStore.getState()

      expect(isSending('session-1')).toBe(false)

      addSendingSession('session-1')
      expect(isSending('session-1')).toBe(true)

      removeSendingSession('session-1')
      expect(isSending('session-1')).toBe(false)
    })

    it('checks if worktree is running', () => {
      const { setActiveSession, addSendingSession, isWorktreeRunning } = useChatStore.getState()

      setActiveSession('worktree-1', 'session-1')

      expect(isWorktreeRunning('worktree-1')).toBe(false)

      addSendingSession('session-1')
      expect(isWorktreeRunning('worktree-1')).toBe(true)
    })
  })

  describe('waiting for input state', () => {
    it('sets and checks waiting for input', () => {
      const { setWaitingForInput, isWaitingForInput } = useChatStore.getState()

      expect(isWaitingForInput('session-1')).toBe(false)

      setWaitingForInput('session-1', true)
      expect(isWaitingForInput('session-1')).toBe(true)

      setWaitingForInput('session-1', false)
      expect(isWaitingForInput('session-1')).toBe(false)
    })
  })

  describe('streaming content', () => {
    it('appends streaming content', () => {
      const { appendStreamingContent } = useChatStore.getState()

      appendStreamingContent('session-1', 'Hello ')
      appendStreamingContent('session-1', 'World')

      expect(useChatStore.getState().streamingContents['session-1']).toBe('Hello World')
    })

    it('clears streaming content', () => {
      const { appendStreamingContent, clearStreamingContent } = useChatStore.getState()

      appendStreamingContent('session-1', 'Hello')
      clearStreamingContent('session-1')

      expect(useChatStore.getState().streamingContents['session-1']).toBeUndefined()
    })
  })

  describe('tool calls', () => {
    const mockToolCall: ToolCall = {
      id: 'tool-1',
      name: 'Read',
      input: { file_path: '/test.txt' },
    }

    it('adds tool call', () => {
      const { addToolCall } = useChatStore.getState()

      addToolCall('session-1', mockToolCall)

      expect(useChatStore.getState().activeToolCalls['session-1']).toContainEqual(mockToolCall)
    })

    it('deduplicates tool calls by ID', () => {
      const { addToolCall } = useChatStore.getState()

      addToolCall('session-1', mockToolCall)
      addToolCall('session-1', mockToolCall)

      expect(useChatStore.getState().activeToolCalls['session-1']).toHaveLength(1)
    })

    it('updates tool call output', () => {
      const { addToolCall, updateToolCallOutput } = useChatStore.getState()

      addToolCall('session-1', mockToolCall)
      updateToolCallOutput('session-1', 'tool-1', 'file contents')

      const toolCalls = useChatStore.getState().activeToolCalls['session-1']
      expect(toolCalls?.[0]?.output).toBe('file contents')
    })

    it('clears tool calls', () => {
      const { addToolCall, clearToolCalls } = useChatStore.getState()

      addToolCall('session-1', mockToolCall)
      clearToolCalls('session-1')

      expect(useChatStore.getState().activeToolCalls['session-1']).toBeUndefined()
    })
  })

  describe('content blocks', () => {
    it('adds text block', () => {
      const { addTextBlock, getStreamingContentBlocks } = useChatStore.getState()

      addTextBlock('session-1', 'Hello')

      const blocks = getStreamingContentBlocks('session-1')
      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toEqual({ type: 'text', text: 'Hello' })
    })

    it('appends to existing text block', () => {
      const { addTextBlock, getStreamingContentBlocks } = useChatStore.getState()

      addTextBlock('session-1', 'Hello ')
      addTextBlock('session-1', 'World')

      const blocks = getStreamingContentBlocks('session-1')
      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toEqual({ type: 'text', text: 'Hello World' })
    })

    it('adds tool block', () => {
      const { addTextBlock, addToolBlock, getStreamingContentBlocks } = useChatStore.getState()

      addTextBlock('session-1', 'Hello')
      addToolBlock('session-1', 'tool-1')

      const blocks = getStreamingContentBlocks('session-1')
      expect(blocks).toHaveLength(2)
      expect(blocks[1]).toEqual({ type: 'tool_use', tool_call_id: 'tool-1' })
    })

    it('adds thinking block', () => {
      const { addThinkingBlock, getStreamingContentBlocks } = useChatStore.getState()

      addThinkingBlock('session-1', 'Thinking...')

      const blocks = getStreamingContentBlocks('session-1')
      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toEqual({ type: 'thinking', thinking: 'Thinking...' })
    })

    it('clears content blocks', () => {
      const { addTextBlock, clearStreamingContentBlocks, getStreamingContentBlocks } = useChatStore.getState()

      addTextBlock('session-1', 'Hello')
      clearStreamingContentBlocks('session-1')

      expect(getStreamingContentBlocks('session-1')).toHaveLength(0)
    })
  })

  describe('execution mode', () => {
    it('cycles execution mode', () => {
      const { cycleExecutionMode, getExecutionMode } = useChatStore.getState()

      expect(getExecutionMode('session-1')).toBe('plan')

      cycleExecutionMode('session-1')
      expect(getExecutionMode('session-1')).toBe('build')

      cycleExecutionMode('session-1')
      expect(getExecutionMode('session-1')).toBe('yolo')

      cycleExecutionMode('session-1')
      expect(getExecutionMode('session-1')).toBe('plan')
    })

    it('sets execution mode directly', () => {
      const { setExecutionMode, getExecutionMode } = useChatStore.getState()

      setExecutionMode('session-1', 'yolo')
      expect(getExecutionMode('session-1')).toBe('yolo')
    })

    it('clears pending denials when switching to yolo', () => {
      const { setPendingDenials, setExecutionMode, getPendingDenials } = useChatStore.getState()

      const denials: PermissionDenial[] = [{ tool_name: 'Bash', tool_use_id: 'toolu_123', tool_input: {} }]
      setPendingDenials('session-1', denials)

      setExecutionMode('session-1', 'yolo')

      expect(getPendingDenials('session-1')).toHaveLength(0)
    })
  })

  describe('thinking level', () => {
    it('sets and gets thinking level', () => {
      const { setThinkingLevel, getThinkingLevel } = useChatStore.getState()

      expect(getThinkingLevel('session-1')).toBe('off')

      setThinkingLevel('session-1', 'think')
      expect(getThinkingLevel('session-1')).toBe('think')
    })

    it('tracks manual thinking override', () => {
      const { setManualThinkingOverride, hasManualThinkingOverride } = useChatStore.getState()

      expect(hasManualThinkingOverride('session-1')).toBe(false)

      setManualThinkingOverride('session-1', true)
      expect(hasManualThinkingOverride('session-1')).toBe(true)
    })
  })

  describe('question answering', () => {
    it('marks question as answered', () => {
      const { markQuestionAnswered, isQuestionAnswered, getSubmittedAnswers } = useChatStore.getState()

      const answers: QuestionAnswer[] = [{ questionIndex: 0, selectedOptions: [0] }]
      markQuestionAnswered('session-1', 'tool-1', answers)

      expect(isQuestionAnswered('session-1', 'tool-1')).toBe(true)
      expect(getSubmittedAnswers('session-1', 'tool-1')).toEqual(answers)
    })

    it('returns false for unanswered question', () => {
      const { isQuestionAnswered } = useChatStore.getState()

      expect(isQuestionAnswered('session-1', 'tool-1')).toBe(false)
    })

    it('tracks question skipping', () => {
      const { setQuestionsSkipped, areQuestionsSkipped } = useChatStore.getState()

      expect(areQuestionsSkipped('session-1')).toBe(false)

      setQuestionsSkipped('session-1', true)
      expect(areQuestionsSkipped('session-1')).toBe(true)

      setQuestionsSkipped('session-1', false)
      expect(areQuestionsSkipped('session-1')).toBe(false)
    })
  })

  describe('message queue', () => {
    const createMockMessage = (id: string, message: string): QueuedMessage => ({
      id,
      message,
      pendingImages: [],
      pendingFiles: [],
      pendingSkills: [],
      pendingTextFiles: [],
      provider: 'claude',
      model: 'sonnet',
      executionMode: 'plan',
      thinkingLevel: 'off',
      disableThinkingForMode: false,
      queuedAt: Date.now(),
    })

    const mockMessage = createMockMessage('msg-1', 'Hello')

    it('enqueues message', () => {
      const { enqueueMessage, getQueueLength, getQueuedMessages } = useChatStore.getState()

      enqueueMessage('session-1', mockMessage)

      expect(getQueueLength('session-1')).toBe(1)
      expect(getQueuedMessages('session-1')[0]?.id).toBe(mockMessage.id)
    })

    it('dequeues message (FIFO)', () => {
      const { enqueueMessage, dequeueMessage } = useChatStore.getState()

      const msg1 = createMockMessage('msg-1', 'First')
      const msg2 = createMockMessage('msg-2', 'Second')

      enqueueMessage('session-1', msg1)
      enqueueMessage('session-1', msg2)

      const dequeued = dequeueMessage('session-1')
      expect(dequeued?.id).toBe(msg1.id)
      expect(useChatStore.getState().getQueueLength('session-1')).toBe(1)
    })

    it('returns undefined when dequeuing empty queue', () => {
      const { dequeueMessage } = useChatStore.getState()

      expect(dequeueMessage('session-1')).toBeUndefined()
    })

    it('removes specific queued message', () => {
      const { enqueueMessage, removeQueuedMessage, getQueuedMessages } = useChatStore.getState()

      const msg1 = createMockMessage('msg-1', 'First')
      const msg2 = createMockMessage('msg-2', 'Second')

      enqueueMessage('session-1', msg1)
      enqueueMessage('session-1', msg2)

      removeQueuedMessage('session-1', 'msg-1')

      const messages = getQueuedMessages('session-1')
      expect(messages).toHaveLength(1)
      expect(messages[0]?.id).toBe('msg-2')
    })

    it('clears queue', () => {
      const { enqueueMessage, clearQueue, getQueueLength } = useChatStore.getState()

      enqueueMessage('session-1', mockMessage)
      clearQueue('session-1')

      expect(getQueueLength('session-1')).toBe(0)
    })
  })

  describe('permission approvals', () => {
    it('adds approved tool', () => {
      const { addApprovedTool, getApprovedTools } = useChatStore.getState()

      addApprovedTool('session-1', 'Bash(npm test)')

      expect(getApprovedTools('session-1')).toContain('Bash(npm test)')
    })

    it('clears approved tools', () => {
      const { addApprovedTool, clearApprovedTools, getApprovedTools } = useChatStore.getState()

      addApprovedTool('session-1', 'Bash(npm test)')
      clearApprovedTools('session-1')

      expect(getApprovedTools('session-1')).toHaveLength(0)
    })
  })

  describe('pending denials', () => {
    const denials: PermissionDenial[] = [
      { tool_name: 'Bash', tool_use_id: 'toolu_123', tool_input: { command: 'rm -rf /' } },
    ]

    it('sets and gets pending denials', () => {
      const { setPendingDenials, getPendingDenials } = useChatStore.getState()

      setPendingDenials('session-1', denials)

      expect(getPendingDenials('session-1')).toEqual(denials)
    })

    it('clears pending denials', () => {
      const { setPendingDenials, clearPendingDenials, getPendingDenials } = useChatStore.getState()

      setPendingDenials('session-1', denials)
      clearPendingDenials('session-1')

      expect(getPendingDenials('session-1')).toHaveLength(0)
    })
  })

  describe('denied message context', () => {
    const context = {
      message: 'test message',
      model: 'sonnet',
      executionMode: 'plan' as const,
    }

    it('sets and gets denied message context', () => {
      const { setDeniedMessageContext, getDeniedMessageContext } = useChatStore.getState()

      setDeniedMessageContext('session-1', context)

      expect(getDeniedMessageContext('session-1')).toEqual(context)
    })

    it('clears denied message context', () => {
      const { setDeniedMessageContext, clearDeniedMessageContext, getDeniedMessageContext } = useChatStore.getState()

      setDeniedMessageContext('session-1', context)
      clearDeniedMessageContext('session-1')

      expect(getDeniedMessageContext('session-1')).toBeUndefined()
    })
  })

  describe('clearSessionState', () => {
    it('clears all session-specific state', () => {
      const store = useChatStore.getState()

      // Set up various session state
      store.addApprovedTool('session-1', 'Bash')
      store.setPendingDenials('session-1', [{ tool_name: 'Write', tool_use_id: 'toolu_456', tool_input: {} }])
      store.setDeniedMessageContext('session-1', { message: 'test' })
      store.setSessionReviewing('session-1', true)
      store.setWaitingForInput('session-1', true)
      store.markQuestionAnswered('session-1', 'q1', [{ questionIndex: 0, selectedOptions: [0] }])
      store.markFindingFixed('session-1', 'finding-1')
      store.setManualThinkingOverride('session-1', true)

      store.clearSessionState('session-1')

      expect(store.getApprovedTools('session-1')).toHaveLength(0)
      expect(store.getPendingDenials('session-1')).toHaveLength(0)
      expect(store.getDeniedMessageContext('session-1')).toBeUndefined()
      expect(store.isSessionReviewing('session-1')).toBe(false)
      expect(store.isWaitingForInput('session-1')).toBe(false)
      expect(store.isQuestionAnswered('session-1', 'q1')).toBe(false)
      expect(store.isFindingFixed('session-1', 'finding-1')).toBe(false)
      expect(store.hasManualThinkingOverride('session-1')).toBe(false)
    })
  })

  describe('input drafts', () => {
    it('sets and clears input draft', () => {
      const { setInputDraft, clearInputDraft } = useChatStore.getState()

      setInputDraft('session-1', 'Hello world')
      expect(useChatStore.getState().inputDrafts['session-1']).toBe('Hello world')

      clearInputDraft('session-1')
      expect(useChatStore.getState().inputDrafts['session-1']).toBeUndefined()
    })
  })

  describe('error handling', () => {
    it('sets and clears error', () => {
      const { setError } = useChatStore.getState()

      setError('session-1', 'Something went wrong')
      expect(useChatStore.getState().errors['session-1']).toBe('Something went wrong')

      setError('session-1', null)
      expect(useChatStore.getState().errors['session-1']).toBeNull()
    })

    it('sets and clears last sent message', () => {
      const { setLastSentMessage, clearLastSentMessage } = useChatStore.getState()

      setLastSentMessage('session-1', 'Hello')
      expect(useChatStore.getState().lastSentMessages['session-1']).toBe('Hello')

      clearLastSentMessage('session-1')
      expect(useChatStore.getState().lastSentMessages['session-1']).toBeUndefined()
    })
  })

  describe('pending images', () => {
    const mockImage: PendingImage = { id: 'img-1', path: '/test.png', filename: 'test.png' }

    it('adds pending image', () => {
      const { addPendingImage, getPendingImages } = useChatStore.getState()

      addPendingImage('session-1', mockImage)

      expect(getPendingImages('session-1')).toContainEqual(mockImage)
    })

    it('removes pending image', () => {
      const { addPendingImage, removePendingImage, getPendingImages } = useChatStore.getState()

      addPendingImage('session-1', mockImage)
      removePendingImage('session-1', 'img-1')

      expect(getPendingImages('session-1')).toHaveLength(0)
    })

    it('clears pending images', () => {
      const { addPendingImage, clearPendingImages, getPendingImages } = useChatStore.getState()

      addPendingImage('session-1', mockImage)
      clearPendingImages('session-1')

      expect(getPendingImages('session-1')).toHaveLength(0)
    })
  })

  describe('active todos', () => {
    const mockTodos = [
      { content: 'Task 1', status: 'pending' as const, activeForm: 'Doing task 1' },
      { content: 'Task 2', status: 'completed' as const, activeForm: 'Doing task 2' },
    ]

    it('sets and gets active todos', () => {
      const { setActiveTodos, getActiveTodos } = useChatStore.getState()

      setActiveTodos('session-1', mockTodos)

      expect(getActiveTodos('session-1')).toEqual(mockTodos)
    })

    it('clears active todos', () => {
      const { setActiveTodos, clearActiveTodos, getActiveTodos } = useChatStore.getState()

      setActiveTodos('session-1', mockTodos)
      clearActiveTodos('session-1')

      expect(getActiveTodos('session-1')).toHaveLength(0)
    })
  })

  describe('fixed findings', () => {
    it('marks finding as fixed', () => {
      const { markFindingFixed, isFindingFixed } = useChatStore.getState()

      markFindingFixed('session-1', 'finding-1')

      expect(isFindingFixed('session-1', 'finding-1')).toBe(true)
      expect(isFindingFixed('session-1', 'finding-2')).toBe(false)
    })

    it('clears fixed findings', () => {
      const { markFindingFixed, clearFixedFindings, isFindingFixed } = useChatStore.getState()

      markFindingFixed('session-1', 'finding-1')
      clearFixedFindings('session-1')

      expect(isFindingFixed('session-1', 'finding-1')).toBe(false)
    })
  })

  describe('streaming plan approval', () => {
    it('sets and checks streaming plan approval', () => {
      const { setStreamingPlanApproved, isStreamingPlanApproved } = useChatStore.getState()

      expect(isStreamingPlanApproved('session-1')).toBe(false)

      setStreamingPlanApproved('session-1', true)
      expect(isStreamingPlanApproved('session-1')).toBe(true)
    })

    it('clears streaming plan approval', () => {
      const { setStreamingPlanApproved, clearStreamingPlanApproval, isStreamingPlanApproved } = useChatStore.getState()

      setStreamingPlanApproved('session-1', true)
      clearStreamingPlanApproval('session-1')

      expect(isStreamingPlanApproved('session-1')).toBe(false)
    })
  })

  describe('executing mode', () => {
    it('sets and gets executing mode', () => {
      const { setExecutingMode, getExecutingMode } = useChatStore.getState()

      expect(getExecutingMode('session-1')).toBeUndefined()

      setExecutingMode('session-1', 'build')
      expect(getExecutingMode('session-1')).toBe('build')
    })

    it('clears executing mode', () => {
      const { setExecutingMode, clearExecutingMode, getExecutingMode } = useChatStore.getState()

      setExecutingMode('session-1', 'build')
      clearExecutingMode('session-1')

      expect(getExecutingMode('session-1')).toBeUndefined()
    })
  })

  describe('compaction tracking', () => {
    it('sets and gets last compaction', () => {
      const { setLastCompaction, getLastCompaction } = useChatStore.getState()

      setLastCompaction('session-1', 'auto')

      const compaction = getLastCompaction('session-1')
      expect(compaction?.trigger).toBe('auto')
      expect(compaction?.timestamp).toBeGreaterThan(0)
    })

    it('clears last compaction', () => {
      const { setLastCompaction, clearLastCompaction, getLastCompaction } = useChatStore.getState()

      setLastCompaction('session-1', 'auto')
      clearLastCompaction('session-1')

      expect(getLastCompaction('session-1')).toBeUndefined()
    })
  })

  describe('save context tracking', () => {
    it('sets and checks saving context', () => {
      const { setSavingContext, isSavingContext } = useChatStore.getState()

      expect(isSavingContext('session-1')).toBe(false)

      setSavingContext('session-1', true)
      expect(isSavingContext('session-1')).toBe(true)

      setSavingContext('session-1', false)
      expect(isSavingContext('session-1')).toBe(false)
    })
  })

  describe('review results', () => {
    const mockResults: ReviewResponse = {
      summary: 'No issues found',
      findings: [],
      approval_status: 'approved',
    }

    it('sets review results and switches to review tab', () => {
      const { setReviewResults, isViewingReviewTab } = useChatStore.getState()

      setReviewResults('worktree-1', mockResults)

      expect(useChatStore.getState().reviewResults['worktree-1']).toEqual(mockResults)
      expect(isViewingReviewTab('worktree-1')).toBe(true)
    })

    it('clears review results and viewing state', () => {
      const { setReviewResults, clearReviewResults, isViewingReviewTab } = useChatStore.getState()

      setReviewResults('worktree-1', mockResults)
      clearReviewResults('worktree-1')

      expect(useChatStore.getState().reviewResults['worktree-1']).toBeUndefined()
      expect(isViewingReviewTab('worktree-1')).toBe(false)
    })

    it('sets viewing review tab', () => {
      const { setViewingReviewTab, isViewingReviewTab } = useChatStore.getState()

      setViewingReviewTab('worktree-1', true)
      expect(isViewingReviewTab('worktree-1')).toBe(true)

      setViewingReviewTab('worktree-1', false)
      expect(isViewingReviewTab('worktree-1')).toBe(false)
    })
  })

  describe('review fixed findings (worktree-based)', () => {
    it('marks and checks review finding fixed', () => {
      const { markReviewFindingFixed, isReviewFindingFixed } = useChatStore.getState()

      markReviewFindingFixed('worktree-1', 'finding-1')

      expect(isReviewFindingFixed('worktree-1', 'finding-1')).toBe(true)
      expect(isReviewFindingFixed('worktree-1', 'finding-2')).toBe(false)
    })

    it('clears fixed review findings', () => {
      const { markReviewFindingFixed, clearFixedReviewFindings, isReviewFindingFixed } = useChatStore.getState()

      markReviewFindingFixed('worktree-1', 'finding-1')
      clearFixedReviewFindings('worktree-1')

      expect(isReviewFindingFixed('worktree-1', 'finding-1')).toBe(false)
    })
  })

  describe('session reviewing status', () => {
    it('sets and checks session reviewing', () => {
      const { setSessionReviewing, isSessionReviewing } = useChatStore.getState()

      expect(isSessionReviewing('session-1')).toBe(false)

      setSessionReviewing('session-1', true)
      expect(isSessionReviewing('session-1')).toBe(true)

      setSessionReviewing('session-1', false)
      expect(isSessionReviewing('session-1')).toBe(false)
    })
  })
})
