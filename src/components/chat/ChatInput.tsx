import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useIsMobile } from '@/hooks/use-mobile'
import { invoke } from '@/lib/transport'
import { generateId } from '@/lib/uuid'
import { toast } from 'sonner'
import { Textarea } from '@/components/ui/textarea'
import { Kbd } from '@/components/ui/kbd'
import { useChatStore } from '@/store/chat-store'
import { getFilename, getExtension } from '@/lib/path-utils'
import type {
  PendingFile,
  PendingSkill,
  ClaudeCommand,
  SaveImageResponse,
  SaveTextResponse,
  ReadTextResponse,
  ExecutionMode,
} from '@/types/chat'
import {
  FileMentionPopover,
  type FileMentionPopoverHandle,
} from './FileMentionPopover'
import { queryClient } from '@/lib/query-client'
import { fileQueryKeys } from '@/services/files'
import type { WorktreeFile } from '@/types/chat'
import { SlashPopover, type SlashPopoverHandle } from './SlashPopover'

import { MAX_IMAGE_SIZE, ALLOWED_IMAGE_TYPES } from './image-constants'

/** Maximum text file size in bytes (10MB) */
const MAX_TEXT_SIZE = 10 * 1024 * 1024

/** Threshold for saving pasted text as file (2000 chars) */
const TEXT_PASTE_THRESHOLD = 2000

interface ChatInputProps {
  activeSessionId: string | undefined
  activeWorktreePath: string | undefined
  isSending: boolean
  executionMode: ExecutionMode
  canSwitchBackendWithTab?: boolean
  focusChatShortcut: string
  onSubmit: (e: React.FormEvent) => void
  onCancel: () => void
  onSwitchBackendWithTab?: () => void
  onCommandExecute?: (command: ClaudeCommand) => void
  onHasValueChange?: (hasValue: boolean) => void
  onRegisterClearHandler?: (clearHandler: (() => void) | null) => void
  formRef: React.RefObject<HTMLFormElement | null>
  inputRef: React.RefObject<HTMLTextAreaElement | null>
}

