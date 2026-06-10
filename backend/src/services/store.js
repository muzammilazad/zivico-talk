import { prisma } from "./prisma.js";
import { ensureDefaultSupportAccount, ensureSupportContactForUser } from "./defaultAccounts.js";

const messageInclude = {
  reactions: true,
  replyToMessage: {
    include: {
      sender: { select: { id: true, name: true } }
    }
  }
};

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, fcmToken, ...safeUser } = user;
  safeUser.role = safeUser.role === "user" ? "client" : safeUser.role || "client";
  safeUser.isAdmin = safeUser.role === "admin";
  safeUser.isSupport = safeUser.role === "support";
  safeUser.isOfficialSupport = safeUser.role === "support" && Boolean(safeUser.isSystem);
  return safeUser;
}

function normalizeContactRequest(request) {
  if (!request) return null;
  const { sender, receiver, ...rest } = request;
  return {
    ...rest,
    requesterId: request.senderId,
    respondedAt: request.respondedAt || undefined,
    requester: publicUser(sender),
    receiver: publicUser(receiver)
  };
}

function normalizeMessage(message) {
  if (!message) return null;
  const replyToMessage = message.replyToMessage
    ? {
        id: message.replyToMessage.id,
        senderId: message.replyToMessage.senderId,
        senderName: message.replyToMessage.sender?.name || "Zivico user",
        type: message.replyToMessage.type,
        text: message.replyToMessage.text,
        mediaName: message.replyToMessage.mediaName,
        mediaUrl: message.replyToMessage.mediaUrl,
        mediaMimeType: message.replyToMessage.mediaMimeType,
        mediaDurationSeconds: message.replyToMessage.mediaDurationSeconds
      }
    : null;

  return {
    ...message,
    text: message.isDeletedForEveryone ? "" : message.text,
    reactions: message.reactions || [],
    replyToMessage,
    message: message.isDeletedForEveryone ? "" : message.text || "",
    timestamp: message.createdAt,
    createdAt: message.createdAt
  };
}

function normalizeCallEvent(event) {
  if (!event) return null;
  return {
    ...event,
    type: "call_event"
  };
}

export async function findUserByEmail(email) {
  return prisma.user.findUnique({ where: { email: String(email || "").toLowerCase() } });
}

export function isAdminEmail(email) {
  const adminEmails = String(process.env.ADMIN_EMAIL || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return adminEmails.includes(String(email || "").toLowerCase());
}

export async function findUserByPhone(phone) {
  const value = String(phone || "").trim();
  if (!value) return null;
  return prisma.user.findUnique({ where: { phone: value } });
}

export async function findUserById(id) {
  return prisma.user.findUnique({ where: { id: String(id) } });
}

export async function updateUserFcmToken(userId, fcmToken) {
  return prisma.user.update({
    where: { id: String(userId) },
    data: { fcmToken: String(fcmToken) },
    select: { id: true }
  });
}

export async function getUserPushTarget(userId) {
  return prisma.user.findUnique({
    where: { id: String(userId) },
    select: {
      id: true,
      name: true,
      fcmToken: true,
      notifyMessages: true,
      notifyCalls: true
    }
  });
}

export async function createUser(user) {
  return prisma.user.create({
    data: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone || null,
      passwordHash: user.passwordHash,
      role: user.role || "client",
      isSystem: Boolean(user.isSystem),
      avatarUrl: user.avatarUrl || null,
      createdAt: user.createdAt ? new Date(user.createdAt) : undefined
    }
  });
}

export async function ensureAdminRole(user) {
  if (!user) return null;
  if (user.role === "admin" || !isAdminEmail(user.email)) return publicUser(user);
  return publicUser(await prisma.user.update({ where: { id: user.id }, data: { role: "admin" } }));
}

export async function updateUserAvatar(userId, avatarUrl) {
  return publicUser(
    await prisma.user.update({
      where: { id: String(userId) },
      data: { avatarUrl }
    })
  );
}

export async function listUsers() {
  const users = await prisma.user.findMany({ orderBy: { name: "asc" } });
  return users.map(publicUser);
}

