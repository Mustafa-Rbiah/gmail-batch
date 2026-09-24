import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as archiverModule from 'archiver';
const archiver: any = (archiverModule as any).default || archiverModule;
import {
  createGmailClient,
  openGmailAllMail,
  ensureDownloadedLabel,
  buildGmailQuery,
} from '../src/server/imap.js';
import { cleanAndFormatEmlBytes } from '../src/services/headerCleaner.js';
import type { CleanHeadersConfig } from '../src/types.js';

function sanitizeFilename(subject: string, id: string): string {
  const cleanSubject = (subject || 'untitled')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim()
    .slice(0, 60);
  return `${cleanSubject}_${id}.eml`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  const {
    email,
    appPassword,
    category,
    limit = 20,
    headerOptions = {},
    customQuery,
    dateFilter,
  } = req.body || {};

  if (!email || !appPassword) {
    return res.status(400).json({ success: false, error: 'Missing credentials' });
  }

  const client = createGmailClient({ email, appPassword });

  try {
    await client.connect();
    await ensureDownloadedLabel(client);

    const { lock } = await openGmailAllMail(client);

    try {
      const query = buildGmailQuery(category || 'inbox', customQuery, dateFilter);
      const searchResult = await client.search({ gmraw: query }, { uid: true });
      const uids = Array.isArray(searchResult) ? (searchResult as number[]) : [];

      if (uids.length === 0) {
        return res.status(404).json({
          success: false,
          error: `No unread, non-downloaded emails found matching query "${query}".`,
        });
      }

      const countToFetch = Math.min(Number(limit) || 20, uids.length);
      const sortOrder = dateFilter?.sortOrder || 'newest';
      let selectedUids = sortOrder === 'oldest'
        ? uids.slice(0, countToFetch)
        : uids.slice(-countToFetch).reverse();

      const processedItems: {
        id: string;
        subject: string;
        from: string;
        date: string;
        filename: string;
        size: number;
        bytes: Uint8Array;
      }[] = [];

      const fetchedUids: number[] = [];

      for await (const message of client.fetch(
        selectedUids,
        {
          uid: true,
          envelope: true,
          internalDate: true,
          size: true,
          source: true,
        },
        { uid: true }
      )) {
        if (!message.source) continue;

        fetchedUids.push(message.uid);

        const env = message.envelope || ({} as any);
        const fromStr = env.from?.[0]
          ? `${env.from[0].name ? `"${env.from[0].name}" ` : ''}<${env.from[0].address || ''}>`
          : 'Unknown';
        const subject = env.subject || '(No Subject)';
        const dateStr = message.internalDate
          ? new Date(message.internalDate).toISOString()
          : new Date().toISOString();

        const rawBytes = new Uint8Array(message.source);
        const finalBytes = headerOptions.enabled !== false
          ? cleanAndFormatEmlBytes(rawBytes, headerOptions as CleanHeadersConfig)
          : rawBytes;

        const filename = sanitizeFilename(subject, String(message.uid));

        processedItems.push({
          id: String(message.uid),
          subject,
          from: fromStr,
          date: dateStr,
          filename,
          size: finalBytes.length,
          bytes: finalBytes,
        });
      }

      if (processedItems.length === 0) {
        return res.status(500).json({
          success: false,
          error: 'Failed to fetch raw message contents from IMAP server.',
        });
      }

      // Tag all fetched emails with the 'Downloaded' label
      try {
        await client.messageFlagsAdd(fetchedUids, ['Downloaded'], { uid: true });
      } catch (labelErr) {
        console.warn('Could not add label Downloaded via messageFlagsAdd:', labelErr);
      }

      const wantsJson = req.query?.format === 'json';

      if (wantsJson) {
        return res.json({
          success: true,
          total: processedItems.length,
          items: processedItems.map((item) => ({
            id: item.id,
            subject: item.subject,
            from: item.from,
            date: item.date,
            filename: item.filename,
            sizeEstimate: item.size,
            status: 'completed',
            rawBase64: Buffer.from(item.bytes).toString('base64'),
          })),
        });
      }

      const catSlug = (category || 'mail').replace(/[^a-zA-Z0-9_-]/g, '_');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const zipFilename = `gmail_backup_${catSlug}_${timestamp}.zip`;

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);
      res.setHeader('X-Total-Count', String(processedItems.length));

      const archive = archiver('zip', { zlib: { level: 9 } });

      archive.on('error', (err: any) => {
        console.error('Archiver error:', err);
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: err.message });
        }
      });

      archive.pipe(res);

      for (const item of processedItems) {
        archive.append(Buffer.from(item.bytes), { name: item.filename });
      }

      await archive.finalize();
    } finally {
      lock.release();
      await client.logout();
    }
  } catch (err: any) {
    console.error('Download error:', err);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: err.message || 'Failed to download and package emails.',
      });
    }
  }
}
