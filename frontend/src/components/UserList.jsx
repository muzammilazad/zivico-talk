import { Circle, Headphones } from "lucide-react";

function avatarFor(user, apiUrl) {
  if (user.isOfficialSupport || user.role === "support") {
    return (
      <span className="avatar support-avatar">
        <Headphones size={20} />
      </span>
    );
  }

  if (user.avatarUrl) {
    const src = user.avatarUrl.startsWith("http") ? user.avatarUrl : `${apiUrl}${user.avatarUrl}`;
    return <img className="avatar image-avatar" src={src} alt={user.name} />;
  }

  return <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>;
}

export default function UserList({
  apiUrl,
  users,
  selectedUser,
  onlineIds,
  unreadCounts,
  latestMessages,
  pendingRequestCount,
  searchValue,
  onAddContact,
  onSearch,
  onShowRequests,
  onSelect
}) {
  return (
    <aside className="user-list">
      <div className="list-header">
        <h2>Chats</h2>
        <div className="list-actions">
          <button type="button" onClick={onAddContact}>
            Add Contact
          </button>
          <button type="button" onClick={onShowRequests}>
            Requests
            {pendingRequestCount > 0 && <span className="request-badge">{pendingRequestCount}</span>}
          </button>
        </div>
      </div>
      <div className="sidebar-search">
        <input
          value={searchValue}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search contacts"
        />
      </div>
      <div className="users">
        {users.length === 0 && <p className="empty-copy">No contacts yet. Add someone by email or phone.</p>}
        {users.map((user) => {
          const userId = String(user.id);
          const isSupport = user.isOfficialSupport || user.role === "support";
          const online = onlineIds.has(user.id) || onlineIds.has(userId);
          const unreadCount = unreadCounts[userId] || 0;
          const preview = latestMessages[userId] || (online ? "Online" : "Offline");

          return (
            <button
              key={user.id}
              type="button"
              className={`user-row ${String(selectedUser?.id) === userId ? "selected" : ""} ${isSupport ? "support-row" : ""}`}
              onClick={() => onSelect(user)}
            >
              {avatarFor(user, apiUrl)}
              <span className="user-main">
                <strong>
                  {user.name}
                  {isSupport && <span className="support-badge">Official Support</span>}
                </strong>
                <small>{preview}</small>
              </span>
              <span className="user-meta">
                {unreadCount > 0 && <span className="unread-badge">{unreadCount}</span>}
                <Circle
                  aria-label={online ? "Online" : "Offline"}
                  className={online ? "presence online" : "presence"}
                  size={10}
                  fill="currentColor"
                />
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