export async function updateUserProfile(userId, data) {
  return publicUser(
    await prisma.user.update({
      where: { id: String(userId) },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.phone !== undefined ? { phone: data.phone || null } : {}),
        ...(data.about !== undefined ? { about: data.about || null } : {})
      }
    })
  );
}

export async function updateUserSettings(userId, data) {
  return publicUser(
    await prisma.user.update({
      where: { id: String(userId) },
      data: {
        ...(data.showOnline !== undefined ? { showOnline: Boolean(data.showOnline) } : {}),
        ...(data.showLastSeen !== undefined ? { showLastSeen: Boolean(data.showLastSeen) } : {}),
        ...(data.readReceipts !== undefined ? { readReceipts: Boolean(data.readReceipts) } : {}),
        ...(data.notifyMessages !== undefined ? { notifyMessages: Boolean(data.notifyMessages) } : {}),
        ...(data.notifyCalls !== undefined ? { notifyCalls: Boolean(data.notifyCalls) } : {}),
        ...(data.notifyContacts !== undefined ? { notifyContacts: Boolean(data.notifyContacts) } : {})
      }
    })
  );
}

export async function searchUsers({ query, currentUserId }) {
  const q = String(query || "").trim();
  if (!q) return [];

  const currentUser = await prisma.user.findUnique({ where: { id: String(currentUserId) } });
  const role = currentUser?.role === "user" ? "client" : currentUser?.role || "client";
  const visibleRoleFilter =
    role === "admin"
      ? {}
      : role === "support"
        ? { OR: [{ role: "client" }, { role: "user" }] }
        : { OR: [{ role: "client" }, { role: "user" }] };

  const users = await prisma.user.findMany({
    where: {
      id: { not: String(currentUserId) },
      AND: [visibleRoleFilter, { OR: [{ name: { contains: q } }, { email: { contains: q } }, { phone: { contains: q } }] }]
    },
    orderBy: { name: "asc" },
    take: 8
  });

  return users.map(publicUser);
}

export async function listAcceptedContacts(userId) {
  const currentUser = await prisma.user.findUnique({ where: { id: String(userId) } });
  if (currentUser?.role === "client" || currentUser?.role === "user") {
    await ensureSupportContactForUser(currentUser);
  }

  const contacts = await prisma.contact.findMany({
    where: { userId: String(userId), status: "accepted" },
    include: { contactUser: true },
    orderBy: { createdAt: "desc" }
  });

  const users = contacts.map((contact) => publicUser(contact.contactUser));

  if (currentUser?.role === "client" || currentUser?.role === "user") {
    const support = publicUser(await ensureDefaultSupportAccount());
    if (support && !users.some((user) => String(user.id) === String(support.id))) {
      users.unshift(support);
    }
  }

  return users;
}

export async function getContactStatus(userAId, userBId) {
  if (String(userAId) === String(userBId)) return { status: "self" };

  const contact = await prisma.contact.findFirst({
    where: {
      userId: String(userAId),
      contactUserId: String(userBId),
      status: "accepted"
    }
  });
  if (contact) return { status: "accepted", contact };

  const request = await prisma.contactRequest.findFirst({
    where: {
      status: "pending",
      OR: [
        { senderId: String(userAId), receiverId: String(userBId) },
        { senderId: String(userBId), receiverId: String(userAId) }
      ]
    },
    include: { sender: true, receiver: true },
    orderBy: { createdAt: "desc" }
  });

  if (request) {
    const direction = String(request.senderId) === String(userAId) ? "sent" : "received";
    return { status: "pending", relationshipStatus: `pending_${direction}`, direction, request: normalizeContactRequest(request) };
  }

  const rejectedRequest = await prisma.contactRequest.findFirst({
    where: {
      status: "rejected",
      OR: [
        { senderId: String(userAId), receiverId: String(userBId) },
        { senderId: String(userBId), receiverId: String(userAId) }
      ]
    },
    include: { sender: true, receiver: true },
    orderBy: { respondedAt: "desc" }
  });

  return rejectedRequest
    ? { status: "rejected", relationshipStatus: "rejected", request: normalizeContactRequest(rejectedRequest) }
    : { status: "none", relationshipStatus: "none" };
}

