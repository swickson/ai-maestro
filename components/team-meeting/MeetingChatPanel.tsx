'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Send, Users, User, AlertTriangle, Play } from 'lucide-react'
import type { Agent } from '@/types/agent'

interface ChatMessage {
  id: string
  from: string
  fromAlias?: string
  fromLabel?: string
  to: string
  toAlias?: string
  timestamp: string
  subject: string
  preview: string
  isMine: boolean
  displayFrom: string
}

interface LoopGuardStatus {
  hopCount: number
  maxHops: number
  paused: boolean
}

interface MeetingChatPanelProps {
  agents: Agent[]
  messages: ChatMessage[]
  meetingId?: string
  onSendToAgent: (agentId: string, message: string) => Promise<void>
  onBroadcastToAll: (message: string) => Promise<void>
  onContinue?: () => Promise<void>
}

export default function MeetingChatPanel({ agents, messages, meetingId, onSendToAgent, onBroadcastToAll, onContinue }: MeetingChatPanelProps) {
  const [recipient, setRecipient] = useState<string>('all')
  const [inputText, setInputText] = useState('')
  const [sending, setSending] = useState(false)
  const [loopGuard, setLoopGuard] = useState<LoopGuardStatus | null>(null)
  const [presence, setPresence] = useState<Record<string, { status: string; lastActivity?: string }>>({})
  const [showMentions, setShowMentions] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  // Poll loop guard status and agent presence
  useEffect(() => {
    if (!meetingId) return
    const poll = async () => {
      try {
        const [guardRes, presenceRes] = await Promise.all([
          fetch(`/api/meetings/${meetingId}/loop-guard`),
          fetch(`/api/meetings/${meetingId}/presence`),
        ])
        if (guardRes.ok) setLoopGuard(await guardRes.json())
        if (presenceRes.ok) {
          const data = await presenceRes.json()
          setPresence(data.agents || {})
        }
      } catch { /* ignore */ }
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [meetingId])

  // Build agent name list for @mention autocomplete
  const agentNames = useMemo(() =>
    agents.map(a => ({
      id: a.id,
      name: a.name || a.id,
      label: a.label || a.alias || a.name || a.id.slice(0, 8),
    })),
    [agents]
  )

  // Filter agents for autocomplete dropdown
  const filteredMentions = useMemo(() => {
    if (!mentionFilter) return [{ id: 'all', name: 'all', label: 'All Agents' }, ...agentNames]
    const lower = mentionFilter.toLowerCase()
    const matches = agentNames.filter(a =>
      a.name.toLowerCase().includes(lower) || a.label.toLowerCase().includes(lower)
    )
    // Include @all if it matches the filter
    if ('all'.includes(lower)) {
      matches.unshift({ id: 'all', name: 'all', label: 'All Agents' })
    }
    return matches
  }, [agentNames, mentionFilter])

  // Handle @mention insertion
  const insertMention = useCallback((name: string) => {
    const textarea = inputRef.current
    if (!textarea) return

    // Find the @ trigger position
    const cursorPos = textarea.selectionStart
    const textBefore = inputText.slice(0, cursorPos)
    const atIndex = textBefore.lastIndexOf('@')

    if (atIndex >= 0) {
      const before = inputText.slice(0, atIndex)
      const after = inputText.slice(cursorPos)
      const newText = `${before}@${name} ${after}`
      setInputText(newText)
      // Set cursor after the inserted mention
      setTimeout(() => {
        const newPos = atIndex + name.length + 2
        textarea.setSelectionRange(newPos, newPos)
        textarea.focus()
      }, 0)
    }

    setShowMentions(false)
    setMentionFilter('')
    setMentionIndex(0)
  }, [inputText])

  // Detect @ typing for autocomplete
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    setInputText(text)

    // Check if user is typing an @mention
    const cursorPos = e.target.selectionStart
    const textBefore = text.slice(0, cursorPos)
    const atIndex = textBefore.lastIndexOf('@')

    if (atIndex >= 0 && (atIndex === 0 || textBefore[atIndex - 1] === ' ')) {
      const partial = textBefore.slice(atIndex + 1)
      // Only show if no space after @ (still typing the mention)
      if (!partial.includes(' ')) {
        setShowMentions(true)
        setMentionFilter(partial)
        setMentionIndex(0)
        return
      }
    }

    setShowMentions(false)
  }

  const handleSend = async () => {
    const text = inputText.trim()
    if (!text || sending) return

    // Handle /continue command
    if (text.toLowerCase() === '/continue') {
      setSending(true)
      try {
        if (onContinue) {
          await onContinue()
        }
        setInputText('')
      } finally {
        setSending(false)
      }
      return
    }

    setSending(true)
    try {
      if (recipient === 'all') {
        await onBroadcastToAll(text)
      } else {
        await onSendToAgent(recipient, text)
      }
      setInputText('')
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle mention autocomplete navigation
    if (showMentions && filteredMentions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex(i => Math.min(i + 1, filteredMentions.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex(i => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        if (showMentions) {
          e.preventDefault()
          insertMention(filteredMentions[mentionIndex].name)
          return
        }
      }
      if (e.key === 'Escape') {
        setShowMentions(false)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Filter messages based on selected recipient
  const filteredMessages = recipient === 'all'
    ? messages
    : messages.filter(m =>
        m.from === recipient || m.to === recipient ||
        m.fromAlias === recipient || m.toAlias === recipient
      )

  return (
    <div className="flex flex-col h-full">
      {/* Recipient selector */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-800 overflow-x-auto">
        <button
          onClick={() => setRecipient('all')}
          className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-full whitespace-nowrap transition-colors ${
            recipient === 'all'
              ? 'bg-emerald-600/30 text-emerald-300'
              : 'text-gray-500 hover:bg-gray-800 hover:text-gray-300'
          }`}
        >
          <Users className="w-3 h-3" />
          All
        </button>
        {agents.map(agent => {
          const name = agent.label || agent.name || agent.alias || agent.id.slice(0, 8)
          const agentPresence = presence[agent.id]
          const statusColor = agentPresence?.status === 'working' ? 'bg-yellow-400'
            : agentPresence?.status === 'active' ? 'bg-green-400'
            : agentPresence?.status === 'idle' ? 'bg-blue-400'
            : agentPresence?.status === 'online' ? 'bg-green-400'
            : 'bg-gray-600'
          const statusTitle = agentPresence?.status || 'unknown'
          return (
            <button
              key={agent.id}
              onClick={() => setRecipient(agent.id)}
              title={statusTitle}
              className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-full whitespace-nowrap transition-colors ${
                recipient === agent.id
                  ? 'bg-blue-600/30 text-blue-300'
                  : 'text-gray-500 hover:bg-gray-800 hover:text-gray-300'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${statusColor} flex-shrink-0`} />
              {name.length > 15 ? name.slice(0, 15) + '...' : name}
            </button>
          )
        })}
      </div>

      {/* Loop guard status banner */}
      {loopGuard?.paused && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-900/30 border-b border-yellow-800/50 text-yellow-300 text-[11px]">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>Loop guard paused at {loopGuard.hopCount}/{loopGuard.maxHops} hops.</span>
          <button
            onClick={() => {
              if (onContinue) onContinue()
            }}
            className="flex items-center gap-1 px-2 py-0.5 bg-yellow-700/50 hover:bg-yellow-700 rounded text-yellow-200 transition-colors"
          >
            <Play className="w-3 h-3" />
            /continue
          </button>
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {filteredMessages.length === 0 && (
          <p className="text-[11px] text-gray-600 text-center py-8">
            No messages yet. Use @agent-name to mention specific agents, or @all for everyone.
          </p>
        )}
        {filteredMessages.map(msg => {
          // System messages (join/leave) get distinct styling
          const isSystem = msg.from === 'system' || msg.displayFrom === 'System'
          if (isSystem) {
            return (
              <div key={msg.id} className="flex justify-center py-1">
                <span className="text-[10px] text-gray-500 italic">
                  {msg.preview}
                </span>
              </div>
            )
          }

          return (
            <div
              key={msg.id}
              className={`flex flex-col ${msg.isMine ? 'items-end' : 'items-start'}`}
            >
              <span className="text-[9px] text-gray-600 mb-0.5">
                {msg.displayFrom}{msg.isMine ? <span className="ml-1 text-emerald-500/70">(you)</span> : ''} {msg.toAlias ? `→ ${msg.toAlias}` : ''}
              </span>
              <div
                className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
                  msg.isMine
                    ? 'bg-emerald-600/30 text-emerald-100'
                    : 'bg-gray-800 text-gray-300'
                }`}
              >
                {msg.preview}
              </div>
              <span className="text-[9px] text-gray-700 mt-0.5">
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          )
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Compose area */}
      <div className="px-3 py-2 border-t border-gray-800 relative">
        {/* @mention autocomplete dropdown */}
        {showMentions && filteredMentions.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl max-h-40 overflow-y-auto z-20">
            {filteredMentions.map((agent, i) => (
              <div
                key={agent.id}
                onClick={() => insertMention(agent.name)}
                className={`px-3 py-1.5 text-[11px] cursor-pointer flex items-center gap-2 ${
                  i === mentionIndex
                    ? 'bg-blue-600/30 text-blue-200'
                    : 'text-gray-300 hover:bg-gray-700'
                }`}
              >
                {agent.id === 'all' ? (
                  <Users className="w-3 h-3 text-emerald-400" />
                ) : (
                  <User className="w-3 h-3 text-blue-400" />
                )}
                <span className="font-medium">@{agent.name}</span>
                {agent.label !== agent.name && (
                  <span className="text-gray-500">{agent.label}</span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onBlur={() => setTimeout(() => setShowMentions(false), 200)}
            placeholder="Type @ to mention agents, /continue to resume..."
            rows={1}
            className="flex-1 text-xs bg-gray-800/50 text-gray-200 placeholder-gray-600 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-gray-600 max-h-20"
            style={{ minHeight: '36px' }}
          />
          <button
            onClick={handleSend}
            disabled={!inputText.trim() || sending}
            className="p-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
