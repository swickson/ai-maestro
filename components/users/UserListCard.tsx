'use client'

import { Shield, Globe, Trash2 } from 'lucide-react'
import type { UserRecord } from '@/types/user'

interface UserListCardProps {
  user: UserRecord
  onClick: () => void
  onDelete: () => void
}

const platformIcons: Record<string, string> = {
  discord: 'Discord',
  slack: 'Slack',
  email: 'Email',
}

export default function UserListCard({ user, onClick, onDelete }: UserListCardProps) {
  return (
    <div
      onClick={onClick}
      className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-600 transition-all cursor-pointer group"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-amber-600/20 flex items-center justify-center text-amber-400 text-sm font-medium">
            {user.displayName.charAt(0).toUpperCase()}
          </div>
          <div>
            <h3 className="text-sm font-medium text-white">{user.displayName}</h3>
            {user.aliases.length > 0 && (
              <p className="text-[10px] text-gray-500">{user.aliases.join(', ')}</p>
            )}
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="p-1 rounded hover:bg-gray-800 text-gray-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
          title="Delete user"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-2 mb-3">
        <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
          user.role === 'operator'
            ? 'bg-amber-600/20 text-amber-400'
            : 'bg-gray-700/50 text-gray-400'
        }`}>
          {user.role === 'operator' ? <Shield className="w-2.5 h-2.5" /> : <Globe className="w-2.5 h-2.5" />}
          {user.role}
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
          user.trustLevel === 'full'
            ? 'bg-green-600/20 text-green-400'
            : 'bg-red-600/20 text-red-400'
        }`}>
          trust: {user.trustLevel}
        </span>
      </div>

      {user.platforms.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {user.platforms.map((p, i) => (
            <span
              key={i}
              className="text-[10px] px-1.5 py-0.5 bg-gray-800 text-gray-400 rounded"
              title={`${p.handle} (${p.platformUserId})`}
            >
              {platformIcons[p.type] || p.type}: {p.handle}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
