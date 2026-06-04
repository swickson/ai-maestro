'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Plus, Contact, Search } from 'lucide-react'
import UserListCard from '@/components/users/UserListCard'
import { VersionChecker } from '@/components/VersionChecker'
import type { UserRecord } from '@/types/user'

export default function UsersPage() {
  const router = useRouter()
  const [users, setUsers] = useState<UserRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newDisplayName, setNewDisplayName] = useState('')
  const [newRole, setNewRole] = useState<'operator' | 'external'>('external')
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<'' | 'operator' | 'external'>('')

  const fetchUsers = useCallback(async () => {
    try {
      const url = roleFilter ? `/api/users?role=${roleFilter}` : '/api/users'
      const res = await fetch(url)
      if (!res.ok) return
      const data = await res.json()
      setUsers(data.users || [])
    } catch (err) {
      console.error('Failed to fetch users:', err)
    } finally {
      setLoading(false)
    }
  }, [roleFilter])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  const handleCreate = async () => {
    if (!newDisplayName.trim()) return
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: newDisplayName.trim(),
          role: newRole,
          trustLevel: newRole === 'operator' ? 'full' : 'none',
          aliases: [],
          platforms: [],
        }),
      })
      if (!res.ok) {
        const errData = await res.json()
        throw new Error(errData.error || 'Failed to create user')
      }
      const data = await res.json()
      setNewDisplayName('')
      setCreating(false)
      router.push(`/users/${data.user.id}`)
    } catch (err) {
      console.error('Failed to create user:', err)
    }
  }

  const handleDelete = async (userId: string) => {
    try {
      const res = await fetch(`/api/users/${userId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete user')
      setUsers(prev => prev.filter(u => u.id !== userId))
      setDeleteConfirm(null)
    } catch (err) {
      console.error('Failed to delete user:', err)
    }
  }

  const filtered = users.filter(u => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      u.displayName.toLowerCase().includes(q) ||
      u.aliases.some(a => a.toLowerCase().includes(q)) ||
      u.platforms.some(p => p.handle.toLowerCase().includes(q) || p.type.toLowerCase().includes(q))
    )
  })

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white">
      {/* Header */}
      <div className="border-b border-gray-800 bg-gray-900/50 backdrop-blur flex-shrink-0">
        <div className="px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-gray-400 hover:text-white transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Dashboard
            </Link>
            <div className="w-px h-5 bg-gray-700" />
            <div className="flex items-center gap-2">
              <Contact className="w-4 h-4 text-amber-400" />
              <span className="text-sm font-medium text-white">Users</span>
              <span className="text-xs text-gray-500">({users.length})</span>
            </div>
          </div>
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add User
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="border-b border-gray-800/50 px-6 py-3 flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search users..."
            className="w-full bg-gray-900 border border-gray-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50"
          />
        </div>
        <div className="flex gap-1.5">
          {(['', 'operator', 'external'] as const).map(role => (
            <button
              key={role}
              onClick={() => { setRoleFilter(role); setLoading(true) }}
              className={`text-[10px] px-2 py-1 rounded-full transition-colors ${
                roleFilter === role
                  ? 'bg-amber-600/30 text-amber-300'
                  : 'text-gray-500 hover:bg-gray-800 hover:text-gray-300'
              }`}
            >
              {role || 'All'}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-8 h-8 border-4 border-amber-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-amber-600/10 flex items-center justify-center">
              <Contact className="w-8 h-8 text-amber-400" />
            </div>
            <h2 className="text-lg font-medium text-white mb-2">
              {search ? 'No matching users' : 'No users yet'}
            </h2>
            <p className="text-sm text-gray-500 mb-6">
              {search ? 'Try a different search term' : 'Add users to manage identity resolution and message routing'}
            </p>
            {!search && (
              <button
                onClick={() => setCreating(true)}
                className="inline-flex items-center gap-1.5 text-sm px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add First User
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-5xl">
            {filtered.map(user => (
              <UserListCard
                key={user.id}
                user={user}
                onClick={() => router.push(`/users/${user.id}`)}
                onDelete={() => setDeleteConfirm(user.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Create User Dialog */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full mx-4">
            <h4 className="text-sm font-medium text-white mb-4">Add User</h4>
            <input
              type="text"
              value={newDisplayName}
              onChange={e => setNewDisplayName(e.target.value)}
              placeholder="Display name..."
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500 mb-3"
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false) }}
            />
            <div className="flex gap-2 mb-4">
              {(['operator', 'external'] as const).map(role => (
                <button
                  key={role}
                  onClick={() => setNewRole(role)}
                  className={`flex-1 text-xs py-1.5 rounded-lg border transition-colors ${
                    newRole === role
                      ? 'border-amber-500 bg-amber-600/20 text-amber-300'
                      : 'border-gray-700 text-gray-400 hover:border-gray-600'
                  }`}
                >
                  {role}
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setCreating(false); setNewDisplayName('') }}
                className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!newDisplayName.trim()}
                className="text-xs px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded transition-colors disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full mx-4">
            <h4 className="text-sm font-medium text-white mb-2">Delete User</h4>
            <p className="text-xs text-gray-400 mb-4">Are you sure? This will remove the user from the directory.</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                className="text-xs px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
              >
                Delete
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
