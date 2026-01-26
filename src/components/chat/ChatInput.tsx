import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { Textarea } from '@/components/ui/textarea'
import { Kbd } from '@/components/ui/kbd'
import { useChatStore } from '@/store/chat-store'
import { getFilename } from '@/lib/path-utils'
import type {
  PendingFile,
  PendingSkill,
  ClaudeCommand,
  SaveImageResponse,
  SaveTextResponse,
  ExecutionMode,
} from '@/types/chat'
import {
  FileMentionPopover,
  type FileMentionPopoverHandle,
} from './FileMentionPopover'
import { SlashPopover, type SlashPopoverHandle } from './SlashPopover'

import { MAX_IMAGE_SIZE, ALLOWED_IMAGE_TYPES } from './image-constants'

/** Maximum text file size in bytes (10MB) */
const MAX_TEXT_SIZE = 10 * 1024 * 1024

/** Threshold for saving pasted text as file (500 chars) */
const TEXT_PASTE_THRESHOLD = 500

interface ChatInputProps {
  activeSessionId: string | undefined
  activeWorktreePath: string | undefined
  isSending: boolean
  executionMode: ExecutionMode
  focusChatShortcut: string
  onSubmit: (e: React.FormEvent) => void
  onCancel: () => void
  onCommandExecute?: (commandName: string) => void
  onHasValueChange?: (hasValue: boolean) => void
  formRef: React.RefObject<HTMLFormElement | null>
  inputRef: React.RefObject<HTMLTextAreaElement | null>
}

