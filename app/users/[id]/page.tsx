'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Contact, Save, Plus, X, Shield, Globe, Trash2 } from 'lucide-react'
import { VersionChecker } from '@/components/VersionChecker'
import type { UserRecord, UserPlatformMapping, UserRole, UserTrustLevel } from '@/types/user'

export default function UserDetailPage() {
  const params = useParams()
  const router = useRouter()
  const userId = params.id as string

  const [user, setUser] = useState<UserRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Editable fields
  const [displayName, setDisplayName] = useState('')
  const [aliases, setAliases] = useState<string[]>([])
  const [newAlias, setNewAlias] = useState('')
  const [role, setRole] = useState<UserRole>('external')
  const [trustLevel, setTrustLevel] = useState<UserTrustLevel>('none')
  const [preferredPlatform, setPreferredPlatform] = useState('')
  const [platforms, setPlatforms] = useState<UserPlatformMapping[]>([])

  // Add platform dialog
  const [addingPlatform, setAddingPlatform] = useState(false)
  const [newPlatformType, setNewPlatformType] = useState('discord')
  const [newPlatformUserId, setNewPlatformUserId] = useState('')
  const [newPlatformHandle, setNewPlatformHandle] = useState('')

  const fetchUser = useCallback(async () => {
    try {
      const res = await fetch(`/api/users/${userId}`)
      if (!res.ok) {
        setError('User not found')
        return
      }
      const data = await res.json()
      const u: UserRecord = data.user
      setUser(u)
      setDisplayName(u.displayName)
      setAliases([...u.aliases])
      setRole(u.role)
      setTrustLevel(u.trustLevel)
      setPreferredPlatform(u.preferredPlatform || '')
      setPlatforms([...u.platforms])
    } catch (err) {
      setError('Failed to load user')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => { fetchUser() }, [fetchUser])

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName,
          aliases,
          role,
          trustLevel,
          preferredPlatform: preferredPlatform || undefined,
          platforms,
        }),
      })
      if (!res.ok) {
        const errData = await res.json()
        throw new Error(errData.error || 'Failed to save')
      }
      const data = await res.json()
      setUser(data.user)
    } catch (err) {
      console.error('Failed to save user:', err)
    } finally {
      setSaving(false)
    }
  }

  const addAlias = () => {
    const trimmed = newAlias.trim().toLowerCase()
    if (trimmed && !aliases.includes(trimmed)) {
      setAliases([...aliases, trimmed])
      setNewAlias('')
    }
  }

  const removeAlias = (alias: string) => {
    setAliases(aliases.filter(a => a !== alias))
  }

  const addPlatform = () => {
    if (!newPlatformUserId.trim() || !newPlatformHandle.trim()) return
    setPlatforms([...platforms, {
      type: newPlatformType,
      platformUserId: newPlatformUserId.trim(),
      handle: newPlatformHandle.trim(),
    }])
    setNewPlatformType('discord')
    setNewPlatformUserId('')
    setNewPlatformHandle('')
    setAddingPlatform(false)
  }

  const removePlatform = (index: number) => {
    setPlatforms(platforms.filter((_, i) => i !== index))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950">
        <div className="w-8 h-8 border-4 border-amber-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error || !user) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-gray-950 text-white">
        <p className="text-gray-400 mb-4">{error || 'User not found'}</p>
        <Link href="/users" className="text-amber-400 hover:text-amber-300 text-sm">Back to Users</Link>
      </div>
    )
  }

  const hasChanges =
    displayName !== user.displayName ||
    JSON.stringify(aliases) !== JSON.stringify(user.aliases) ||
    role !== user.role ||
    trustLevel !== user.trustLevel ||
    (preferredPlatform || '') !== (user.preferredPlatform || '') ||
    JSON.stringify(platforms) !== JSON.stringify(user.platforms)

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white">
      {/* Header */}
      <div className="border-b border-gray-800 bg-gray-900/50 backdrop-blur flex-shrink-0">
        <div className="px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/users"
              className="inline-flex items-center gap-2 text-gray-400 hover:text-white transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Users
            </Link>
            <div className="w-px h-5 bg-gray-700" />
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-amber-600/20 flex items-center justify-center text-amber-400 text-xs font-medium">
                {user.displayName.charAt(0).toUpperCase()}
              </div>
              <span className="text-sm font-medium text-white">{user.displayName}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                user.role === 'operator' ? 'bg-amber-600/20 text-amber-400' : 'bg-gray-700/50 text-gray-400'
              }`}>
                {user.role}
              </span>
            </div>
          </div>
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl space-y-6">

          {/* Display Name */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Display Name</label>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500/50"
            />
          </div>

          {/* Role & Trust */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Role</label>
              <div className="flex gap-2">
                {(['operator', 'external'] as const).map(r => (
                  <button
                    key={r}
                    onClick={() => setRole(r)}
                    className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-2 rounded-lg border transition-colors ${
                      role === r
                        ? 'border-amber-500 bg-amber-600/20 text-amber-300'
                        : 'border-gray-700 text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    {r === 'operator' ? <Shield className="w-3 h-3" /> : <Globe className="w-3 h-3" />}
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Trust Level</label>
              <div className="flex gap-2">
                {(['full', 'none'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setTrustLevel(t)}
                    className={`flex-1 text-xs py-2 rounded-lg border transition-colors ${
                      trustLevel === t
                        ? 'border-amber-500 bg-amber-600/20 text-amber-300'
                        : 'border-gray-700 text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Aliases */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Aliases</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {aliases.map(alias => (
                <span
                  key={alias}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-gray-800 text-gray-300 rounded-lg"
                >
                  {alias}
                  <button onClick={() => removeAlias(alias)} className="text-gray-500 hover:text-red-400">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newAlias}
                onChange={e => setNewAlias(e.target.value)}
                placeholder="Add alias..."
                className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50"
                onKeyDown={e => { if (e.key === 'Enter') addAlias() }}
              />
              <button
                onClick={addAlias}
                disabled={!newAlias.trim()}
                className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>

          {/* Preferred Platform */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Preferred Platform</label>
            <select
              value={preferredPlatform}
              onChange={e => setPreferredPlatform(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500/50"
            >
              <option value="">None</option>
              {platforms.map((p, i) => (
                <option key={i} value={p.type}>{p.type} ({p.handle})</option>
              ))}
            </select>
          </div>

          {/* Platform Mappings */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-gray-400">Platform Mappings</label>
              <button
                onClick={() => setAddingPlatform(true)}
                className="flex items-center gap-1 text-[10px] px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded transition-colors"
              >
                <Plus className="w-3 h-3" />
                Add Platform
              </button>
            </div>
            {platforms.length === 0 ? (
              <p className="text-xs text-gray-600 py-4 text-center">No platform mappings yet</p>
            ) : (
              <div className="space-y-2">
                {platforms.map((p, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg px-3 py-2.5"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] px-1.5 py-0.5 bg-gray-800 text-gray-400 rounded font-medium uppercase">
                          {p.type}
                        </span>
                        <span className="text-sm text-white">{p.handle}</span>
                      </div>
                      <p className="text-[10px] text-gray-500 mt-0.5">ID: {p.platformUserId}</p>
                    </div>
                    <button
                      onClick={() => removePlatform(i)}
                      className="p-1 rounded hover:bg-gray-800 text-gray-600 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Last Seen */}
          {user.lastSeenPerPlatform && Object.keys(user.lastSeenPerPlatform).length > 0 && (
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Last Seen</label>
              <div className="space-y-1">
                {Object.entries(user.lastSeenPerPlatform).map(([platform, timestamp]) => (
                  <div key={platform} className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">{platform}</span>
                    <span className="text-gray-500">{new Date(timestamp).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Timestamps */}
          <div className="border-t border-gray-800 pt-4 text-[10px] text-gray-600 space-y-1">
            <p>Created: {new Date(user.createdAt).toLocaleString()}</p>
            <p>Updated: {new Date(user.updatedAt).toLocaleString()}</p>
            <p className="font-mono">ID: {user.id}</p>
          </div>
        </div>
      </div>

      {/* Add Platform Dialog */}
      {addingPlatform && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full mx-4">
            <h4 className="text-sm font-medium text-white mb-4">Add Platform Mapping</h4>
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] text-gray-400 mb-1">Platform</label>
                <select
                  value={newPlatformType}
                  onChange={e => setNewPlatformType(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
                >
                  <option value="discord">Discord</option>
                  <option value="slack">Slack</option>
                  <option value="email">Email</option>
                  <option value="telegram">Telegram</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] text-gray-400 mb-1">Platform User ID</label>
                <input
                  type="text"
                  value={newPlatformUserId}
                  onChange={e => setNewPlatformUserId(e.target.value)}
                  placeholder="e.g., 123456789012345"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label className="block text-[10px] text-gray-400 mb-1">Handle / Username</label>
                <input
                  type="text"
                  value={newPlatformHandle}
                  onChange={e => setNewPlatformHandle(e.target.value)}
                  placeholder="e.g., gosub"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
                  onKeyDown={e => { if (e.key === 'Enter') addPlatform() }}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => { setAddingPlatform(false); setNewPlatformUserId(''); setNewPlatformHandle('') }}
                className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={addPlatform}
                disabled={!newPlatformUserId.trim() || !newPlatformHandle.trim()}
                className="text-xs px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded transition-colors disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-gray-800 bg-gray-950 px-4 py-2 flex-shrink-0">
        <div className="flex flex-col md:flex-row justify-between items-center gap-1 md:gap-0 md:h-5">
          <p className="text-xs md:text-sm text-white leading-none">
            <VersionChecker /> • Made with <span className="text-red-500 text-lg inline-block scale-x-125">&#9829;</span> in Boulder Colorado
          </p>
          <p className="text-xs md:text-sm text-white leading-none">
            Concept by{' '}
            <a href="https://x.com/jkpelaez" target="_blank" rel="noopener noreferrer" className="hover:text-gray-300 transition-colors">
              Juan Pelaez
            </a>{' '}
            @{' '}
            <a href="https://23blocks.com" target="_blank" rel="noopener noreferrer" className="font-semibold text-red-500 hover:text-red-400 transition-colors">
              23blocks
            </a>
            . Coded by Claude
          </p>
        </div>
      </footer>
    </div>
  )
}
