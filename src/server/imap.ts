import { ImapFlow } from 'imapflow';
import { cleanAndFormatEmlBytes } from '../services/headerCleaner.js';
import { CleanHeadersConfig, DateFilterConfig } from '../types.js';

export interface ImapCredentials {
  email: string;
  appPassword: string;
}

/**
 * Creates an ImapFlow client configured for Gmail SSL (imap.gmail.com:993)
 */
export function createGmailClient(credentials: ImapCredentials): ImapFlow {
  const cleanEmail = (credentials.email || '').trim();
  const cleanPass = (credentials.appPassword || '').replace(/\s+/g, '').trim();

  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: cleanEmail,
      pass: cleanPass,
    },
    logger: false,
    emitLogs: false,
  });
}

/**
 * Finds and locks the optimal Gmail mailbox ('[Gmail]/All Mail' or 'INBOX')
 */
export async function openGmailAllMail(client: ImapFlow) {
  const mailboxes = await client.list();
  
  // Prefer mailbox with specialUse '\All' or name containing 'All Mail'
  const allMailBox = mailboxes.find(
    (m) =>
      m.specialUse === '\\All' ||
      m.path.toLowerCase().includes('all mail') ||
      m.path.toLowerCase().includes('tous les messages')
  );

  const targetPath = allMailBox ? allMailBox.path : 'INBOX';
  const lock = await client.getMailboxLock(targetPath);
  return { lock, path: targetPath, mailboxes };
}

/**
 * Ensures the 'Downloaded' label/mailbox exists on Gmail
 */
export async function ensureDownloadedLabel(client: ImapFlow): Promise<void> {
  try {
    await client.mailboxCreate('Downloaded');
  } catch (err: any) {
    // Ignore if already exists (ALREADYEXISTS / Mailbox exists error)
  }
}

/**
 * Builds standard Gmail search query
 */
export function buildGmailQuery(
  category: string,
  customQuery?: string,
  dateFilter?: DateFilterConfig
): string {
  const parts: string[] = [];

  // Exclude already downloaded emails
  parts.push('-label:Downloaded');
  parts.push('is:unread');

  if (category === 'custom' && customQuery && customQuery.trim()) {
    parts.push(customQuery.trim());
  } else if (category === 'primary') {
    parts.push('category:primary');
  } else if (category === 'promotions') {
    parts.push('category:promotions');
  } else if (category === 'social') {
    parts.push('category:social');
  } else if (category === 'updates') {
    parts.push('category:updates');
  } else if (category === 'forums') {
    parts.push('category:forums');
  } else if (category === 'inbox') {
    parts.push('label:inbox');
  }
  // 'all' category doesn't need category constraint

  // Date filters
  if (dateFilter?.startDate) {
    const d = new Date(dateFilter.startDate);
    if (!isNaN(d.getTime())) {
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      parts.push(`after:${yyyy}/${mm}/${dd}`);
    }
  }

  if (dateFilter?.endDate) {
    const d = new Date(dateFilter.endDate);
    if (!isNaN(d.getTime())) {
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      parts.push(`before:${yyyy}/${mm}/${dd}`);
    }
  }

  return parts.join(' ');
}
