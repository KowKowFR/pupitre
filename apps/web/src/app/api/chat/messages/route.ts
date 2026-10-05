import {
  CHAT_DEFAULT_CHANNEL,
  CHAT_IMAGES_PER_MESSAGE,
  CHAT_IMAGE_MAX_BYTES,
  CHAT_MESSAGE_MAX,
  CHAT_PAGE_SIZE,
  keepMentions,
  sniffImage,
} from '@pupitre/core';
import {
  getChatMessage,
  insertChatMessage,
  listChatMessages,
  markChatRead,
  type NewChatAttachment,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { chat as messages } from '@/i18n/messages/chat';
import { resolveMentions } from '@/lib/chat';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody, readLimitedFormData } from '@/lib/http';
import { enforceRateLimit, type RateLimitRule } from '@/lib/rate-limit';
import { requireTeamMember } from '@/lib/rbac';
import { publishRealtime } from '@/lib/realtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Enough for a lively conversation, too little to drown the thread. */
const CHAT_POST_RULE: RateLimitRule = { name: 'chat:post', limit: 20, windowSec: 30 };

const querySchema = z.object({
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(CHAT_PAGE_SIZE),
});

/** A page of the thread, the most recent requested first, returned in reading order. */
export const GET = apiRoute(async (request) => {
  await requireTeamMember(request);
  const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  const items = await listChatMessages(CHAT_DEFAULT_CHANNEL, query);
  return NextResponse.json({ items, hasMore: items.length === query.limit });
});

const bodySchema = z.object({
  body: z
    .string()
    .max(CHAT_MESSAGE_MAX * 2)
    .default(''),
  /** The message being replied to. It must exist, in this room, and not be deleted. */
  replyToId: z.string().uuid().nullable().default(null),
});

/** The text, plus the images — and a little margin for the multipart envelope. */
const MULTIPART_MAX_BYTES = CHAT_IMAGES_PER_MESSAGE * CHAT_IMAGE_MAX_BYTES + 64 * 1024;

/**
 * The message arrives as JSON, or as `multipart/form-data` when it carries
 * images: `body` and `replyToId` fields, `image` files (four at most).
 *
 * Each image is read in its bytes: format and dimensions come from there, never
 * from the file name nor the announced type. It was already resized and
 * re-encoded by the browser — the server only checks and stores.
 */
async function readMessage(request: Request) {
  const type = request.headers.get('content-type') ?? '';
  if (!type.startsWith('multipart/form-data')) {
    return { ...(await readJsonBody(request, bodySchema)), attachments: [] };
  }

  const form = await readLimitedFormData(request, MULTIPART_MAX_BYTES);
  const fields = bodySchema.parse({
    body: form.get('body') ?? '',
    replyToId: form.get('replyToId') || null,
  });
  const files = form.getAll('image').filter((entry): entry is File => entry instanceof File);
  if (files.length > CHAT_IMAGES_PER_MESSAGE) {
    throw new HttpError(
      422,
      'too_many_images',
      msg(messages, 'error.tooManyImages', { max: CHAT_IMAGES_PER_MESSAGE }),
    );
  }

  const attachments: NewChatAttachment[] = [];
  for (const file of files) {
    if (file.size > CHAT_IMAGE_MAX_BYTES) {
      throw new HttpError(
        413,
        'image_too_large',
        msg(messages, 'error.imageTooLarge', {
          max: Math.round(CHAT_IMAGE_MAX_BYTES / 1024 / 1024),
        }),
      );
    }
    const data = Buffer.from(await file.arrayBuffer());
    const info = sniffImage(data);
    if (!info) throw new HttpError(415, 'unsupported_image', msg(messages, 'error.imageFormat'));
    attachments.push({ ...info, bytes: data.byteLength, data });
  }
  return { ...fields, attachments };
}

/**
 * Writing to the team. The mentions are checked again here: a token pointing to
 * what the author cannot open becomes text again. The message is saved, then
 * pushed live — the database first, so that a tab reconnecting at the same
 * instant reads it again.
 *
 * No audit line: a message is not an action on the fleet, and the log must not
 * drown in the conversation. Deleting someone else's message, on the other hand,
 * is traced.
 */
export const POST = apiRoute(async (request) => {
  const auth = await requireTeamMember(request);
  await enforceRateLimit(CHAT_POST_RULE, auth.userId);
  const input = await readMessage(request);

  const raw = input.body.replace(/\r\n?/g, '\n').trim();
  // An image alone is a message; an empty message is not.
  if (raw.length === 0 && input.attachments.length === 0) {
    throw new HttpError(422, 'empty_message', msg(messages, 'error.empty'));
  }
  if (raw.length > CHAT_MESSAGE_MAX) {
    throw new HttpError(
      422,
      'message_too_long',
      msg(messages, 'error.tooLong', { max: CHAT_MESSAGE_MAX }),
    );
  }

  if (input.replyToId) {
    const original = await getChatMessage(input.replyToId);
    if (!original || original.deleted || original.channel !== CHAT_DEFAULT_CHANNEL) {
      throw new NotFoundError(msg(messages, 'error.replyNotFound'));
    }
  }

  const mentions = await resolveMentions(raw, auth);
  const body = keepMentions(raw, mentions);
  const message = await insertChatMessage({
    channel: CHAT_DEFAULT_CHANNEL,
    authorId: auth.userId,
    body,
    mentions,
    replyToId: input.replyToId,
    attachments: input.attachments,
  });
  await markChatRead(auth.userId, CHAT_DEFAULT_CHANNEL, new Date(message.createdAt));

  await publishRealtime({
    type: 'chat.message',
    message: {
      id: message.id,
      channel: message.channel,
      authorId: message.authorId,
      authorName: message.authorName,
      body: message.body,
      mentions: message.mentions,
      replyTo: message.replyTo,
      reactions: message.reactions,
      attachments: message.attachments,
      createdAt: message.createdAt,
    },
  });
  return NextResponse.json(message, { status: 201 });
});