export const ChatInput = memo(function ChatInput({
  activeSessionId,
  activeWorktreePath,
  isSending,
  executionMode,
  canSwitchBackendWithTab = false,
  focusChatShortcut,
  onSubmit,
  onCancel,
  onSwitchBackendWithTab,
  onCommandExecute,
  onHasValueChange,
  onRegisterClearHandler,
  formRef,
  inputRef,
}: ChatInputProps) {
  const isMobile = useIsMobile()

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
    containerWidth: number
  } | null>(null)
  const [atTriggerIndex, setAtTriggerIndex] = useState<number | null>(null)

  // Slash popover state (for / commands and skills)
  const [slashPopoverOpen, setSlashPopoverOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashAnchor, setSlashAnchor] = useState<{
    top: number
    left: number
  } | null>(null)
  const [slashTriggerIndex, setSlashTriggerIndex] = useState<number | null>(
    null
  )

  // Refs to expose navigation methods from popovers
  const fileMentionHandleRef = useRef<FileMentionPopoverHandle | null>(null)
  const slashPopoverHandleRef = useRef<SlashPopoverHandle | null>(null)

  // Stable ref for parent callback to avoid re-subscribing effects
  const onHasValueChangeRef = useRef(onHasValueChange)
  useEffect(() => {
    onHasValueChangeRef.current = onHasValueChange
  }, [onHasValueChange])

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
    onHasValueChangeRef.current?.(Boolean(draft.trim()))

    // Only update showHint if session actually changed (not on mount)
    if (lastSessionRef.current !== activeSessionId) {
      lastSessionRef.current = activeSessionId
      // Use requestAnimationFrame to avoid setState-in-effect lint warning
      requestAnimationFrame(() => setShowHint(!draft.trim()))
    }

    if (inputRef.current) {
      inputRef.current.value = draft
    }
  }, [activeSessionId, inputRef])

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
        // Cancel pending debounced writes so cleared drafts don't get restored.
        clearTimeout(debouncedSaveRef.current)
        inputRef.current.value = ''
        valueRef.current = ''
        setShowHint(true)
        onHasValueChangeRef.current?.(false)
      }

      // React to external restores (draft went from empty to non-empty)
      // This handles message restoration after instant cancellation
      if (!prevDraft && draft && inputRef.current && !inputRef.current.value) {
        inputRef.current.value = draft
        valueRef.current = draft
        setShowHint(false)
        onHasValueChangeRef.current?.(true)
      }
    })
  }, [activeSessionId, inputRef])

  const clearInputState = useCallback(() => {
    clearTimeout(debouncedSaveRef.current)
    if (inputRef.current) {
      inputRef.current.value = ''
    }
    valueRef.current = ''
    setShowHint(true)
    onHasValueChangeRef.current?.(false)
  }, [inputRef])

  useEffect(() => {
    onRegisterClearHandler?.(clearInputState)
    return () => onRegisterClearHandler?.(null)
  }, [clearInputState, onRegisterClearHandler])

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
      const isEmpty = !value.trim()
      setShowHint(prev => (prev !== isEmpty ? isEmpty : prev))
      // Notify parent of hasValue change for send button styling
      onHasValueChangeRef.current?.(!isEmpty)

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

          // Anchor at the top-left of the form so popover appears above the input
          setFileMentionAnchor({
            top: 0,
            left: 0,
            containerWidth: formRef.current?.offsetWidth ?? 0,
          })
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
      } else if (!fileMentionOpen) {
        // Re-detect @mention: scan backward from cursor for @ preceded by whitespace/start
        // This handles editing an already-completed mention (e.g. backspacing into @filename)
        let scanPos = cursorPos - 1
        while (
          scanPos >= 0 &&
          value[scanPos] !== ' ' &&
          value[scanPos] !== '\n'
        ) {
          if (value[scanPos] === '@') {
            const charBefore = value[scanPos - 1]
            if (scanPos === 0 || charBefore === ' ' || charBefore === '\n') {
              const query = value.slice(scanPos + 1, cursorPos)
              setAtTriggerIndex(scanPos)
              setFileMentionQuery(query)
              setFileMentionOpen(true)
              // Anchor at the top-left of the form so popover appears above the input
              setFileMentionAnchor({
                top: 0,
                left: 0,
                containerWidth: formRef.current?.offsetWidth ?? 0,
              })
            }
            break
          }
          scanPos--
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

            // Anchor at the top-left of the form so popover appears above the input
            setSlashAnchor({ top: 0, left: 16 })
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
    },
    [
      activeSessionId,
      atTriggerIndex,
      fileMentionOpen,
      slashTriggerIndex,
      slashPopoverOpen,
    ]
  )

  // Handle keyboard events
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // When file mention popover is open, handle navigation
      if (fileMentionOpen) {
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault()
            fileMentionHandleRef.current?.moveDown()
            return
          case 'ArrowUp':
            e.preventDefault()
            fileMentionHandleRef.current?.moveUp()
            return
          case 'Enter':
          case 'Tab':
            e.preventDefault()
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
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault()
            slashPopoverHandleRef.current?.moveDown()
            return
          case 'ArrowUp':
            e.preventDefault()
            slashPopoverHandleRef.current?.moveUp()
            return
          case 'Enter':
          case 'Tab':
            e.preventDefault()
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

      // TAB toggles Claude/Codex backend when available.
      // Keep Shift+Tab for global "cycle execution mode" keybinding.
      if (
        e.key === 'Tab' &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        canSwitchBackendWithTab &&
        onSwitchBackendWithTab
      ) {
        e.preventDefault()
        onSwitchBackendWithTab()
        return
      }

      // Fallback cancel shortcut handling while input is focused.
      // Global listeners should handle this already, but this avoids misses when
      // keybinding state is stale or a platform reports forward-delete.
      if (
        isSending &&
        (e.metaKey || e.ctrlKey) &&
        e.altKey &&
        (e.key === 'Backspace' || e.key === 'Delete')
      ) {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }

      // Enter without shift sends the message (on mobile, Enter adds a newline instead)
      if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
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
      }
      // Shift+Enter adds a new line (default behavior)
    },
    [
      activeSessionId,
      fileMentionOpen,
      slashPopoverOpen,
      isSending,
      onCancel,
      onSubmit,
      canSwitchBackendWithTab,
      onSwitchBackendWithTab,
      isMobile,
    ]
  )

  // Handle paste events
  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      if (!activeSessionId) return

      // Check for jean-prompt clipboard format (copied from a sent message)
      const html = e.clipboardData?.getData('text/html')
      if (html) {
        const match = html.match(/data-jean-prompt="([^"]+)"/)
        if (match?.[1]) {
          // Read text synchronously before preventDefault - clipboardData
          // is only available during the event handler, not after await
          const text = e.clipboardData?.getData('text/plain') ?? ''
          e.preventDefault()
          try {
            const metadata = JSON.parse(decodeURIComponent(match[1])) as {
              images?: string[]
              textFiles?: string[]
              files?: string[]
              skills?: { name: string; path: string }[]
            }

            // Insert the plain text into the textarea first
            if (text && inputRef.current) {
              const textarea = inputRef.current
              const start = textarea.selectionStart
              const end = textarea.selectionEnd
              const current = textarea.value
              textarea.value =
                current.slice(0, start) + text + current.slice(end)
              valueRef.current = textarea.value
              textarea.selectionStart = textarea.selectionEnd =
                start + text.length
              // Save draft
              useChatStore
                .getState()
                .setInputDraft(activeSessionId, textarea.value)
              onHasValueChangeRef.current?.(Boolean(textarea.value.trim()))
            }

            const {
              addPendingImage,
              addPendingFile,
              addPendingSkill,
              addPendingTextFile,
            } = useChatStore.getState()

            // Restore images (they already exist on disk)
            for (const path of metadata.images ?? []) {
              addPendingImage(activeSessionId, {
                id: generateId(),
                path,
                filename: getFilename(path),
              })
            }

            // Restore text files (read content from disk)
            for (const path of metadata.textFiles ?? []) {
              try {
                const response = await invoke<ReadTextResponse>(
                  'read_pasted_text',
                  { path }
                )
                addPendingTextFile(activeSessionId, {
                  id: generateId(),
                  path,
                  filename: getFilename(path),
                  size: response.size,
                  content: response.content,
                })
              } catch {
                // File may no longer exist, skip
              }
            }

            // Restore file mentions
            for (const path of metadata.files ?? []) {
              addPendingFile(activeSessionId, {
                id: generateId(),
                relativePath: path,
                extension: getExtension(path),
                isDirectory: false,
              })
            }

            // Restore skills
            for (const skill of metadata.skills ?? []) {
              addPendingSkill(activeSessionId, {
                id: generateId(),
                name: skill.name,
                path: skill.path,
              })
            }
          } catch {
            // Invalid JSON, fall through to normal paste
          }
          return
        }
      }

      const items = e.clipboardData?.items
      if (!items) return

      // First, check for image items in the clipboard
      let hasImage = false
      for (const item of items) {
        if (!item.type.startsWith('image/')) continue
        hasImage = true

        // SVGs are XML text — route through text file path instead of raster image pipeline
        if (item.type === 'image/svg+xml') {
          const file = item.getAsFile()
          if (!file) continue
          e.preventDefault()

          try {
            const svgText = await file.text()
            const result = await invoke<SaveTextResponse>('save_pasted_text', {
              content: svgText,
            })
            const { addPendingTextFile } = useChatStore.getState()
            addPendingTextFile(activeSessionId, {
              id: result.id,
              path: result.path,
              filename: result.filename,
              size: result.size,
              content: svgText,
            })
          } catch (error) {
            console.error('Failed to save SVG:', error)
            toast.error('Failed to save SVG', {
              description: String(error),
            })
          }
          continue
        }

        // Check if it's an allowed type
        if (!ALLOWED_IMAGE_TYPES.includes(item.type)) {
          toast.error('Unsupported image type', {
            description: `Allowed types: PNG, JPEG, GIF, WebP, SVG`,
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

          // Add loading placeholder immediately
          const placeholderId = `loading-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
          const { addPendingImage, updatePendingImage, removePendingImage } =
            useChatStore.getState()
          addPendingImage(activeSessionId, {
            id: placeholderId,
            path: '',
            filename: 'Processing...',
            loading: true,
          })

          try {
            // Save to disk via Tauri command (resizes/compresses)
            const result = await invoke<SaveImageResponse>(
              'save_pasted_image',
              {
                data: base64Data,
                mimeType: file.type,
              }
            )

            // Replace loading placeholder with actual image
            updatePendingImage(activeSessionId, placeholderId, {
              id: result.id,
              path: result.path,
              filename: result.filename,
              loading: false,
            })
          } catch (error) {
            console.error('Failed to save image:', error)
            removePendingImage(activeSessionId, placeholderId)
            toast.error('Failed to save image', {
              description: String(error),
            })
          }
        }
        reader.readAsDataURL(file)
      }

      // If we handled an image, don't also process text
      if (hasImage) return

      // Native clipboard fallback (Linux/WebKitGTK doesn't expose image items via Web API)
      const clipboardText = e.clipboardData?.getData('text/plain')
      const clipboardHtml = e.clipboardData?.getData('text/html')
      if (!clipboardText && !clipboardHtml) {
        e.preventDefault()
        const placeholderId = `clipboard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const { addPendingImage, updatePendingImage, removePendingImage } =
          useChatStore.getState()
        addPendingImage(activeSessionId, {
          id: placeholderId,
          path: '',
          filename: 'Processing...',
          loading: true,
        })
        try {
          const result = await invoke<SaveImageResponse | null>(
            'read_clipboard_image'
          )
          if (result) {
            updatePendingImage(activeSessionId, placeholderId, {
              id: result.id,
              path: result.path,
              filename: result.filename,
              loading: false,
            })
            return
          }
          // No image in clipboard — remove placeholder
          removePendingImage(activeSessionId, placeholderId)
        } catch (error) {
          console.error('Failed to read clipboard image natively:', error)
          removePendingImage(activeSessionId, placeholderId)
          toast.error('Failed to paste image', {
            description: String(error),
          })
        }
      }

      // Check for large text paste
      const text = clipboardText
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

      // Auto-resolve @file mentions in regular (small) text pastes
      if (text && text.length < TEXT_PASTE_THRESHOLD && activeWorktreePath) {
        const mentionRegex = /@(\S+)/g
        let mentionMatch
        const mentions: string[] = []
        while ((mentionMatch = mentionRegex.exec(text)) !== null) {
          if (mentionMatch[1]) mentions.push(mentionMatch[1])
        }

        if (mentions.length > 0) {
          // Get file list: cache-first, async fallback
          let fileList: WorktreeFile[] | undefined = queryClient.getQueryData(
            fileQueryKeys.worktreeFiles(activeWorktreePath)
          )
          if (!fileList) {
            try {
              fileList = await invoke<WorktreeFile[]>('list_worktree_files', {
                worktreePath: activeWorktreePath,
                maxFiles: 5000,
              })
              queryClient.setQueryData(
                fileQueryKeys.worktreeFiles(activeWorktreePath),
                fileList
              )
            } catch {
              fileList = []
            }
          }

          if (fileList.length > 0) {
            const byFullPath = new Map<string, WorktreeFile>()
            const byFilename = new Map<string, WorktreeFile[]>()
            for (const f of fileList) {
              byFullPath.set(f.relative_path, f)
              const name = getFilename(f.relative_path)
              const arr = byFilename.get(name)
              if (arr) arr.push(f)
              else byFilename.set(name, [f])
            }

            const { addPendingFile } = useChatStore.getState()
            for (const mention of mentions) {
              let resolved = byFullPath.get(mention)
              if (!resolved) {
                const candidates = byFilename.get(mention)
                if (candidates?.length === 1) resolved = candidates[0]
              }
              if (resolved) {
                addPendingFile(activeSessionId, {
                  id: generateId(),
                  relativePath: resolved.relative_path,
                  extension: resolved.extension,
                  isDirectory: resolved.is_dir,
                })
              }
            }
          }
        }
      }
    },
    [activeSessionId, activeWorktreePath, inputRef]
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

        // Cancel pending debounced save (it still has the old "/query" value)
        // and sync cleaned value to store immediately
        clearTimeout(debouncedSaveRef.current)
        useChatStore.getState().setInputDraft(activeSessionId, newValue)
        onHasValueChangeRef.current?.(Boolean(newValue.trim()))

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
      // Cancel pending debounced save (it still has the old "/command" value)
      clearTimeout(debouncedSaveRef.current)

      // Clear input
      if (inputRef.current) {
        inputRef.current.value = ''
        valueRef.current = ''
      }
      if (activeSessionId) {
        useChatStore.getState().setInputDraft(activeSessionId, '')
      }

      // Reset slash popover state
      setSlashPopoverOpen(false)
      setSlashTriggerIndex(null)
      setSlashQuery('')
      setShowHint(true)

      // Notify parent to execute command
      onCommandExecute?.(command)
    },
    [activeSessionId, inputRef, onCommandExecute]
  )

  // Determine if slash is at prompt start (for enabling commands)
  const isSlashAtPromptStart =
    slashTriggerIndex !== null &&
    (slashTriggerIndex === 0 ||
      // eslint-disable-next-line react-hooks/refs
      valueRef.current.slice(0, slashTriggerIndex).trim() === '')

  return (
    <div className="relative">
      <Textarea
        ref={inputRef}
        placeholder={
          isSending
            ? executionMode === 'yolo'
              ? 'Yolo: Type to queue next message...'
              : executionMode === 'plan'
                ? 'Plan: Type to queue next message...'
                : 'Build: Type to queue next message...'
            : executionMode === 'plan'
              ? 'Planning: Plan a task, @mention files...'
              : executionMode === 'yolo'
                ? 'Yolo: No limits, only your imagination and tokens...'
                : 'Build: Ask to make changes, @mention files...'
        }
        // PERFORMANCE: Uncontrolled input - no value prop
        // Value is managed via valueRef and direct DOM manipulation
        defaultValue=""
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        disabled={false}
        className="custom-scrollbar min-h-[40px] max-h-[240px] w-full resize-none overflow-y-auto border-0 bg-transparent dark:bg-transparent p-0 font-mono text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        rows={1}
        autoFocus={!isMobile}
      />
      {showHint && (
        <span className="absolute top-0 right-0 hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground opacity-40">
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
        containerWidth={fileMentionAnchor?.containerWidth}
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
        containerRef={formRef}
        isAtPromptStart={isSlashAtPromptStart}
        worktreePath={activeWorktreePath}
        handleRef={slashPopoverHandleRef}
      />
    </div>
  )
})