export const ChatInput = memo(function ChatInput({
  activeSessionId,
  activeWorktreePath,
  isSending,
  executionMode,
  focusChatShortcut,
  onSubmit,
  onCancel,
  onCommandExecute,
  onHasValueChange,
  formRef,
  inputRef,
}: ChatInputProps) {
  // PERFORMANCE: Use uncontrolled input pattern - track value in ref, not state
  // This avoids React re-renders on every keystroke
  const valueRef = useRef<string>('')
  const debouncedSaveRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )

  // File mention popover state (local to this component)
  const [fileMentionOpen, setFileMentionOpen] = useState(false)
  const [fileMentionQuery, setFileMentionQuery] = useState('')
  const [fileMentionAnchor, setFileMentionAnchor] = useState<{
    top: number
    left: number
  } | null>(null)
  const [atTriggerIndex, setAtTriggerIndex] = useState<number | null>(null)

  // Slash popover state (for / commands and skills)
  const [slashPopoverOpen, setSlashPopoverOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashAnchor, setSlashAnchor] = useState<{
    top: number
    left: number
  } | null>(null)
  const [slashTriggerIndex, setSlashTriggerIndex] = useState<number | null>(null)

  // Refs to expose navigation methods from popovers
  const fileMentionHandleRef = useRef<FileMentionPopoverHandle | null>(null)
  const slashPopoverHandleRef = useRef<SlashPopoverHandle | null>(null)

  // Track empty state for showing keyboard hint (only re-renders at boundary)
  const [showHint, setShowHint] = useState(() => {
    // Lazy initializer - check draft on mount
    const draft =
      useChatStore.getState().inputDrafts[activeSessionId ?? ''] ?? ''
    return !draft.trim()
  })
  // Track last session to detect changes
  const lastSessionRef = useRef<string | undefined>(activeSessionId)

  // Initialize/restore draft when session changes
  useEffect(() => {
    const draft =
      useChatStore.getState().inputDrafts[activeSessionId ?? ''] ?? ''
    valueRef.current = draft

    // Notify parent of current value (on mount AND session change)
    onHasValueChange?.(Boolean(draft.trim()))

    // Only update showHint if session actually changed (not on mount)
    if (lastSessionRef.current !== activeSessionId) {
      lastSessionRef.current = activeSessionId
      // Use requestAnimationFrame to avoid setState-in-effect lint warning
      requestAnimationFrame(() => setShowHint(!draft.trim()))
    }

    if (inputRef.current) {
      inputRef.current.value = draft
      // Reset height for restored content
      inputRef.current.style.height = 'auto'
      inputRef.current.style.height = `${inputRef.current.scrollHeight}px`
    }
  }, [activeSessionId, inputRef, onHasValueChange])

  // Listen for command:focus-chat-input event from command palette
  useEffect(() => {
    const handleFocusChatInput = () => {
      inputRef.current?.focus()
    }

    window.addEventListener('command:focus-chat-input', handleFocusChatInput)
    return () =>
      window.removeEventListener(
        'command:focus-chat-input',
        handleFocusChatInput
      )
  }, [inputRef])

  // Sync DOM when store draft is cleared or restored externally
  useEffect(() => {
    return useChatStore.subscribe((state, prevState) => {
      const draft = state.inputDrafts[activeSessionId ?? ''] ?? ''
      const prevDraft = prevState.inputDrafts[activeSessionId ?? ''] ?? ''

      // React to external clears (draft went from non-empty to empty)
      if (prevDraft && !draft && inputRef.current?.value) {
        inputRef.current.value = ''
        valueRef.current = ''
        inputRef.current.style.height = 'auto'
        setShowHint(true)
        onHasValueChange?.(false)
      }

      // React to external restores (draft went from empty to non-empty)
      // This handles message restoration after instant cancellation
      if (!prevDraft && draft && inputRef.current && !inputRef.current.value) {
        inputRef.current.value = draft
        valueRef.current = draft
        inputRef.current.style.height = 'auto'
        inputRef.current.style.height = `${inputRef.current.scrollHeight}px`
        setShowHint(false)
        onHasValueChange?.(true)
      }
    })
  }, [activeSessionId, inputRef, onHasValueChange])

  // Handle textarea value changes
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value
      if (!activeSessionId) return

      // PERFORMANCE: Update ref only, no React render
      valueRef.current = value

      // Debounced save to store for persistence (crash recovery, session switching)
      clearTimeout(debouncedSaveRef.current)
      debouncedSaveRef.current = setTimeout(() => {
        useChatStore.getState().setInputDraft(activeSessionId, value)
      }, 1000)

      // Update hint visibility only at empty/non-empty boundary (minimal re-renders)
      // Also notify parent of hasValue change for send button styling
      const isEmpty = !value.trim()
      setShowHint(prev => {
        if (prev !== isEmpty) {
          onHasValueChange?.(!isEmpty)
          return isEmpty
        }
        return prev
      })

      // Sync pending files with @mentions in input
      // Remove any pending files whose @filename is no longer in the text
      const { getPendingFiles, removePendingFile } = useChatStore.getState()
      const files = getPendingFiles(activeSessionId)
      if (files.length > 0) {
        // Extract all @word patterns from the input
        const mentionedNames = new Set<string>()
        const mentionRegex = /@(\S+)/g
        let match
        while ((match = mentionRegex.exec(value)) !== null) {
          if (match[1]) {
            mentionedNames.add(match[1])
          }
        }

        // Remove files that are no longer mentioned
        for (const file of files) {
          const filename = getFilename(file.relativePath)
          if (!mentionedNames.has(filename)) {
            removePendingFile(activeSessionId, file.id)
          }
        }
      }

      // Detect @ trigger for file mentions
      const cursorPos = e.target.selectionStart ?? 0
      const prevChar = value[cursorPos - 1]

      // Check if user just typed @
      if (prevChar === '@') {
        // Check that it's at start or preceded by whitespace
        const charBeforeAt = value[cursorPos - 2]
        if (cursorPos === 1 || charBeforeAt === ' ' || charBeforeAt === '\n') {
          setAtTriggerIndex(cursorPos - 1)
          setFileMentionQuery('')
          setFileMentionOpen(true)

          // Calculate anchor position relative to form
          const textarea = e.target
          const form = formRef.current
          if (form) {
            const formRect = form.getBoundingClientRect()
            const textareaRect = textarea.getBoundingClientRect()
            // Position above the textarea, at the left edge
            setFileMentionAnchor({
              top: textareaRect.top - formRect.top - 8,
              left: textareaRect.left - formRect.left + 16,
            })
          }
        }
      } else if (atTriggerIndex !== null && fileMentionOpen) {
        // Continuing to type after @, update query
        const query = value.slice(atTriggerIndex + 1, cursorPos)

        // Close if user typed space, newline, or backspaced past @
        if (
          query.includes(' ') ||
          query.includes('\n') ||
          cursorPos <= atTriggerIndex
        ) {
          setFileMentionOpen(false)
          setAtTriggerIndex(null)
          setFileMentionQuery('')
        } else {
          setFileMentionQuery(query)
        }
      }

      // Detect / trigger for slash commands and skills (only if @ popover not open)
      if (!fileMentionOpen) {
        if (prevChar === '/') {
          // Check that it's at start or preceded by whitespace
          const charBeforeSlash = value[cursorPos - 2]
          if (
            cursorPos === 1 ||
            charBeforeSlash === ' ' ||
            charBeforeSlash === '\n'
          ) {
            setSlashTriggerIndex(cursorPos - 1)
            setSlashQuery('')
            setSlashPopoverOpen(true)

            // Calculate anchor position relative to form
            const textarea = e.target
            const form = formRef.current
            if (form) {
              const formRect = form.getBoundingClientRect()
              const textareaRect = textarea.getBoundingClientRect()
              setSlashAnchor({
                top: textareaRect.top - formRect.top - 8,
                left: textareaRect.left - formRect.left + 16,
              })
            }
          }
        } else if (slashTriggerIndex !== null && slashPopoverOpen) {
          // Continuing to type after /, update query
          const query = value.slice(slashTriggerIndex + 1, cursorPos)

          // Close if user typed space, newline, or backspaced past /
          if (
            query.includes(' ') ||
            query.includes('\n') ||
            cursorPos <= slashTriggerIndex
          ) {
            setSlashPopoverOpen(false)
            setSlashTriggerIndex(null)
            setSlashQuery('')
          } else {
            setSlashQuery(query)
          }
        }
      }

      // Auto-resize textarea based on content
      const textarea = e.target
      textarea.style.height = 'auto'
      textarea.style.height = `${textarea.scrollHeight}px`
    },
    [
      activeSessionId,
      atTriggerIndex,
      fileMentionOpen,
      slashTriggerIndex,
      slashPopoverOpen,
      formRef,
      onHasValueChange,
    ]
  )

  // Handle keyboard events
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      console.log('[ChatInput] handleKeyDown:', {
        key: e.key,
        fileMentionOpen,
        slashPopoverOpen,
        fileMentionHandleRef: !!fileMentionHandleRef.current,
        slashPopoverHandleRef: !!slashPopoverHandleRef.current,
      })

      // When file mention popover is open, handle navigation
      if (fileMentionOpen) {
        console.log('[ChatInput] File mention popover open, handling key:', e.key)
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault()
            console.log('[ChatInput] Calling fileMentionHandleRef.moveDown()')
            fileMentionHandleRef.current?.moveDown()
            return
          case 'ArrowUp':
            e.preventDefault()
            console.log('[ChatInput] Calling fileMentionHandleRef.moveUp()')
            fileMentionHandleRef.current?.moveUp()
            return
          case 'Enter':
          case 'Tab':
            e.preventDefault()
            console.log('[ChatInput] Calling fileMentionHandleRef.selectCurrent()')
            fileMentionHandleRef.current?.selectCurrent()
            return
          case 'Escape':
            e.preventDefault()
            setFileMentionOpen(false)
            setFileMentionQuery('')
            return
        }
      }

      // When slash popover is open, handle navigation
      if (slashPopoverOpen) {
        console.log('[ChatInput] Slash popover open, handling key:', e.key)
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault()
            console.log('[ChatInput] Calling slashPopoverHandleRef.moveDown()')
            slashPopoverHandleRef.current?.moveDown()
            return
          case 'ArrowUp':
            e.preventDefault()
            console.log('[ChatInput] Calling slashPopoverHandleRef.moveUp()')
            slashPopoverHandleRef.current?.moveUp()
            return
          case 'Enter':
          case 'Tab':
            e.preventDefault()
            console.log('[ChatInput] Calling slashPopoverHandleRef.selectCurrent()')
            slashPopoverHandleRef.current?.selectCurrent()
            return
          case 'Escape':
            e.preventDefault()
            setSlashPopoverOpen(false)
            setSlashTriggerIndex(null)
            setSlashQuery('')
            return
        }
      }

      // Cmd+Option+Backspace (Mac) / Ctrl+Alt+Backspace (Windows/Linux) cancels the running Claude process
      if (
        e.key === 'Backspace' &&
        (e.metaKey || e.ctrlKey) &&
        e.altKey &&
        isSending
      ) {
        e.preventDefault()
        onCancel()
        return
      }
      // Enter without shift sends the message
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        // Cancel any pending debounced save
        clearTimeout(debouncedSaveRef.current)
        // Sync to store immediately before submit so ChatWindow can read it
        if (activeSessionId) {
          useChatStore
            .getState()
            .setInputDraft(activeSessionId, valueRef.current)
        }
        onSubmit(e)
        // Clear input immediately (don't wait for store subscription)
        valueRef.current = ''
        setShowHint(true)
        const textarea = e.target as HTMLTextAreaElement
        textarea.value = ''
        textarea.style.height = 'auto'
      }
      // Shift+Enter adds a new line (default behavior)
    },
    [activeSessionId, fileMentionOpen, slashPopoverOpen, isSending, onCancel, onSubmit]
  )

  // Handle paste events
  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      if (!activeSessionId) return

      const items = e.clipboardData?.items
      if (!items) return

      // First, check for image items in the clipboard
      let hasImage = false
      for (const item of items) {
        if (!item.type.startsWith('image/')) continue
        hasImage = true

        // Check if it's an allowed type
        if (!ALLOWED_IMAGE_TYPES.includes(item.type)) {
          toast.error('Unsupported image type', {
            description: `Allowed types: PNG, JPEG, GIF, WebP`,
          })
          continue
        }

        const file = item.getAsFile()
        if (!file) continue

        // Prevent default paste (we're handling it)
        e.preventDefault()

        // Check size limit
        if (file.size > MAX_IMAGE_SIZE) {
          toast.error('Image too large', {
            description: 'Maximum size is 10MB',
          })
          continue
        }

        // Read as base64 and save to disk
        const reader = new FileReader()
        reader.onload = async event => {
          const dataUrl = event.target?.result as string
          if (!dataUrl) return

          // Extract base64 data (remove data URL prefix)
          const base64Data = dataUrl.split(',')[1]
          if (!base64Data) return

          try {
            // Save to disk via Tauri command (saves to app data dir)
            const result = await invoke<SaveImageResponse>(
              'save_pasted_image',
              {
                data: base64Data,
                mimeType: file.type,
              }
            )

            // Add to pending images
            const { addPendingImage } = useChatStore.getState()
            addPendingImage(activeSessionId, {
              id: result.id,
              path: result.path,
              filename: result.filename,
            })
          } catch (error) {
            console.error('Failed to save image:', error)
            toast.error('Failed to save image', {
              description: String(error),
            })
          }
        }
        reader.readAsDataURL(file)
      }

      // If we handled an image, don't also process text
      if (hasImage) return

      // Check for large text paste
      const text = e.clipboardData?.getData('text/plain')
      if (text && text.length >= TEXT_PASTE_THRESHOLD) {
        // Prevent default paste (we're handling it as a file)
        e.preventDefault()

        // Check size limit
        const textSize = new TextEncoder().encode(text).length
        if (textSize > MAX_TEXT_SIZE) {
          toast.error('Text too large', {
            description: 'Maximum size is 10MB',
          })
          return
        }

        try {
          // Save to disk via Tauri command (saves to app data dir)
          const result = await invoke<SaveTextResponse>('save_pasted_text', {
            content: text,
          })

          // Add to pending text files
          const { addPendingTextFile } = useChatStore.getState()
          addPendingTextFile(activeSessionId, {
            id: result.id,
            path: result.path,
            filename: result.filename,
            size: result.size,
            content: text,
          })
        } catch (error) {
          console.error('Failed to save text file:', error)
          toast.error('Failed to save text file', {
            description: String(error),
          })
        }
      }
    },
    [activeSessionId]
  )

  // Handle file selection from @ mention popover
  const handleFileSelect = useCallback(
    (file: PendingFile) => {
      if (!activeSessionId) return

      const { addPendingFile } = useChatStore.getState()
      addPendingFile(activeSessionId, file)

      // Replace @query with @filename in the input
      const triggerIndex = atTriggerIndex
      if (triggerIndex !== null && inputRef.current) {
        const currentValue = valueRef.current
        const cursorPos = inputRef.current.selectionStart ?? currentValue.length
        const beforeAt = currentValue.slice(0, triggerIndex)
        const afterQuery = currentValue.slice(cursorPos)
        // Get just the filename from the path
        const filename = getFilename(file.relativePath)
        const newValue = `${beforeAt}@${filename} ${afterQuery}`

        // PERFORMANCE: Update DOM directly, no React render
        inputRef.current.value = newValue
        valueRef.current = newValue

        // Set cursor position after the inserted filename
        requestAnimationFrame(() => {
          const newCursorPos = triggerIndex + filename.length + 2 // +2 for @ and space
          inputRef.current?.setSelectionRange(newCursorPos, newCursorPos)
        })
      }

      // Reset file mention state
      setFileMentionOpen(false)
      setAtTriggerIndex(null)
      setFileMentionQuery('')

      // Refocus input
      inputRef.current?.focus()
    },
    [activeSessionId, atTriggerIndex, inputRef]
  )

  // Handle skill selection from / mention popover
  const handleSkillSelect = useCallback(
    (skill: PendingSkill) => {
      if (!activeSessionId) return

      const { addPendingSkill } = useChatStore.getState()
      addPendingSkill(activeSessionId, skill)

      // Remove the /query text from input (skill shows as badge only, like images)
      const triggerIndex = slashTriggerIndex
      if (triggerIndex !== null && inputRef.current) {
        const currentValue = valueRef.current
        const cursorPos = inputRef.current.selectionStart ?? currentValue.length
        const beforeSlash = currentValue.slice(0, triggerIndex)
        const afterQuery = currentValue.slice(cursorPos)
        const newValue = beforeSlash + afterQuery

        // PERFORMANCE: Update DOM directly, no React render
        inputRef.current.value = newValue
        valueRef.current = newValue

        // Set cursor position where the slash was
        requestAnimationFrame(() => {
          inputRef.current?.setSelectionRange(triggerIndex, triggerIndex)
        })
      }

      // Reset slash popover state
      setSlashPopoverOpen(false)
      setSlashTriggerIndex(null)
      setSlashQuery('')

      // Refocus input
      inputRef.current?.focus()
    },
    [activeSessionId, slashTriggerIndex, inputRef]
  )

  // Handle command selection from / mention popover (executes immediately)
  const handleCommandSelect = useCallback(
    (command: ClaudeCommand) => {
      // Clear input
      if (inputRef.current) {
        inputRef.current.value = ''
        valueRef.current = ''
        inputRef.current.style.height = 'auto'
      }

      // Reset slash popover state
      setSlashPopoverOpen(false)
      setSlashTriggerIndex(null)
      setSlashQuery('')
      setShowHint(true)

      // Notify parent to execute command
      onCommandExecute?.(`/${command.name}`)
    },
    [inputRef, onCommandExecute]
  )

  // Determine if slash is at prompt start (for enabling commands)
  const isSlashAtPromptStart =
    slashTriggerIndex !== null &&
    (slashTriggerIndex === 0 ||
      valueRef.current.slice(0, slashTriggerIndex).trim() === '')

  return (
    <div className="relative">
      <Textarea
        ref={inputRef}
        placeholder={
          isSending
            ? 'Type to queue next message...'
            : executionMode === 'plan'
              ? 'Plan a task, @mention files...'
              : executionMode === 'yolo'
                ? 'What do you want Claude to do? (no restrictions!)...'
                : 'Ask to make changes, @mention files...'
        }
        // PERFORMANCE: Uncontrolled input - no value prop
        // Value is managed via valueRef and direct DOM manipulation
        defaultValue=""
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        disabled={false}
        className="min-h-[60px] max-h-[200px] w-full resize-none border-0 bg-transparent dark:bg-transparent p-0 font-mono text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        rows={2}
        autoFocus
      />
      {showHint && (
        <span className="absolute top-0 right-0 flex items-center gap-1.5 text-xs text-muted-foreground opacity-40">
          <Kbd>{focusChatShortcut}</Kbd>
          <span>to focus</span>
        </span>
      )}

      {/* File mention popover (@ mentions) */}
      <FileMentionPopover
        worktreePath={activeWorktreePath ?? null}
        open={fileMentionOpen}
        onOpenChange={setFileMentionOpen}
        onSelectFile={handleFileSelect}
        searchQuery={fileMentionQuery}
        anchorPosition={fileMentionAnchor}
        containerRef={formRef}
        handleRef={fileMentionHandleRef}
      />

      {/* Slash popover (/ commands and skills) */}
      <SlashPopover
        open={slashPopoverOpen}
        onOpenChange={setSlashPopoverOpen}
        onSelectSkill={handleSkillSelect}
        onSelectCommand={handleCommandSelect}
        searchQuery={slashQuery}
        anchorPosition={slashAnchor}
        isAtPromptStart={isSlashAtPromptStart}
        handleRef={slashPopoverHandleRef}
      />
    </div>
  )
})
