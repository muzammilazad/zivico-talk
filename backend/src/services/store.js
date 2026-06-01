import { prisma } from "./prisma.js";

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
  const { passwordHash, ...safeUser } = user;
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
    reactions: message.reactions || [],
    replyToMessage,
    message: message.text || "",
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

export async function findUserByPhone(phone) {
  const value = String(phone || "").trim();
  if (!value) return null;
  return prisma.user.findUnique({ where: { phone: value } });
}

export async function findUserById(id) {
  return prisma.user.findUnique({ where: { id: String(id) } });
}

export async function createUser(user) {
  return prisma.user.create({
    data: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone || null,
      passwordHash: user.passwordHash,
      avatarUrl: user.avatarUrl || null,
      createdAt: user.createdAt ? new Date(user.createdAt) : undefined
    }
  });
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

export async function searchUsers({ query, currentUserId }) {
  const q = String(query || "").trim();
  if (!q) return [];

  const users = await prisma.user.findMany({
    where: {
      id: { not: String(currentUserId) },
      OR: [{ email: { contains: q } }, { phone: { contains: q } }]
    },
    orderBy: { name: "asc" },
    take: 8
  });

  return users.map(publicUser);
}

export async function listAcceptedContacts(userId) {
  const contacts = await prisma.contact.findMany({
    where: { userId: String(userId), status: "accepted" },
    include: { contactUser: true },
    orderBy: { createdAt: "desc" }
  });

  return contacts.map((contact) => publicUser(contact.contactUser));
}

export async function getContactStatus(userAId, userBId) {
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
    }
  });

  return request ? { status: "pending", request: normalizeContactRequest(request) } : { status: "none" };
}

export async function createContactRequest(request) {
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

  return messages.map(normalizeMessage);
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

  return [...messages.map(normalizeMessage), ...callEvents.map(normalizeCallEvent)].sort(
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