export async function createContactRequest(request) {
  if (String(request.requesterId) === String(request.receiverId)) {
    const error = new Error("You cannot add yourself");
    error.statusCode = 400;
    throw error;
  }

  const contactStatus = await getContactStatus(request.requesterId, request.receiverId);
  if (contactStatus.status === "accepted") {
    const error = new Error("Already contacts");
    error.statusCode = 409;
    throw error;
  }
  if (contactStatus.status === "pending") {
    const error = new Error("Request pending");
    error.statusCode = 409;
    throw error;
  }

  const existing = await prisma.contactRequest.findFirst({
    where: {
      senderId: String(request.requesterId),
      receiverId: String(request.receiverId),
      status: "pending"
    },
    include: { sender: true, receiver: true }
  });
  if (existing) return normalizeContactRequest(existing);

  const created = await prisma.contactRequest.create({
    data: {
      id: request.id,
      senderId: String(request.requesterId),
      receiverId: String(request.receiverId),
      status: request.status || "pending",
      createdAt: request.createdAt ? new Date(request.createdAt) : undefined
    },
    include: { sender: true, receiver: true }
  });

  return normalizeContactRequest(created);
}

export async function listPendingContactRequests(receiverId) {
  const requests = await prisma.contactRequest.findMany({
    where: { receiverId: String(receiverId), status: "pending" },
    include: { sender: true, receiver: true },
    orderBy: { createdAt: "desc" }
  });

  return requests.map(normalizeContactRequest);
}

export async function acceptContactRequest(requestId, receiverId) {
  const request = await prisma.contactRequest.findFirst({
    where: { id: String(requestId), receiverId: String(receiverId), status: "pending" }
  });
  if (!request) return null;

  const result = await prisma.$transaction(async (tx) => {
    const accepted = await tx.contactRequest.update({
      where: { id: request.id },
      data: { status: "accepted", respondedAt: new Date() },
      include: { sender: true, receiver: true }
    });

    await tx.contact.upsert({
      where: { userId_contactUserId: { userId: request.senderId, contactUserId: request.receiverId } },
      update: { status: "accepted" },
      create: { userId: request.senderId, contactUserId: request.receiverId, status: "accepted" }
    });
    await tx.contact.upsert({
      where: { userId_contactUserId: { userId: request.receiverId, contactUserId: request.senderId } },
      update: { status: "accepted" },
      create: { userId: request.receiverId, contactUserId: request.senderId, status: "accepted" }
    });

    return accepted;
  });

  return {
    request: normalizeContactRequest(result),
    requester: publicUser(result.sender),
    receiver: publicUser(result.receiver)
  };
}

export async function rejectContactRequest(requestId, receiverId) {
  const request = await prisma.contactRequest.findFirst({
    where: { id: String(requestId), receiverId: String(receiverId), status: "pending" }
  });
  if (!request) return null;

  const rejected = await prisma.contactRequest.update({
    where: { id: request.id },
    data: { status: "rejected", respondedAt: new Date() },
    include: { sender: true, receiver: true }
  });

  return normalizeContactRequest(rejected);
}

export async function saveMessage(message) {
  const created = await prisma.message.create({
    data: {
      id: message.id,
      senderId: String(message.senderId),
      receiverId: String(message.receiverId),
      type: message.type || "text",
      text: message.text || message.message || null,
      mediaUrl: message.mediaUrl || null,
      mediaName: message.mediaName || null,
      mediaMimeType: message.mediaMimeType || null,
      mediaDurationSeconds: message.mediaDurationSeconds ? Number(message.mediaDurationSeconds) : null,
      replyToMessageId: message.replyToMessageId || null,
      isForwarded: Boolean(message.isForwarded),
      status: message.status || "sent",
      createdAt: message.createdAt ? new Date(message.createdAt) : undefined
    },
    include: messageInclude
  });

  return normalizeMessage(created);
}

export async function updateMessageStatus(messageId, status) {
  const updated = await prisma.message.update({
    where: { id: String(messageId) },
    data: { status },
    include: messageInclude
  });

  return normalizeMessage(updated);
}

export async function editMessage({ messageId, userId, text }) {
  const message = await prisma.message.findFirst({
    where: {
      id: String(messageId),
      senderId: String(userId),
      type: "text",
      isDeletedForEveryone: false
    }
  });
  if (!message) return null;

  const updated = await prisma.message.update({
    where: { id: String(messageId) },
    data: { text: String(text || "").trim(), editedAt: new Date() },
    include: messageInclude
  });
  return normalizeMessage(updated);
}

export async function deleteMessage({ messageId, userId, scope }) {
  const message = await findMessageForUser(messageId, userId);
  if (!message) return null;

  if (scope === "everyone" && String(message.senderId) === String(userId)) {
    const updated = await prisma.message.update({
      where: { id: String(messageId) },
      data: {
        isDeletedForEveryone: true,
        text: null,
        mediaUrl: null,
        mediaName: null,
        mediaMimeType: null,
        mediaDurationSeconds: null
      },
      include: messageInclude
    });
    return { scope, message: normalizeMessage(updated) };
  }

  const deletedForUserIds = new Set(
    String(message.deletedForUserIds || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
  deletedForUserIds.add(String(userId));
  const updated = await prisma.message.update({
    where: { id: String(messageId) },
    data: { deletedForUserIds: Array.from(deletedForUserIds).join(",") },
    include: messageInclude
  });
  return { scope: "me", message: normalizeMessage(updated) };
}

export async function markConversationRead({ readerId, peerId, messageIds = [] }) {
  const ids = messageIds.map(String);
  const where = {
    senderId: String(peerId),
    receiverId: String(readerId),
    status: { not: "read" },
    ...(ids.length > 0 ? { id: { in: ids } } : {})
  };

  const messages = await prisma.message.findMany({ where, include: messageInclude });
  if (messages.length === 0) return [];

  await prisma.message.updateMany({
    where: { id: { in: messages.map((message) => message.id) } },
    data: { status: "read" }
  });

  return messages.map((message) => normalizeMessage({ ...message, status: "read" }));
}

export async function getConversation(userId, peerId) {
  const messages = await prisma.message.findMany({
    where: {
      OR: [
        { senderId: String(userId), receiverId: String(peerId) },
        { senderId: String(peerId), receiverId: String(userId) }
      ]
    },
    orderBy: { createdAt: "asc" },
    include: messageInclude
  });

  return messages
    .filter((message) => !String(message.deletedForUserIds || "").split(",").includes(String(userId)))
    .map(normalizeMessage);
}

export async function saveCallEvent(event) {
  const created = await prisma.callEvent.create({
    data: {
      id: event.id,
      callerId: String(event.callerId),
      receiverId: String(event.receiverId),
      callType: event.callType,
      status: event.status,
      durationSeconds: Number(event.durationSeconds || 0),
      createdAt: event.createdAt ? new Date(event.createdAt) : undefined
    }
  });

  return normalizeCallEvent(created);
}

export async function saveMediaFile(file) {
  return prisma.mediaFile.create({
    data: {
      id: file.id,
      uploaderId: String(file.uploaderId),
      url: file.url,
      fileName: file.fileName,
      mimeType: file.mimeType,
      size: Number(file.size || 0),
      createdAt: file.createdAt ? new Date(file.createdAt) : undefined
    }
  });
}

export async function getConversationTimeline(userId, peerId) {
  const [messages, callEvents] = await Promise.all([
    prisma.message.findMany({
      where: {
        OR: [
          { senderId: String(userId), receiverId: String(peerId) },
          { senderId: String(peerId), receiverId: String(userId) }
        ]
      },
      include: messageInclude
    }),
    prisma.callEvent.findMany({
      where: {
        OR: [
          { callerId: String(userId), receiverId: String(peerId) },
          { callerId: String(peerId), receiverId: String(userId) }
        ]
      }
    })
  ]);

  return [
    ...messages
      .filter((message) => !String(message.deletedForUserIds || "").split(",").includes(String(userId)))
      .map(normalizeMessage),
    ...callEvents.map(normalizeCallEvent)
  ].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
  );
}

export async function findMessageForUser(messageId, userId) {
  return prisma.message.findFirst({
    where: {
      id: String(messageId),
      OR: [{ senderId: String(userId) }, { receiverId: String(userId) }]
    },
    include: messageInclude
  });
}

export async function forwardMessage({ messageId, senderId, receiverIds = [] }) {
  const original = await findMessageForUser(messageId, senderId);
  if (!original) return null;

  const uniqueReceiverIds = [...new Set(receiverIds.map(String))].filter((receiverId) => receiverId !== String(senderId));
  if (uniqueReceiverIds.length === 0) return [];

  const contacts = await prisma.contact.findMany({
    where: {
      userId: String(senderId),
      contactUserId: { in: uniqueReceiverIds },
      status: "accepted"
    }
  });
  const acceptedReceiverIds = new Set(contacts.map((contact) => String(contact.contactUserId)));
  const rejectedReceiverIds = uniqueReceiverIds.filter((receiverId) => !acceptedReceiverIds.has(receiverId));
  if (rejectedReceiverIds.length > 0) {
    const error = new Error("Can only forward to accepted contacts");
    error.statusCode = 403;
    throw error;
  }

  const created = await prisma.$transaction(
    uniqueReceiverIds.map((receiverId) =>
      prisma.message.create({
        data: {
          senderId: String(senderId),
          receiverId,
          type: original.type,
          text: original.text,
          mediaUrl: original.mediaUrl,
          mediaName: original.mediaName,
          mediaMimeType: original.mediaMimeType,
          mediaDurationSeconds: original.mediaDurationSeconds,
          isForwarded: true,
          status: "sent"
        },
        include: messageInclude
      })
    )
  );

  return created.map(normalizeMessage);
}

export async function upsertMessageReaction({ messageId, userId, emoji }) {
  const message = await findMessageForUser(messageId, userId);
  if (!message) return null;

  const currentReaction = await prisma.messageReaction.findUnique({
    where: { messageId_userId: { messageId: String(messageId), userId: String(userId) } }
  });

  if (currentReaction?.emoji === emoji) {
    await prisma.messageReaction.delete({ where: { id: currentReaction.id } });
    return { action: "removed", reaction: currentReaction, message: normalizeMessage(message) };
  }

  const reaction = await prisma.messageReaction.upsert({
    where: { messageId_userId: { messageId: String(messageId), userId: String(userId) } },
    update: { emoji },
    create: {
      messageId: String(messageId),
      userId: String(userId),
      emoji
    }
  });

  return {
    action: currentReaction ? "updated" : "added",
    reaction,
    message: normalizeMessage(message)
  };
}

export async function deleteMessageReaction({ messageId, userId }) {
  const message = await findMessageForUser(messageId, userId);
  if (!message) return null;

  const currentReaction = await prisma.messageReaction.findUnique({
    where: { messageId_userId: { messageId: String(messageId), userId: String(userId) } }
  });

  if (!currentReaction) {
    return { action: "removed", reaction: null, message: normalizeMessage(message) };
  }

  await prisma.messageReaction.delete({ where: { id: currentReaction.id } });
  return { action: "removed", reaction: currentReaction, message: normalizeMessage(message) };
}

export async function getConversationSummaries(userId) {
  const contacts = await listAcceptedContacts(userId);

  const summaries = await Promise.all(
    contacts.map(async (contact) => {
      const peerId = String(contact.id);
      const [timeline, unreadCount] = await Promise.all([
        getConversationTimeline(userId, peerId),
        prisma.message.count({
          where: {
            senderId: peerId,
            receiverId: String(userId),
            status: { not: "read" }
          }
        })
      ]);

      return {
        peerId,
        unreadCount,
        latest: timeline.at(-1) || null
      };
    })
  );

  return summaries;
}

export async function listCallEventsForUser(userId) {
  const events = await prisma.callEvent.findMany({
    where: { OR: [{ callerId: String(userId) }, { receiverId: String(userId) }] },
    include: {
      caller: { select: { id: true, name: true, email: true, avatarUrl: true } },
      receiver: { select: { id: true, name: true, email: true, avatarUrl: true } }
    },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  return events.map(normalizeCallEvent);
}

export async function createNotification({ userId, type, title, body }) {
  return prisma.notification.create({
    data: { userId: String(userId), type, title, body: body || null }
  });
}

export async function listNotifications(userId) {
  return prisma.notification.findMany({
    where: { userId: String(userId) },
    orderBy: { createdAt: "desc" },
    take: 50
  });
}

export async function markNotificationRead(userId, notificationId) {
  await prisma.notification.updateMany({
    where: { id: String(notificationId), userId: String(userId) },
    data: { isRead: true }
  });
  return listNotifications(userId);
}

export async function clearNotifications(userId) {
  await prisma.notification.updateMany({
    where: { userId: String(userId), isRead: false },
    data: { isRead: true }
  });
  return listNotifications(userId);
}

export async function getDashboardMetrics(userId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [totalContacts, unreadMessages, missedCalls, todaysCalls, pendingRequests, calls, messages] = await Promise.all([
    prisma.contact.count({ where: { userId: String(userId), status: "accepted" } }),
    prisma.message.count({ where: { receiverId: String(userId), status: { not: "read" } } }),
    prisma.callEvent.count({ where: { receiverId: String(userId), status: "missed" } }),
    prisma.callEvent.count({
      where: { createdAt: { gte: today }, OR: [{ callerId: String(userId) }, { receiverId: String(userId) }] }
    }),
    prisma.contactRequest.count({ where: { receiverId: String(userId), status: "pending" } }),
    prisma.callEvent.findMany({
      where: { OR: [{ callerId: String(userId) }, { receiverId: String(userId) }] },
      orderBy: { createdAt: "desc" },
      take: 8
    }),
    prisma.message.findMany({
      where: { OR: [{ senderId: String(userId) }, { receiverId: String(userId) }] },
      orderBy: { createdAt: "desc" },
      take: 8
    })
  ]);

  const recentActivity = [...calls.map(normalizeCallEvent), ...messages.map(normalizeMessage)]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 8);

  return { totalContacts, unreadMessages, missedCalls, todaysCalls, pendingRequests, recentActivity };
}

export async function getAdminMetrics(onlineUserCount = 0) {
  const [totalUsers, totalMessages, totalCalls, missedCalls, mediaFiles, pendingContactRequests] = await Promise.all([
    prisma.user.count(),
    prisma.message.count(),
    prisma.callEvent.count(),
    prisma.callEvent.count({ where: { status: "missed" } }),
    prisma.mediaFile.count(),
    prisma.contactRequest.count({ where: { status: "pending" } })
  ]);
  return { totalUsers, onlineUsers: onlineUserCount, totalMessages, totalCalls, missedCalls, mediaFiles, pendingContactRequests };
}

export async function listAdminUsers() {
  return prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, email: true, phone: true, role: true, isBlocked: true, createdAt: true }
  });
}

export async function setUserBlocked(userId, isBlocked) {
  return publicUser(await prisma.user.update({ where: { id: String(userId) }, data: { isBlocked: Boolean(isBlocked) } }));
}

export async function listAdminCallEvents() {
  return prisma.callEvent.findMany({
    include: {
      caller: { select: { id: true, name: true, email: true } },
      receiver: { select: { id: true, name: true, email: true } }
    },
    orderBy: { createdAt: "desc" },
    take: 100
  });
}

export async function getAdminMessageStats() {
  const [byType, delivered, read, sent] = await Promise.all([
    prisma.message.groupBy({ by: ["type"], _count: { _all: true } }),
    prisma.message.count({ where: { status: "delivered" } }),
    prisma.message.count({ where: { status: "read" } }),
    prisma.message.count({ where: { status: "sent" } })
  ]);
  return { byType, statuses: { sent, delivered, read } };
}

export async function listAdminMediaFiles() {
  return prisma.mediaFile.findMany({
    include: { uploader: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: 100
  });
}
